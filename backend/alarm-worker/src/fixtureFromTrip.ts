/**
 * trip 토큰 1개 → replay fixture 후보 자동 생성 로직 (Epic #2239 P1, #2586).
 *
 * "매 가설마다 라이드/로그" 루프의 마지막 조각 — D1 `trip_events`(read-only 소비, 스키마
 * 변경 없음)로 실 trip의 시간창·노선·segment 역 목록·fire 이력을 뽑아내고, 그 시간창으로
 * R2 seoul-capture를 병합해(`buildReplayFixture`, #2580) 라이브러리 후보 fixture +
 * registry 엔트리 스켈레톤을 만든다.
 *
 * D1 SQL 문자열 생성 + wrangler/D1 응답 파싱 + registry 스켈레톤 직렬화 — 순수 함수만
 * 둔다. wrangler d1 execute / `GET /admin/seoul-capture/keys`(#2595) 호출 / wrangler r2
 * object get 실행(실제 네트워크 I/O)은 `scripts/fixtureFromTrip.mjs`(얇은 I/O 셸) 책임이다
 * — `buildReplayFixture.mjs`(#2580)와 동일 분리 패턴.
 */
// `hashTripToken`은 `.ts` 확장자를 명시한다 — 이 파일은 `scripts/fixtureFromTrip.mjs`가
// Node 네이티브 type-stripping으로 직접 로드한다(vitest/webpack 같은 번들러 경유가 아님).
// Node ESM은 확장자 생략 relative import를 해석하지 못해(#2586 코드리뷰 — 실행 시
// ERR_MODULE_NOT_FOUND 확인), 이 체인에서만 명시 확장자가 필요하다
// (tsconfig `allowImportingTsExtensions` 참고).
import { hashTripToken } from '../../../src/shared/infra/monitoring/tripTokenHash.ts';

/** trip 시간창 앞뒤로 붙이는 여유(R2 capture 조회 시). 이슈 스펙 "±2분 margin". */
export const TRIP_WINDOW_MARGIN_MS = 2 * 60 * 1000;

/** `SELECT ts, kind, station, line, meta FROM trip_events WHERE token_hash = ?` 1행. */
export interface TripEventRow {
  ts: number;
  kind: string;
  station: string | null;
  line: string | null;
  meta: string | null;
}

export interface TripWindow {
  fromMs: number;
  toMs: number;
}

/** 실제 발사 시도(kind='cron-fire-attempt') 1건 요약 — 사람이 스켈레톤을 검증할 때 참고. */
export interface FireAttemptSummary {
  ts: number;
  station: string | null;
  line: string | null;
  outcome: string | null;
}

export type ResolveTokenHashError = 'missing_input' | 'conflicting_input' | 'invalid_token_hash';

/** `--token-hash` 형식 — `hashTripToken` 출력과 동일한 8자리 소문자 hex. */
export const TOKEN_HASH_PATTERN = /^[0-9a-f]{8}$/;

/**
 * `--trip <tripToken>` / `--token-hash <8hex>` 중 정확히 하나로 tokenHash를 산출한다.
 *
 * trip이 종료/삭제되면 KV에서 원본 토큰은 사라지고 D1 `trip_events`에는 `token_hash`만
 * 남는다 — 과거 trip을 fixture化하려면(이 도구의 존재 목적) hash 입력이 유일한 경로가
 * 된다. 이미 시간이 지난 trip(도구를 쓰는 전형적 상황)은 `--trip` 원본 토큰을 다시 구할
 * 방법이 없으므로 `--token-hash`를 1급 입력으로 지원한다.
 *
 * 둘 다 없거나(`missing_input`) 둘 다 있으면(`conflicting_input`) 에러. `--token-hash`
 * 값이 8자리 소문자 hex(`TOKEN_HASH_PATTERN`)가 아니면 `invalid_token_hash`.
 */
export function resolveTokenHash(
  tripToken: string | undefined,
  tokenHashArg: string | undefined,
): { tokenHash: string } | { error: ResolveTokenHashError } {
  if (tripToken !== undefined && tokenHashArg !== undefined) return { error: 'conflicting_input' };
  if (tripToken === undefined && tokenHashArg === undefined) return { error: 'missing_input' };
  if (tokenHashArg !== undefined) {
    if (!TOKEN_HASH_PATTERN.test(tokenHashArg)) return { error: 'invalid_token_hash' };
    return { tokenHash: tokenHashArg };
  }
  return { tokenHash: hashTripToken(tripToken as string) };
}

/**
 * tokenHash(D1 조회 키, trip_events는 원본 token을 저장하지 않는다) → SELECT SQL.
 * tokenHash는 `resolveTokenHash`가 검증한 8자 hex 문자열이라 그대로 SQL 리터럴에
 * 삽입해도 안전하다(사용자 입력 직삽입 아님).
 */
export function buildTripEventsQuery(tokenHash: string): string {
  return `SELECT ts, kind, station, line, meta FROM trip_events WHERE token_hash = '${tokenHash}' ORDER BY ts ASC`;
}

/**
 * `wrangler d1 execute --json` stdout → TripEventRow[]. D1 조회 실패(형식 불일치)와
 * 캡처 없음(빈 결과)을 각각 구분되는 메시지의 Error로 던진다(수락 기준 — 명확한 에러 메시지).
 */
export function parseTripEventsResponse(stdout: string, tokenHash: string): TripEventRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`D1 조회 실패: 응답 JSON 파싱 실패 (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('D1 조회 실패: 예상 형식(결과 배열)이 아닙니다 — wrangler d1 execute 출력 확인 필요');
  }
  const first = parsed[0];
  if (!first || typeof first !== 'object' || !Array.isArray((first as Record<string, unknown>).results)) {
    throw new Error('D1 조회 실패: 응답에 results 배열이 없습니다');
  }
  const results = (first as { results: unknown[] }).results;
  if (results.length === 0) {
    throw new Error(
      `trip_events에 해당 trip 이벤트가 없습니다 (tokenHash=${tokenHash}) — trip 토큰이 맞는지, 캡처가 존재하는 기간인지 확인 필요`,
    );
  }
  return results.map((row, index) => parseTripEventRow(row, index));
}

function parseTripEventRow(raw: unknown, index: number): TripEventRow {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`D1 조회 실패: trip_events row[${index}]가 object가 아닙니다`);
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.ts !== 'number') {
    throw new TypeError(`D1 조회 실패: trip_events row[${index}].ts가 number가 아닙니다`);
  }
  if (typeof o.kind !== 'string') {
    throw new TypeError(`D1 조회 실패: trip_events row[${index}].kind가 string이 아닙니다`);
  }
  return {
    ts: o.ts,
    kind: o.kind,
    station: typeof o.station === 'string' ? o.station : null,
    line: typeof o.line === 'string' ? o.line : null,
    meta: typeof o.meta === 'string' ? o.meta : null,
  };
}

/**
 * trip_events row들의 ts min/max ± margin → R2 seoul-capture 조회 시간창.
 * 대량 배열 스프레드 min/max는 RangeError 위험(`replayFixture.ts` computeWindow 리뷰와 동일
 * 이유)이라 순회로 계산한다.
 */
export function computeTripCaptureWindow(rows: TripEventRow[], marginMs: number = TRIP_WINDOW_MARGIN_MS): TripWindow {
  if (rows.length === 0) {
    throw new Error('trip_events가 비어 있어 시간창을 계산할 수 없습니다');
  }
  let minTs = rows[0].ts;
  let maxTs = rows[0].ts;
  for (const row of rows) {
    if (row.ts < minTs) minTs = row.ts;
    if (row.ts > maxTs) maxTs = row.ts;
  }
  return { fromMs: minTs - marginMs, toMs: maxTs + marginMs };
}

function utcDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** segment 역 목록 — station이 있는 row에서 첫 등장 순서로 dedup. */
export function extractSegmentStations(rows: TripEventRow[]): string[] {
  return dedupInOrder(rows.map((row) => row.station));
}

/** 관련 노선 목록 — line이 있는 row에서 첫 등장 순서로 dedup. */
export function extractLines(rows: TripEventRow[]): string[] {
  return dedupInOrder(rows.map((row) => row.line));
}

function dedupInOrder(values: (string | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value !== null && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/** 실제 fire 이력(kind='cron-fire-attempt') 요약 — registry 스켈레톤 검증 참고용. */
export function extractFireAttempts(rows: TripEventRow[]): FireAttemptSummary[] {
  return rows
    .filter((row) => row.kind === 'cron-fire-attempt')
    .map((row) => ({ ts: row.ts, station: row.station, line: row.line, outcome: parseOutcome(row.meta) }));
}

function parseOutcome(meta: string | null): string | null {
  if (!meta) return null;
  try {
    const parsedMeta = JSON.parse(meta) as Record<string, unknown>;
    return typeof parsedMeta.outcome === 'string' ? parsedMeta.outcome : null;
  } catch {
    return null;
  }
}

/**
 * `GET /admin/seoul-capture/keys`(#2595) 요청 시 시간창 하한을 앞당기는 여유. cycle이
 * window 시작 직전에 시작해도 그 cycle의 entry 일부가 window 안에 들어올 수 있어서다
 * (`buildReplayFixture`가 entry 단위로 다시 걸러내므로 여기서는 넉넉하게 요청하는 게
 * 안전, `scripts/fixtureFromTrip.mjs`가 `from` 계산에 사용).
 */
export const CAPTURE_KEY_PRE_ROLL_MS = 90_000;

/**
 * fixture 파일명 slug — `capture_<YYYYMMDD>T<HHmm>Z_<tokenHash>` (파일명·registry
 * entry.slug 공용). window 시작 시분(UTC)까지 포함하는 이유: 같은 UTC 날짜에 trip이 여러
 * 건이면 날짜+tokenHash만으로는 부족하지 않지만(tokenHash가 이미 trip을 구분), 사람이
 * 라이브러리를 훑을 때 같은 날짜의 여러 fixture를 시간순으로 식별하기 쉽게 하기 위함
 * (#2586 코드리뷰).
 */
export function buildFixtureSlug(tokenHash: string, window: TripWindow): string {
  const start = new Date(window.fromMs);
  const dateStr = utcDateKey(window.fromMs).replaceAll('-', '');
  const hh = String(start.getUTCHours()).padStart(2, '0');
  const mm = String(start.getUTCMinutes()).padStart(2, '0');
  return `capture_${dateStr}T${hh}${mm}Z_${tokenHash}`;
}

export interface RegistrySkeletonParams {
  slug: string;
  fixtureFileName: string;
  tokenHash: string;
  segmentStations: string[];
  lines: string[];
  isLossy: boolean;
}

/**
 * `src/__tests__/replayLibrary.ts`의 `REPLAY_LIBRARY` 배열에 붙여넣을 entry 텍스트
 * 스켈레톤(#2585 규약 — `ReplayLibraryEntry`). 사람이 등록 diff만 확인하면 되도록
 * `expect.firedStations`는 segment 역 전체로 채우고, `seedTrips`/`description`은 자동
 * 유추 불가 필드라 사람이 채워야 하는 후속 작업으로 남긴다(#2586 본문 참조). 실 캡처
 * fixture이므로 `cronIntervalMs`는 항상 `'recorded'`(합성 fixture 전용 균일 그리드 옵션은
 * 쓰지 않는다).
 */
export function buildRegistryEntrySkeleton(params: RegistrySkeletonParams): string {
  const firedStationsLiteral = JSON.stringify(params.segmentStations);
  const linesHint = params.lines.length > 0 ? params.lines.join(', ') : '(미확인)';
  const lossyLine = params.isLossy
    ? "\n    allowLossy: true, // fixtureFromTrip: 캡처 유실 신호(droppedEntries/failedCycleStartsMs) 감지 — 검토 필요"
    : '';
  return `{
    slug: '${params.slug}',
    fixturePath: '${params.fixtureFileName}',
    description: 'tokenHash=${params.tokenHash} — TODO: 원 이슈/사건 번호로 교체',
    seedTrips: () => [
      // TODO: 이 trip의 실제 seed 상태를 채운다 (lock 여부, waypoints, currentLegAnchor 등).
      // 노선: ${linesHint}
    ],
    cronIntervalMs: 'recorded',
    loadFixture: makeFixtureLoader('${params.fixtureFileName}'), // TODO: 파일 상단에 로더 선언 추가
    expect: {
      firedStations: ${firedStationsLiteral}, // TODO: 실제 fire 이력과 대조해 검증/축소
    },${lossyLine}
  },`;
}

/**
 * `.env` 파일 텍스트에서 `KEY=value` 한 줄의 값을 추출한다(dotenv 의미론의 최소 부분집합 —
 * 이 도구가 필요로 하는 단일 키 조회만 지원, 멀티라인 값/변수 확장 등은 다루지 않는다).
 * `scripts/fixtureFromTrip.mjs`의 `ADMIN_TOKEN` fallback 조회가 사용한다(#2586 코드리뷰 —
 * ad-hoc 인라인 파서를 ts 층으로 이동 + 단위테스트).
 *
 * - `#`로 시작하는 줄 전체는 주석으로 무시한다.
 * - 값이 작은따옴표(`'`)/큰따옴표(`"`)/백틱(`` ` ``)으로 양끝을 감싸면 그 따옴표를 벗기고,
 *   따옴표 안 내용은 `#`가 있어도 그대로 보존한다(dotenv 의미론 — 따옴표 안은 리터럴).
 * - 따옴표가 없으면 값에서 첫 `#` 이후를 인라인 주석으로 잘라내고 trim한다.
 * - key가 여러 줄에 있으면 처음 매칭되는 값을 반환한다(dotenv와 동일 — 나중 값이 앞선 값을
 *   덮어쓰지 않는다는 의미가 아니라 단순 첫 매치 우선 조회).
 */
export function parseEnvValue(envFileContent: string, key: string): string | undefined {
  const lines = envFileContent.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;
    const lineKey = line.slice(0, eqIndex).trim();
    if (lineKey !== key) continue;
    return stripEnvValue(line.slice(eqIndex + 1).trim());
  }
  return undefined;
}

function stripEnvValue(rawValue: string): string {
  if (rawValue.length >= 2) {
    const first = rawValue[0];
    const last = rawValue[rawValue.length - 1];
    if ((first === '"' || first === "'" || first === '`') && first === last) {
      return rawValue.slice(1, -1);
    }
  }
  const hashIndex = rawValue.indexOf('#');
  const withoutComment = hashIndex === -1 ? rawValue : rawValue.slice(0, hashIndex);
  return withoutComment.trim();
}
