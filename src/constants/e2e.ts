/**
 * E2E mock mode 빌드 타임 상수.
 * EXPO_PUBLIC_E2E_MOCK=true로 빌드된 번들에서만 true.
 * 프로덕션 빌드에서는 false 상수로 인라인되어 mock 분기가 dead-code-eliminate된다.
 */
export const IS_E2E_MOCK = process.env.EXPO_PUBLIC_E2E_MOCK === 'true';

/**
 * mock 모드에서 노출할 고정 좌표 — 강남역 2호선 (stations.json id "강남-2"와 동일).
 * 좌표가 stations.json과 어긋나면 거리 임계값에서 미세 flake가 날 수 있으니
 * 정본 데이터와 항상 일치시킨다.
 */
export const E2E_MOCK_LOCATION = {
  latitude: 37.49799,
  longitude: 127.027912,
  accuracyMeters: 10,
  speedMps: 0,
} as const;
