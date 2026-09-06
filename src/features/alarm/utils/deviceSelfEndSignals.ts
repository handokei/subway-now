/**
 * Device self-contained 자동종료 signal 판정 helpers (#2043).
 *
 * Backend silent push `trip-ended`가 도달하지 못하는 시나리오 backstop:
 *   - 앱 kill + APNs 미도달 (관찰 22)
 *   - 6h+ 잔존 후 사용자가 재개
 *   - 9h+ lifecycle backstop만 유일 backup (KTX 등 장거리 trip 보호 목적이라 자동종료 늦음)
 *
 * ADR-023 (backend vs device 역할 경계) + [[feedback-device-self-contained-fusion]] paradigm:
 * "backend/GPS/WiFi 다 죽어도 device 보장". 자동종료도 device self-contained 확장.
 *
 * 초기 스코프: 3-signal (Signal 4 backend-timeout은 silentPushTask.ts 4-way 편집 충돌 회피
 * 후속 이슈로 분리).
 *
 *   Signal 1 fusion-destination: fusion nearestStation === destination + confidence 강 + 30s 지속
 *   Signal 2 arc-completion:     routeProgress.arc >= 0.95 + stationary 60s 지속
 *   Signal 3 eta-backstop:       currentTime - tripStartedAt > expectedEta × 2 + stationary 5min
 *
 * OR 조건 — 하나라도 trigger면 self-end. 각 signal은 순수 함수라 host hook이 상태 지속 시간을
 * 별도로 관리하고 여기서는 "현재 tick input"만 평가한다.
 *
 * False positive 방어:
 *   - Signal 1: FusionConfidence 강 신호(backend-ssot/boarding-lock/position-train/arrival-*
 *     /wifi-ssid/route-progress) 화이트리스트 — gps-only/gps-only-underground 배제
 *   - Signal 2: stationary 60s 지속 요구 — 움직임 중이면 trigger X
 *   - Signal 3: eta × 2 gate + stationary 5min — KTX 등 실 6h+ trip은 eta 자체가 커서 자연 방어
 */

import type { FusionConfidence } from '../../../shared/types/fusion';

/**
 * 강 fusion confidence 화이트리스트 — 자동종료 Signal 1의 최소 요구.
 *
 * 'gps-only' 및 'gps-only-underground'는 지하 fix / wifi/cell 삼각측량이 흔한 좌표원이라
 * destination 오버랩 시 false positive 위험 → 배제. 나머지는 arrival/position/wifi 실측 신호
 * 기반이라 destination 근접 판정에 신뢰 가능.
 */
const STRONG_CONFIDENCES: readonly FusionConfidence[] = [
  'backend-ssot',
  'boarding-lock',
  'boarding-lock-interp',
  'position-train',
  'arrival-confirmed',
  'arrival-arriving',
  'route-progress',
  'wifi-ssid',
  'detection-fused',
];

export function isStrongFusionConfidenceForSelfEnd(confidence: FusionConfidence): boolean {
  return STRONG_CONFIDENCES.includes(confidence);
}

/** Signal 반환 shape. trigger=true 시 reason 라벨로 fired count 분류. */
export interface SelfEndSignalVerdict {
  trigger: boolean;
  reason: SelfEndSignalReason | null;
}

export type SelfEndSignalReason =
  | 'fusion-destination'
  | 'arc-completion'
  | 'eta-backstop';

/**
 * Signal 1 — fusion nearestStation이 destination과 일치하면서 강 confidence + N초 지속.
 *
 * @param currentStationId  fusion result.station.id (없으면 null)
 * @param destinationId     활성 trip destination.id (없으면 null → trip 없음, trigger false)
 * @param confidence        fusion confidence 라벨
 * @param destinationMatchStartedAt  matching 최초 tick의 epoch ms (host hook이 유지). null이면
 *                                    아직 match 시작 전.
 * @param now               기준 시각 (테스트 결정성)
 * @param requiredDurationMs 지속 요구 시간 (기본 30s)
 */
export function fusionDestinationSignal(
  currentStationId: string | null,
  destinationId: string | null,
  confidence: FusionConfidence | null,
  destinationMatchStartedAt: number | null,
  now: number,
  requiredDurationMs: number = 30_000,
): SelfEndSignalVerdict {
  if (destinationId === null) return { trigger: false, reason: null };
  if (currentStationId === null) return { trigger: false, reason: null };
  if (currentStationId !== destinationId) return { trigger: false, reason: null };
  if (confidence === null) return { trigger: false, reason: null };
  if (!isStrongFusionConfidenceForSelfEnd(confidence)) {
    return { trigger: false, reason: null };
  }
  if (destinationMatchStartedAt === null) return { trigger: false, reason: null };
  if (now - destinationMatchStartedAt < requiredDurationMs) {
    return { trigger: false, reason: null };
  }
  return { trigger: true, reason: 'fusion-destination' };
}

/**
 * Signal 2 — routeProgress arc가 종점에 근접(≥0.95) + stationary N초 지속.
 *
 * @param arcProgress            0~1 (progressM / totalArcM). arc 없으면 null.
 * @param isStationary           positionStability === 'static'
 * @param stationaryStartedAt    stationary 최초 tick의 epoch ms (host hook 유지). null이면
 *                                아직 stationary 진입 전 또는 움직임 중.
 * @param now                    기준 시각
 * @param requiredDurationMs     지속 요구 시간 (기본 60s)
 * @param progressThreshold      arc 완료 임계 (기본 0.95)
 */
export function arcCompletionSignal(
  arcProgress: number | null,
  isStationary: boolean,
  stationaryStartedAt: number | null,
  now: number,
  requiredDurationMs: number = 60_000,
  progressThreshold: number = 0.95,
): SelfEndSignalVerdict {
  if (arcProgress === null) return { trigger: false, reason: null };
  if (arcProgress < progressThreshold) return { trigger: false, reason: null };
  if (!isStationary) return { trigger: false, reason: null };
  if (stationaryStartedAt === null) return { trigger: false, reason: null };
  if (now - stationaryStartedAt < requiredDurationMs) {
    return { trigger: false, reason: null };
  }
  return { trigger: true, reason: 'arc-completion' };
}

/**
 * Signal 3 — trip 시작 후 expectedEta × 2 초과 + stationary 5분 지속.
 *
 * 위치/도착 신호가 아무것도 안 잡히는 최후 backstop. KTX 등 실 장거리 trip은 expectedEta 자체가
 * 크므로 eta×2 gate가 자연 방어. stationary 5분 조건으로 이동 중 false trigger 차단.
 *
 * @param tripStartedAt         epoch ms. null이면 미기록 → skip.
 * @param expectedEtaMs         trip 예상 소요 시간 (ms). null이면 skip.
 * @param stationary5minStartedAt stationary 5분 지속 최초 tick의 epoch ms (host hook 유지).
 * @param now                   기준 시각
 * @param stationaryDurationMs  stationary 지속 요구 (기본 5분)
 */
export function etaBackstopSignal(
  tripStartedAt: number | null,
  expectedEtaMs: number | null,
  stationary5minStartedAt: number | null,
  now: number,
  stationaryDurationMs: number = 5 * 60_000,
): SelfEndSignalVerdict {
  if (tripStartedAt === null) return { trigger: false, reason: null };
  if (expectedEtaMs === null) return { trigger: false, reason: null };
  if (expectedEtaMs <= 0) return { trigger: false, reason: null };
  const elapsed = now - tripStartedAt;
  if (elapsed <= expectedEtaMs * 2) return { trigger: false, reason: null };
  if (stationary5minStartedAt === null) return { trigger: false, reason: null };
  if (now - stationary5minStartedAt < stationaryDurationMs) {
    return { trigger: false, reason: null };
  }
  return { trigger: true, reason: 'eta-backstop' };
}

/**
 * OR fusion — signal 배열 중 첫 trigger를 반환. 모두 false면 trigger=false / reason=null.
 * 배열 순서가 우선순위 — Signal 1(fusion-destination)이 가장 신뢰 높아 앞에 둔다.
 */
export function shouldTriggerSelfEnd(
  signals: readonly SelfEndSignalVerdict[],
): SelfEndSignalVerdict {
  for (const s of signals) {
    if (s.trigger) return s;
  }
  return { trigger: false, reason: null };
}

/**
 * #2341 — Signal 1(fusion-destination)의 destination-match 30s 지속 요구가 backend destination
 * push(실측 도달 지연 35~51s) 발사보다 먼저 self-end로 trip을 삭제해버리는 race 차단 게이트.
 *
 * destination push(source='silent-push-received', kind='destination')가 destination-match
 * 시작 이후 관측되면 즉시 통과. 관측 안 됐으면 DESTINATION_PUSH_TIMEOUT_MS(기본 4분 — 실측
 * 지연 35~51s 대비 충분한 여유이면서, backend가 완전 침묵하는 trip이 self-end를 영구히
 * 대기하는 stale-trip 방지 백스톱) 경과해야만 통과.
 */
export const DESTINATION_PUSH_TIMEOUT_MS = 4 * 60_000;

export interface DestinationPushObservationEntry {
  source: string;
  kind?: string;
  ts: number;
}

/**
 * alarmLog ring buffer entries에서 destination-match 시작(sinceTs) 이후 도달한 destination
 * push(visible station kind) 관측 여부를 판정한다. alarmLog.ts의 computeSilentPushReach와
 * 동일한 '도달=received station kind' 정의를 destination에 한정해 재사용한다.
 */
export function hasObservedDestinationPush(
  entries: readonly DestinationPushObservationEntry[],
  sinceTs: number,
): boolean {
  return entries.some(
    (entry) =>
      entry.source === 'silent-push-received' &&
      entry.kind === 'destination' &&
      entry.ts >= sinceTs,
  );
}

/**
 * @param destinationMatchStartedAt Signal 1 destination-match 최초 진입 tick의 epoch ms.
 * @param now                        기준 시각.
 * @param pushObserved               destination push 관측 여부 (hasObservedDestinationPush 결과).
 * @param timeoutMs                  백스톱 타임아웃 (기본 DESTINATION_PUSH_TIMEOUT_MS).
 */
export function destinationPushGatePassed(
  destinationMatchStartedAt: number | null,
  now: number,
  pushObserved: boolean,
  timeoutMs: number = DESTINATION_PUSH_TIMEOUT_MS,
): boolean {
  if (pushObserved) return true;
  if (destinationMatchStartedAt === null) return false;
  return now - destinationMatchStartedAt >= timeoutMs;
}
