import { inferEnvironment } from '../inferEnvironment';

describe('inferEnvironment', () => {
  it('subsurface=true 명시 → underground', () => {
    expect(
      inferEnvironment({ subsurface: true, surfaceSSOT: false, undergroundSSOT: false }),
    ).toBe('underground');
  });

  it('subsurface=true는 surfaceSSOT가 활성이어도 underground 우선 (barometer 확정)', () => {
    expect(
      inferEnvironment({ subsurface: true, surfaceSSOT: true, undergroundSSOT: false }),
    ).toBe('underground');
  });

  it('subsurface=false + surfaceSSOT 활성 → surface', () => {
    expect(
      inferEnvironment({ subsurface: false, surfaceSSOT: true, undergroundSSOT: false }),
    ).toBe('surface');
  });

  it('subsurface=false + undergroundSSOT 활성(지상 SSOT 없음) → underground (지하상가)', () => {
    expect(
      inferEnvironment({ subsurface: false, surfaceSSOT: false, undergroundSSOT: true }),
    ).toBe('underground');
  });

  it('subsurface=false + 둘 다 null → unknown', () => {
    expect(
      inferEnvironment({ subsurface: false, surfaceSSOT: false, undergroundSSOT: false }),
    ).toBe('unknown');
  });

  it('subsurface=undefined + surfaceSSOT만 활성 → surface (hybrid)', () => {
    expect(
      inferEnvironment({ subsurface: undefined, surfaceSSOT: true, undergroundSSOT: false }),
    ).toBe('surface');
  });

  it('subsurface=undefined + undergroundSSOT만 활성 → underground (hybrid)', () => {
    expect(
      inferEnvironment({ subsurface: undefined, surfaceSSOT: false, undergroundSSOT: true }),
    ).toBe('underground');
  });

  it('subsurface=undefined + 둘 다 활성 → unknown (분간 불가)', () => {
    expect(
      inferEnvironment({ subsurface: undefined, surfaceSSOT: true, undergroundSSOT: true }),
    ).toBe('unknown');
  });

  it('subsurface=undefined + 둘 다 null → unknown', () => {
    expect(
      inferEnvironment({ subsurface: undefined, surfaceSSOT: false, undergroundSSOT: false }),
    ).toBe('unknown');
  });
});
