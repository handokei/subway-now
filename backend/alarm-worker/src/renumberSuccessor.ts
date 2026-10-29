/**
 * #3158 — 2호선 성수 열차 번호 변경(renumber) 시 lock을 시간표 후속으로 재부착하는 순수 판정.
 *
 * 한 물리 열차가 성수에서 종착(예: 3009 "성수")하고 다음 번호(3045 "성수종착")로 이어진다. 후속은
 * OA-22750 열차시간표에서 "성수 시발마다 직전 미배정 종착"으로 결정된다 — 오프라인 빌드
 * (`scripts/build-renumber-successors.js`) 산출물 `data/line2RenumberSuccessors.json`을 읽는다
 * (리서치 tasks/research-2026-10-21-seoul-shtrmpath.md §1: 관측 9/9 일치, 모호 2건 해소).
 *
 * 본 모듈은 I/O 없음 — 호출자(`scheduled.ts` `attemptTimetableSuccessorReattach`)가 피드·trip을 공급하고
 * 결과를 반영한다. **후속이 라이브 피드에서 같은 노선·leg 방향·성수 인접 역에서 관측될 때만** 재부착을 허용한다
 * (미관측이면 기존 vanish-swap 불변 — 시간표는 후보를 "확정"하는 근거이지 "예측으로 lock을 옮기는" 근거가 아니다).
 *
 * 시각(시간창)은 판별에 쓰지 않는다 — 저녁 실측은 시간표 대비 +8~+16분 어긋난다(10/28 3286->3324 +14분, 아침은 +-2분).
 * 시간표 키는 항목이 1개뿐이라 시각 없이도 후속이 유일하고, 대신 게이트 4종으로 오발을 막는다:
 *  G1 성수 leg / G2 lock 열차 시간표 방향 == leg 방향 / G3 후속이 성수·leg 방향 다음 역에서 관측 / G4 leg당 1회.
 *
 * 한계(추정): 평일/주말만 구분(공휴일은 주말 시간표를 쓰지 않음 = 평일 취급), 시간표 기준일 고정
 * (`meta.timetableBaseDate`), 임시시간표 미반영. 어긋나면 후속이 미관측이라 기존 동작으로 수렴한다.
 */

import successorData from './data/line2RenumberSuccessors.json';
import { inferLegDirection, nextStationInDirection } from './legDirection';
import { resolveLegOriginStation } from './lockSwap';
import type { PositionEntry } from './seoul';
import type { LineNumber, Trip } from './types';

type DayTypeKey = 'weekday' | 'weekend';
/** JSON 엔트리 튜플 — `meta.entryFields` = [next, dir, endSec, startSec]. */
type SuccessorEntry = readonly [string, string, number, number];
interface SuccessorData {
  meta: { line: string; renumberStation: string; timetableBaseDate: string };
  tables: Record<DayTypeKey, Record<string, readonly SuccessorEntry[]>>;
}

const DATA = successorData as unknown as SuccessorData;

/** 후속표가 커버하는 노선 — 그 외 노선은 조회 자체를 하지 않는다. */
export const RENUMBER_LINE: LineNumber = DATA.meta.line;
/** 번호가 바뀌는 역(종착 역명 매칭 기준). */
export const RENUMBER_STATION = DATA.meta.renumberStation;
export const RENUMBER_TIMETABLE_BASE_DATE = DATA.meta.timetableBaseDate;

/** 후속 관측 행의 최대 수신 경과(ms) — 오래된 행으로 재부착하지 않는다. */
export const RENUMBER_OBSERVATION_MAX_AGE_MS = 5 * 60 * 1000;
/** vanish-swap이 먼저 옮긴 lock을 시간표 후속으로 정정할 수 있는 기간(ms). */
export const RENUMBER_ARM_TTL_MS = 15 * 60 * 1000;

/** 실시간 열차번호 prefix — (2|3)ddd <-> 시간표 2ddd (끝 3자리 보존, 후속도 같은 prefix). */
const REALTIME_TRAIN_NO = /^([23])(\d{3})$/;
/** 시간표 방향 표기 -> 피드 `isUp`. 2호선 내선=상행. */
const DIRECTION_IS_UP: Readonly<Record<string, boolean>> = { 내선: true, 외선: false };
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKEND_DAYS_OF_WEEK: readonly number[] = [0, 6];

/** vanish-swap이 옮긴 lock을 되돌릴 수 있도록 trip에 남기는 표식(`Trip.renumberSuccessor`). */
export interface RenumberArm {
  /** 원래 lock 열차(시간표 키 조회 대상). */
  from: string;
  /** vanish-swap이 옮겨 간 열차 — 이 값과 같은 lock일 때만 정정(그 사이 사용자 탭 등으로 바뀌면 불간섭). */
  swappedTo: string;
  armedAt: number;
}

export interface RenumberSuccessor {
  fromCode: string;
  successorCode: string;
  isUp: boolean;
  dayType: DayTypeKey;
}

export function kstDayType(nowMs: number): DayTypeKey {
  const dow = new Date(nowMs + KST_OFFSET_MS).getUTCDay();
  return WEEKEND_DAYS_OF_WEEK.includes(dow) ? 'weekend' : 'weekday';
}

/** 시간표에서 `trainCode`(실시간 번호)의 후속을 조회한다. 노선·번호 형식·시간표 항목이 없으면 null. 시각은 요일 구분에만 쓴다. */
export function lookupRenumberSuccessor(
  line: LineNumber,
  trainCode: string,
  nowMs: number,
): RenumberSuccessor | null {
  if (line !== RENUMBER_LINE) return null;
  const match = REALTIME_TRAIN_NO.exec(trainCode);
  if (!match) return null;
  const [, prefix, key] = match;
  const dayType = kstDayType(nowMs);
  const entries = DATA.tables[dayType][key];
  if (!entries) return null;
  // 키당 항목 1개(평일 448·주말 373키 전수, 테스트가 불변식으로 강제) — 시각 없이도 후속이 유일하다.
  const [next, dir] = entries[0];
  const isUp = DIRECTION_IS_UP[dir];
  if (isUp === undefined) return null;
  return { fromCode: trainCode, successorCode: `${prefix}${next}`, isUp, dayType };
}

export type RenumberReattachRejection =
  | 'not-renumber-line'
  | 'no-table-entry'
  | 'no-fresh-feed'
  | 'direction-mismatch'
  | 'lock-train-still-running'
  | 'successor-not-adjacent'
  | 'successor-not-observed';

export type RenumberReattachDecision =
  | { ok: true; fromCode: string; successorCode: string; dayType: DayTypeKey }
  | { ok: false; reason: RenumberReattachRejection };

export interface RenumberReattachInput {
  lockLine: LineNumber;
  lockTrainCode: string;
  arm: RenumberArm | undefined;
  /** 신선도 게이트를 통과한 해당 노선 position 스냅샷(부재/stale이면 null). */
  positions: readonly PositionEntry[] | null;
  nowMs: number;
  /** lock이 달린 leg의 진행 방향(`legDirectionOf`). 미상(null)이면 fail-closed. */
  legDirection: LegDirection | null;
}

/** 조회 대상 원 열차 — vanish-swap이 옮긴 lock이면 표식의 `from`, 아니면 현재 lock. */
export function resolveRenumberOrigin(
  lockTrainCode: string,
  arm: RenumberArm | undefined,
  nowMs: number,
): string {
  const armed = arm !== undefined && arm.swappedTo === lockTrainCode && nowMs - arm.armedAt <= RENUMBER_ARM_TTL_MS;
  return armed ? arm.from : lockTrainCode;
}

/**
 * 시간표 후속 재부착 가능 여부. 전부 AND:
 *  1) 후속표 노선 2) 시간표 항목(요일) 3) 후속 시간표 방향 == leg 방향(G2) 4) 신선한 피드
 *  5) lock 열차가 소멸했거나 성수 종착으로 표시 6) 후속이 같은 노선(피드)·같은 방향(isUp)·신선한 수신으로
 *  성수 또는 leg 방향 다음 역(G3)에서 관측.
 */
export function decideTimetableReattach(input: RenumberReattachInput): RenumberReattachDecision {
  const { lockLine, lockTrainCode, arm, positions, nowMs, legDirection } = input;
  if (lockLine !== RENUMBER_LINE) return { ok: false, reason: 'not-renumber-line' };
  const fromCode = resolveRenumberOrigin(lockTrainCode, arm, nowMs);
  const successor = lookupRenumberSuccessor(lockLine, fromCode, nowMs);
  if (!successor) return { ok: false, reason: 'no-table-entry' };
  if (legDirection === null || (legDirection === 'up') !== successor.isUp) {
    return { ok: false, reason: 'direction-mismatch' };
  }
  if (!positions) return { ok: false, reason: 'no-fresh-feed' };
  const fromRow = positions.find((p) => p.trainCode === fromCode);
  if (fromRow && !(fromRow.terminus ?? '').startsWith(RENUMBER_STATION)) {
    return { ok: false, reason: 'lock-train-still-running' };
  }
  const { successorCode, isUp, dayType } = successor;
  const observed = positions.filter(
    (p) =>
      p.trainCode === successorCode &&
      p.isUp === isUp &&
      (p.recptnMs <= 0 || nowMs - p.recptnMs <= RENUMBER_OBSERVATION_MAX_AGE_MS),
  );
  if (observed.length === 0) return { ok: false, reason: 'successor-not-observed' };
  // G3 — 후속은 성수에서 leg 방향으로 막 출발한 열차다. 같은 번호를 다른 곳에서 재사용하는 열차는 성수·다음 역 밖에 있다.
  const adjacentStations = [RENUMBER_STATION, nextStationInDirection(lockLine, RENUMBER_STATION, legDirection)];
  if (!observed.some((p) => adjacentStations.includes(p.stationName))) {
    return { ok: false, reason: 'successor-not-adjacent' };
  }
  return { ok: true, fromCode, successorCode, dayType };
}

export type LegDirection = 'up' | 'down';

interface RenumberLegLock {
  line: LineNumber;
  trainCode: string;
  segmentStations: readonly string[];
}

/**
 * lock이 달린 leg의 진행 방향. segmentStations 양 끝으로 추론하고, 1개뿐(트립 꼬리)이면 leg 앵커 -> 그 역으로 추론한다
 * (`lockSwap.attachTrainCodeForLeg`와 같은 규칙). 추론 불가면 null.
 */
export function legDirectionOf(trip: Trip, lock: RenumberLegLock): LegDirection | null {
  const { line, segmentStations } = lock;
  const last = segmentStations[segmentStations.length - 1];
  if (segmentStations.length >= 2) return inferLegDirection(line, segmentStations[0], last);
  const legOrigin = resolveLegOriginStation(trip, line);
  return legOrigin !== undefined ? inferLegDirection(line, legOrigin, last) : null;
}

export type RenumberLegRejection =
  | 'no-renumber-station-on-leg'
  | 'direction-mismatch'
  | 'already-reattached-this-leg';

export type RenumberLegDecision = { ok: true } | { ok: false; reason: RenumberLegRejection };

/**
 * 시간표 후속 재부착·유예·정정 표식의 leg 게이트. 전부 AND:
 *  G1 이 leg가 성수를 지난다(segmentStations 포함 OR leg 앵커가 성수 — confirm/register lock은 탑승역이 seg에 없을 수 있다)
 *  G2 lock(또는 vanish-swap 전 원) 열차의 시간표 방향 == leg 방향 (반대 방향 후속으로 옮기지 않는다 — 10/3 3174->3212)
 *  G4 이번 leg에서 이미 번호를 바꾼 열차가 아니다: `lockCodeHistory`의 열차 시간표 후속이 현재 lock이면 거부.
 * 시간표 항목이 없는 lock(지선 등)은 비교 대상이 없어 G2/G4가 막지 않는다 — 후속 조회가 따로 null을 돌려준다.
 * 한계: 같은 열차가 한 leg에서 성수를 두 번 지나 다시 번호를 바꾸는 경우(2호선 한 바퀴)는 G4가 두 번째를 막는다.
 */
export function checkRenumberLeg(trip: Trip, lock: RenumberLegLock, nowMs: number): RenumberLegDecision {
  const { line, trainCode, segmentStations } = lock;
  const onRenumberLeg =
    segmentStations.includes(RENUMBER_STATION) || resolveLegOriginStation(trip, line) === RENUMBER_STATION;
  if (!onRenumberLeg) return { ok: false, reason: 'no-renumber-station-on-leg' };
  const own = lookupRenumberSuccessor(line, resolveRenumberOrigin(trainCode, trip.renumberSuccessor, nowMs), nowMs);
  if (own) {
    const legDirection = legDirectionOf(trip, lock);
    if (legDirection === null || (legDirection === 'up') !== own.isUp) return { ok: false, reason: 'direction-mismatch' };
  }
  const alreadyReattached = (trip.lockCodeHistory ?? []).some(
    (code) => lookupRenumberSuccessor(line, code, nowMs)?.successorCode === trainCode,
  );
  return alreadyReattached ? { ok: false, reason: 'already-reattached-this-leg' } : { ok: true };
}

/**
 * vanish-swap이 lock을 `oldCode`->`newCode`로 옮길 때 남길 표식. 옛 lock이 시간표 항목을 가진
 * 번호 변경 열차일 때만 만든다(그 외는 undefined — 기존 필드 불변). 연쇄 swap이면 `from`/`armedAt` 유지.
 */
export function nextRenumberArm(
  line: LineNumber,
  prev: RenumberArm | undefined,
  oldCode: string,
  newCode: string,
  nowMs: number,
): RenumberArm | undefined {
  const from = resolveRenumberOrigin(oldCode, prev, nowMs);
  if (!lookupRenumberSuccessor(line, from, nowMs)) return undefined;
  const chained = prev !== undefined && from === prev.from;
  return { from, swappedTo: newCode, armedAt: chained ? prev.armedAt : nowMs };
}

/** vanish-swap을 시간표 후속 대기를 위해 유예하는 최대 tick 수(= swap 시도 임계 이후 추가 miss tick). */
export const RENUMBER_SWAP_DEFER_TICKS = 2;

/**
 * 시간표 후속 항목(요일)을 가진 번호 변경 열차가 사라졌으면 vanish-swap을 `RENUMBER_SWAP_DEFER_TICKS` tick
 * 유예한다. 항목이 없으면 즉시 기존 동작(false). 유예 안에 후속이 관측되면 시간표 재부착이 먼저 처리하고,
 * 유예가 끝나도 안 나타나면 기존 vanish-swap이 실행된다. `missCount` = 이번 tick 포함 연속 miss 수.
 */
export function shouldDeferVanishSwap(input: {
  lockLine: LineNumber;
  lockTrainCode: string;
  arm: RenumberArm | undefined;
  missCount: number;
  swapThreshold: number;
  nowMs: number;
}): boolean {
  const { lockLine, lockTrainCode, arm, missCount, swapThreshold, nowMs } = input;
  if (missCount >= swapThreshold + RENUMBER_SWAP_DEFER_TICKS) return false;
  const origin = resolveRenumberOrigin(lockTrainCode, arm, nowMs);
  return lookupRenumberSuccessor(lockLine, origin, nowMs) !== null;
}
