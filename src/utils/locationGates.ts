import { MAX_ACCURACY_M, MAX_ACCURACY_M_DISPLAY, MAX_LOCATION_AGE_MS } from '../constants/location';

export function isLocationFresh(timestamp: number | undefined): boolean {
  // expo-location 타입상 timestamp는 non-nullable이지만, 네이티브 deferred batch에서
  // 누락된 사례가 보고된 적이 있어 방어적으로 null 체크를 유지한다.
  if (timestamp == null) return false;
  return Date.now() - timestamp <= MAX_LOCATION_AGE_MS;
}

export function isAccuracyAcceptable(accuracy: number | null | undefined): boolean {
  return accuracy == null || accuracy <= MAX_ACCURACY_M;
}

export function isAccuracyAcceptableForDisplay(accuracy: number | null | undefined): boolean {
  return accuracy == null || accuracy <= MAX_ACCURACY_M_DISPLAY;
}
