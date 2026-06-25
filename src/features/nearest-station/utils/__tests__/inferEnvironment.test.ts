import { inferEnvironment } from '../inferEnvironment';

describe('inferEnvironment', () => {
  // ── 기존 경로 (backward-compat) ───────────────────────────────────────────

  it('subsurface=true 명시 → underground', () => {
    expect(
      inferEnvironment({ subsurface: true, surfaceSSOT: false, undergroundSSOT: false }),
    ).toEqual({ environment: 'underground' });
  });

  it('subsurface=true는 surfaceSSOT가 활성이어도 underground 우선 (barometer 확정)', () => {
    expect(
      inferEnvironment({ subsurface: true, surfaceSSOT: true, undergroundSSOT: false }),
    ).toEqual({ environment: 'underground' });
  });

  it('subsurface=false + surfaceSSOT 활성 → surface', () => {
    expect(
      inferEnvironment({ subsurface: false, surfaceSSOT: true, undergroundSSOT: false }),
    ).toEqual({ environment: 'surface' });
  });

  it('subsurface=false + undergroundSSOT 활성(지상 SSOT 없음) → underground (지하상가)', () => {
    expect(
      inferEnvironment({ subsurface: false, surfaceSSOT: false, undergroundSSOT: true }),
    ).toEqual({ environment: 'underground' });
  });

  it('subsurface=false + 둘 다 null, tripActive/barometerStop 미제공 → unknown (힌트 없음)', () => {
    expect(
      inferEnvironment({ subsurface: false, surfaceSSOT: false, undergroundSSOT: false }),
    ).toEqual({ environment: 'unknown' });
  });

  it('subsurface=undefined + surfaceSSOT만 활성 → surface (hybrid)', () => {
    expect(
      inferEnvironment({ subsurface: undefined, surfaceSSOT: true, undergroundSSOT: false }),
    ).toEqual({ environment: 'surface' });
  });

  it('subsurface=undefined + undergroundSSOT만 활성 → underground (hybrid)', () => {
    expect(
      inferEnvironment({ subsurface: undefined, surfaceSSOT: false, undergroundSSOT: true }),
    ).toEqual({ environment: 'underground' });
  });

  it('subsurface=undefined + 둘 다 활성 → unknown (분간 불가)', () => {
    expect(
      inferEnvironment({ subsurface: undefined, surfaceSSOT: true, undergroundSSOT: true }),
    ).toEqual({ environment: 'unknown' });
  });

  it('subsurface=undefined + 둘 다 null → unknown', () => {
    expect(
      inferEnvironment({ subsurface: undefined, surfaceSSOT: false, undergroundSSOT: false }),
    ).toEqual({ environment: 'unknown' });
  });

  // ── #1872 barometer-stop hint 분기 ───────────────────────────────────────

  it('tripActive=true + barometerStop=true + subsurface=false + SSOT 없음 → unknown + hintReason=barometer-stop', () => {
    expect(
      inferEnvironment({
        subsurface: false,
        surfaceSSOT: false,
        undergroundSSOT: false,
        tripActive: true,
        barometerStop: true,
      }),
    ).toEqual({ environment: 'unknown', hintReason: 'barometer-stop' });
  });

  it('tripActive=false → barometerStop 무시 (false positive 차단)', () => {
    expect(
      inferEnvironment({
        subsurface: false,
        surfaceSSOT: false,
        undergroundSSOT: false,
        tripActive: false,
        barometerStop: true,
      }),
    ).toEqual({ environment: 'unknown' });
  });

  it('tripActive=undefined → barometerStop 무시 (기존 caller backward-compat)', () => {
    expect(
      inferEnvironment({
        subsurface: false,
        surfaceSSOT: false,
        undergroundSSOT: false,
        barometerStop: true,
      }),
    ).toEqual({ environment: 'unknown' });
  });

  it('tripActive=true + barometerStop=false → 힌트 없음 (이동 중)', () => {
    expect(
      inferEnvironment({
        subsurface: false,
        surfaceSSOT: false,
        undergroundSSOT: false,
        tripActive: true,
        barometerStop: false,
      }),
    ).toEqual({ environment: 'unknown' });
  });

  it('tripActive=true + barometerStop=undefined (warmup) → 힌트 없음', () => {
    expect(
      inferEnvironment({
        subsurface: false,
        surfaceSSOT: false,
        undergroundSSOT: false,
        tripActive: true,
        barometerStop: undefined,
      }),
    ).toEqual({ environment: 'unknown' });
  });

  it('tripActive=true + barometerStop=true + surfaceSSOT=true → surface 우선 (힌트 없음)', () => {
    expect(
      inferEnvironment({
        subsurface: false,
        surfaceSSOT: true,
        undergroundSSOT: false,
        tripActive: true,
        barometerStop: true,
      }),
    ).toEqual({ environment: 'surface' });
  });

  it('tripActive=true + barometerStop=true + undergroundSSOT=true → underground 우선 (힌트 없음)', () => {
    expect(
      inferEnvironment({
        subsurface: false,
        surfaceSSOT: false,
        undergroundSSOT: true,
        tripActive: true,
        barometerStop: true,
      }),
    ).toEqual({ environment: 'underground' });
  });

  it('subsurface=true + tripActive=true + barometerStop=true → underground 우선 (subsurface 확정)', () => {
    expect(
      inferEnvironment({
        subsurface: true,
        surfaceSSOT: false,
        undergroundSSOT: false,
        tripActive: true,
        barometerStop: true,
      }),
    ).toEqual({ environment: 'underground' });
  });

  it('subsurface=undefined + tripActive=true + barometerStop=true → hint 비발동 (subsurface=false 경로만 hint)', () => {
    // subsurface=undefined 경로는 SSOT 신호로만 판단 — stop hint 없음
    expect(
      inferEnvironment({
        subsurface: undefined,
        surfaceSSOT: false,
        undergroundSSOT: false,
        tripActive: true,
        barometerStop: true,
      }),
    ).toEqual({ environment: 'unknown' });
  });
});
