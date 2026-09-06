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

  it('#1932 — subsurface=false + 두 SSOT 모두 null + hint 미발동 → surface (raw barometer 신뢰, GPS accuracy 미전달)', () => {
    // cascade tier 2(gpsDerivedFastPath)와의 semantic equivalence 보존.
    // 기존: 'unknown' (DebugModal 표시 전용 시기). 변경: barometer 명시 지상 신뢰 → 'surface'.
    // gpsAccuracyMeters 미전달(fix 없음)은 #2468 garbage 판정 미적용 — 기존 동작 그대로.
    expect(
      inferEnvironment({ subsurface: false, surfaceSSOT: false, undergroundSSOT: false }).label,
    ).toBe('surface');
  });

  describe('#2468 — garbage GPS 하에서 subsurface=false 단독 surface 단정 차단', () => {
    it('GPS 양호(accuracy=20m) + 두 SSOT null → surface 유지 (gpsDerivedFastPath 보존, blanket revert 아님)', () => {
      const result = inferEnvironment({
        subsurface: false,
        surfaceSSOT: false,
        undergroundSSOT: false,
        gpsAccuracyMeters: 20,
      });
      expect(result.label).toBe('surface');
      expect(result.hintReason).toBeUndefined();
    });

    it('gpsAccuracyMeters=null(fix 없음) + 두 SSOT null → surface (기존 동작 보존, garbage 판정 미적용)', () => {
      const result = inferEnvironment({
        subsurface: false,
        surfaceSSOT: false,
        undergroundSSOT: false,
        gpsAccuracyMeters: null,
      });
      expect(result.label).toBe('surface');
    });

    it('GPS garbage(accuracy=1395m, 실 dump값) + lockActive=true + 두 SSOT null → underground (RED before fix, #2468)', () => {
      const result = inferEnvironment({
        subsurface: false,
        surfaceSSOT: false,
        undergroundSSOT: false,
        gpsAccuracyMeters: 1395,
        lockActive: true,
      });
      expect(result.label).toBe('underground');
      expect(result.hintReason).toBe('gps-garbage-underground');
    });

    it('GPS garbage(accuracy=3703m) + lockActive=false → unknown (lock 근거 없어 underground 단정 안 함)', () => {
      const result = inferEnvironment({
        subsurface: false,
        surfaceSSOT: false,
        undergroundSSOT: false,
        gpsAccuracyMeters: 3703,
        lockActive: false,
      });
      expect(result.label).toBe('unknown');
      expect(result.hintReason).toBeUndefined();
    });

    it('GPS garbage + lockActive 미전달 → unknown (기본값 false 취급)', () => {
      const result = inferEnvironment({
        subsurface: false,
        surfaceSSOT: false,
        undergroundSSOT: false,
        gpsAccuracyMeters: 5000,
      });
      expect(result.label).toBe('unknown');
    });

    it('qualityDegraded=true(accuracy 미전달) + lockActive=true → underground (accuracy 없어도 qualityDegraded 단독으로 garbage 판정)', () => {
      const result = inferEnvironment({
        subsurface: false,
        surfaceSSOT: false,
        undergroundSSOT: false,
        qualityDegraded: true,
        lockActive: true,
      });
      expect(result.label).toBe('underground');
      expect(result.hintReason).toBe('gps-garbage-underground');
    });

    it('accuracy=50m 경계값(초과 아님) → garbage 아님, surface 유지', () => {
      const result = inferEnvironment({
        subsurface: false,
        surfaceSSOT: false,
        undergroundSSOT: false,
        gpsAccuracyMeters: 50,
        lockActive: true,
      });
      expect(result.label).toBe('surface');
    });

    it('surfaceSSOT 활성이면 GPS garbage여도 surface 우선 (priority-2가 4보다 앞섬, 회귀 아님)', () => {
      const result = inferEnvironment({
        subsurface: false,
        surfaceSSOT: true,
        undergroundSSOT: false,
        gpsAccuracyMeters: 5000,
        lockActive: false,
      });
      expect(result.label).toBe('surface');
    });

    it('barometer-stop hint가 GPS garbage 판정보다 우선 (priority 순서 보존)', () => {
      const result = inferEnvironment({
        subsurface: false,
        surfaceSSOT: false,
        undergroundSSOT: false,
        tripActive: true,
        barometerStop: true,
        gpsAccuracyMeters: 5000,
        lockActive: true,
      });
      expect(result.label).toBe('unknown');
      expect(result.hintReason).toBe('barometer-stop');
    });
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

  describe('#2070 gps-quality-drop hintReason', () => {
    it('subsurface=undefined + 둘 다 null + qualityDegraded=true → underground (hint gps-quality-drop)', () => {
      const result = inferEnvironment({
        subsurface: undefined,
        surfaceSSOT: false,
        undergroundSSOT: false,
        qualityDegraded: true,
      });
      expect(result.label).toBe('underground');
      expect(result.hintReason).toBe('gps-quality-drop');
    });

    it('subsurface=undefined + 둘 다 활성 + qualityDegraded=true → underground (분간 불가 구간 보강)', () => {
      const result = inferEnvironment({
        subsurface: undefined,
        surfaceSSOT: true,
        undergroundSSOT: true,
        qualityDegraded: true,
      });
      expect(result.label).toBe('underground');
      expect(result.hintReason).toBe('gps-quality-drop');
    });

    it('subsurface=undefined + 둘 다 null + qualityDegraded=false → unknown (기존 동작 보존)', () => {
      const result = inferEnvironment({
        subsurface: undefined,
        surfaceSSOT: false,
        undergroundSSOT: false,
        qualityDegraded: false,
      });
      expect(result.label).toBe('unknown');
      expect(result.hintReason).toBeUndefined();
    });

    it('qualityDegraded 미전달 시 기존 동작(unknown) 보존', () => {
      const result = inferEnvironment({
        subsurface: undefined,
        surfaceSSOT: false,
        undergroundSSOT: false,
      });
      expect(result.label).toBe('unknown');
      expect(result.hintReason).toBeUndefined();
    });

    it('surfaceSSOT만 활성이면 qualityDegraded=true여도 surface 우선 (기존 판정 대체 아님)', () => {
      const result = inferEnvironment({
        subsurface: undefined,
        surfaceSSOT: true,
        undergroundSSOT: false,
        qualityDegraded: true,
      });
      expect(result.label).toBe('surface');
      expect(result.hintReason).toBeUndefined();
    });

    it('subsurface=true(barometer 확정)면 qualityDegraded=true여도 판정 불변', () => {
      const result = inferEnvironment({
        subsurface: true,
        surfaceSSOT: false,
        undergroundSSOT: false,
        qualityDegraded: true,
      });
      expect(result.label).toBe('underground');
      expect(result.hintReason).toBeUndefined();
    });

    it('#2468 회귀 fix — subsurface=false + SSOT 없음 + qualityDegraded=true(lockActive 미전달) → unknown (surface 단정 X)', () => {
      // 변경 전(#1932 당시): 'surface' 반환 — 이것이 바로 #2468 확인된 회귀(garbage GPS를
      // barometer subsurface=false 단독으로 지상 단정). qualityDegraded는 GPS garbage 신호이므로
      // lock 근거 없는 이 case는 'unknown'이 맞다(lockActive=true였다면 'underground').
      const result = inferEnvironment({
        subsurface: false,
        surfaceSSOT: false,
        undergroundSSOT: false,
        qualityDegraded: true,
      });
      expect(result.label).toBe('unknown');
      expect(result.hintReason).toBeUndefined();
    });
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
