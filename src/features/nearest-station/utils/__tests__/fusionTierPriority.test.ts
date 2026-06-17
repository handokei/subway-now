import {
  FUSION_TIER_PRIORITY,
  getTierRank,
  tierFor,
  type FusionTier,
} from '../fusionTierPriority';
import type { FusionConfidence, FusionSource } from '../../../../shared/types/fusion';

describe('fusionTierPriority (R-10, #1168)', () => {
  describe('FUSION_TIER_PRIORITY table', () => {
    it('spec §4.2 순서 — wifi-ssid가 최상위, gps-only가 최하위', () => {
      expect(FUSION_TIER_PRIORITY[0]).toBe<FusionTier>('wifi-ssid');
      expect(FUSION_TIER_PRIORITY[FUSION_TIER_PRIORITY.length - 1]).toBe<FusionTier>('gps-only');
    });

    it('boarding-lock-train-match가 position-train보다 상위', () => {
      expect(FUSION_TIER_PRIORITY.indexOf('boarding-lock-train-match')).toBeLessThan(
        FUSION_TIER_PRIORITY.indexOf('position-train'),
      );
    });

    it('position-train > fused-position > fused-arrival-* > route-progress > estimator-* > detection-fused > gps-*', () => {
      const order: FusionTier[] = [
        'position-train',
        'fused-position',
        'fused-arrival-confirmed',
        'fused-arrival-arriving',
        'route-progress',
        'estimator-live-position',
        'estimator-arrival-eta',
        'estimator-reanchored-hop',
        'detection-fused',
        'gps-only-underground',
        'gps-only',
      ];
      const ranks = order.map((t) => FUSION_TIER_PRIORITY.indexOf(t));
      const sorted = [...ranks].sort((a, b) => a - b);
      expect(ranks).toEqual(sorted);
      ranks.forEach((r) => expect(r).toBeGreaterThanOrEqual(0));
    });

    it('표에 중복 없음', () => {
      expect(new Set(FUSION_TIER_PRIORITY).size).toBe(FUSION_TIER_PRIORITY.length);
    });
  });

  describe('getTierRank', () => {
    it('표에 있는 tier는 indexOf 결과 반환', () => {
      expect(getTierRank('wifi-ssid')).toBe(0);
      expect(getTierRank('gps-only')).toBe(FUSION_TIER_PRIORITY.length - 1);
    });

    it('표에 없는 tier(타입 위반)는 Infinity — 정렬 시 최하위', () => {
      expect(getTierRank('unknown' as unknown as FusionTier)).toBe(Number.POSITIVE_INFINITY);
    });
  });

  describe('tierFor — (source, confidence) → FusionTier 매핑', () => {
    const cases: ReadonlyArray<[FusionSource, FusionConfidence, FusionTier]> = [
      ['wifi-ssid', 'wifi-ssid', 'wifi-ssid'],
      ['boarding-lock', 'boarding-lock', 'boarding-lock-train-match'],
      ['boarding-lock-interp', 'boarding-lock-interp', 'estimator-live-position'],
      ['position-train', 'position-train', 'position-train'],
      ['position', 'arrival-confirmed', 'fused-position'],
      ['position', 'arrival-arriving', 'fused-position'],
      ['arrival', 'arrival-confirmed', 'fused-arrival-confirmed'],
      ['arrival', 'arrival-arriving', 'fused-arrival-arriving'],
      ['route-progress', 'route-progress', 'route-progress'],
      ['gps', 'gps-only', 'gps-only'],
      ['gps', 'gps-only-underground', 'gps-only-underground'],
      // #1398 — detection-fused는 source='gps' 유지 + confidence 라벨만 승격.
      ['gps', 'detection-fused', 'detection-fused'],
    ];

    it.each(cases)('source=%s + confidence=%s → tier=%s', (source, confidence, expected) => {
      expect(tierFor(source, confidence)).toBe(expected);
    });

    it('position source는 confidence와 무관하게 fused-position', () => {
      expect(tierFor('position', 'arrival-confirmed')).toBe('fused-position');
      expect(tierFor('position', 'arrival-arriving')).toBe('fused-position');
    });
  });

  describe('tier 비교 — spec §1.4 trust 순서', () => {
    it('position-train > fused-position', () => {
      expect(getTierRank('position-train')).toBeLessThan(getTierRank('fused-position'));
    });

    it('fused-position > fused-arrival-confirmed', () => {
      expect(getTierRank('fused-position')).toBeLessThan(getTierRank('fused-arrival-confirmed'));
    });

    it('route-progress > gps-only', () => {
      expect(getTierRank('route-progress')).toBeLessThan(getTierRank('gps-only'));
    });

    it('gps-only-underground > gps-only — 지하 라벨이 한 단계 위', () => {
      expect(getTierRank('gps-only-underground')).toBeLessThan(getTierRank('gps-only'));
    });

    it('#1398 — detection-fused > gps-only-underground — verdict 결합 라벨이 단순 강등보다 신뢰', () => {
      expect(getTierRank('detection-fused')).toBeLessThan(getTierRank('gps-only-underground'));
    });
  });
});
