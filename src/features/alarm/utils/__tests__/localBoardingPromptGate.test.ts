import {
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
    statusMessage: '전역 출발',
    trainCode: '1234',
    line: '7',
    receivedAtMs: Date.now(),
    arrivalCode: 3,
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
});
