/**
 * iOS pending local notification 64개 한도 상수 (#1757, #1538 Sub 2 → #2089 통합 이후 축소).
 *
 * #2089 — OS 예약 스케줄러 3종(alarmScheduler/tripBoundScheduler/boardingLockScheduler)이
 * `safetyNetScheduler` 단일 모듈로 통합되며 역할이 "주 발사 채널"에서 "취침모드 한정
 * backend-outage 백업"으로 격하됐다. 예약 단위도 (early, imminent) 2 phase × window에서
 * waypoint(환승/도착)당 단일 fire 1건으로 축소되어, BL/TBA/TRANSFER 채널별 quota 분배가
 * 더 이상 필요 없다 — safetyNetScheduler 전용 단일 cap({@link SAFETY_NET_MAX_WAYPOINTS})으로 대체.
 */

/** iOS pending notification 절대 한도. */
export const IOS_NOTIFICATION_HARD_LIMIT = 64;

/** 시스템 여유 + silent push delivery용 buffer. */
export const IOS_NOTIFICATION_SAFETY_BUFFER = 4;

/** 앱이 사용 가능한 분배 가능 quota 합계. */
export const IOS_NOTIFICATION_USABLE_QUOTA = IOS_NOTIFICATION_HARD_LIMIT - IOS_NOTIFICATION_SAFETY_BUFFER;

/**
 * safetyNetScheduler(#2089) OS 예약 최대 waypoint(환승/도착) 개수 — "iOS 64-cap 분배" 하드닝 보존.
 *
 * waypoint당 단일 fire 1건만 예약하므로(2 phase 폐지) 서울 최장 노선(9호선 급행 38 stop) 기준
 * 다환승 trip도 waypoint 수는 소수(직접 1개 / 1환승 2개 / 다환승 4~5개)라 64 한도에 실질적으로
 * 도달하지 않는다. 그럼에도 방어적으로 IOS_NOTIFICATION_USABLE_QUOTA 이내로 cap해 OS 제약을
 * 구조적으로 보장한다.
 */
export const SAFETY_NET_MAX_WAYPOINTS = IOS_NOTIFICATION_USABLE_QUOTA;
