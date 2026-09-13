/**
 * trip 토큰 1개 → replay fixture 후보 자동 생성 로직 (Epic #2239 P1, #2586).
 *
 * "매 가설마다 라이드/로그" 루프의 마지막 조각 — D1 `trip_events`(read-only 소비, 스키마
 * 변경 없음)로 실 trip의 시간창·노선·segment 역 목록·fire 이력을 뽑아내고, 그 시간창으로
 * R2 seoul-capture를 병합해(`buildReplayFixture`, #2580) 라이브러리 후보 fixture +
 * registry 엔트리 스켈레톤을 만든다.
 *
 * D1 SQL 문자열 생성 + wrangler/D1 응답 파싱 + registry 스켈레톤 직렬화 — 순수 함수만
 * 둔다. wrangler d1 execute / aws s3api / wrangler r2 object get 실행(실제 네트워크 I/O)은
 * `scripts/fixtureFromTrip.mjs`(얇은 I/O 셸) 책임이다 — `buildReplayFixture.mjs`(#2580)와
 * 동일 분리 패턴.
 */
// `hashTripToken`은 `.ts` 확장자를 명시한다 — 이 파일은 `scripts/fixtureFromTrip.mjs`가
// Node 네이티브 type-stripping으로 직접 로드한다(vitest/webpack 같은 번들러 경유가 아님).
// Node ESM은 확장자 생략 relative import를 해석하지 못해(#2586 코드리뷰 — 실행 시
// ERR_MODULE_NOT_FOUND 확인), 이 체인에서만 명시 확장자가 필요하다
// (tsconfig `allowImportingTsExtensions` 참고).
import { hashTripToken } from '../../../src/shared/infra/monitoring/tripTokenHash.ts';

/**
 * R2 key prefix — `seoulCapture.ts`의 `SEOUL_CAPTURE_KEY_PREFIX`와 값이 반드시 같아야
 * 한다(테스트로 SSoT 일치를 고정). 그 값을 직접 import하지 않는 이유: `seoulCapture.ts`는
 * `./seoul`(값 import, extensionless)로 이어지는 프로덕션 런타임 체인을 갖고 있어, 이
 * leaf 모듈이 그 체인 전체를 Node 네이티브 로더로 끌고 들어오게 된다(#2586 코드리뷰 —
 * leaf-safe 구조). 이 파일은 순수 문자열 상수 하나만 필요하므로 재선언이 더 안전하다.
 */
export const SEOUL_CAPTURE_KEY_PREFIX = 'seoul-capture/';

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

/**
 * tripToken → tokenHash(D1 조회 키, trip_events는 원본 token을 저장하지 않는다) + SELECT SQL.
 * tokenHash는 `hashTripToken`이 생성하는 8자 hex 문자열이라 그대로 SQL 리터럴에 삽입해도
 * 안전하다(사용자 입력 직삽입 아님).
 */
export function buildTripEventsQuery(tripToken: string): { tokenHash: string; sql: string } {
  const tokenHash = hashTripToken(tripToken);
  const sql = `SELECT ts, kind, station, line, meta FROM trip_events WHERE token_hash = '${tokenHash}' ORDER BY ts ASC`;
  return { tokenHash, sql };
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

/**
 * window가 걸치는 UTC 날짜(YYYY-MM-DD) 목록, 오름차순 — R2 `seoul-capture/{date}/` prefix
 * 나열에 쓴다(`seoulCapture.ts`의 `buildSeoulCaptureKey`와 동일 UTC 날짜 규약).
 */
export function computeCaptureDates(window: TripWindow): string[] {
  const oneDayMs = 24 * 60 * 60 * 1000;
  const startDay = Date.parse(`${utcDateKey(window.fromMs)}T00:00:00.000Z`);
  const endDay = Date.parse(`${utcDateKey(window.toMs)}T00:00:00.000Z`);
  const dates: string[] = [];
  for (let cursor = startDay; cursor <= endDay; cursor += oneDayMs) {
    dates.push(utcDateKey(cursor));
  }
  return dates;
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
 * R2 캡처 키(basename=`<cycleStartMs>.json`)를 다운로드 전에 시간창으로 사전 필터한다.
 * 날짜 prefix 전체(~1440개/일)를 무조건 받으면 Free plan quota를 불필요하게 소진한다
 * (#2073 lesson). `preRollMs`만큼 하한을 앞당기는 이유는 cycle이 window 시작 직전에
 * 시작해도 그 cycle의 entry 일부가 window 안에 들어올 수 있어서다(`buildReplayFixture`가
 * entry 단위로 다시 걸러내므로 여기서는 넉넉하게 통과시키는 게 안전).
 */
export const CAPTURE_KEY_PRE_ROLL_MS = 90_000;

export function filterCaptureKeysInWindow(
  keys: string[],
  window: TripWindow,
  preRollMs: number = CAPTURE_KEY_PRE_ROLL_MS,
): string[] {
  const lowerBound = window.fromMs - preRollMs;
  return keys.filter((key) => {
    const base = key.slice(key.lastIndexOf('/') + 1).replace('.json', '');
    const cycleStartMs = Number(base);
    return Number.isFinite(cycleStartMs) && cycleStartMs >= lowerBound && cycleStartMs <= window.toMs;
  });
}

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
