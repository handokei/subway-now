import { inferEnvironment } from '../inferEnvironment';

describe('inferEnvironment', () => {
  // ── 기존 케이스 (backward-compat) ──────────────────────────────────────────
  it('subsurface=true 명시 → underground', () => {
    expect(
      inferEnvironment({ subsurface: true, surfaceSSOT: false, undergroundSSOT: false }),
    ).toEqual({ label: 'underground' });
  });

  it('subsurface=true는 surfaceSSOT가 활성이어도 underground 우선 (barometer 확정)', () => {
    expect(
      inferEnvironment({ subsurface: true, surfaceSSOT: true, undergroundSSOT: false }),
    ).toEqual({ label: 'underground' });
  });

  it('subsurface=false + surfaceSSOT 활성 → surface', () => {
    expect(
      inferEnvironment({ subsurface: false, surfaceSSOT: true, undergroundSSOT: false }),
    ).toEqual({ label: 'surface' });
  });

  it('subsurface=false + undergroundSSOT 활성(지상 SSOT 없음) → underground (지하상가)', () => {
    expect(
      inferEnvironment({ subsurface: false, surfaceSSOT: false, undergroundSSOT: true }),
    ).toEqual({ label: 'underground' });
  });

  it('subsurface=false + 둘 다 null → unknown (hintReason 없음)', () => {
    expect(
      inferEnvironment({ subsurface: false, surfaceSSOT: false, undergroundSSOT: false }),
    ).toEqual({ label: 'unknown' });
  });

  it('subsurface=undefined + surfaceSSOT만 활성 → surface (hybrid)', () => {
    expect(
      inferEnvironment({ subsurface: undefined, surfaceSSOT: true, undergroundSSOT: false }),
    ).toEqual({ label: 'surface' });
  });

  it('subsurface=undefined + undergroundSSOT만 활성 → underground (hybrid)', () => {
    expect(
      inferEnvironment({ subsurface: undefined, surfaceSSOT: false, undergroundSSOT: true }),
    ).toEqual({ label: 'underground' });
  });

  it('subsurface=undefined + 둘 다 활성 → unknown (분간 불가)', () => {
    expect(
      inferEnvironment({ subsurface: undefined, surfaceSSOT: true, undergroundSSOT: true }),
    ).toEqual({ label: 'unknown' });
  });

  it('subsurface=undefined + 둘 다 null → unknown', () => {
    expect(
      inferEnvironment({ subsurface: undefined, surfaceSSOT: false, undergroundSSOT: false }),
    ).toEqual({ label: 'unknown' });
  });

  // ── #1860 옵션 C barometer-stop 힌트 매트릭스 ─────────────────────────────
  describe('barometer-stop hint (#1860)', () => {
    it('tripActive=true + barometerStop=true + subsurface=false + SSOT 없음 → unknown + hintReason', () => {
      expect(
        inferEnvironment({
          subsurface: false,
          surfaceSSOT: false,
          undergroundSSOT: false,
          tripActive: true,
          barometerStop: true,
        }),
      ).toEqual({ label: 'unknown', hintReason: 'barometer-stop' });
    });

    it('tripActive=true + barometerStop=false → hint 없음 (이동 중)', () => {
      expect(
        inferEnvironment({
          subsurface: false,
          surfaceSSOT: false,
          undergroundSSOT: false,
          tripActive: true,
          barometerStop: false,
        }),
      ).toEqual({ label: 'unknown' });
    });

    it('tripActive=false + barometerStop=true → hint 없음 (trip 비활성 = false positive 방지)', () => {
      expect(
        inferEnvironment({
          subsurface: false,
          surfaceSSOT: false,
          undergroundSSOT: false,
          tripActive: false,
          barometerStop: true,
        }),
      ).toEqual({ label: 'unknown' });
    });

    it('tripActive=undefined + barometerStop=true → hint 없음 (미전달 = 기존 동작)', () => {
      expect(
        inferEnvironment({
          subsurface: false,
          surfaceSSOT: false,
          undergroundSSOT: false,
          barometerStop: true,
        }),
      ).toEqual({ label: 'unknown' });
    });

    it('tripActive=true + barometerStop=undefined (warmup) → hint 없음', () => {
      expect(
        inferEnvironment({
          subsurface: false,
          surfaceSSOT: false,
          undergroundSSOT: false,
          tripActive: true,
          barometerStop: undefined,
        }),
      ).toEqual({ label: 'unknown' });
    });

    it('tripActive=true + barometerStop=true + surfaceSSOT 활성 → surface 우선 (hint 없음)', () => {
      expect(
        inferEnvironment({
          subsurface: false,
          surfaceSSOT: true,
          undergroundSSOT: false,
          tripActive: true,
          barometerStop: true,
        }),
      ).toEqual({ label: 'surface' });
    });

    it('tripActive=true + barometerStop=true + undergroundSSOT 활성 → underground 우선 (hint 없음)', () => {
      expect(
        inferEnvironment({
          subsurface: false,
          surfaceSSOT: false,
          undergroundSSOT: true,
          tripActive: true,
          barometerStop: true,
        }),
      ).toEqual({ label: 'underground' });
    });

    it('tripActive=true + barometerStop=true + subsurface=true → underground 우선 (hint 없음)', () => {
      expect(
        inferEnvironment({
          subsurface: true,
          surfaceSSOT: false,
          undergroundSSOT: false,
          tripActive: true,
          barometerStop: true,
        }),
      ).toEqual({ label: 'underground' });
    });
  });
});
