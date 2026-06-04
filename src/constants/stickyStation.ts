// #876 — Sticky Station 임계 상수.
//
// trip이 없을 때(탑승 전 / 환승 대기 / 단순 위치 확인) 백엔드 정답을 줄 트리거가 없다 —
// 클라가 GPS-only 회귀. 지하 진입 후 50~100m 정확도 fix가 250m 표시 게이트를 통과해
// 부정확한 역으로 흔들리는 회귀를 막기 위해, 지상에서 잠깐 좋은 fix가 잡힐 때 그 역을
// lock한다.
//
// 알람 트리거에는 영향 없음 — sticky는 표시(currentStation)에만 영향. 알람 경로는 별도
// 엄격 게이트(MAX_ACCURACY_M=200m, useStationAlarm)에서 차단된다.

/** 좋은 fix 정확도 임계값. 알람 엄격 게이트(200m)보다 훨씬 보수적. */
export const STICKY_GOOD_FIX_ACCURACY_M = 50;

/** 좋은 fix 속도 임계값(m/s). 1 m/s 미만 = 정지(서거나 걷기 시작 직전). */
export const STICKY_GOOD_FIX_SPEED_MAX_MPS = 1;

/** 같은 역 N회 연속 좋은 fix → lock. FG 폴링 2s 기준 ~6초 안정 관찰. */
export const STICKY_LOCK_CONSECUTIVE_COUNT = 3;

/** Lock TTL(ms). 30분. stale lock 방지 — 사용자가 앱 켜두고 다른 곳으로 이동한 후 복귀 케이스. */
export const STICKY_TTL_MS = 30 * 60 * 1000;

/** Unlock 거리 임계값(km). 다른 역으로 진짜 이동했다고 판단. */
export const STICKY_UNLOCK_DISTANCE_KM = 1.0;
