import { describe, expect, it } from 'vitest';
import { ARRIVAL_CODE } from '../alarm';
import {
  DISMISS_SILENCE_MS,
  evaluateBoardingPromptGates,
  markPromptFired,
  markPromptSilenced,
  pickAutoTrainCode,
} from '../boardingPrompt';
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

  it('#9: 이미 fired된 trip은 차단', () => {
    const r = evaluateBoardingPromptGates({
      series: happySeries(now),
      origin: ORIGIN,
      nextStation: NEXT,
      now,
      promptState: { fired: true, lastFiredAt: now - 1000 },
    });
    expect(r).toEqual(expect.objectContaining({ pass: false, reason: 'already-fired' }));
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

  it('#6: N<3 → window-too-small', () => {
    const small = happySeries(now).slice(-2);
    const r = evaluateBoardingPromptGates({
      series: small,
      origin: ORIGIN,
      nextStation: NEXT,
      now,
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toBe('window-too-small');
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
});

describe('markPromptFired / markPromptSilenced', () => {
  it('markPromptFired는 fired=true + lastFiredAt 설정', () => {
    expect(markPromptFired(1234)).toEqual({ fired: true, lastFiredAt: 1234 });
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
