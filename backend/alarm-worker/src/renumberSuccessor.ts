/**
 * #3158 — 2호선 성수 열차 번호 변경(renumber) 시 lock을 시간표 후속으로 재부착하는 순수 판정.
 *
 * 한 물리 열차가 성수에서 종착(예: 3009 "성수")하고 다음 번호(3045 "성수종착")로 이어진다. 후속은
 * OA-22750 열차시간표에서 "성수 시발마다 직전 미배정 종착"으로 결정된다 — 오프라인 빌드
 * (`scripts/build-renumber-successors.js`) 산출물 `data/line2RenumberSuccessors.json`을 읽는다
 * (리서치 tasks/research-2026-10-21-seoul-shtrmpath.md §1: 관측 9/9 일치, 모호 2건 해소).
 *
 * 본 모듈은 I/O 없음 — 호출자(`scheduled.ts` `attemptTimetableSuccessorReattach`)가 피드·trip을 공급하고
 * 결과를 반영한다. **후속이 라이브 피드에서 같은 노선·방향·시간창 안에 관측될 때만** 재부착을 허용한다
 * (미관측이면 기존 vanish-swap 불변 — 시간표는 후보를 "확정"하는 근거이지 "예측으로 lock을 옮기는" 근거가 아니다).
 *
 * 한계(추정): 평일/주말만 구분(공휴일은 주말 시간표를 쓰지 않음 = 평일 취급), 시간표 기준일 고정
 * (`meta.timetableBaseDate`), 임시시간표 미반영. 어긋나면 후속이 미관측이라 기존 동작으로 수렴한다.
 */

import successorData from './data/line2RenumberSuccessors.json';
import type { PositionEntry } from './seoul';
import type { LineNumber } from './types';

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

/** 시간표상 종착~시발 구간 앞뒤로 허용하는 시간창(초). 관측: 시간표 대비 98.8%가 +-120초. */
export const RENUMBER_WINDOW_SEC = 600;
/** 후속 관측 행의 최대 수신 경과(ms) — 오래된 행으로 재부착하지 않는다. */
export const RENUMBER_OBSERVATION_MAX_AGE_MS = 5 * 60 * 1000;
/** vanish-swap이 먼저 옮긴 lock을 시간표 후속으로 정정할 수 있는 기간(ms). */
export const RENUMBER_ARM_TTL_MS = 15 * 60 * 1000;

/** 실시간 열차번호 prefix — (2|3)ddd <-> 시간표 2ddd (끝 3자리 보존, 후속도 같은 prefix). */
const REALTIME_TRAIN_NO = /^([23])(\d{3})$/;
/** 시간표 방향 표기 -> 피드 `isUp`. 2호선 내선=상행. */
const DIRECTION_IS_UP: Readonly<Record<string, boolean>> = { 내선: true, 외선: false };
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const SECONDS_PER_DAY = 86400;
/** 시간표 빌드와 동일: 이 시각(시) 미만은 익일 운행으로 +24h. */
const SERVICE_DAY_WRAP_HOUR = 3;
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

function kstServiceSec(nowMs: number): number {
  const sec = Math.floor(((nowMs + KST_OFFSET_MS) % (SECONDS_PER_DAY * 1000)) / 1000);
  return sec < SERVICE_DAY_WRAP_HOUR * 3600 ? sec + SECONDS_PER_DAY : sec;
}

/** 시간표에서 `trainCode`(실시간 번호)의 후속을 조회한다. 노선·번호 형식·시간창이 맞지 않으면 null. */
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
  const nowSec = kstServiceSec(nowMs);
  const entry = entries.find(
    ([, , endSec, startSec]) => nowSec >= endSec - RENUMBER_WINDOW_SEC && nowSec <= startSec + RENUMBER_WINDOW_SEC,
  );
  if (!entry) return null;
  const [next, dir] = entry;
  const isUp = DIRECTION_IS_UP[dir];
  if (isUp === undefined) return null;
  return { fromCode: trainCode, successorCode: `${prefix}${next}`, isUp, dayType };
}

export type RenumberReattachRejection =
  | 'not-renumber-line'
  | 'no-table-entry'
  | 'no-fresh-feed'
  | 'lock-train-still-running'
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
 *  1) 후속표 노선 2) 시간표 항목(요일·시간창) 3) 신선한 피드 4) lock 열차가 소멸했거나 성수 종착으로 표시
 *  5) 후속이 같은 노선(피드)·같은 방향(isUp)·신선한 수신으로 관측.
 */
export function decideTimetableReattach(input: RenumberReattachInput): RenumberReattachDecision {
  const { lockLine, lockTrainCode, arm, positions, nowMs } = input;
  if (lockLine !== RENUMBER_LINE) return { ok: false, reason: 'not-renumber-line' };
  const fromCode = resolveRenumberOrigin(lockTrainCode, arm, nowMs);
  const successor = lookupRenumberSuccessor(lockLine, fromCode, nowMs);
  if (!successor) return { ok: false, reason: 'no-table-entry' };
  if (!positions) return { ok: false, reason: 'no-fresh-feed' };
  const fromRow = positions.find((p) => p.trainCode === fromCode);
  if (fromRow && !(fromRow.terminus ?? '').startsWith(RENUMBER_STATION)) {
    return { ok: false, reason: 'lock-train-still-running' };
  }
  const { successorCode, isUp, dayType } = successor;
  const observed = positions.some(
    (p) =>
      p.trainCode === successorCode &&
      p.isUp === isUp &&
      (p.recptnMs <= 0 || nowMs - p.recptnMs <= RENUMBER_OBSERVATION_MAX_AGE_MS),
  );
  if (!observed) return { ok: false, reason: 'successor-not-observed' };
  return { ok: true, fromCode, successorCode, dayType };
}

/**
 * vanish-swap이 lock을 `oldCode`->`newCode`로 옮길 때 남길 표식. 옛 lock이 시간표 항목(시간창 포함)을 가진
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
 * 시간표 후속 항목(요일·시간창)을 가진 번호 변경 열차가 사라졌으면 vanish-swap을 `RENUMBER_SWAP_DEFER_TICKS` tick
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
