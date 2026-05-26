import {
  MAX_ACCURACY_M,
  MAX_ACCURACY_M_DISPLAY,
  MAX_LOCATION_AGE_MS,
  MAX_PLAUSIBLE_SPEED_MPS,
  MIN_JUMP_DISTANCE_M,
} from '../constants/location';
import { haversine } from './haversine';

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

export interface FixSample {
  lat: number;
  lng: number;
  timestamp: number;
}

// 21:29 효창공원앞↔신내 25km/8s 텔레포트(#527) 같은 비현실 좌표 점프를 차단한다.
// 게이트 통과 조건:
//   - prev null (콜드스타트) → 통과
//   - dtMs <= 0 (중복 fix) → 통과
//   - 거리 < MIN_JUMP_DISTANCE_M → GPS 노이즈 범위로 간주, 속도 검사 면제
//   - 거리 >= MIN_JUMP_DISTANCE_M → 속도 <= MAX_PLAUSIBLE_SPEED_MPS면 통과
//
// 플랜의 "짧은 Δt 보강(<5s && >500m)"은 현 속도 임계값(50 m/s)보다 항상 약한 조건이라
// dead branch가 되어 제외. 운영에서 timestamp 노이즈 케이스 관찰되면 #495에서 재도입.
export function isPlausibleJump(prev: FixSample | null, curr: FixSample): boolean {
  if (!prev) return true;
  const dtMs = curr.timestamp - prev.timestamp;
  if (dtMs <= 0) return true;
  const distanceM = haversine(prev.lat, prev.lng, curr.lat, curr.lng) * 1000;
  if (distanceM < MIN_JUMP_DISTANCE_M) return true;
  const speedMps = distanceM / (dtMs / 1000);
  return speedMps <= MAX_PLAUSIBLE_SPEED_MPS;
}
