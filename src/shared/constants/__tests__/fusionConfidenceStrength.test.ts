import {
  STRONG_FUSION_CONFIDENCE,
  isStrongFusionConfidence,
} from '../fusionConfidenceStrength';
import type { FusionConfidence } from '../../types/fusion';

describe('STRONG_FUSION_CONFIDENCE (#1541)', () => {
  // ADR-014 §4 사용자 명시 의향 동급 보호 원칙: 실측 신호만 강 신호로 분류.
  // 시간 적분/거리 기반 추정(*-interp, gps-only*, route-progress)은 약 신호.
  const STRONG_CASES: readonly FusionConfidence[] = [
    'boarding-lock',
    'position-train',
    'arrival-confirmed',
    'wifi-ssid',
  ];
  const WEAK_CASES: readonly FusionConfidence[] = [
    'boarding-lock-interp',
    'arrival-arriving',
    'route-progress',
    'gps-only',
    'gps-only-underground',
    'detection-fused',
  ];

  it.each(STRONG_CASES)('%s는 강 신호로 분류된다', (c) => {
    expect(STRONG_FUSION_CONFIDENCE.has(c)).toBe(true);
    expect(isStrongFusionConfidence(c)).toBe(true);
  });

  it.each(WEAK_CASES)('%s는 약 신호로 분류된다 (override 게이트 통과 X)', (c) => {
    expect(STRONG_FUSION_CONFIDENCE.has(c)).toBe(false);
    expect(isStrongFusionConfidence(c)).toBe(false);
  });

  it.each([null, undefined])('%p은 약 신호로 처리된다', (c) => {
    expect(isStrongFusionConfidence(c)).toBe(false);
  });
});
