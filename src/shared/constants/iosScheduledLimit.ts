/**
 * iOS pending local notification 64개 한도 분배 상수 (#1757, #1538 Sub 2).
 *
 * Sub 1 (#1756)에서 boardingLockScheduler.DEFAULT_WINDOW_SIZE를 Infinity로 변경해
 * BL 채널이 route 전체를 사전 예약 — 64 한도 초과 위험. 본 상수로 채널별 quota를 고정한다.
 *
 * 분배 근거:
 *   iOS 한도:           64
 *   safety buffer:       4  (silent push delivery 1~2건 + 시스템 여유)
 *   분배 가능:          60
 *
 *   BL (boardingLock):  30  — lock 활성 시 destination + 환승 all waypoint × 2 phase.
 *                            서울 최장 노선(9호선 급행 38 stop) 기준 waypoint 수는 소수.
 *                            직접 destination: 1 waypoint × 2 = 2건.
 *                            1환승: 2 waypoints × 2 = 4건.
 *                            다환승(3~4): 4~5 waypoints × 2 = 8~10건.
 *                            30으로 다환승 ~ 종점까지 여유 보유.
 *   TBA (trip-bound):   24  — lockless / lock 미확정 시 역 시퀀스 × 2 phase rolling window.
 *                            기존 TRIPBOUND_WINDOW_SIZE=20 → 12 stop × 2 = 24건.
 *                            BL 활성 후 tba: cancel이 발생하지만 양 채널 동시 존재 과도기 허용.
 *   TRANSFER (예비):     6  — 환승 직후 leg 전환 과도기 중복 허용 버퍼.
 *                            BL + TBA 각각 다음 window로 채우는 순간 일시적 중복 최대 6건.
 *
 *   합계: 30 + 24 + 6 = 60 ≤ 60 (buffer 포함 총 64).
 *
 * 채널별 적용:
 *   - BL_QUOTA: scheduleHopsForLock / advanceHopWindow의 window 상한.
 *               DEFAULT_WINDOW_SIZE=Infinity 는 유지 — advance 로직의 "route 끝까지" 의미.
 *               실제 OS 예약 수는 본 quota로 cap.
 *   - TBA_QUOTA: prescheduleStationAlerts의 windowSize 기본값으로 대체.
 *                기존 TRIPBOUND_WINDOW_SIZE=20 stop × 2 phase = 40건이었으나
 *                quota 12 stop × 2 phase = 24건으로 조정.
 *   - TRANSFER_QUOTA: 과도기 버퍼. 현재 코드에서 채널로 예약되지 않고 BL/TBA margin 내에 흡수됨.
 *                     향후 환승 전용 채널 도입 시 사용 예정 (현재는 문서화/측정용).
 */

/** iOS pending notification 절대 한도. */
export const IOS_NOTIFICATION_HARD_LIMIT = 64;

/** 시스템 여유 + silent push delivery용 buffer. */
export const IOS_NOTIFICATION_SAFETY_BUFFER = 4;

/** 앱이 사용 가능한 분배 가능 quota 합계. */
export const IOS_NOTIFICATION_USABLE_QUOTA = IOS_NOTIFICATION_HARD_LIMIT - IOS_NOTIFICATION_SAFETY_BUFFER;

/**
 * boardingLock 채널 (bl:) OS 예약 최대 건수.
 * scheduleHopsForLock / advanceHopWindow 내 실제 예약 건수 상한.
 * 2 phase(early+imminent) × waypoint 수이므로 waypoint 기준 15 stop에 해당.
 */
export const BL_QUOTA = 30;

/**
 * trip-bound 채널 (tba:) OS 예약 최대 건수.
 * prescheduleStationAlerts의 windowSize 기본값으로 사용.
 * 2 phase(early+imminent) × 12 stop = 24건.
 *
 * @see TBA_WINDOW_SIZE — stop 단위 환산값 (TBA_QUOTA / 2).
 */
export const TBA_QUOTA = 24;

/**
 * TBA_QUOTA를 stop 개수로 환산 (각 stop에 2 phase 예약).
 * prescheduleStationAlerts의 windowSize 파라미터는 stop 단위이므로 이 값을 넘긴다.
 */
export const TBA_WINDOW_SIZE = TBA_QUOTA / 2; // 12

/**
 * 환승 leg 전환 과도기 중복 버퍼.
 * 현재는 BL + TBA margin 내에서 흡수되며 별도 채널로 예약되지 않는다.
 * 향후 환승 전용 채널 도입 시 명시 적용 예정.
 */
export const TRANSFER_QUOTA = IOS_NOTIFICATION_USABLE_QUOTA - BL_QUOTA - TBA_QUOTA; // 6

/**
 * BL_QUOTA를 waypoint 개수로 환산 (각 waypoint에 2 phase 예약).
 * scheduleHopsForLock / advanceHopWindow 의 lastIdx cap에 사용.
 * 각 hop이 최대 2건(early + imminent)을 OS 큐에 push하므로 BL_QUOTA / 2 = 15.
 */
export const BL_MAX_WAYPOINTS = BL_QUOTA / 2; // 15
