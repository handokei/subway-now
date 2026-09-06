/* eslint-disable import/no-restricted-paths -- shared test fixtures cross feature slices */
/**
 * #1605 — backend SSoT mirror cascade 테스트 공통 fixture.
 * useFusedNearestStation.backendSsotCascade / estimatorBackendSsotOverride 등 여러 테스트가 같은
 * mirror entry 빌더를 사용 — 중복 제거 + schema drift 방지.
 *
 * jest.mock 자체는 caller가 직접 (compile-time hoist) 호출하고, 본 모듈은 entry 생성/타이밍
 * 유틸만 제공한다.
 */

import { act } from '@testing-library/react-native';
import type { BackendSsotMirrorEntry } from '../features/alarm/utils/backendSsotMirror';

/**
 * 테스트 기본 시각. 호출자가 jest.setSystemTime + Date.now 기준값으로 사용.
 * 정수 epoch ms — 시계 후진 검증 시 큰 값에서 -240_000 등 안전.
 */
export const BACKEND_SSOT_FIXTURE_T0 = 1_700_000_000_000;

/**
 * BackendSsotMirrorEntry 기본값 + overrides 빌더.
 *
 * 기본값: 용마산(7) currentStationId / 'moving' / arvlcd-arrived evidence / lastAdvanceAt=T0 / passedStations 비어있음.
 * 호출자는 currentStationId/lastAdvanceAt/receivedAt 등을 override해 fresh/stale/cross-line 시나리오를 만든다.
 *
 * stationName 기본값을 '용마산'로 둔 이유: cascade 테스트 두 시나리오가 모두 같은 origin 가정으로
 * 시작 — fixture는 시나리오 setup의 일부, station id 차이는 override로 명시.
 */
export function makeBackendSsotMirrorEntry(
  overrides: Partial<BackendSsotMirrorEntry> = {},
): BackendSsotMirrorEntry {
  return {
    currentStationId: '용마산',
    motionState: 'moving',
    lastAdvanceEvidence: 'arvlcd-arrived',
    lastAdvanceAt: BACKEND_SSOT_FIXTURE_T0,
    passedStations: [],
    receivedAt: BACKEND_SSOT_FIXTURE_T0,
    ...overrides,
  };
}

/**
 * useFusedNearestStation 내부 5s setInterval 1 tick + microtask flush.
 * mockRead가 resolveValue로 entry를 반환할 때 cascade reducer가 state를 hydrate하도록 보장.
 */
export async function flushBackendSsotMirrorTick(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(5_000);
    await Promise.resolve();
  });
}
