import { describe, expect, it, vi } from 'vitest';
import { ARRIVAL_CODE } from '../alarm';
import {
  DISMISS_SILENCE_MS,
  evaluateBoardingPromptGates,
  evaluateHopEndPromptGates,
  markPromptFired,
  markPromptSilenced,
  pickAutoTrainCode,
} from '../boardingPrompt';
import * as positionSeries from '../positionSeries';
import type { PositionPoint } from '../types';
import type { ArrivalEntry } from '../seoul';

/**
 * 9단 게이트 평가는 series sample 3+, accuracy < 50m, 출발역 100m 이내, 방향 cosine ≥ 0.7,
 * fused speed ≥ 5km/h, motion ∈ {walking, automotive}, silence/fired 미발동 7개 조건을 한꺼번에
 * 만족해야 통과. 헬퍼로 'happy' series + origin/nextStation 좌표를 미리 만들고 각 테스트가
 * 한 조건만 깨뜨려 reason을 검증.
 */
function happySeries(now: number): PositionPoint[] {
  // 출발역(0,0)에서 다음역(0, 0.01) 방향(동쪽)으로 이동 중. 60s 동안 0.0008 deg ~ 88m
  // (5.3 km/h → walking이지만 raw 그대로 5km/h 약간 초과) — accuracy 10m, motion 'automotive'.
  // 마지막 sample이 origin 100m 이내에 있어야 게이트 #4 통과 (origin이 출발역, 사용자가
  // 막 출발 직후 시점을 모델링).
  return [
    {
      lat: 0,
      lng: -0.0004,
      accuracy: 10,
      ts: now - 60_000,
      motion: 'automotive',
    },
    {
      lat: 0,
      lng: 0.0002,
      accuracy: 10,
      ts: now - 30_000,
      motion: 'automotive',
    },
    {
      lat: 0,
      lng: 0.0008,
      accuracy: 10,
      ts: now,
      motion: 'automotive',
    },
  ];
}

const ORIGIN = { lat: 0, lng: 0 };
const NEXT = { lat: 0, lng: 0.01 };

describe('evaluateBoardingPromptGates — 9단 AND 게이트', () => {
  const now = 1_000_000;

  it('happy path: 모든 게이트 통과 → pass=true + fusedSpeedKmh 반환', () => {
    const r = evaluateBoardingPromptGates({
      series: happySeries(now),
      origin: ORIGIN,
      nextStation: NEXT,
      now,
    });
    expect(r.pass).toBe(true);
    if (r.pass) {
      expect(r.fusedSpeedKmh).toBeGreaterThan(5);
      expect(r.metrics.motion).toBe('automotive');
    }
  });

  // #2130 (Part B-be-2) — "trip당 1회(fired 영구 차단)" 정책 폐기. `fired` 자체는 더 이상
  // 검사하지 않고 `lastFiredAt` 기준 최소 발사 간격(5분)으로 dedup한다.
  it('#9: 최근(5분 미만) 발사된 trip은 fired-too-recently로 차단', () => {
    const r = evaluateBoardingPromptGates({
      series: happySeries(now),
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      promptState: { fired: true, lastFiredAt: now - 1000 },
    });
    expect(r).toEqual(expect.objectContaining({ pass: false, reason: 'fired-too-recently' }));
  });

  it('#9: fired=true 여도 최소 간격(5분) 경과 + 최대 횟수 미달이면 통과 (반복 발사 A4)', () => {
    const r = evaluateBoardingPromptGates({
      series: happySeries(now),
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      promptState: { fired: true, lastFiredAt: now - 5 * 60 * 1000, fireCount: 1 },
    });
    expect(r.pass).toBe(true);
  });

  it('#9: fireCount가 최대 발사 횟수(3)에 도달하면 max-fires-reached로 차단', () => {
    const r = evaluateBoardingPromptGates({
      series: happySeries(now),
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      promptState: { fired: true, lastFiredAt: now - 10 * 60 * 1000, fireCount: 3 },
    });
    expect(r).toEqual(expect.objectContaining({ pass: false, reason: 'max-fires-reached' }));
  });

  it('#9: silencedUntil이 미래면 silenced 차단', () => {
    const r = evaluateBoardingPromptGates({
      series: happySeries(now),
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      promptState: { silencedUntil: now + 60_000 },
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toBe('silenced');
  });

  it('#9: silencedUntil이 과거면 통과 (silence 만료)', () => {
    const r = evaluateBoardingPromptGates({
      series: happySeries(now),
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      promptState: { silencedUntil: now - 60_000 },
    });
    expect(r.pass).toBe(true);
  });

  it('#6: N≥1이면 통과 — sample 2개도 OK (#1886 RC-2: MIN_WINDOW_SAMPLES=1)', () => {
    // 옵션 D: 후보 1개 이상이면 발사. N=2 sample은 통과해야 한다.
    const twoSamples = happySeries(now).slice(-2);
    const r = evaluateBoardingPromptGates({
      series: twoSamples,
      origin: ORIGIN,
      nextStation: NEXT,
      now,
    });
    // 2 samples: accuracy/origin/direction/speed 조건 충족 시 통과.
    // happySeries 2개는 direction cosine이 0.7 이상이고 accuracy/origin 조건도 충족.
    expect(r.pass).toBe(true);
  });

  it('#6: N=0(빈 series) → no-candidates (#1886 RC-2: count=0만 차단)', () => {
    const r = evaluateBoardingPromptGates({
      series: [],
      origin: ORIGIN,
      nextStation: NEXT,
      now,
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toBe('no-candidates');
  });

  it('#3: 평균 accuracy ≥ 50m → accuracy-too-poor', () => {
    const blurry = happySeries(now).map((p) => ({ ...p, accuracy: 60 }));
    const r = evaluateBoardingPromptGates({
      series: blurry,
      origin: ORIGIN,
      nextStation: NEXT,
      now,
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toBe('accuracy-too-poor');
  });

  it('#4: 출발역에서 100m 초과 → origin-too-far', () => {
    const r = evaluateBoardingPromptGates({
      series: happySeries(now),
      // 1km 떨어진 다른 origin
      origin: { lat: 0.01, lng: 0.01 },
      nextStation: NEXT,
      now,
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toBe('origin-too-far');
  });

  it('#5: 방향 cosine < 0.7 → direction-mismatch (다른 방향 진행)', () => {
    // expected vector: 동쪽(NEXT). series는 북쪽으로 이동 (44m → 88m 모두 origin 100m 이내) — cos≈0
    const northbound: PositionPoint[] = [
      { lat: -0.0004, lng: 0, accuracy: 10, ts: now - 60_000, motion: 'automotive' },
      { lat: 0.0002, lng: 0, accuracy: 10, ts: now - 30_000, motion: 'automotive' },
      { lat: 0.0008, lng: 0, accuracy: 10, ts: now, motion: 'automotive' },
    ];
    const r = evaluateBoardingPromptGates({
      series: northbound,
      origin: ORIGIN,
      nextStation: NEXT,
      now,
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toBe('direction-mismatch');
  });

  it('#8: motion=stationary → motion-not-moving', () => {
    const stationary = happySeries(now).map((p) => ({ ...p, motion: 'stationary' as const }));
    const r = evaluateBoardingPromptGates({
      series: stationary,
      origin: ORIGIN,
      nextStation: NEXT,
      now,
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toBe('motion-not-moving');
  });

  it('#8: motion=unknown → motion-not-moving', () => {
    const unknown = happySeries(now).map((p) => ({ ...p, motion: 'unknown' as const }));
    const r = evaluateBoardingPromptGates({
      series: unknown,
      origin: ORIGIN,
      nextStation: NEXT,
      now,
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toBe('motion-not-moving');
  });

  it('#7: fused speed < 5 km/h → speed-too-low (천천히 이동)', () => {
    // walking 게이트 통과 + ~0.0001 deg / 30s = ~12m/30s = 1.44 km/h. clamp 후도 5 미만.
    const slow: PositionPoint[] = [
      { lat: 0, lng: 0, accuracy: 10, ts: now - 60_000, motion: 'walking' },
      { lat: 0, lng: 0.00005, accuracy: 10, ts: now - 30_000, motion: 'walking' },
      { lat: 0, lng: 0.0001, accuracy: 10, ts: now, motion: 'walking' },
    ];
    const r = evaluateBoardingPromptGates({
      series: slow,
      origin: ORIGIN,
      nextStation: NEXT,
      now,
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toBe('speed-too-low');
  });

  it('#828: mapMatched arcM이 양 끝 sample에 있으면 fusedSpeed에 흘러간다 (GPS+map weighted)', () => {
    // 좌표는 happy GPS와 동일하지만 양 끝 sample에 arcM 0 → 1000 (1km, 60s) → mapMatched=60 km/h.
    // GPS-only 평균은 ~5.3 km/h였으나 mapMatched 가중치가 합산되어 metrics.mapMatchedKmh 산출.
    const wired: PositionPoint[] = [
      {
        lat: 0,
        lng: -0.0004,
        accuracy: 10,
        ts: now - 60_000,
        motion: 'automotive',
        mapMatchedLine: '2',
        mapMatchedArcM: 0,
      },
      { lat: 0, lng: 0.0002, accuracy: 10, ts: now - 30_000, motion: 'automotive' },
      {
        lat: 0,
        lng: 0.0008,
        accuracy: 10,
        ts: now,
        motion: 'automotive',
        mapMatchedLine: '2',
        mapMatchedArcM: 1000,
      },
    ];
    const r = evaluateBoardingPromptGates({
      series: wired,
      origin: ORIGIN,
      nextStation: NEXT,
      now,
    });
    expect(r.pass).toBe(true);
    if (r.pass) {
      expect(r.metrics.mapMatchedKmh).toBeCloseTo(60, 0);
      // happy(GPS-only)의 fusedSpeedKmh보다 큰 값이어야 — mapMatched 60km/h가 weighted average에 합류.
      expect(r.fusedSpeedKmh).toBeGreaterThan(10);
    }
  });

  it('#828: mapMatched 부재면 mapMatchedKmh=null로 GPS-only 동작 (Phase 1 회귀 없음)', () => {
    const r = evaluateBoardingPromptGates({
      series: happySeries(now),
      origin: ORIGIN,
      nextStation: NEXT,
      now,
    });
    expect(r.pass).toBe(true);
    if (r.pass) expect(r.metrics.mapMatchedKmh).toBeNull();
  });
});

describe('evaluateBoardingPromptGates — #824 kalmanKmh 전달', () => {
  const now = 1_000_000;
  const ORIGIN = { lat: 0, lng: 0 };
  const NEXT = { lat: 0, lng: 0.01 };

  /**
   * 아주 느린 series — GPS 속도가 too-low가 되도록 원점 부근에서 거의 이동 안 함.
   * 단, origin(0,0) 방향(동쪽)으로 이동 + 마지막 sample이 origin 100m 이내여야
   * 다른 gate(방향/origin-too-far)를 통과할 수 있다.
   *
   * 속도: lng -0.00004 → 0 → 0.00004
   *   Δlng ≈ 4.44m/30s → ≈ 0.53 km/h (automotive mode이므로 floor 5 km/h 적용됨)
   *   automotive floor=5 → fusedSpeed 5 → MIN_FUSED_SPEED_KMH=5 → 경계.
   *   실제로 5 이상이므로 gate를 통과할 수 있다.
   *
   * 그래서 walking mode로 하면 floor가 없어 0.53 km/h < 5 km/h → speed-too-low.
   */
  function verySlowWalkingSeries(n: number) {
    return [
      { lat: 0, lng: -0.00004, accuracy: 10, ts: n - 60_000, motion: 'walking' as const },
      { lat: 0, lng: 0, accuracy: 10, ts: n - 30_000, motion: 'walking' as const },
      { lat: 0, lng: 0.00004, accuracy: 10, ts: n, motion: 'walking' as const },
    ];
  }

  it('kalmanKmh 없으면 매우 저속 walking series는 speed-too-low', () => {
    const r = evaluateBoardingPromptGates({
      series: verySlowWalkingSeries(now),
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      kalmanKmh: undefined,
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toBe('speed-too-low');
  });

  it('kalmanKmh=50 주입 시 fusedSpeedKmh가 달라져 game outcome이 변한다', () => {
    // GPS-only: speed-too-low
    // kalmanKmh=50 주입 시: totalW = 0.7 + 0.6 = 1.3
    // raw = (gpsAvg*0.7 + 50*0.6) / 1.3 >> 5 km/h
    // walking clamp: Math.min(raw, 10) = 10 → 5 km/h 초과 → speed gate 통과
    const withKalman = evaluateBoardingPromptGates({
      series: verySlowWalkingSeries(now),
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      kalmanKmh: 50,
    });
    // kalmanKmh 주입 후 pass=true이거나, 다른 reason으로 fail (speed-too-low는 아님)
    if (!withKalman.pass) {
      expect(withKalman.reason).not.toBe('speed-too-low');
    }
    if (withKalman.pass) {
      expect(withKalman.fusedSpeedKmh).toBeGreaterThan(5);
    }
  });

  it('kalmanKmh 전달 시 fusedSpeedKmh가 GPS-only보다 크다 (happy path 기준)', () => {
    // happy series: 동쪽으로 충분히 이동 (automotive)
    function happySeries(n: number) {
      return [
        { lat: 0, lng: -0.0004, accuracy: 10, ts: n - 60_000, motion: 'automotive' as const },
        { lat: 0, lng: 0.0002, accuracy: 10, ts: n - 30_000, motion: 'automotive' as const },
        { lat: 0, lng: 0.0008, accuracy: 10, ts: n, motion: 'automotive' as const },
      ];
    }

    const withoutKalman = evaluateBoardingPromptGates({
      series: happySeries(now),
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      kalmanKmh: null,
    });
    const withKalman = evaluateBoardingPromptGates({
      series: happySeries(now),
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      kalmanKmh: 60, // GPS-only 속도보다 훨씬 높은 Kalman 값
    });

    // 둘 다 통과해야 하며 Kalman 있을 때 fusedSpeedKmh가 더 크다
    expect(withoutKalman.pass).toBe(true);
    expect(withKalman.pass).toBe(true);
    if (withoutKalman.pass && withKalman.pass) {
      expect(withKalman.fusedSpeedKmh).toBeGreaterThan(withoutKalman.fusedSpeedKmh);
    }
  });
});

describe('evaluateBoardingPromptGates — #833 pre-computed metrics 재사용', () => {
  const now = 1_000_000;

  it('metrics 미지정 시 내부 evaluateWindow를 호출한다', () => {
    const spy = vi.spyOn(positionSeries, 'evaluateWindow');
    try {
      const r = evaluateBoardingPromptGates({
        series: happySeries(now),
        origin: ORIGIN,
        nextStation: NEXT,
        now,
      });
      expect(r.pass).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('metrics 지정 시 evaluateWindow를 호출하지 않고 주입값을 그대로 사용한다', () => {
    // 내부 호출이 일어났다면 happy series 결과를 재계산해 stationary 차단을 우회했을 것.
    // motion=stationary로 주입한 metrics를 그대로 쓴다면 motion-not-moving으로 차단되어야 한다.
    const injected: positionSeries.WindowedMetrics = {
      count: 5,
      gpsAvgKmh: 20,
      avgAccuracyMeters: 10,
      motion: 'stationary',
      start: { lat: 0, lng: -0.0004 },
      end: { lat: 0, lng: 0.0008 },
      mapMatchedKmh: null,
    };
    const spy = vi.spyOn(positionSeries, 'evaluateWindow');
    try {
      const r = evaluateBoardingPromptGates({
        series: happySeries(now),
        origin: ORIGIN,
        nextStation: NEXT,
        now,
        metrics: injected,
      });
      expect(r.pass).toBe(false);
      if (!r.pass) {
        expect(r.reason).toBe('motion-not-moving');
        expect(r.metrics).toBe(injected); // 동일 참조 — 재계산 안 함
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * 지하 환경에서 GPS series 가 stale(=잘못된 좌표) 인 경우. 기존 9단 AND 게이트는
 * #4 origin-too-far / #5 direction-mismatch 등으로 100% fail → 7일 누적 0건 회귀.
 * environment='underground' 분기는 GPS 의존 게이트(#3~#7) byPass 후 #8 motion 만 평가.
 * accuracy 는 surface 분기의 #4 origin-too-far reason 분리를 위해 cutoff(50m) 미만 사용.
 */
function staleGpsSeries(n: number): PositionPoint[] {
  // 출발역(0,0) 에서 1km 떨어진 wrong 좌표 + 잘못된 방향 진행 (서쪽). accuracy 10m.
  return [
    { lat: 0.01, lng: 0.01, accuracy: 10, ts: n - 60_000, motion: 'automotive' },
    { lat: 0.01, lng: 0.009, accuracy: 10, ts: n - 30_000, motion: 'automotive' },
    { lat: 0.01, lng: 0.008, accuracy: 10, ts: n, motion: 'automotive' },
  ];
}

describe('evaluateBoardingPromptGates — #1536 (S3) 환경 분기', () => {
  const now = 1_000_000;

  it('underground: stale GPS series 도 motion=automotive 면 통과 (fusedSpeedKmh=0)', () => {
    const r = evaluateBoardingPromptGates({
      series: staleGpsSeries(now),
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      environment: 'underground',
    });
    expect(r.pass).toBe(true);
    if (r.pass) expect(r.fusedSpeedKmh).toBe(0);
  });

  it('underground: motion=stationary 면 #8 게이트로 차단 (motion-stationary)', () => {
    const stationary = staleGpsSeries(now).map((p) => ({
      ...p,
      motion: 'stationary' as const,
    }));
    const r = evaluateBoardingPromptGates({
      series: stationary,
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      environment: 'underground',
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toBe('motion-stationary');
  });

  // #2130 (Part B-be-2) — "trip당 1회" 정책 폐기. underground 분기에서도 반복 발사 게이트
  // (fired-too-recently)가 #9로 우선 평가된다.
  it('underground: 최근 발사(5분 미만) = fired-too-recently (게이트 #9 우선 평가)', () => {
    const r = evaluateBoardingPromptGates({
      series: staleGpsSeries(now),
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      environment: 'underground',
      promptState: { fired: true, lastFiredAt: now - 1000 },
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toBe('fired-too-recently');
  });

  it('mixed: GPS 의존 게이트 byPass (underground 와 동일 분기)', () => {
    const r = evaluateBoardingPromptGates({
      series: staleGpsSeries(now),
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      environment: 'mixed',
    });
    expect(r.pass).toBe(true);
  });

  it('unknown: GPS 의존 게이트 byPass (보수적 분기)', () => {
    const r = evaluateBoardingPromptGates({
      series: staleGpsSeries(now),
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      environment: 'unknown',
    });
    expect(r.pass).toBe(true);
  });

  it('surface: stale GPS series 는 기존 9단 AND 그대로 — origin-too-far 차단', () => {
    const r = evaluateBoardingPromptGates({
      series: staleGpsSeries(now),
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      environment: 'surface',
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toBe('origin-too-far');
  });

  it('environment undefined (legacy 호출자) 는 기존 9단 AND 그대로', () => {
    const r = evaluateBoardingPromptGates({
      series: staleGpsSeries(now),
      origin: ORIGIN,
      nextStation: NEXT,
      now,
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toBe('origin-too-far');
  });

  it('surface env + happy series → 기존처럼 fusedSpeedKmh>0', () => {
    const r = evaluateBoardingPromptGates({
      series: happySeries(now),
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      environment: 'surface',
    });
    expect(r.pass).toBe(true);
    if (r.pass) expect(r.fusedSpeedKmh).toBeGreaterThan(5);
  });
});

/**
 * #1820 — GPS-bypass 환경(underground/mixed/unknown)에서 motion=unknown 허용.
 * Day 2 production 36건 evidence: environment=unknown + motion=unknown → 100% 차단 회귀.
 * 옵션 A: bypass 환경에서 stationary만 차단, walking/automotive/unknown 통과.
 */
describe('evaluateBoardingPromptGates — #1820 motion grace (GPS-bypass 환경)', () => {
  const now = 1_000_000;

  // underground stale GPS series (모든 motion=unknown 로 덮어쓸 것)
  function unknownMotionSeries(n: number): PositionPoint[] {
    return staleGpsSeries(n).map((p) => ({ ...p, motion: 'unknown' as const }));
  }

  it('underground + motion=unknown → pass (warmup grace)', () => {
    const r = evaluateBoardingPromptGates({
      series: unknownMotionSeries(now),
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      environment: 'underground',
    });
    expect(r.pass).toBe(true);
    if (r.pass) expect(r.fusedSpeedKmh).toBe(0);
  });

  it('underground + motion=stationary → fail (motion-stationary)', () => {
    const stationary = staleGpsSeries(now).map((p) => ({
      ...p,
      motion: 'stationary' as const,
    }));
    const r = evaluateBoardingPromptGates({
      series: stationary,
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      environment: 'underground',
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toBe('motion-stationary');
  });

  it('underground + motion=walking → pass', () => {
    const walking = staleGpsSeries(now).map((p) => ({
      ...p,
      motion: 'walking' as const,
    }));
    const r = evaluateBoardingPromptGates({
      series: walking,
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      environment: 'underground',
    });
    expect(r.pass).toBe(true);
  });

  it('surface + motion=unknown → fail (motion-not-moving, 기존 정책 유지)', () => {
    const unknown = happySeries(now).map((p) => ({ ...p, motion: 'unknown' as const }));
    const r = evaluateBoardingPromptGates({
      series: unknown,
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      environment: 'surface',
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toBe('motion-not-moving');
  });

  it('surface + motion=walking → pass (기존 정책 유지)', () => {
    // happySeries는 이미 motion=automotive이므로 walking으로 교체
    const walking = happySeries(now).map((p) => ({ ...p, motion: 'walking' as const }));
    const r = evaluateBoardingPromptGates({
      series: walking,
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      environment: 'surface',
    });
    expect(r.pass).toBe(true);
  });
});

/**
 * #2014 (ADR-022 B8) — archFlag='on' 시 GPS/motion/speed 게이트(#3~#8) 전부 skip.
 * #9 (fired/silenced) 만 평가. arvlCd=1 관측 자체는 caller 가 fetchArrivals + pickAutoTrainCode 로 별도 검증.
 * archFlag='off' 또는 undefined 은 기존 게이트 동작 100% 유지 (회귀 방어).
 */
describe('evaluateBoardingPromptGates — #2014 (ADR-022 B8) archFlag', () => {
  const now = 1_000_000;

  it('archFlag=on: stale GPS + motion=stationary 여도 pass (모든 GPS/motion 게이트 skip)', () => {
    const stationary = staleGpsSeries(now).map((p) => ({
      ...p,
      motion: 'stationary' as const,
    }));
    const r = evaluateBoardingPromptGates({
      series: stationary,
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      environment: 'surface',
      archFlag: 'on',
    });
    expect(r.pass).toBe(true);
    if (r.pass) expect(r.fusedSpeedKmh).toBe(0);
  });

  it('archFlag=on: series=[] 여도 pass (window-too-small 차단 우회)', () => {
    // 관찰 11 root cause 재현: 60s window sample 0건이라 legacy path 에선 no-candidates 로 100% 차단.
    // archFlag=on 은 이 게이트를 skip 해야 한다.
    const r = evaluateBoardingPromptGates({
      series: [],
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      archFlag: 'on',
    });
    expect(r.pass).toBe(true);
  });

  // #2130 (Part B-be-2) — "trip당 1회" 정책 폐기. archFlag=on 에서도 반복 발사 게이트
  // (fired-too-recently)가 #9로 여전히 평가된다.
  it('archFlag=on: 최근 발사(5분 미만) = fired-too-recently (게이트 #9 는 여전히 평가)', () => {
    const r = evaluateBoardingPromptGates({
      series: happySeries(now),
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      promptState: { fired: true, lastFiredAt: now - 1000 },
      archFlag: 'on',
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toBe('fired-too-recently');
  });

  it('archFlag=on: silencedUntil 미래 = silenced (게이트 #9 는 여전히 평가)', () => {
    const r = evaluateBoardingPromptGates({
      series: happySeries(now),
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      promptState: { silencedUntil: now + 60_000 },
      archFlag: 'on',
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toBe('silenced');
  });

  it('archFlag=off: stale GPS + surface → 기존 9단 AND (origin-too-far)', () => {
    const r = evaluateBoardingPromptGates({
      series: staleGpsSeries(now),
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      environment: 'surface',
      archFlag: 'off',
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toBe('origin-too-far');
  });

  it('archFlag=off: happy series → 기존 통과 동작 유지 (fusedSpeedKmh > 0)', () => {
    const r = evaluateBoardingPromptGates({
      series: happySeries(now),
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      archFlag: 'off',
    });
    expect(r.pass).toBe(true);
    if (r.pass) expect(r.fusedSpeedKmh).toBeGreaterThan(5);
  });
});

describe('markPromptFired / markPromptSilenced', () => {
  it('markPromptFired는 fired=true + lastFiredAt 설정 (prev/trainCode 없으면 fireCount=1, firedTrainCodes 생략)', () => {
    expect(markPromptFired(1234)).toEqual({ fired: true, lastFiredAt: 1234, fireCount: 1 });
  });

  // #2130 (Part B-be-2) — 반복 발사(A4) 상태 누적.
  it('markPromptFired: prev + trainCode 전달 시 firedTrainCodes append + fireCount 증가', () => {
    const prev = { fired: true, lastFiredAt: 1000, fireCount: 1, firedTrainCodes: ['A1'] };
    const r = markPromptFired(2000, prev, 'B2');
    expect(r).toEqual({
      fired: true,
      lastFiredAt: 2000,
      fireCount: 2,
      firedTrainCodes: ['A1', 'B2'],
    });
  });

  it('markPromptFired: trainCode=null 이면 firedTrainCodes는 prev 그대로(append 없음)', () => {
    const prev = { fired: true, lastFiredAt: 1000, fireCount: 1, firedTrainCodes: ['A1'] };
    const r = markPromptFired(2000, prev, null);
    expect(r.firedTrainCodes).toEqual(['A1']);
    expect(r.fireCount).toBe(2);
  });
  it('markPromptSilenced는 silencedUntil = now + DISMISS_SILENCE_MS', () => {
    const r = markPromptSilenced(undefined, 1000);
    expect(r.silencedUntil).toBe(1000 + DISMISS_SILENCE_MS);
  });
  it('markPromptSilenced는 기존 fired 상태 보존', () => {
    const r = markPromptSilenced({ fired: true, lastFiredAt: 500 }, 1000);
    expect(r.fired).toBe(true);
    expect(r.lastFiredAt).toBe(500);
  });
});

describe('pickAutoTrainCode — arvlCd 우선순위', () => {
  function entry(overrides: Partial<ArrivalEntry>): ArrivalEntry {
    return {
      destination: '',
      arrivalSeconds: 0,
      trainCode: 'T1',
      isUp: true,
      subwayNm: '2호선',
      arvlCd: null,
      ...overrides,
    };
  }

  it('priority 1: arvlCd=2 (출발) 단독 → 채택', () => {
    const arrivals = [
      entry({ trainCode: 'T1', arvlCd: 0 }),
      entry({ trainCode: 'T2', arvlCd: 2 }),
      entry({ trainCode: 'T3', arvlCd: ARRIVAL_CODE.ARRIVED }),
    ];
    expect(pickAutoTrainCode(arrivals, '2호선', 'up')).toBe('T2');
  });

  it('priority 2: arvlCd=1 (도착) — arvlCd=2 없을 때', () => {
    const arrivals = [
      entry({ trainCode: 'T1', arvlCd: 0 }),
      entry({ trainCode: 'T2', arvlCd: ARRIVAL_CODE.ARRIVED }),
    ];
    expect(pickAutoTrainCode(arrivals, '2호선', 'up')).toBe('T2');
  });

  it('priority 3: arvlCd=0 (진입) — 2/1 없을 때', () => {
    const arrivals = [entry({ trainCode: 'T1', arvlCd: 0 })];
    expect(pickAutoTrainCode(arrivals, '2호선', 'up')).toBe('T1');
  });

  it('priority 4: 그 외 코드 → 첫 후보 (receivedAt 순서 가정)', () => {
    const arrivals = [
      entry({ trainCode: 'T1', arvlCd: 99 }),
      entry({ trainCode: 'T2', arvlCd: 3 }),
    ];
    expect(pickAutoTrainCode(arrivals, '2호선', 'up')).toBe('T1');
  });

  it('ambiguity: 같은 우선순위 후보 2+ → null (자동 lock 안 함)', () => {
    const arrivals = [
      entry({ trainCode: 'T1', arvlCd: 2 }),
      entry({ trainCode: 'T2', arvlCd: 2 }),
    ];
    expect(pickAutoTrainCode(arrivals, '2호선', 'up')).toBeNull();
  });

  it('line 매칭 안 되면 null', () => {
    const arrivals = [entry({ trainCode: 'T1', arvlCd: 2, subwayNm: '99호선' })];
    expect(pickAutoTrainCode(arrivals, '2호선', 'up')).toBeNull();
  });

  it('direction null → 양방향 허용', () => {
    const arrivals = [entry({ trainCode: 'T1', arvlCd: 2, isUp: false })];
    expect(pickAutoTrainCode(arrivals, '2호선', null)).toBe('T1');
  });

  it('direction=down → 하행만 매칭', () => {
    const arrivals = [
      entry({ trainCode: 'TU', arvlCd: 2, isUp: true }),
      entry({ trainCode: 'TD', arvlCd: 2, isUp: false }),
    ];
    expect(pickAutoTrainCode(arrivals, '2호선', 'down')).toBe('TD');
  });

  it('방향 매칭 후 모두 제거되면 null', () => {
    const arrivals = [entry({ trainCode: 'T1', arvlCd: 2, isUp: true })];
    expect(pickAutoTrainCode(arrivals, '2호선', 'down')).toBeNull();
  });

  it('trainCode 빈 문자열 후보 → null', () => {
    const arrivals = [entry({ trainCode: '', arvlCd: 2 })];
    expect(pickAutoTrainCode(arrivals, '2호선', 'up')).toBeNull();
  });
});

describe('evaluateHopEndPromptGates (#2034)', () => {
  const NOW = 1_700_000_000_000;

  it('promptState 없음 → pass=true', () => {
    const r = evaluateHopEndPromptGates({ now: NOW });
    expect(r.pass).toBe(true);
    if (r.pass) expect(r.fusedSpeedKmh).toBe(0);
  });

  it('promptState.fired=true → already-fired 차단', () => {
    const r = evaluateHopEndPromptGates({
      promptState: { fired: true, lastFiredAt: NOW - 60_000 },
      now: NOW,
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toBe('already-fired');
  });

  it('promptState.silencedUntil 이 미래 → silenced 차단', () => {
    const r = evaluateHopEndPromptGates({
      promptState: { silencedUntil: NOW + 30_000 },
      now: NOW,
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toBe('silenced');
  });

  it('promptState.silencedUntil 이 과거 → pass', () => {
    const r = evaluateHopEndPromptGates({
      promptState: { silencedUntil: NOW - 30_000 },
      now: NOW,
    });
    expect(r.pass).toBe(true);
  });
});
