import {
  FUSION_TIER_PRIORITY,
  getTierRank,
  tierFor,
  type FusionTier,
} from '../fusionTierPriority';
import type { FusionConfidence, FusionSource } from '../../../../shared/types/fusion';

describe('fusionTierPriority (R-10, #1168)', () => {
  describe('FUSION_TIER_PRIORITY table', () => {
    it('spec §4.2 순서 — backend-ssot가 최상위, gps-only가 최하위 (#1568 T8b)', () => {
      expect(FUSION_TIER_PRIORITY[0]).toBe<FusionTier>('backend-ssot');
      expect(FUSION_TIER_PRIORITY[FUSION_TIER_PRIORITY.length - 1]).toBe<FusionTier>('gps-only');
    });

    it('#1568 (T8b) — backend-ssot이 wifi-ssid보다 상위', () => {
      expect(FUSION_TIER_PRIORITY.indexOf('backend-ssot')).toBeLessThan(
        FUSION_TIER_PRIORITY.indexOf('wifi-ssid'),
      );
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
      expect(getTierRank('backend-ssot')).toBe(0);
      expect(getTierRank('wifi-ssid')).toBe(1);
      expect(getTierRank('gps-only')).toBe(FUSION_TIER_PRIORITY.length - 1);
    });

    it('표에 없는 tier(타입 위반)는 Infinity — 정렬 시 최하위', () => {
      expect(getTierRank('unknown' as unknown as FusionTier)).toBe(Number.POSITIVE_INFINITY);
    });
  });

  describe('tierFor — (source, confidence) → FusionTier 매핑', () => {
    const cases: ReadonlyArray<[FusionSource, FusionConfidence, FusionTier]> = [
      ['backend-ssot', 'backend-ssot', 'backend-ssot'],
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
    // 5 케이스 모두 동일 단언 패턴 — getTierRank(상위) < getTierRank(하위). cpd 방지로 테이블화.
    it.each<{ label: string; higher: FusionTier; lower: FusionTier }>([
      { label: 'position-train > fused-position', higher: 'position-train', lower: 'fused-position' },
      {
        label: 'fused-position > fused-arrival-confirmed',
        higher: 'fused-position',
        lower: 'fused-arrival-confirmed',
      },
      { label: 'route-progress > gps-only', higher: 'route-progress', lower: 'gps-only' },
      {
        label: 'gps-only-underground > gps-only — 지하 라벨이 한 단계 위',
        higher: 'gps-only-underground',
        lower: 'gps-only',
      },
      {
        label: '#1398 — detection-fused > gps-only-underground — verdict 결합 라벨이 단순 강등보다 신뢰',
        higher: 'detection-fused',
        lower: 'gps-only-underground',
      },
    ])('$label', ({ higher, lower }) => {
      expect(getTierRank(higher)).toBeLessThan(getTierRank(lower));
    });
  });
});
