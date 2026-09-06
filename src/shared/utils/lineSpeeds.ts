/**
 * 거리(m) ÷ 노선 평균 속도(km/h) → 초 단위 hop 시간 추정.
 *
 * `stationRoute.getStopSeconds` fallback 경로에서 사용 — 실측 운행 시간
 * (`stationTravelTimes.json`)이 미커버인 노선의 hop을 기존 120s 고정
 * fallback 대신 거리·속도 기반 추정으로 대체한다(#1472).
 *
 * km/h → m/s: speed * 1000 / 3600. seconds = distanceMeters / m_per_s.
 */

import type { LineNumber } from '../types/station';
import { LINE_AVERAGE_SPEED_KMH } from '../constants/lineSpeeds';

export function getStopSecondsFromDistance(
  line: LineNumber,
  distanceMeters: number,
): number {
  const speedKmh = LINE_AVERAGE_SPEED_KMH[line];
  const mPerS = (speedKmh * 1000) / 3600;
  return distanceMeters / mPerS;
}
