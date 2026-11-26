import type { MapMode } from '../hooks/useMapMode';

interface LocationGateInput {
  readonly permissionDenied: boolean;
  readonly loading: boolean;
  readonly userLocation: unknown;
  readonly error: unknown;
}

/**
 * #3371 — 위치 상태 화면(LocationStateView) 조기 반환 여부.
 * 지도 모드는 기존 동작 그대로, 노선도 모드는 위치 없이도 렌더되므로 게이트를 우회한다
 * (위치가 없으면 가까운 역 강조만 생략).
 */
export function shouldShowLocationGate(mode: MapMode, input: LocationGateInput): boolean {
  if (mode === 'schematic') return false;
  const { permissionDenied, loading, userLocation, error } = input;
  return permissionDenied || loading || !userLocation || Boolean(error);
}
