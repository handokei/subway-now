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

// #1317 — 저품질 GPS 내성 unlock.
//
// 기존 distance/better-fix unlock은 모두 "좋은 fix"(accuracy ≤ 50m)를 요구한다. 지하·도심
// 협곡에서 accuracy가 50~250m로 떨어지면(예: 용마산 trip, accuracy 52.7m, signalMask=UUF)
// 좋은 fix가 한 번도 누적되지 않아 어느 unlock 게이트도 발동하지 못하고, 출발역 lock이 영구
// 고착된다(현재역이 출발역으로 회귀). 한 번의 부정확 fix로 풀면 반대 회귀(잘못된 unlock)가
// 나므로, "여러 fix에 걸쳐 lock된 역에서 멀어진(>1km) 다른 역이 연속 관찰"되는 누적 증거로만
// 푼다 — lock 메커니즘의 N회 연속 관찰과 대칭.

/**
 * 저품질 unlock에서 허용하는 최대 accuracy(m). 표시 게이트(MAX_ACCURACY_M_DISPLAY=250m)와
 * 동일 — 쓰레기 좌표(±1.5km)는 거부하되 50~250m의 열화 fix는 누적 증거로 받아들인다.
 * useNearestStation은 이미 표시 게이트를 통과한 fix만 sticky로 흘려보내므로 이중 안전장치.
 */
export const STICKY_DEGRADED_UNLOCK_ACCURACY_M = 250;

/**
 * lock된 역에서 1km+ 떨어진 "다른 역" fix가 N회 연속 관찰되면 저품질이어도 unlock.
 * STICKY_LOCK_CONSECUTIVE_COUNT(3)와 동일한 안정 관찰 기준 — 단발성 부정확 fix는 카운트가
 * 리셋되어 풀리지 않는다(false unlock 방지).
 */
export const STICKY_DEGRADED_UNLOCK_COUNT = 3;
