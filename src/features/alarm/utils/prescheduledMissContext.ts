/**
 * 사전 예약 miss trip 자동 진단 컨텍스트 (#986, #918/#956 follow-up).
 *
 * `prescheduledMetrics`가 trip 윈도우 안에서 scheduledCount > firedCount 인 trip 을 감지하면
 * 본 모듈이 **이미 영속화된 신호들**을 모아 telemetry payload에 첨부한다. 새 write hook을
 * 분산시키지 않고 trip-end 시점에 한 번만 derive — 사이드이펙트 0.
 *
 * 적재 신호:
 *   - lockedTrainCode / lockedAt    : BoardingLock (탑승 시점 trainCode + boardedAt)
 *   - lastSilentPushReceived         : alarmLog의 마지막 silent-push-received 엔트리 요약
 *   - lastScheduledStamp             : alarmLog의 마지막 bg-scheduled fired 엔트리의 stamp
 *   - missedIdentifiers              : ledger에서 actualFireMs 미기록 entry id 목록
 *
 * 모든 필드는 optional — 신호 없으면 그대로 제외. context 객체 자체가 비어있으면(모든
 * 필드 부재) caller는 missContext를 첨부하지 않는다 (isEmptyMissContext 가드).
 *
 * Privacy: trainCode/stationName은 token prefix 기반 anonymous aggregate와 동일 정책으로
 * 노출 — 좌표/원문 미적재. backend는 console.log + Logpush 로 보존 (AE blob에는 미적재).
 */

import type { AlarmLogEntry } from './alarmLog';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { PrescheduledLedgerEntry } from './prescheduledMetrics';

/**
 * Trip-end 시점 진단 컨텍스트 1건. 모든 필드 optional — 신호 없으면 생략.
 *
 * backend `prescheduledTelemetry.validatePrescheduledUpload`가 동형 schema로 검증한다.
 * 추가 필드는 양쪽 동시 갱신 — 한쪽이 unknown이면 reject (조용히 drop 안 함).
 */
export interface PrescheduledMissContext {
  /** BoardingLock.trainCode — 사용자가 탭한 열차. lock 없으면 생략. */
  lockedTrainCode?: string;
  /** BoardingLock.boardedAt — 탑승 시각(epoch ms). lock 없으면 생략. */
  lockedAt?: number;
  /** 마지막 silent push 수신 entry 요약. window 안에 1건도 없으면 생략. */
  lastSilentPushReceived?: {
    sentAt?: number;
    receivedAt: number;
    stationName?: string;
  };
  /** 마지막 bg-scheduled fired 엔트리의 stamp 요약. 없으면 생략. */
  lastScheduledStamp?: {
    selectedArrivalSeconds?: number;
    expectedStationAtFire?: string;
    actualLastNotifiedStation?: string;
  };
  /** ledger에서 actualFireMs가 미기록된 identifier 목록. 빈 배열이면 생략. */
  missedIdentifiers?: readonly string[];
}

export interface CollectMissContextInput {
  /** trip 윈도우 lower bound (inclusive). */
  tripStart: number;
  /** trip 윈도우 upper bound (inclusive). */
  tripEnd: number;
  /** trip-end 시점 alarmLog 전체. caller가 한 번 읽어 전달. */
  alarmLogEntries: readonly AlarmLogEntry[];
  /** trip-end 시점 BoardingLock (null = lock 없이 종료된 trip). */
  boardingLock: BoardingLock | null;
  /** trip-end 시점 prescheduled ledger 전체. */
  ledger: readonly PrescheduledLedgerEntry[];
}

/**
 * trip 윈도우 안 entry만 필터링. ts 가 [tripStart, tripEnd] 포함이면 통과.
 * 정의: tripEnd 시점 발생한 entry 도 포함 (recallMetrics는 strict gt 시작이지만 본 함수는
 * 진단 목적이라 윈도우 양 끝 포함이 더 안전 — 누락된 신호 더 잘 잡힘).
 */
function inWindow(entry: AlarmLogEntry, tripStart: number, tripEnd: number): boolean {
  return entry.ts >= tripStart && entry.ts <= tripEnd;
}

/**
 * 윈도우 안 가장 최근 silent-push-received entry 추출. 다수면 ts 가장 큰 것.
 * 없으면 undefined.
 */
function pickLastSilentPushReceived(
  entries: readonly AlarmLogEntry[],
  tripStart: number,
  tripEnd: number,
): PrescheduledMissContext['lastSilentPushReceived'] {
  let last: AlarmLogEntry | undefined;
  for (const entry of entries) {
    if (!inWindow(entry, tripStart, tripEnd)) continue;
    if (entry.source !== 'silent-push-received') continue;
    if (entry.receivedAt === undefined) continue;
    if (last === undefined || entry.ts > last.ts) last = entry;
  }
  if (!last || last.receivedAt === undefined) return undefined;
  const out: NonNullable<PrescheduledMissContext['lastSilentPushReceived']> = {
    receivedAt: last.receivedAt,
  };
  if (last.sentAt !== undefined) out.sentAt = last.sentAt;
  if (last.stationName !== undefined) out.stationName = last.stationName;
  return out;
}

/**
 * 윈도우 안 가장 최근 bg-scheduled fired entry 추출. stamp 필드 중 하나라도 값이
 * 있으면 채택. 모두 null/undefined인 entry는 skip (정보 없음).
 */
function pickLastScheduledStamp(
  entries: readonly AlarmLogEntry[],
  tripStart: number,
  tripEnd: number,
): PrescheduledMissContext['lastScheduledStamp'] {
  let last: AlarmLogEntry | undefined;
  for (const entry of entries) {
    if (!inWindow(entry, tripStart, tripEnd)) continue;
    if (entry.source !== 'bg-scheduled') continue;
    if (entry.outcome !== 'fired') continue;
    // stamp 필드 셋 다 비어있으면 스킵 — 진단 가치 0.
    const hasStamp =
      (entry.selectedArrivalSeconds !== null && entry.selectedArrivalSeconds !== undefined) ||
      (entry.expectedStationAtFire !== null && entry.expectedStationAtFire !== undefined) ||
      (entry.actualLastNotifiedStation !== null &&
        entry.actualLastNotifiedStation !== undefined);
    if (!hasStamp) continue;
    if (last === undefined || entry.ts > last.ts) last = entry;
  }
  if (!last) return undefined;
  const out: NonNullable<PrescheduledMissContext['lastScheduledStamp']> = {};
  if (last.selectedArrivalSeconds !== null && last.selectedArrivalSeconds !== undefined) {
    out.selectedArrivalSeconds = last.selectedArrivalSeconds;
  }
  if (last.expectedStationAtFire !== null && last.expectedStationAtFire !== undefined) {
    out.expectedStationAtFire = last.expectedStationAtFire;
  }
  if (last.actualLastNotifiedStation !== null && last.actualLastNotifiedStation !== undefined) {
    out.actualLastNotifiedStation = last.actualLastNotifiedStation;
  }
  return out;
}

/**
 * ledger에서 윈도우 안 scheduled entry 중 actualFireMs 가 비어있는 identifier 목록.
 * 한 trip의 사전 예약 최대치는 ~80건이라 그대로 노출 — 노이즈 우려 없음.
 */
function collectMissedIdentifiers(
  ledger: readonly PrescheduledLedgerEntry[],
  tripStart: number,
  tripEnd: number,
): string[] {
  const out: string[] = [];
  for (const entry of ledger) {
    if (entry.scheduledFireMs < tripStart || entry.scheduledFireMs > tripEnd) continue;
    if (entry.actualFireMs !== undefined) continue;
    out.push(entry.identifier);
  }
  return out;
}

/**
 * Trip-end 시점 진단 컨텍스트 derive. 호출자는 prescheduledMetrics 결과의 scheduled>fired
 * 조건이 성립할 때만 호출 — 본 함수 자체는 그 가드를 안 한다 (caller 책임).
 *
 * 모든 신호는 이미 영속화돼 있으므로 추가 I/O 0. caller가 alarmLog/lock/ledger를 한 번
 * 읽어 전달한다.
 */
export function collectMissContext(input: CollectMissContextInput): PrescheduledMissContext {
  const { tripStart, tripEnd, alarmLogEntries, boardingLock, ledger } = input;
  const out: PrescheduledMissContext = {};

  if (boardingLock) {
    // empty trainCode(저장소 손상 케이스)는 skip — backend missContext schema가 빈 문자열 reject.
    // 잘못된 신호가 trip 전체 upload를 깨지 않게 client에서 미리 차단.
    if (boardingLock.trainCode.length > 0) {
      out.lockedTrainCode = boardingLock.trainCode;
    }
    if (Number.isFinite(boardingLock.boardedAt)) {
      out.lockedAt = boardingLock.boardedAt;
    }
  }

  const lastSilent = pickLastSilentPushReceived(alarmLogEntries, tripStart, tripEnd);
  if (lastSilent) out.lastSilentPushReceived = lastSilent;

  const lastStamp = pickLastScheduledStamp(alarmLogEntries, tripStart, tripEnd);
  if (lastStamp) out.lastScheduledStamp = lastStamp;

  const missed = collectMissedIdentifiers(ledger, tripStart, tripEnd);
  if (missed.length > 0) out.missedIdentifiers = missed;

  return out;
}

/**
 * 한 신호도 없는 경우 — caller는 missContext 자체를 upload payload에 첨부하지 않는다.
 * (네트워크 절약 + backend validation 통과 보장.)
 */
export function isEmptyMissContext(context: PrescheduledMissContext): boolean {
  return (
    context.lockedTrainCode === undefined &&
    context.lockedAt === undefined &&
    context.lastSilentPushReceived === undefined &&
    context.lastScheduledStamp === undefined &&
    context.missedIdentifiers === undefined
  );
}
