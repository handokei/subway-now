/**
 * #2817 — LA fallback 알림(iOS LA 비활성/예외, Android) dedup TTL. 매 GPS poll마다
 * 거리/ETA가 바뀌어 content 기준 dedup이 무력화되던 회귀(같은 역 초당 ×3 버스트)를 막기 위해
 * 역 정체성(stationName) + 이 시간창 기준으로 교체한다(`stationNotification.ts`
 * `scheduleFallbackStationNotification`). GPS poll 주기(수 초~수십 초) 대비 여유를 두면서도
 * 실제 역 이동(수십 초~수 분 간격) 알림은 억제하지 않는 값.
 */
export const LA_FALLBACK_DEDUP_TTL_MS = 45 * 1000;
