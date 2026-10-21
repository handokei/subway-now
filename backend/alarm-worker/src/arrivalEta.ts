/**
 * 도착 ETA "모름(unknown)" 도메인 규칙 (#3132) — device `src/shared/utils/arrivalEta.ts`의 backend 카피.
 *
 * 코레일 운영 노선(1·경의중앙·공항철도·분당 등)은 서울 실시간 API가 남은 시간을 모를 때 `barvlDt=0`을
 * 내려준다 — 진짜 0초와 구분되지 않는다. 이를 `Math.max(0, …)`로 0초에 접으면 LA 즉시 트리거·ETA 갱신·
 * 표시 ETA가 "곧 도착"으로 오염된다. 모름은 `ArrivalEntry.arrivalSeconds=null`로 표현해(타입이 모든
 * 소비자의 분기를 강제) 지어낸 시각이 어디로도 흘러가지 않게 한다.
 *
 * 서울교통공사 노선은 실측상 `barvlDt=0`이 `arvlCd=1`(도착)에서만 나온다(3,318행 중 56행, arvlCd
 * 3/4/5/99 + 0 은 0건) → 이 규칙은 서울교통공사 행을 바꾸지 않는다.
 *
 * device와 backend 두 파서의 drift는 같은 실측 fixture(`korail_20261021`)를 양쪽 replay 테스트가
 * 같은 기대값으로 읽어 차단한다.
 */
import { ARRIVAL_CODE } from './alarm';

/** `[N]번째 전역 (역명)` — 그룹1 = N. */
const BRACKET_STOPS_AWAY_RE = /\[(\d+)\]번째 전역/;

/** barvlDt=0 이 "진짜 0초"인 arvlCd — 진입/도착/출발. 그 외 코드의 0은 시간 모름. */
const GENUINE_ZERO_ARRIVAL_CODES: readonly number[] = [
  ARRIVAL_CODE.ENTERING,
  ARRIVAL_CODE.ARRIVED,
  ARRIVAL_CODE.DEPARTED,
];

/** 전역 출발/진입/도착 — 문구에 N이 없어도 "직전 역 근처"(=1역 전)를 뜻하는 코드. */
const ADJACENT_STATION_ARRIVAL_CODES: readonly number[] = [
  ARRIVAL_CODE.PREV_DEPARTED,
  ARRIVAL_CODE.PREV_ENTERING,
  ARRIVAL_CODE.PREV_ARRIVED,
];

/** stopsAway도 모르는 행을 맨 뒤로 보내는 정렬 키 (Infinity - Infinity = NaN 회피). */
const UNKNOWN_STOPS_AWAY_SORT_KEY = Number.MAX_SAFE_INTEGER;

/**
 * P3 — `barvlDt<=0 && arvlCd ∉ {0,1,2}`. NaN/음수/누락(→NaN) barvlDt, arvlCd 누락(null)도 unknown.
 * 잘못 unknown으로 분류해도 원문은 여전히 정확하지만(카운트다운만 잃음), 잘못 known(0)으로 두면
 * 틀린 "곧 도착"이 나가므로 비대칭 비용 기준으로 unknown 쪽에 둔다.
 */
export function isEtaUnknownRow(barvlDt: number, arvlCd: number | null): boolean {
  return !(barvlDt > 0) && (arvlCd === null || !GENUINE_ZERO_ARRIVAL_CODES.includes(arvlCd));
}

/**
 * 몇 역 전인지. `[N]번째 전역`의 N, 없으면 unknown 행의 arvlCd 3/4/5 → 1, 그 외 null.
 * 초로 환산하지 않는다 — N은 stations.json hop과 일치하지 않고 역명도 해석 불가한 경우가 있다.
 */
export function parseStopsAway(
  statusMessage: string,
  arvlCd: number | null,
  etaUnknown: boolean,
): number | null {
  const match = BRACKET_STOPS_AWAY_RE.exec(statusMessage);
  if (match) return Number(match[1]);
  if (etaUnknown && arvlCd !== null && ADJACENT_STATION_ARRIVAL_CODES.includes(arvlCd)) return 1;
  return null;
}

/** ETA 초가 있는 행인지 (0도 known). 타입 가드. */
export function hasKnownEta<T extends { arrivalSeconds: number | null }>(
  row: T,
): row is T & { arrivalSeconds: number } {
  return row.arrivalSeconds !== null;
}

/** known 행 중 최소 ETA(초). 전부 unknown(또는 빈 pool)이면 null — 0으로 접지 않는다. */
export function minKnownEtaSeconds(pool: readonly { arrivalSeconds: number | null }[]): number | null {
  const known = pool.filter(hasKnownEta);
  return known.length === 0 ? null : Math.min(...known.map((row) => row.arrivalSeconds));
}

/**
 * 정렬 비교기: 초 있는 행(오름차순) → stopsAway 오름차순 → stopsAway도 모르는 행 맨 뒤.
 * 어떤 행도 제외하지 않는다. `Array.prototype.sort`는 안정 정렬이라 동률은 입력 순서를 유지한다.
 */
export function compareEtaUnknownLast(
  a: { arrivalSeconds: number | null; stopsAway?: number | null },
  b: { arrivalSeconds: number | null; stopsAway?: number | null },
): number {
  if (a.arrivalSeconds !== null && b.arrivalSeconds !== null) return a.arrivalSeconds - b.arrivalSeconds;
  if (a.arrivalSeconds !== null) return -1;
  if (b.arrivalSeconds !== null) return 1;
  return (a.stopsAway ?? UNKNOWN_STOPS_AWAY_SORT_KEY) - (b.stopsAway ?? UNKNOWN_STOPS_AWAY_SORT_KEY);
}
