#!/usr/bin/env node
/**
 * trip 토큰 1개 → replay fixture 후보 자동 생성 one-command 도구 (#2586, Epic #2239 P1).
 *
 * D1 조회(SQL 문자열 생성/응답 파싱), 시간창 계산, registry 스켈레톤 직렬화는 전부
 * `../src/fixtureFromTrip.ts`에 있다(vitest 커버) — 이 파일은 wrangler/aws CLI 실행 + 임시
 * 디렉토리 관리만 하는 얇은 I/O 셸이다(`buildReplayFixture.mjs`, #2580과 동일 분리 원칙).
 *
 * 절차 (README "Seoul capture → replay fixture" 수동 절차를 trip 토큰 기준으로 자동화):
 *   1) `wrangler d1 execute <DB> --remote --json --command "<SELECT ... WHERE token_hash=?>"`
 *      로 trip_events에서 시간창/노선/segment 역/fire 이력 추출.
 *   2) 시간창(±2분 margin)이 걸치는 UTC 날짜마다 `aws s3api list-objects-v2`로 R2 cycle 키
 *      나열 → `wrangler r2 object get`으로 임시 디렉토리에 다운로드.
 *   3) `buildReplayFixture`(#2580, ../src/replayFixture.ts)로 병합 → `<slug>.fixture.json`.
 *   4) registry 엔트리 스켈레톤(#2585 규약)을 stdout에 출력 — 사람은 등록 diff 확인만.
 *
 * wrangler/aws 인증은 로컬 환경 것을 그대로 쓴다(이 스크립트는 자격증명을 다루지 않는다).
 *
 * Usage:
 *   node scripts/fixtureFromTrip.mjs --trip <tripToken> --account-id <cfAccountId>
 *     [--out src/__tests__/fixtures/replayLibrary/] [--bucket subway-now-telemetry]
 *     [--db subway-now-db]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildFixtureSlug,
  buildRegistryEntrySkeleton,
  buildTripEventsQuery,
  computeCaptureDates,
  computeTripCaptureWindow,
  extractFireAttempts,
  extractLines,
  extractSegmentStations,
  parseTripEventsResponse,
} from '../src/fixtureFromTrip.ts';
import { buildReplayFixture, isLossyFixture, parseSeoulCaptureCycle } from '../src/replayFixture.ts';
import { SEOUL_CAPTURE_KEY_PREFIX } from '../src/seoulCapture.ts';

const DEFAULT_OUT_DIR = 'src/__tests__/fixtures/replayLibrary/';
const DEFAULT_BUCKET = 'subway-now-telemetry';
const DEFAULT_DB = 'subway-now-db';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    args[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return args;
}

/** cycle 파일 하나를 읽어 SeoulCaptureCycle로 검증(`buildReplayFixture.mjs`와 동일 패턴). */
function readCycleFile(filePath) {
  let parsedJson;
  try {
    parsedJson = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    return { error: `JSON 파싱 실패: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    return { cycle: parseSeoulCaptureCycle(parsedJson) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * wrangler/aws CLI 실행 지점을 한 곳으로 수렴 — 이 스크립트는 개발자 로컬 전용 CLI로
 * CI/서버에서 실행되지 않으므로, PATH에서 wrangler/aws를 해석하는 것은 의도된 동작이다.
 * spawn 호출을 여기 하나로 좁혀 S4036 위험 수용 표식(NOSONAR)도 1곳만 필요하게 한다.
 */
function runCli(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf-8', ...options }); // NOSONAR — dev-only local CLI; PATH resolution of wrangler/aws is intentional (S4036)
}

function runD1Query(db, sql) {
  try {
    return runCli('wrangler', ['d1', 'execute', db, '--remote', '--json', '--command', sql], {
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(`D1 조회 실패: wrangler d1 execute 실행 실패 (${err instanceof Error ? err.message : String(err)})`);
  }
}

/** 지정 날짜의 R2 seoul-capture 키 목록(aws s3api list-objects-v2, 목록 조회는 wrangler 미지원). */
function listCaptureKeys(bucket, accountId, date) {
  const prefix = `${SEOUL_CAPTURE_KEY_PREFIX}${date}/`;
  let stdout;
  try {
    stdout = runCli('aws', [
      's3api',
      'list-objects-v2',
      '--endpoint-url',
      `https://${accountId}.r2.cloudflarestorage.com`,
      '--bucket',
      bucket,
      '--prefix',
      prefix,
      '--query',
      'Contents[].Key',
      '--output',
      'text',
    ]);
  } catch (err) {
    console.warn(`[warn] ${date} 캡처 키 나열 실패(부분 캡처로 진행): ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  const trimmed = stdout.trim();
  if (trimmed === '' || trimmed === 'None') return [];
  return trimmed.split(/\s+/);
}

/** R2 키 하나를 로컬 파일로 다운로드. 실패해도 throw하지 않고 skip(부분 캡처 허용). */
function downloadCaptureKey(bucket, key, destDir) {
  const fileName = path.basename(key);
  const destPath = path.join(destDir, fileName);
  try {
    runCli('wrangler', ['r2', 'object', 'get', `${bucket}/${key}`, '--file', destPath]);
    return destPath;
  } catch (err) {
    console.warn(`[skip] ${key} 다운로드 실패: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.trip || !args['account-id']) {
    console.error(
      'Usage: node scripts/fixtureFromTrip.mjs --trip <tripToken> --account-id <cfAccountId> ' +
        '[--out src/__tests__/fixtures/replayLibrary/] [--bucket subway-now-telemetry] [--db subway-now-db]',
    );
    process.exit(1);
  }

  const outDir = args.out ?? DEFAULT_OUT_DIR;
  const bucket = args.bucket ?? DEFAULT_BUCKET;
  const db = args.db ?? DEFAULT_DB;

  // 1) D1 조회 — 시간창/노선/segment 역/fire 이력.
  const { tokenHash, sql } = buildTripEventsQuery(args.trip);
  const stdout = runD1Query(db, sql);
  const rows = parseTripEventsResponse(stdout, tokenHash);

  const window = computeTripCaptureWindow(rows);
  const segmentStations = extractSegmentStations(rows);
  const lines = extractLines(rows);
  const fireAttempts = extractFireAttempts(rows);
  const dates = computeCaptureDates(window);

  // 2) 시간창이 걸치는 날짜마다 R2 캡처 키 나열 + 다운로드.
  const tempDir = mkdtempSync(path.join(tmpdir(), 'fixture-from-trip-'));
  const cycleFiles = [];
  try {
    for (const date of dates) {
      const keys = listCaptureKeys(bucket, args['account-id'], date);
      if (keys.length === 0) {
        console.warn(`[warn] ${date}: 캡처 키 0건 — 부분 캡처 가능성`);
      }
      for (const key of keys) {
        const filePath = downloadCaptureKey(bucket, key, tempDir);
        if (filePath) cycleFiles.push(filePath);
      }
    }

    if (cycleFiles.length === 0) {
      throw new Error(
        `캡처 없음: 시간창(${new Date(window.fromMs).toISOString()} ~ ${new Date(window.toMs).toISOString()})에 ` +
          '해당하는 R2 seoul-capture 객체를 하나도 찾지 못했습니다',
      );
    }

    // 3) cycle 병합.
    const cycles = [];
    let skipped = 0;
    for (const filePath of cycleFiles) {
      const result = readCycleFile(filePath);
      if ('error' in result) {
        console.warn(`[skip] ${path.basename(filePath)}: ${result.error}`);
        skipped += 1;
        continue;
      }
      cycles.push(result.cycle);
    }

    const fixture = buildReplayFixture(cycles, window);
    const slug = buildFixtureSlug(tokenHash, window);
    const fixtureFileName = `${slug}.fixture.json`;
    mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, fixtureFileName);
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
        `trip_events: ${rows.length}건`,
        `capture cycles: ${cycles.length} (skipped: ${skipped})`,
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
        `fixture out: ${outPath}`,
        '',
        `--- registry 스켈레톤 (src/__tests__/replayLibrary.ts REPLAY_LIBRARY 배열에 붙여넣기) ---`,
        registrySkeleton,
      ].join('\n'),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
