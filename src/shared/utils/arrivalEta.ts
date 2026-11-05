/**
 * 도착 ETA "모름(unknown)" 도메인 규칙 (#3132).
 *
 * 코레일 운영 노선(1·경의중앙·공항철도·분당 등)은 서울 실시간 API가 남은 시간을 모를 때
 * `barvlDt=0`을 내려준다 — 진짜 0초와 구분되지 않는다. 이를 `Math.max(0, …)`로 0초에 접으면
 * 화면에 00:00, 지연 계산·LA 즉시트리거 오염이 생긴다. 모름은 `arrivalSeconds=null`로 표현하고
 * (타입이 모든 소비자의 분기를 강제), 대신 피드가 주는 위치 문구(`arvlMsg2`/`arvlMsg3`)를 보여준다.
 *
 * 서울교통공사 노선은 실측상 `barvlDt=0`이 `arvlCd=1`(도착)에서만 나온다(3,318행 중 56행) →
 * 이 규칙은 서울교통공사 행을 바꾸지 않는다.
 */
import i18next from 'i18next';
import { ARRIVAL_CODE } from '../constants/arrivalCodes';
import type { ArrivalInfo } from '../types/arrival';

/** `[N]번째 전역 (역명)` — 그룹1 = N, 그룹2 = 역명(없을 수 있음). */
export const BRACKET_STOPS_AWAY_RE = /\[(\d+)\]번째 전역(?:\s*\(([^)]*)\))?/;

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

const KOREAN_LANGUAGE_PREFIX = 'ko';

/** stopsAway도 모르는 행을 맨 뒤로 보내는 정렬 키 (Infinity - Infinity = NaN 회피). */
const UNKNOWN_STOPS_AWAY_SORT_KEY = Number.MAX_SAFE_INTEGER;

/**
 * P3 — `barvlDt<=0 && arvlCd ∉ {0,1,2}`. NaN/음수/누락(→NaN) barvlDt도 unknown.
 * 잘못 unknown으로 분류해도 원문 문구는 여전히 정확하지만(카운트다운만 잃음), 잘못 known(0)으로
 * 두면 틀린 00:00이 뜨므로 비대칭 비용 기준으로 unknown 쪽에 둔다.
 */
export function isEtaUnknownRow(barvlDt: number, arrivalCode: number): boolean {
  return !(barvlDt > 0) && !GENUINE_ZERO_ARRIVAL_CODES.includes(arrivalCode);
}

/**
 * 몇 역 전인지. `[N]번째 전역`의 N, 없으면 unknown 행의 arvlCd 3/4/5 → 1, 그 외 null.
 * 초로 환산하지 않는다 — N은 stations.json hop과 일치하지 않고 역명도 해석 불가한 경우가 있다.
 */
export function parseStopsAway(
  statusMessage: string,
  arrivalCode: number,
  etaUnknown: boolean,
): number | null {
  const match = BRACKET_STOPS_AWAY_RE.exec(statusMessage);
  if (match) return Number(match[1]);
  if (etaUnknown && ADJACENT_STATION_ARRIVAL_CODES.includes(arrivalCode)) return 1;
  return null;
}

/** ETA 초가 있는 행 — `arrivalSeconds: number`로 좁혀진 타입. */
export type KnownEtaRow<T extends { arrivalSeconds: number | null }> = T & { arrivalSeconds: number };

/** ETA 초가 있는 행인지 (0도 known). 타입 가드. */
export function hasKnownEta<T extends { arrivalSeconds: number | null }>(row: T): row is KnownEtaRow<T> {
  return row.arrivalSeconds !== null;
}

/**
 * 표시 순서: 초 있는 행(호출자가 준 순서 유지) → stopsAway 오름차순 → stopsAway도 모르는 행 맨 뒤.
 * 어떤 행도 제외하지 않는다. unknown이 없으면 입력 순서 그대로(서울교통공사 표시 불변).
 */
export function orderKnownEtaFirst<T extends Pick<ArrivalInfo, 'arrivalSeconds' | 'stopsAway'>>(
  rows: readonly T[],
): T[] {
  const known = rows.filter(hasKnownEta);
  const unknown = rows
    .filter((row) => !hasKnownEta(row))
    .sort(
      (a, b) =>
        (a.stopsAway ?? UNKNOWN_STOPS_AWAY_SORT_KEY) - (b.stopsAway ?? UNKNOWN_STOPS_AWAY_SORT_KEY),
    );
  return [...known, ...unknown];
}

export interface ArrivalEtaPosition {
  /** 큰 글씨 — "3번째 전역" / "전역 도착" / "3 stops away". */
  primary: string;
  /** 작은 글씨 — 역명. 모르면 생략. */
  secondary?: string;
}

/**
 * unknown 행의 위치 문구. ko = 피드 원문(`[N]번째 전역`만 "N번째 전역"으로 정리), en/ja/zh = stopsAway i18n.
 * stopsAway를 몰라 번역 불가하면 피드 원문으로 degrade(빈 칸 금지).
 */
export function formatArrivalEtaPosition(
  row: Pick<ArrivalInfo, 'statusMessage' | 'stopsAway' | 'locationStation'>,
): ArrivalEtaPosition {
  const { statusMessage, stopsAway, locationStation } = row;
  const secondary = BRACKET_STOPS_AWAY_RE.exec(statusMessage)?.[2] || locationStation || undefined;
  const isKorean = i18next.language.startsWith(KOREAN_LANGUAGE_PREFIX);
  const hasBracket = BRACKET_STOPS_AWAY_RE.test(statusMessage);
  const translate = stopsAway != null && (!isKorean || hasBracket);
  const primary = translate ? i18next.t('arrival.stopsAway', { count: stopsAway }) : statusMessage;
  return secondary === undefined ? { primary } : { primary, secondary };
}

/** arvlCd 0/1/2 → 홈 카드 상태 라벨 i18n 키. 데이터 주도 — 코드 추가는 이 표만 고친다. */
const ARRIVAL_STATUS_LABEL_KEY: Readonly<
  Record<number, 'arrival.statusEntering' | 'arrival.statusArrived' | 'arrival.statusDeparted'>
> = {
  [ARRIVAL_CODE.ENTERING]: 'arrival.statusEntering',
  [ARRIVAL_CODE.ARRIVED]: 'arrival.statusArrived',
  [ARRIVAL_CODE.DEPARTED]: 'arrival.statusDeparted',
};

/**
 * 진입/도착/출발(arvlCd 0/1/2) 행의 상태 라벨. barvlDt 는 보지 않는다 — 코레일은 0, 서울교통공사는
 * 고정값(60/10/120)이라 카운트다운이 의미 없다. secondary(역명) 는 일부러 생략: 진입 행의 arvlMsg3 가
 * 직전 역을 가리킬 수 있어 "진입 / 제기동"처럼 잘못 읽힌다.
 */
export function formatArrivalStatusLabel(arrivalCode: number): ArrivalEtaPosition | null {
  const key = ARRIVAL_STATUS_LABEL_KEY[arrivalCode];
  return key === undefined ? null : { primary: i18next.t(key) };
}

/** DebugModal 한 줄 표기 — known "120s", unknown "?s (3 stops)" / "?s". V/X: unknown 비율을 눈으로 확인. */
export function formatDebugEta(row: Pick<ArrivalInfo, 'arrivalSeconds' | 'stopsAway'>): string {
  const { arrivalSeconds, stopsAway } = row;
  if (arrivalSeconds !== null) return `${Math.round(arrivalSeconds)}s`;
  return stopsAway == null ? '?s' : `?s (${stopsAway} stops)`;
}
