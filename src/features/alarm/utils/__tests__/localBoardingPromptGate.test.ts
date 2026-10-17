import {
  decideLocalBoardingPromptFire,
  evaluateLocalBoardingPromptGate,
  LOCAL_BOARDING_PROMPT_PROXIMITY_MARGIN_M,
} from '../localBoardingPromptGate';
import type { BoardingPromptContext } from '../boardingPromptContext';
import type { ArrivalInfo, StationArrival } from '../../../../shared/types/arrival';

function makeContext(overrides: {
  originDistanceM?: number;
  originAccuracyM?: number;
  direction?: 'up' | 'down' | null;
  line?: string;
}): BoardingPromptContext {
  return {
    promptGeoContext: {
      origin: { lat: 37.5, lng: 127.0 },
      nextStation: { lat: 37.51, lng: 127.01 },
      direction: overrides.direction === undefined ? 'up' : overrides.direction,
      originDistanceM: overrides.originDistanceM,
      originAccuracyM: overrides.originAccuracyM,
    },
    promptDisplay: {
      originStation: '중곡',
      line: overrides.line ?? '7',
    },
  };
}

function makeArrival(overrides: Partial<ArrivalInfo> & { direction: 'up' | 'down' }): StationArrival {
  const info: ArrivalInfo = {
    destination: '건대입구',
    arrivalMinutes: 3,
    arrivalSeconds: 180,
    statusMessage: '도착',
    trainCode: '1234',
    line: '7',
    receivedAtMs: Date.now(),
    // #2801 — imminent(0/1/2) 기본값. 기존 기본값 3(전역출발, non-imminent)은 이 gate의
    // proximity/line-matching 테스트 의도와 무관한데 신규 imminent 게이트가 이를 차단해버려
    // 무관 테스트가 깨지는 걸 막는다. imminent 자체를 검증하는 케이스는 명시 override.
    arrivalCode: 1,
    isLastTrain: false,
    trainType: 'normal',
    ...overrides,
  };
  return overrides.direction === 'up'
    ? { up: [info], down: [] }
    : { up: [], down: [info] };
}

describe('evaluateLocalBoardingPromptGate', () => {
  it('근접(originDistanceM - originAccuracyM <= margin) + 같은 line/방향 도착열차 존재 → pass', () => {
    const context = makeContext({ originDistanceM: 100, originAccuracyM: 20, direction: 'up' });
    const arrival = makeArrival({ direction: 'up', line: '7' });
    expect(evaluateLocalBoardingPromptGate({ context, arrival })).toEqual({ pass: true });
  });

  it('경계값: originDistanceM - originAccuracyM === margin → pass', () => {
    const context = makeContext({
      originDistanceM: LOCAL_BOARDING_PROMPT_PROXIMITY_MARGIN_M + 20,
      originAccuracyM: 20,
      direction: 'up',
    });
    const arrival = makeArrival({ direction: 'up', line: '7' });
    expect(evaluateLocalBoardingPromptGate({ context, arrival }).pass).toBe(true);
  });

  it('originDistanceM 부재(GPS fix 없음) → not-near-origin', () => {
    const context = makeContext({ originAccuracyM: 20, direction: 'up' });
    const arrival = makeArrival({ direction: 'up', line: '7' });
    expect(evaluateLocalBoardingPromptGate({ context, arrival })).toEqual({
      pass: false,
      reason: 'not-near-origin',
    });
  });

  it('originAccuracyM 부재 → not-near-origin', () => {
    const context = makeContext({ originDistanceM: 100, direction: 'up' });
    const arrival = makeArrival({ direction: 'up', line: '7' });
    expect(evaluateLocalBoardingPromptGate({ context, arrival })).toEqual({
      pass: false,
      reason: 'not-near-origin',
    });
  });

  it('margin 초과(originDistanceM - originAccuracyM > margin) → not-near-origin', () => {
    const context = makeContext({
      originDistanceM: LOCAL_BOARDING_PROMPT_PROXIMITY_MARGIN_M + 21,
      originAccuracyM: 20,
      direction: 'up',
    });
    const arrival = makeArrival({ direction: 'up', line: '7' });
    expect(evaluateLocalBoardingPromptGate({ context, arrival })).toEqual({
      pass: false,
      reason: 'not-near-origin',
    });
  });

  it('근접 통과했지만 같은 line 도착열차 없음 → no-arriving-train', () => {
    const context = makeContext({ originDistanceM: 50, originAccuracyM: 10, direction: 'up', line: '7' });
    const arrival = makeArrival({ direction: 'up', line: '2' });
    expect(evaluateLocalBoardingPromptGate({ context, arrival })).toEqual({
      pass: false,
      reason: 'no-arriving-train',
    });
  });

  it('direction 지정 시 반대 방향 후보는 무시(다른 방향에 도착열차 있어도 no-arriving-train)', () => {
    const context = makeContext({ originDistanceM: 50, originAccuracyM: 10, direction: 'up', line: '7' });
    const arrival = makeArrival({ direction: 'down', line: '7' });
    expect(evaluateLocalBoardingPromptGate({ context, arrival })).toEqual({
      pass: false,
      reason: 'no-arriving-train',
    });
  });

  it('arrivalSeconds<=0인 후보는 도착열차로 인정하지 않음', () => {
    const context = makeContext({ originDistanceM: 50, originAccuracyM: 10, direction: 'up', line: '7' });
    const arrival = makeArrival({ direction: 'up', line: '7', arrivalSeconds: 0 });
    expect(evaluateLocalBoardingPromptGate({ context, arrival })).toEqual({
      pass: false,
      reason: 'no-arriving-train',
    });
  });

  it('direction=null(비단조 노선)이면 양방향 후보 모두 허용', () => {
    const context = makeContext({ originDistanceM: 50, originAccuracyM: 10, direction: null, line: '7' });
    const arrival = makeArrival({ direction: 'down', line: '7' });
    expect(evaluateLocalBoardingPromptGate({ context, arrival }).pass).toBe(true);
  });

  // #2801 (REOPENED 2026-09-30 정정 스펙 §3.3) — 근접+같은 line 후보가 있어도 전부 non-imminent면
  // (backend 조기 발사 회귀와 동일 결함이 device 로컬 게이트에도 있었다) 차단해야 한다.
  // #2801 (3차 reopen, audit-sides 편측 확정 2026-10-03) — arrivalCode=3(전역출발)은 backend와
  // 동일하게 approaching으로 승격돼 더 이상 "먼 열차"가 아니다. 4(전역진입, 의도적 제외)로 교체.
  it('근접+같은 line 후보 있지만 전부 non-imminent/non-approaching(arrivalCode=4) → suppressed-not-imminent', () => {
    const context = makeContext({ originDistanceM: 50, originAccuracyM: 10, direction: 'up', line: '7' });
    const arrival = makeArrival({ direction: 'up', line: '7', arrivalCode: 4 });
    expect(evaluateLocalBoardingPromptGate({ context, arrival })).toEqual({
      pass: false,
      reason: 'suppressed-not-imminent',
    });
  });

  // #2801 (3차 reopen, audit-sides 편측 확정) — approaching(3/5)도 backend와 동일하게 pass해야
  // 한다. drift 방치 시 MINIMAL_ALARM 활성화 순간 10/2 miss의 device 버전이 재현된다.
  it('근접+같은 line 후보 approaching(arrivalCode=5 전역도착) → pass', () => {
    const context = makeContext({ originDistanceM: 50, originAccuracyM: 10, direction: 'up', line: '7' });
    const arrival = makeArrival({ direction: 'up', line: '7', arrivalCode: 5 });
    expect(evaluateLocalBoardingPromptGate({ context, arrival })).toEqual({ pass: true });
  });

  it('근접+같은 line 후보 imminent(arrivalCode=1 ARRIVED) → pass', () => {
    const context = makeContext({ originDistanceM: 50, originAccuracyM: 10, direction: 'up', line: '7' });
    const arrival = makeArrival({ direction: 'up', line: '7', arrivalCode: 1 });
    expect(evaluateLocalBoardingPromptGate({ context, arrival })).toEqual({ pass: true });
  });

  it('근접+같은 line 후보 미관측(arrivalCode=-1) → pass (fallback-unobservable, 지하 miss 방지)', () => {
    const context = makeContext({ originDistanceM: 50, originAccuracyM: 10, direction: 'up', line: '7' });
    const arrival = makeArrival({ direction: 'up', line: '7', arrivalCode: -1 });
    expect(evaluateLocalBoardingPromptGate({ context, arrival })).toEqual({ pass: true });
  });
});

describe('#2801 — decideLocalBoardingPromptFire (device 로컬 임박 게이트, backend decideBoardingPromptFire와 parity)', () => {
  function arrival(arrivalCode: number): ArrivalInfo {
    return {
      destination: '건대입구',
      arrivalMinutes: 3,
      arrivalSeconds: 180,
      statusMessage: '도착',
      trainCode: '1234',
      line: '7',
      receivedAtMs: Date.now(),
      arrivalCode,
      isLastTrain: false,
      trainType: 'normal',
    };
  }

  it('임박(arrivalCode=1) 존재 → fire:true, decision=imminent', () => {
    expect(decideLocalBoardingPromptFire([arrival(1), arrival(99)])).toEqual({
      fire: true,
      decision: 'imminent',
    });
  });

  it('먼 열차만(arrivalCode=[4,99], 전부 관측됨) → fire:false, decision=suppressed-not-imminent', () => {
    expect(decideLocalBoardingPromptFire([arrival(4), arrival(99)])).toEqual({
      fire: false,
      decision: 'suppressed-not-imminent',
    });
  });

  // #2801 (3차 reopen, audit-sides 편측 확정 2026-10-03) — backend decideBoardingPromptFire와
  // parity. 5(전역도착)/3(전역출발)만 있어도 발사해야 한다(decision 분리).
  it('approaching(arrivalCode=5 전역도착) 존재 → fire:true, decision=approaching', () => {
    expect(decideLocalBoardingPromptFire([arrival(5)])).toEqual({
      fire: true,
      decision: 'approaching',
    });
  });

  it('4(전역진입)만 → fire:false, decision=suppressed-not-imminent (의도적 제외, 거부 케이스)', () => {
    expect(decideLocalBoardingPromptFire([arrival(4)])).toEqual({
      fire: false,
      decision: 'suppressed-not-imminent',
    });
  });

  it('혼합(arrivalCode=[3,-1]) → approaching이 결정적 신호이므로 fallback-unobservable보다 우선', () => {
    expect(decideLocalBoardingPromptFire([arrival(3), arrival(-1)])).toEqual({
      fire: true,
      decision: 'approaching',
    });
  });

  it('전부 미관측(arrivalCode=-1) → fire:true, decision=fallback-unobservable', () => {
    expect(decideLocalBoardingPromptFire([arrival(-1), arrival(-1)])).toEqual({
      fire: true,
      decision: 'fallback-unobservable',
    });
  });

  it('혼합(arrivalCode=[99,-1]) → fire:true, decision=fallback-unobservable (관측 불가 우선)', () => {
    expect(decideLocalBoardingPromptFire([arrival(99), arrival(-1)])).toEqual({
      fire: true,
      decision: 'fallback-unobservable',
    });
  });

  it('출발(arrivalCode=2 DEPARTED) → fire:true, decision=imminent (backend와 동일 회고형 정합)', () => {
    expect(decideLocalBoardingPromptFire([arrival(2)])).toEqual({
      fire: true,
      decision: 'imminent',
    });
  });
});
