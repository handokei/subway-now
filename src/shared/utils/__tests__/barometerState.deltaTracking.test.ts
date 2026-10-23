/**
 * #3191 PR-0 — 기압 ΔP 이벤트 시각 / 첫 hPa 기준선 계측 (동작 변경 0, 관측 전용).
 *
 * 이슈 스펙: "기압 ΔP 이벤트 시각을 Raw에 기록" + "첫 hPa 기준선(§14-5 해제용)".
 * ΔP 이벤트 = 30초 창(BAROMETER_DPDT_WINDOW_MS) 안에서 |ΔP| >= 0.3 hPa(BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA).
 */
import {
  appendBarometerReading,
  getBarometerDeltaTracking,
  getBarometerReadings,
  resetBarometerInstrumentationForTest,
  resetBarometerState,
} from '../barometerState';

const T0 = 1_700_000_000_000;

describe('barometerState 델타 계측 (#3191 PR-0)', () => {
  beforeEach(() => {
    resetBarometerState();
    resetBarometerInstrumentationForTest();
  });

  it('초기값은 전부 null', () => {
    expect(getBarometerDeltaTracking()).toEqual({
      firstHpa: null,
      firstHpaAtMs: null,
      lastDeltaEventAtMs: null,
    });
  });

  it('첫 reading만 firstHpa/firstHpaAtMs로 고정되고 이후 reading이 덮지 않는다', () => {
    appendBarometerReading({ t: T0, pressureHpa: 1013.0 });
    appendBarometerReading({ t: T0 + 1_000, pressureHpa: 1013.05 });
    const { firstHpa, firstHpaAtMs } = getBarometerDeltaTracking();
    expect(firstHpa).toBe(1013.0);
    expect(firstHpaAtMs).toBe(T0);
  });

  it('30초 창 안에서 |ΔP| >= 0.3 이면 그 reading 시각이 이벤트 시각', () => {
    appendBarometerReading({ t: T0, pressureHpa: 1013.0 });
    appendBarometerReading({ t: T0 + 10_000, pressureHpa: 1013.4 });
    expect(getBarometerDeltaTracking().lastDeltaEventAtMs).toBe(T0 + 10_000);
  });

  it('하강(음수 ΔP)도 이벤트', () => {
    appendBarometerReading({ t: T0, pressureHpa: 1013.4 });
    appendBarometerReading({ t: T0 + 5_000, pressureHpa: 1013.0 });
    expect(getBarometerDeltaTracking().lastDeltaEventAtMs).toBe(T0 + 5_000);
  });

  it('|ΔP| < 0.3 이면 이벤트 없음', () => {
    appendBarometerReading({ t: T0, pressureHpa: 1013.0 });
    appendBarometerReading({ t: T0 + 10_000, pressureHpa: 1013.29 });
    expect(getBarometerDeltaTracking().lastDeltaEventAtMs).toBeNull();
  });

  it('창(30초)을 벗어난 과거 reading과의 차이는 이벤트가 아니다', () => {
    appendBarometerReading({ t: T0, pressureHpa: 1013.0 });
    appendBarometerReading({ t: T0 + 40_000, pressureHpa: 1013.9 });
    expect(getBarometerDeltaTracking().lastDeltaEventAtMs).toBeNull();
  });

  it('이벤트 시각은 ring buffer prune/resetBarometerState 이후에도 남는다', () => {
    appendBarometerReading({ t: T0, pressureHpa: 1013.0 });
    appendBarometerReading({ t: T0 + 10_000, pressureHpa: 1013.4 });
    resetBarometerState();
    expect(getBarometerReadings()).toHaveLength(0);
    expect(getBarometerDeltaTracking().lastDeltaEventAtMs).toBe(T0 + 10_000);
  });

  it('동작 불변 — 계측 추가가 ring buffer 내용을 바꾸지 않는다', () => {
    appendBarometerReading({ t: T0, pressureHpa: 1013.0 });
    appendBarometerReading({ t: T0 + 10_000, pressureHpa: 1013.4 });
    expect(getBarometerReadings()).toEqual([
      { t: T0, pressureHpa: 1013.0 },
      { t: T0 + 10_000, pressureHpa: 1013.4 },
    ]);
  });

  it('resetBarometerInstrumentationForTest가 델타 계측도 초기화', () => {
    appendBarometerReading({ t: T0, pressureHpa: 1013.0 });
    appendBarometerReading({ t: T0 + 10_000, pressureHpa: 1013.4 });
    resetBarometerInstrumentationForTest();
    expect(getBarometerDeltaTracking()).toEqual({
      firstHpa: null,
      firstHpaAtMs: null,
      lastDeltaEventAtMs: null,
    });
  });
});
