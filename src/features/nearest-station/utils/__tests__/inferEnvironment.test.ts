import { inferEnvironment } from '../inferEnvironment';

describe('inferEnvironment', () => {
  it('subsurface=true 명시 → underground', () => {
    expect(
      inferEnvironment({ subsurface: true, surfaceSSOT: false, undergroundSSOT: false }).label,
    ).toBe('underground');
  });

  it('subsurface=true는 surfaceSSOT가 활성이어도 underground 우선 (barometer 확정)', () => {
    expect(
      inferEnvironment({ subsurface: true, surfaceSSOT: true, undergroundSSOT: false }).label,
    ).toBe('underground');
  });

  it('subsurface=false + surfaceSSOT 활성 → surface', () => {
    expect(
      inferEnvironment({ subsurface: false, surfaceSSOT: true, undergroundSSOT: false }).label,
    ).toBe('surface');
  });

  it('subsurface=false + undergroundSSOT 활성(지상 SSOT 없음) → underground (지하상가)', () => {
    expect(
      inferEnvironment({ subsurface: false, surfaceSSOT: false, undergroundSSOT: true }).label,
    ).toBe('underground');
  });

  it('subsurface=false + 둘 다 null → unknown', () => {
    expect(
      inferEnvironment({ subsurface: false, surfaceSSOT: false, undergroundSSOT: false }).label,
    ).toBe('unknown');
  });

  it('subsurface=undefined + surfaceSSOT만 활성 → surface (hybrid)', () => {
    expect(
      inferEnvironment({ subsurface: undefined, surfaceSSOT: true, undergroundSSOT: false }).label,
    ).toBe('surface');
  });

  it('subsurface=undefined + undergroundSSOT만 활성 → underground (hybrid)', () => {
    expect(
      inferEnvironment({ subsurface: undefined, surfaceSSOT: false, undergroundSSOT: true }).label,
    ).toBe('underground');
  });

  it('subsurface=undefined + 둘 다 활성 → unknown (분간 불가)', () => {
    expect(
      inferEnvironment({ subsurface: undefined, surfaceSSOT: true, undergroundSSOT: true }).label,
    ).toBe('unknown');
  });

  it('subsurface=undefined + 둘 다 null → unknown', () => {
    expect(
      inferEnvironment({ subsurface: undefined, surfaceSSOT: false, undergroundSSOT: false }).label,
    ).toBe('unknown');
  });

  describe('#1860 barometer-stop hintReason', () => {
    it('tripActive + barometerStop=true + subsurface=false + SSOT 없음 → hintReason 발동', () => {
      const result = inferEnvironment({
        subsurface: false,
        surfaceSSOT: false,
        undergroundSSOT: false,
        tripActive: true,
        barometerStop: true,
      });
      expect(result.label).toBe('unknown');
      expect(result.hintReason).toBe('barometer-stop');
    });

    it('tripActive=false이면 hintReason 미발동', () => {
      const result = inferEnvironment({
        subsurface: false,
        surfaceSSOT: false,
        undergroundSSOT: false,
        tripActive: false,
        barometerStop: true,
      });
      expect(result.hintReason).toBeUndefined();
    });

    it('barometerStop=false이면 hintReason 미발동', () => {
      const result = inferEnvironment({
        subsurface: false,
        surfaceSSOT: false,
        undergroundSSOT: false,
        tripActive: true,
        barometerStop: false,
      });
      expect(result.hintReason).toBeUndefined();
    });

    it('surfaceSSOT 활성 시 hintReason 미발동 (surface 반환 우선)', () => {
      const result = inferEnvironment({
        subsurface: false,
        surfaceSSOT: true,
        undergroundSSOT: false,
        tripActive: true,
        barometerStop: true,
      });
      expect(result.label).toBe('surface');
      expect(result.hintReason).toBeUndefined();
    });

    it('hintReason은 subsurface=false 경로에서만 발동 (undefined는 미발동)', () => {
      const result = inferEnvironment({
        subsurface: undefined,
        surfaceSSOT: false,
        undergroundSSOT: false,
        tripActive: true,
        barometerStop: true,
      });
      expect(result.hintReason).toBeUndefined();
    });
  });
});
