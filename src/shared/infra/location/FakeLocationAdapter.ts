/**
 * FakeLocationAdapter — LocationPort의 in-memory 가짜 구현체.
 *
 * ADR Roadmap — Feature-based + Ports & Adapters Phase 3/5 (#886).
 *
 * 목적:
 *   E2E/단위 테스트에서 expo-location을 jest.mock 없이 어댑터 교체만으로 격리할 수 있도록
 *   in-memory 위치 fixture를 노출한다. 현재 코드베이스의 jest.mock('expo-location') 기반
 *   테스트는 그대로 유지되며, Phase 5에서 본 어댑터 기반으로 일괄 전환한다.
 *
 * 사용 예 (Phase 5 이후):
 *   ```
 *   const fake = createFakeLocationAdapter({
 *     latitude: 37.5, longitude: 127.0, accuracy: 10, speed: 0,
 *   });
 *   const result = await someHook(fake);
 *   ```
 *
 * @see src/features/nearest-station/ports/LocationPort.ts
 */

import type { LocationFix, LocationPermissionResult, LocationPort } from '../../ports/LocationPort';

export interface FakeLocationAdapterOptions {
  /** 초기 위치 — 지정하지 않으면 서울시청. */
  initial?: Partial<LocationFix>;
  /** requestForegroundPermissions 응답 — 기본 granted=true. */
  permissions?: LocationPermissionResult;
}

const SEOUL_CITY_HALL: LocationFix = {
  latitude: 37.566,
  longitude: 126.977,
  accuracy: 10,
  speed: 0,
  timestamp: 0,
};

/**
 * Stateful fake adapter — setPosition 으로 측정값을 갈아끼울 수 있다.
 */
export interface FakeLocationAdapter extends LocationPort {
  setPosition(fix: Partial<LocationFix>): void;
}

export function createFakeLocationAdapter(options: FakeLocationAdapterOptions = {}): FakeLocationAdapter {
  let current: LocationFix = { ...SEOUL_CITY_HALL, ...options.initial };
  const perms: LocationPermissionResult = options.permissions ?? { granted: true, background: false };

  return {
    async getCurrentPosition(): Promise<LocationFix> {
      return { ...current };
    },
    async requestForegroundPermissions(): Promise<LocationPermissionResult> {
      return { ...perms };
    },
    setPosition(fix: Partial<LocationFix>): void {
      current = { ...current, ...fix };
    },
  };
}
