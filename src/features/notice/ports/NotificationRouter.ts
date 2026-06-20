/**
 * #1575 (T12, ADR-017) — NotificationRouter abstraction.
 *
 * 4개로 분산된 notification surface(banner / live-activity / widget / in-app)의 단일 진입점.
 * 모든 fire path는 router.deliver()를 경유해 surface별 dedup + backend SSoT mirror 검증 +
 * sleep mode gate를 통과한 후 실제 발사된다.
 *
 * 본 파일은 interface only — 실제 fan-out 구현은 `infra/NotificationRouterImpl.ts`,
 * surface 별 wrap은 `infra/<Surface>.ts`. caller는 항상 interface로 import해 테스트 시
 * mock 교체가 용이하도록 한다.
 *
 * 회귀 컨텍스트 (이슈 #1575):
 * - destination-early 88건 spam: 분산 dedup이 발사 자체를 못 막음.
 * - 어대→군자 늦은 발사: backend.passedStations에 군자 있음에도 backward fire.
 *
 * Acceptance (#1575):
 * - 같은 (alarmId, surface) 2회 fire = 1회 deliver + 1회 suppress.
 * - 같은 alarmId 다른 surface는 모두 deliver (multi-surface 의도 정합).
 * - backend SSoT mirror에 없는 alarmId = reject (mirror fresh 일 때).
 * - SSoT.passedStations에 stationId 있으면 reject (T9 cross-cut).
 */

/**
 * 4 surface 식별자. 각 surface는 자체 native API 또는 store를 wrap한다.
 *
 * - banner: expo-notifications scheduleNotificationAsync (trigger: null = 즉시 발사)
 * - live-activity: modules/live-activity ensureLiveActivityRegistered / updateLiveActivity
 * - widget: features/widget saveStationToWidget
 * - in-app: useAlarmEventStore.setAlarmEvent (in-app banner UI)
 */
export type NotificationSurface =
  | 'banner'
  | 'live-activity'
  | 'widget'
  | 'in-app';

/**
 * fire path 식별자 (delivery log + observability용). router 자체 동작에는 영향 없음.
 *
 * - fg: FG GPS path (useStationAlarm runSilenceGateAndDispatch)
 * - fg-arvlcd: FG arvlcd fast-path (useStationAlarm)
 * - fg-subsurface: FG subsurface station-passed (useStationAlarm)
 * - fg-phase: FG phase-based fireAndLog (useStationAlarm fireAndLog)
 * - bg-silent-push: BG silent push handler (silentPushTask)
 */
export type NotificationSource =
  | 'fg'
  | 'fg-arvlcd'
  | 'fg-subsurface'
  | 'fg-phase'
  | 'bg-silent-push';

export interface DeliveryRequest {
  /**
   * backend SSoT.alarmEvents의 hash key (`hash(tripToken, stationId, type)`).
   * backend에서 발급된 값을 silent push payload로 받아 그대로 사용. FG가 backend mirror에서
   * 매칭되는 항목이 없으면 fallback id 사용 — `gate-alarm-not-in-ssot` reject 사유로 기록.
   */
  alarmId: string;
  /**
   * 시각적 dedup key (운영자 가독용). `'station-passed:중곡'` / `'transfer-imminent:건대'`.
   * router 내부 dedup에는 사용하지 않고 log에만 stamp.
   */
  eventKey: string;
  surface: NotificationSurface;
  content: {
    title: string;
    body: string;
    data?: Record<string, unknown>;
  };
  source: NotificationSource;
  /** 사용자 sleep mode ON 여부 (호출자가 store에서 읽어 전달). false 또는 undefined = OFF. */
  sleepMode?: boolean;
  /** 본 alarm이 sleep rule 적용 대상인지 (transfer/station-passed only). */
  sleepRuleEligible?: boolean;
}

export type DeliveryReason =
  | 'gate-alarm-not-in-ssot' // backend SSoT mirror에 alarmId 부재 (mirror fresh).
  | 'gate-station-already-passed' // SSoT.passedStations에 stationId 있음 (T9 cross-cut).
  | 'gate-sleep-mode-blocked' // sleepMode ON + sleepRuleEligible alarm.
  | 'dedup-same-surface'; // 동일 (alarmId, surface) 이미 deliver됨.

export interface DeliveryResult {
  delivered: boolean;
  reason?: DeliveryReason;
  surface: NotificationSurface;
  deliveredAt: number;
}

export interface NotificationRouter {
  deliver(req: DeliveryRequest): Promise<DeliveryResult>;
  /**
   * trip 종료 시 호출. dedup map + 진행 중인 native surface state(banner queue / LA / widget)
   * 까지 일괄 클리어. tripBoundCleanups에서 fire-and-forget 호출.
   */
  clearAllForTrip(): Promise<void>;
}
