/**
 * 매역 알림 recall KPI 계산 (#919, Epic #912 A4).
 *
 * Trip 1건의 route stops 와 alarmLog entries 를 입력으로 받아 recall % 와
 * gate suppression 분포를 산출하는 순수 함수.
 *
 *   recall = |route stops ∩ fired stops| / |route stops|
 *
 * recall < 100% 인 trip은 어떤 게이트가 차단했는지 reason 별 카운트를 함께 반환해
 * 회귀의 root cause(accuracy/motion/silence/lockMissing/sleep/...)를 자동 분해한다.
 *
 * 동작 변경 없음 — 순수 측정 인프라. 호출자는 trip 종료 시 본 함수를 호출하고
 * 결과를 telemetry payload 로 backend 에 누적 upload (별도 PR 에서 wire).
 */

import type { AlarmLogEntry, AlarmLogReason } from './alarmLog';

export interface TripRecallInput {
  /** route 의 역 이름 배열 (출발 ~ 목적지 사이 모든 정차역, 순서 무관). */
  routeStops: readonly string[];
  /** alarmLog ring buffer 의 모든 entries (필터링은 내부에서). */
  entries: readonly AlarmLogEntry[];
  /** trip 시작 epoch ms (exclusive) — 이전 trip 의 잔여 entries 차단. */
  tripStart: number;
  /** trip 종료 epoch ms (inclusive). */
  tripEnd: number;
}

export interface TripRecallResult {
  tripStart: number;
  tripEnd: number;
  /** route 정차역 총 개수 (분모). */
  expectedStops: number;
  /** route 와 교집합인 fired 역 개수 (분자, 중복 제거). */
  firedStops: number;
  /** 0~100 정수. expectedStops=0 이면 100 (분모 보호). */
  recallPct: number;
  /** suppressed 엔트리의 게이트별 reason 카운트. 0인 reason 은 키 자체 생략. */
  gateSuppressionCounts: Partial<Record<AlarmLogReason, number>>;
}

/**
 * 게이트 차단으로 분류하는 reason 집합 (글로벌 룰 3 — 데이터 주도).
 *
 * dedup-station / dedup-alarm 은 *정상 동작* (이미 발화된 알람의 재발화 차단)이라
 * 게이트 분포에 포함하면 신호가 오염된다 → 제외.
 *
 * payload-missing-kind / lock-line-mismatch 등 backend race 신호도 게이트로 본다
 * — recall 차감의 원인이 되기 때문.
 *
 * 새 게이트 reason 이 alarmLog.ts AlarmLogReason 에 추가되면 본 배열에 한 줄만
 * 더하면 자동 반영된다. recallMetrics.test.ts 의 sanity 케이스가 누락을 잡아 준다.
 */
export const GATE_SUPPRESSION_REASONS: readonly AlarmLogReason[] = [
  'gate-age',
  'gate-accuracy',
  'gate-jump',
  'gate-unknown-station',
  'gate-no-location',
  'gate-stale-location',
  'gate-out-of-range',
  'lock-line-mismatch',
  'payload-missing-kind',
  'movement-no-location',
  'movement-stale-timestamp',
  'movement-low-accuracy',
  'movement-static-speed',
  'movement-static-position',
  'movement-motion-stationary',
  'sleep-first-transfer',
  'lockless-non-intermediate',
  'lockless-opt-out',
  'dismiss-silence',
];

const GATE_REASON_SET: ReadonlySet<AlarmLogReason> = new Set(GATE_SUPPRESSION_REASONS);

function isInWindow(entry: AlarmLogEntry, tripStart: number, tripEnd: number): boolean {
  return entry.ts > tripStart && entry.ts <= tripEnd;
}

function accountForFiredEntry(
  entry: AlarmLogEntry,
  routeSet: ReadonlySet<string>,
  firedRouteStations: Set<string>,
): void {
  const name = entry.stationName;
  if (name && routeSet.has(name)) {
    firedRouteStations.add(name);
  }
}

function accountForSuppressedEntry(
  entry: AlarmLogEntry,
  gateSuppressionCounts: Partial<Record<AlarmLogReason, number>>,
): void {
  const reason = entry.reason;
  if (reason && GATE_REASON_SET.has(reason)) {
    gateSuppressionCounts[reason] = (gateSuppressionCounts[reason] ?? 0) + 1;
  }
}

export function computeTripRecall(input: TripRecallInput): TripRecallResult {
  const { routeStops, entries, tripStart, tripEnd } = input;
  const expectedStops = routeStops.length;
  const routeSet: ReadonlySet<string> = new Set(routeStops);

  // 분자: route ∩ fired (역 이름 중복 제거 — 같은 역이 여러 채널로 fire 돼도 1로 카운트).
  const firedRouteStations = new Set<string>();
  const gateSuppressionCounts: Partial<Record<AlarmLogReason, number>> = {};

  for (const entry of entries) {
    if (!isInWindow(entry, tripStart, tripEnd)) continue;
    if (entry.outcome === 'fired') {
      accountForFiredEntry(entry, routeSet, firedRouteStations);
    } else if (entry.outcome === 'suppressed') {
      accountForSuppressedEntry(entry, gateSuppressionCounts);
    }
  }

  const firedStops = firedRouteStations.size;
  const recallPct = expectedStops === 0
    ? 100
    : Math.round((firedStops / expectedStops) * 100);

  return {
    tripStart,
    tripEnd,
    expectedStops,
    firedStops,
    recallPct,
    gateSuppressionCounts,
  };
}

/**
 * upload 의미가 있는지 판정 — 모든 카운터가 0 + 게이트 분포 비어있으면 skip.
 * trip 길이가 0 인 가짜 신호(빈 route, 빈 log)를 backend 에 보내지 않기 위한 가드.
 */
export function isEmptyRecall(result: TripRecallResult): boolean {
  return (
    result.expectedStops === 0 &&
    result.firedStops === 0 &&
    Object.keys(result.gateSuppressionCounts).length === 0
  );
}
