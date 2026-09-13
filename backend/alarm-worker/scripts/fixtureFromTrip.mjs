#!/usr/bin/env node
/**
 * trip 토큰 1개 → replay fixture 후보 자동 생성 one-command 도구 (#2586, Epic #2239 P1).
 *
 * D1 조회(SQL 문자열 생성/응답 파싱), 시간창 계산, registry 스켈레톤 직렬화는 전부
 * `../src/fixtureFromTrip.ts`에 있다(vitest 커버) — 이 파일은 wrangler CLI 실행 + admin
 * endpoint 호출 + 임시 디렉토리 관리만 하는 얇은 I/O 셸이다(`buildReplayFixture.mjs`,
 * #2580과 동일 분리 원칙). 인자 파싱 + capture cycle 파일 읽기는 `cliUtils.mjs`(#2586
 * 코드리뷰 — 두 스크립트 공유)로 뺐다.
 *
 * 절차:
 *   1) `wrangler d1 execute <DB> --remote --json --command "<SELECT ... WHERE token_hash=?>"`
 *      로 trip_events에서 시간창/노선/segment 역/fire 이력 추출.
 *   2) `GET /admin/seoul-capture/keys?from=<ms>&to=<ms>`(#2595, Bearer ADMIN_TOKEN)로 그
 *      시간창(사전 필터 preRoll 포함)에 해당하는 R2 seoul-capture 키 목록을 받는다 — aws
 *      s3api + R2 S3 호환 토큰 없이 worker 자신의 TELEMETRY_R2 바인딩으로 조회(#2586
 *      코드리뷰 2차). 매칭 key만 `wrangler r2 object get --remote`로 다운로드한다.
 *   3) `buildReplayFixture`(#2580, ../src/replayFixture.ts)로 병합 →
 *      `<out>/<slug>.fixture.json`. 기본 `<out>`은 `.fixture-staging/`(1:1 게이트 디렉토리인
 *      `src/__tests__/fixtures/replayLibrary/`에 직행하지 않는다 — 사람이 검토 후 옮긴다).
 *   4) registry 엔트리 스켈레톤(#2585 규약)을 stdout에 출력 — 사람은 등록 diff 확인만.
 *
 * wrangler 인증은 로컬 환경 것을 그대로 쓴다. admin endpoint 인증은 `ADMIN_TOKEN` env를
 * 우선하고, 없으면 repo 루트 `.env`의 `EXPO_PUBLIC_ADMIN_TOKEN` 값을 읽는다(이 스크립트가
 * 토큰을 저장/로그에 남기지 않는다 — 값 자체를 출력하지 않는다).
 *
 * Usage: 하단 `USAGE` 상수 참고(인자 누락/충돌 시 stdout에도 그대로 출력된다) — 문서
 * 3중 사본(헤더/상수/README)을 피하려고 여기서는 텍스트를 반복하지 않는다.
 *
 * trip이 종료/삭제된 뒤에는(이 도구의 전형적 사용 시점) KV 원본 토큰이 사라지고 D1
 * `trip_events`에는 `token_hash`만 남는다 — 그 경우 `--token-hash`로 직접 조회한다
 * (`resolveTokenHash`, ../src/fixtureFromTrip.ts).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFixtureSlug,
  buildRegistryEntrySkeleton,
  buildTripEventsQuery,
  CAPTURE_KEY_PRE_ROLL_MS,
  computeTripCaptureWindow,
  extractFireAttempts,
  extractLines,
  extractSegmentStations,
  parseEnvValue,
  parseTripEventsResponse,
  resolveTokenHash,
  segmentTripEvents,
  selectTripSegment,
} from '../src/fixtureFromTrip.ts';
import { buildReplayFixture, isLossyFixture, parseSeoulCaptureCycle } from '../src/replayFixture.ts';
import { parseArgs, readCycleFile, resolveWranglerCommand } from './cliUtils.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT_ENV_PATH = path.join(SCRIPT_DIR, '..', '..', '..', '.env');

const DEFAULT_OUT_DIR = '.fixture-staging/';
const REPLAY_LIBRARY_DIR = 'src/__tests__/fixtures/replayLibrary/';
const DEFAULT_DB = 'subway-now-db';
const DEFAULT_BUCKET = 'subway-now-telemetry';
const DEFAULT_WORKER_URL = 'https://subway-now-alarm-worker.handokei.workers.dev';

const USAGE =
  'Usage: node scripts/fixtureFromTrip.mjs (--trip <tripToken> | --token-hash <8hex>) ' +
  `[--worker-url ${DEFAULT_WORKER_URL}] [--out ${DEFAULT_OUT_DIR}] [--bucket ${DEFAULT_BUCKET}] [--db ${DEFAULT_DB}] ` +
  '[--trip-index 0] [--force]';

/**
 * wrangler CLI 실행 지점을 한 곳으로 수렴 — 로컬 devDependency bin이 있으면 그것을, 없으면
 * `npx wrangler`로 실행한다(`resolveWranglerCommand`, cliUtils.mjs, #2598 — 글로벌 wrangler가
 * PATH에 없는 환경에서 bare spawn ENOENT 수리). spawn 호출을 여기 하나로 좁혀 S4036 위험
 * 수용 표식(NOSONAR)도 1곳만 필요하게 한다.
 */
function runCli(args, options = {}) {
  const { cmd, prefixArgs } = resolveWranglerCommand(SCRIPT_DIR);
  return execFileSync(cmd, [...prefixArgs, ...args], { encoding: 'utf-8', ...options }); // NOSONAR — dev-only local CLI; wrangler resolution is intentional (S4036)
}

function runD1Query(db, sql) {
  try {
    return runCli(['d1', 'execute', db, '--remote', '--json', '--command', sql], {
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(`D1 조회 실패: wrangler d1 execute 실행 실패 (${err instanceof Error ? err.message : String(err)})`);
  }
}

/**
 * admin endpoint 인증 토큰 — env `ADMIN_TOKEN` 우선, 없으면 repo 루트 `.env`의
 * `EXPO_PUBLIC_ADMIN_TOKEN` 값을 읽는다. 값 자체는 반환만 하고 로그에 남기지 않는다.
 */
function resolveAdminToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  if (!existsSync(REPO_ROOT_ENV_PATH)) return undefined;
  const value = parseEnvValue(readFileSync(REPO_ROOT_ENV_PATH, 'utf-8'), 'EXPO_PUBLIC_ADMIN_TOKEN');
  return value === undefined || value === '' ? undefined : value;
}

/**
 * `GET /admin/seoul-capture/keys`(#2595) 호출 — worker 자신의 TELEMETRY_R2 바인딩으로 R2
 * seoul-capture 키 목록을 받는다(aws s3api/R2 S3 토큰 불필요). 401/400 등 비정상 응답은
 * status + body를 그대로 노출한다(오진 방지 — "캡처 없음"으로 뭉뚱그리지 않는다, #2586
 * 코드리뷰). 정상 응답 + 매칭 0건일 때만 호출자가 "캡처 없음"으로 판정한다.
 *
 * trade-off(all-or-nothing, #2586 코드리뷰): 이전 aws 기반 나열은 날짜별 요청이라 일부
 * 날짜만 실패해도 나머지로 부분 진행할 수 있었다. 이 endpoint는 요청 1건이라 실패하면
 * 전체가 실패한다 — 그 대신 실패 원인이 항상 명확하고(status+body 그대로 노출), 이
 * CLI는 재실행 비용이 거의 0(같은 인자로 다시 실행)이라 부분 관용보다 "무엇이 왜
 * 실패했는지 즉시 아는 것"을 우선한다.
 */
async function fetchCaptureKeys(workerUrl, adminToken, fromMs, toMs) {
  const url = new URL('/admin/seoul-capture/keys', workerUrl);
  url.searchParams.set('from', String(fromMs));
  url.searchParams.set('to', String(toMs));

  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${adminToken}` } });
  } catch (err) {
    throw new Error(`GET /admin/seoul-capture/keys 요청 실패(네트워크): ${err instanceof Error ? err.message : String(err)}`);
  }
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`GET /admin/seoul-capture/keys 실패 (status=${res.status}): ${bodyText}`);
  }

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch (err) {
    throw new Error(`GET /admin/seoul-capture/keys 응답 JSON 파싱 실패: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(body.keys)) {
    throw new Error('GET /admin/seoul-capture/keys 응답에 keys 배열이 없습니다');
  }
  return body.keys;
}

/** R2 키 하나를 로컬 파일로 다운로드(`--remote` — 로컬 빈 버킷이 아니라 실 R2 조회). 실패해도 throw하지 않고 skip(부분 캡처 허용). */
function downloadCaptureKey(bucket, key, destDir) {
  const fileName = path.basename(key);
  const destPath = path.join(destDir, fileName);
  try {
    runCli(['r2', 'object', 'get', `${bucket}/${key}`, '--file', destPath, '--remote']);
    return destPath;
  } catch (err) {
    console.warn(`[skip] ${key} 다운로드 실패: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

const BOOLEAN_FLAGS = ['force'];

async function main() {
  const args = parseArgs(process.argv.slice(2), BOOLEAN_FLAGS);

  const resolved = resolveTokenHash(args.trip, args['token-hash']);
  if ('error' in resolved) {
    console.error(USAGE);
    console.error(`인자 오류(${resolved.error}): --trip 또는 --token-hash 중 정확히 하나가 필요합니다(형식: 8자리 소문자 hex).`);
    process.exit(1);
  }
  const { tokenHash } = resolved;

  const workerUrl = args['worker-url'] ?? DEFAULT_WORKER_URL;
  const outDir = args.out ?? DEFAULT_OUT_DIR;
  const bucket = args.bucket ?? DEFAULT_BUCKET;
  const db = args.db ?? DEFAULT_DB;
  const force = args.force === true;

  const tripIndexRaw = args['trip-index'] ?? '0';
  if (!/^\d+$/.test(tripIndexRaw)) {
    console.error(USAGE);
    throw new Error(`--trip-index는 0 이상의 정수여야 합니다 (받은 값: ${tripIndexRaw})`);
  }
  const tripIndex = Number(tripIndexRaw);

  const adminToken = resolveAdminToken();
  if (!adminToken) {
    throw new Error(
      'ADMIN_TOKEN을 찾을 수 없습니다 — env ADMIN_TOKEN을 설정하거나 repo 루트 .env에 EXPO_PUBLIC_ADMIN_TOKEN을 채워주세요.',
    );
  }

  // 1) D1 조회 — token_hash 전체 이벤트(디바이스 수명 단위, 여러 trip 혼재 가능).
  const sql = buildTripEventsQuery(tokenHash);
  const stdout = runD1Query(db, sql);
  const allRows = parseTripEventsResponse(stdout, tokenHash);

  // #2598 결함1 — trip-end 마커로 세그먼트 분리 후, 기본값 최신 세그먼트(--trip-index 0)만
  // window/segment/fire 이력 계산에 사용한다. 과거 trip 혼입으로 인한 window/segment 오염 방지.
  const segments = segmentTripEvents(allRows);
  const selected = selectTripSegment(segments, tripIndex);
  if ('error' in selected) {
    throw new Error(
      `--trip-index ${tripIndex}에 해당하는 trip이 없습니다 (tokenHash=${tokenHash}에서 발견된 trip 수: ${segments.length})`,
    );
  }
  const rows = selected.segment.rows;

  const window = computeTripCaptureWindow(rows);
  const segmentStations = extractSegmentStations(rows);
  const lines = extractLines(rows);
  const fireAttempts = extractFireAttempts(rows);

  // slug/출력 경로를 다운로드 전에 먼저 확정 — 덮어쓰기 여부를 network I/O 전에 판별한다.
  const slug = buildFixtureSlug(tokenHash, window);
  const fixtureFileName = `${slug}.fixture.json`;
  const outPath = path.join(outDir, fixtureFileName);
  if (existsSync(outPath) && !force) {
    throw new Error(`이미 존재합니다: ${outPath} — 덮어쓰려면 --force를 붙이세요`);
  }

  // 2) admin endpoint가 이미 [from, to]로 필터한 키 목록을 받는다(#2595) — 클라이언트측
  // 재필터는 하지 않는다(중복, #2586 코드리뷰). preRoll은 요청 시점에 한 번만 적용.
  const keysInWindow = await fetchCaptureKeys(workerUrl, adminToken, window.fromMs - CAPTURE_KEY_PRE_ROLL_MS, window.toMs);

  const tempDir = mkdtempSync(path.join(tmpdir(), 'fixture-from-trip-'));
  try {
    const cycleFiles = [];
    for (const key of keysInWindow) {
      const filePath = downloadCaptureKey(bucket, key, tempDir);
      if (filePath) cycleFiles.push(filePath);
    }

    if (cycleFiles.length === 0) {
      throw new Error(
        `캡처 없음: 시간창(${new Date(window.fromMs).toISOString()} ~ ${new Date(window.toMs).toISOString()})에 ` +
          `해당하는 R2 seoul-capture 객체를 하나도 찾지 못했습니다(admin endpoint 매칭 ${keysInWindow.length}건)`,
      );
    }

    // 3) cycle 병합.
    const cycles = [];
    let skipped = 0;
    for (const filePath of cycleFiles) {
      const result = readCycleFile(filePath, parseSeoulCaptureCycle);
      if ('error' in result) {
        console.warn(`[skip] ${path.basename(filePath)}: ${result.error}`);
        skipped += 1;
        continue;
      }
      cycles.push(result.cycle);
    }

    const fixture = buildReplayFixture(cycles, window);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outPath, JSON.stringify(fixture, null, 2));

    const lossy = isLossyFixture(fixture);
    const registrySkeleton = buildRegistryEntrySkeleton({
      slug,
      fixtureFileName,
      tokenHash,
      segmentStations,
      lines,
      isLossy: lossy,
    });

    console.log(
      [
        `trip tokenHash: ${tokenHash}`,
        `trip_events: ${rows.length}건 (선택 trip-index=${tripIndex}/${segments.length}개 중, tokenHash 전체 ${allRows.length}건)`,
        `capture cycles: ${cycles.length} (skipped: ${skipped}, admin endpoint 매칭 키: ${keysInWindow.length})`,
        `window: ${new Date(window.fromMs).toISOString()} ~ ${new Date(window.toMs).toISOString()}`,
        `노선: ${lines.join(', ') || '(미확인)'}`,
        `segment 역: ${segmentStations.join(' → ') || '(없음)'}`,
        `실제 fire 이력: ${fireAttempts.length}건${
          fireAttempts.length > 0
            ? '\n' + fireAttempts.map((f) => `  - ${new Date(f.ts).toISOString()} ${f.station ?? '?'} (${f.outcome ?? 'unknown'})`).join('\n')
            : ''
        }`,
        ...(lossy
          ? [
              `[경고] 캡처 유실 신호 감지 — droppedEntries=${fixture.droppedEntries ?? 0}, failedCycleStartsMs=${fixture.failedCycleStartsMs?.length ?? 0}건. 이 fixture로 만든 재생 결과(특히 "발사 안 됨")는 불완전 입력일 수 있습니다.`,
            ]
          : []),
        `fixture out (staging): ${outPath}`,
        `다음 단계: 검토 후 ${REPLAY_LIBRARY_DIR}로 옮기고 아래 registry 스켈레톤을 src/__tests__/replayLibrary.ts에 등록하세요.`,
        '',
        `--- registry 스켈레톤 (src/__tests__/replayLibrary.ts REPLAY_LIBRARY 배열에 붙여넣기) ---`,
        registrySkeleton,
      ].join('\n'),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
