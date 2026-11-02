/**
 * #3191 PR-0 — ΔP 이벤트 종류(window | gap) 계측. 관측 전용(동작 변경 0).
 * 행 8·9의 baro-event가 30s 창 이벤트인지 공백 건넌 이벤트인지 Raw 덤프로 가르기 위한 기록.
 */
import {
  appendBarometerReading,
  getBarometerDeltaTracking,
  resetBarometerInstrumentationForTest,
  resetBarometerState,
} from '../barometerState';

const T0 = 1_700_000_000_000;

describe('barometerState lastDeltaEventKind (#3191 PR-0)', () => {
  beforeEach(() => {
    resetBarometerState();
    resetBarometerInstrumentationForTest();
  });

  it('이벤트가 없으면 null', () => {
    appendBarometerReading({ t: T0, pressureHpa: 1013.0 });
    appendBarometerReading({ t: T0 + 10_000, pressureHpa: 1013.1 });
    expect(getBarometerDeltaTracking().lastDeltaEventKind).toBeNull();
  });

  it("30s 창 안 |ΔP|>=0.3 -> 'window'", () => {
    appendBarometerReading({ t: T0, pressureHpa: 1013.0 });
    appendBarometerReading({ t: T0 + 10_000, pressureHpa: 1013.4 });
    expect(getBarometerDeltaTracking().lastDeltaEventKind).toBe('window');
  });

  it("직전 reading이 창 밖인 |ΔP|>=0.3 -> 'gap'", () => {
    appendBarometerReading({ t: T0, pressureHpa: 1013.0 });
    appendBarometerReading({ t: T0 + 40_000, pressureHpa: 1013.5 });
    expect(getBarometerDeltaTracking().lastDeltaEventKind).toBe('gap');
  });

  it('이후 이벤트 없는 reading은 마지막 종류를 유지 (lastDeltaEventAtMs와 짝)', () => {
    appendBarometerReading({ t: T0, pressureHpa: 1013.0 });
    appendBarometerReading({ t: T0 + 10_000, pressureHpa: 1013.4 });
    appendBarometerReading({ t: T0 + 11_000, pressureHpa: 1013.2 });
    const { lastDeltaEventAtMs, lastDeltaEventKind } = getBarometerDeltaTracking();
    expect(lastDeltaEventAtMs).toBe(T0 + 10_000);
    expect(lastDeltaEventKind).toBe('window');
  });

  it('reset 후 null', () => {
    appendBarometerReading({ t: T0, pressureHpa: 1013.0 });
    appendBarometerReading({ t: T0 + 10_000, pressureHpa: 1013.4 });
    resetBarometerInstrumentationForTest();
    expect(getBarometerDeltaTracking().lastDeltaEventKind).toBeNull();
  });
});
