import { haversine } from '../../../utils/haversine';

// 0.5m/s 미만은 GPS 정지 노이즈로 간주. 역 진입 시 감속(1~5m/s)은 통과시켜 imminent phase가 동작하도록 한다.
const MIN_VALID_SPEED_MPS = 0.5;

export function estimateEtaSeconds(
  distanceMeters: number,
  speedMps: number | null,
): number | null {
  if (speedMps === null || speedMps < MIN_VALID_SPEED_MPS) return null;
  return distanceMeters / speedMps;
}

export function distanceMetersBetween(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): number {
  return haversine(fromLat, fromLng, toLat, toLng) * 1000;
}
