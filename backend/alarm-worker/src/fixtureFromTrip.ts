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

/** trip_events 1건 — `segmentTripEvents`가 나눈 세그먼트 1개(오래된 trip 순서 보존). */
export interface TripSegment {
  rows: TripEventRow[];
}

/**
 * 인접 row 간 시간 간격이 이 값을 넘으면 `trip-end` 마커가 없어도 새 세그먼트로 분리한다
 * (#2598 리뷰 — trip-end 기록 자체가 누락된 trip이 다음 trip과 한 세그먼트로 병합되는 결함
 * 수리). 30분은 지하철 편도 trip이 통상 그 안에 끝난다는 전제의 보수적 임계값 — 실제
 * 최장 편도 trip(환승 포함)도 크게 못 미친다.
 */
export const TRIP_GAP_MS = 30 * 60 * 1000;

/**
 * token_hash 전체 조회 결과(ts asc, 여러 trip 혼재)를 세그먼트로 분리한다(#2598 결함1 —
 * token_hash는 디바이스 수명 단위라 D1 조회가 과거 trip들을 전부 포함해 window/segment
 * 역이 오염됨). 두 기준으로 분리한다:
 *
 * 1. `kind === 'trip-end'` 마커 — 그 row를 끝맺는 세그먼트에 포함시키고 그 지점에서 닫는다.
 * 2. 인접 row 간격이 `TRIP_GAP_MS`를 넘으면 — trip-end가 기록되지 못한 채(앱 kill/push
 *    drop 등) 종료된 trip과 다음 trip이 한 세그먼트로 병합되는 것을 막는다.
 *
 * 마지막 trip-end 이후 남은 row(아직 종료 마커가 D1에 적재되지 않은 진행 중 trip 포함)는
 * 별도 세그먼트로 남긴다. 반환 배열은 오래된 trip이 먼저(index 0) 오는 순서.
 */
export function segmentTripEvents(rows: TripEventRow[]): TripSegment[] {
  const segments: TripSegment[] = [];
  let current: TripEventRow[] = [];
  for (const row of rows) {
    const previous = current[current.length - 1];
    if (previous !== undefined && row.ts - previous.ts > TRIP_GAP_MS) {
      segments.push({ rows: current });
      current = [];
    }
    current.push(row);
    if (row.kind === 'trip-end') {
      segments.push({ rows: current });
      current = [];
    }
  }
  if (current.length > 0) {
    segments.push({ rows: current });
  }
  return segments;
}

/** `isSignificantTripSegment` 판정 기준 — trip-end 마커 자체는 세지 않는다(그것만 있으면 실질 이벤트 0건). */
export const MEANINGFUL_ROW_MIN_COUNT = 2;

/**
 * `trip-end`가 아닌 row가 `MEANINGFUL_ROW_MIN_COUNT`개 이상인 세그먼트만 "실제 trip"으로
 * 취급한다(#2598 리뷰 — 잔여 row 1~2개짜리 파편 세그먼트가 "최신 trip"으로 잘못 선택되는
 * 결함 수리).
 */
export function isSignificantTripSegment(segment: TripSegment): boolean {
  const meaningfulRowCount = segment.rows.filter((row) => row.kind !== 'trip-end').length;
  return meaningfulRowCount >= MEANINGFUL_ROW_MIN_COUNT;
}

export interface TripSegmentSummary {
  rowCount: number;
  fromMs: number;
  toMs: number;
  significant: boolean;
  terminated: boolean;
}

/**
 * `segmentTripEvents` 결과를 사람이 읽을 CLI 요약으로 변환한다(#2598 리뷰 — 사용자가
 * `--trip-index`를 판단할 수 있도록 세그먼트 목록을 노출). 각 세그먼트는 항상 row가
 * 1개 이상이라 `rows[0]`/`rows[rows.length - 1]` 접근이 안전하다(`segmentTripEvents`가
 * 빈 세그먼트를 만들지 않음).
 */
export function describeSegments(segments: TripSegment[]): TripSegmentSummary[] {
  return segments.map((segment) => {
    const { rows } = segment;
    const first = rows[0];
    const last = rows[rows.length - 1];
    return {
      rowCount: rows.length,
      fromMs: first.ts,
      toMs: last.ts,
      significant: isSignificantTripSegment(segment),
      terminated: last.kind === 'trip-end',
    };
  });
}

export type SelectTripSegmentError = 'trip_index_out_of_range';

/**
 * `segmentTripEvents` 결과(오래된 순) + `--trip-index`(뒤에서부터, 0=최신)로 세그먼트
 * 1개를 선택한다. 사용자가 명시적으로 index를 지정한 경로 전용 — significance 필터 없이
 * 전체 세그먼트를 그대로 센다(사용자가 `describeSegments` 출력을 보고 직접 골랐다는 전제).
 * `tripIndexFromEnd`는 호출 전에 0 이상 정수임이 보장된다(스크립트 인자 파싱 단계에서
 * 검증) — 그 전제하에 `index`는 항상 `segments.length - 1` 이하이므로 상한 초과 분기는
 * 존재하지 않는다(#2598 리뷰 — 도달 불가 분기 제거).
 */
export function selectTripSegment(
  segments: TripSegment[],
  tripIndexFromEnd: number,
): { segment: TripSegment } | { error: SelectTripSegmentError } {
  const index = segments.length - 1 - tripIndexFromEnd;
  if (tripIndexFromEnd < 0 || index < 0) {
    return { error: 'trip_index_out_of_range' };
  }
  return { segment: segments[index] };
}

export type SelectDefaultTripSegmentError = 'no_significant_segment';

/**
 * `--trip-index` 미지정 시(기본 선택) 사용 — 가장 최근 세그먼트부터 역순으로 훑어
 * `isSignificantTripSegment`가 true인 첫 세그먼트를 반환한다(#2598 리뷰 — trip-end만
 * 남은 파편 잔여 세그먼트가 최신 trip으로 잘못 선택되는 결함 수리). 전 세그먼트가
 * insignificant면 `no_significant_segment`.
 */
export function selectDefaultTripSegment(
  segments: TripSegment[],
): { segment: TripSegment } | { error: SelectDefaultTripSegmentError } {
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (isSignificantTripSegment(segments[i])) {
      return { segment: segments[i] };
    }
  }
  return { error: 'no_significant_segment' };
}

function utcDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * raw station 코드(`2-010`/`7-015` 형식) 패턴 — 역명이 아니라서 `extractSegmentStations`가
 * 제외 대상 후보로 쓴다(#2598 결함2, 2차 가드 — 1차 규칙은 `kind==='trip-end'` 제외 참고).
 */
const STATION_CODE_PATTERN = /^\d+-\d+$/;

export interface SegmentStationsResult {
  stations: string[];
  /**
   * `trip-end`가 아닌 row인데 station 필드가 코드 패턴이었던 건수(#2598 리뷰 — writer-side
   * root: `trip-end`만이 destination station ID를 station 컬럼에 기록하는 것으로 파악됐으나,
   * 다른 kind에서도 코드 패턴이 나타나면 그 전제가 깨진 것 — 후속 조사가 필요한 신호라
   * 조용히 걸러내지 않고 카운트로 노출한다).
   */
  suspiciousCodeRowCount: number;
}

/**
 * segment 역 목록 — station이 있는 row에서 첫 등장 순서로 dedup.
 *
 * 1차 규칙(#2598 리뷰): `kind === 'trip-end'` row를 역명 후보에서 제외한다 — station
 * 컬럼에 raw 코드(`2-010` 등, destination station ID)를 기록하는 유일한 writer가 trip-end
 * 경로(`liveActivity.ts`)이기 때문. 근본 원인은 writer 쪽(destination ID를 station 컬럼에
 * 잘못 기록)이라 별도 후속 수리가 필요 — 본 PR은 소비 측 필터만 수리한다.
 * 2차 가드: 그 외 kind인데도 코드 패턴인 row는 여전히 제외하되(`STATION_CODE_PATTERN`),
 * 전제가 깨졌다는 신호이므로 `suspiciousCodeRowCount`로 건수를 보고한다.
 */
export function extractSegmentStations(rows: TripEventRow[]): SegmentStationsResult {
  let suspiciousCodeRowCount = 0;
  const stations = rows.map((row) => {
    if (row.kind === 'trip-end') return null;
    if (row.station !== null && STATION_CODE_PATTERN.test(row.station)) {
      suspiciousCodeRowCount += 1;
      return null;
    }
    return row.station;
  });
  return { stations: dedupInOrder(stations), suspiciousCodeRowCount };
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
