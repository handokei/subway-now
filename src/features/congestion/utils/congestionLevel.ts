import type { CongestionLevel } from '../../../shared/types/congestion';

/**
 * 서울교통공사 공식 혼잡도 단계 임계값 (%).
 * - low: < 80
 * - medium: 80 ~ < 130
 * - high: 130 ~ < 150
 * - veryHigh: >= 150
 *
 * 출처: 서울교통공사 혼잡도 안내 (좌석 100%, 손잡이 130%, 밀착 150%).
 */
export const CONGESTION_THRESHOLDS = {
  medium: 80,
  high: 130,
  veryHigh: 150,
} as const;

export function classifyCongestion(raw: number): CongestionLevel {
  if (raw >= CONGESTION_THRESHOLDS.veryHigh) return 'veryHigh';
  if (raw >= CONGESTION_THRESHOLDS.high) return 'high';
  if (raw >= CONGESTION_THRESHOLDS.medium) return 'medium';
  return 'low';
}
