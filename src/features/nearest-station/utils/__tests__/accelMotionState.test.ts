import { getLatestAccelSummary, setLatestAccelSummary } from '../accelMotionState';
import type { AccelSummary } from '../accelMotion';

const SAMPLE: AccelSummary = {
  startTs: 1000,
  endTs: 2000,
  count: 100,
  ax: 0.1,
  ay: 0.2,
  az: 0.3,
  magnitudeMean: 0.5,
  magnitudeStd: 0.1,
  magnitudePeak: 1.2,
};

afterEach(() => {
  // 모듈 ambient state는 테스트 격리를 위해 매번 reset.
  setLatestAccelSummary(null);
});

describe('accelMotionState — ambient', () => {
  it('초기값은 null', () => {
    expect(getLatestAccelSummary()).toBeNull();
  });

  it('set → get round-trip', () => {
    setLatestAccelSummary(SAMPLE);
    expect(getLatestAccelSummary()).toEqual(SAMPLE);
  });

  it('null 명시 reset → 초기값 복귀', () => {
    setLatestAccelSummary(SAMPLE);
    setLatestAccelSummary(null);
    expect(getLatestAccelSummary()).toBeNull();
  });
});
