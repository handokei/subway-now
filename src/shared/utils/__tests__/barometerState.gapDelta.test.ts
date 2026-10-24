/**
 * #3191 PR-1 — 기압 공백을 건넌 ΔP도 이동 증거 이벤트로 기록한다 (F9 BG 복귀 Δ3.4 hPa).
 * 30초 창 밖(공백 > BAROMETER_DPDT_WINDOW_MS)이라 창 규칙으론 안 잡히는 경우.
 */
import {
  appendBarometerReading,
  getBarometerDeltaTracking,
  resetBarometerInstrumentationForTest,
  resetBarometerState,
} from '../barometerState';

const T0 = 1_700_000_000_000;

describe('barometerState 공백 건넌 ΔP 이벤트 (#3191 PR-1)', () => {
  beforeEach(() => {
    resetBarometerState();
    resetBarometerInstrumentationForTest();
  });

  it('공백(>30s) 뒤 |ΔP| >= 0.3 이면 이벤트 (F9: Δ3.4)', () => {
    appendBarometerReading({ t: T0, pressureHpa: 1013.0 });
    appendBarometerReading({ t: T0 + 120_000, pressureHpa: 1016.4 });
    expect(getBarometerDeltaTracking().lastDeltaEventAtMs).toBe(T0 + 120_000);
  });

  it('공백 뒤여도 |ΔP| < 0.3 이면 이벤트 아님', () => {
    appendBarometerReading({ t: T0, pressureHpa: 1013.0 });
    appendBarometerReading({ t: T0 + 120_000, pressureHpa: 1013.2 });
    expect(getBarometerDeltaTracking().lastDeltaEventAtMs).toBeNull();
  });

  it('공백 뒤 하강(음수 ΔP)도 이벤트', () => {
    appendBarometerReading({ t: T0, pressureHpa: 1013.0 });
    appendBarometerReading({ t: T0 + 45_000, pressureHpa: 1012.5 });
    expect(getBarometerDeltaTracking().lastDeltaEventAtMs).toBe(T0 + 45_000);
  });

  it('reset 후 새 세션 첫 reading은 비교 대상(직전 reading)이 없어 이벤트 아님', () => {
    appendBarometerReading({ t: T0, pressureHpa: 1013.0 });
    resetBarometerInstrumentationForTest();
    appendBarometerReading({ t: T0 + 120_000, pressureHpa: 1016.4 });
    expect(getBarometerDeltaTracking().lastDeltaEventAtMs).toBeNull();
  });
});
