/**
 * #3191 PR-2 (D2(b)) — 마지막 reading 시각 + "reset이 세션 추적을 건드리지 않는다"는 불변식 승격.
 *
 * 주석(barometerState.ts)에만 살던 불변식: ΔP 추적(firstHpaAtMs / lastDeltaEventAtMs)은
 * resetBarometerState()(hook unmount마다 호출)의 영향을 받지 않는다. 기압계 관측 가능 판정(D2(b))이
 * 이 값에 기대므로 테스트로 고정한다.
 */
import {
  appendBarometerReading,
  getBarometerDeltaTracking,
  getBarometerReadings,
  getLastBarometerReadingAtMs,
  resetBarometerInstrumentationForTest,
  resetBarometerState,
} from '../barometerState';

const T0 = 1_700_000_000_000;

describe('barometerState 마지막 reading 시각 (#3191 PR-2)', () => {
  beforeEach(() => {
    resetBarometerState();
    resetBarometerInstrumentationForTest();
  });

  it('reading이 없으면 null', () => {
    expect(getLastBarometerReadingAtMs()).toBeNull();
  });

  it('가장 최근 append의 t', () => {
    appendBarometerReading({ t: T0, pressureHpa: 1013.0 });
    appendBarometerReading({ t: T0 + 7_000, pressureHpa: 1013.0 });
    expect(getLastBarometerReadingAtMs()).toBe(T0 + 7_000);
  });

  it('resetBarometerState()는 ring만 비운다 — 마지막 reading 시각 / 첫 hPa / ΔP 이벤트는 세션 동안 유지', () => {
    appendBarometerReading({ t: T0, pressureHpa: 1013.0 });
    appendBarometerReading({ t: T0 + 5_000, pressureHpa: 1013.5 });
    resetBarometerState();
    expect(getBarometerReadings()).toEqual([]);
    expect(getLastBarometerReadingAtMs()).toBe(T0 + 5_000);
    const { firstHpaAtMs, lastDeltaEventAtMs } = getBarometerDeltaTracking();
    expect(firstHpaAtMs).toBe(T0);
    expect(lastDeltaEventAtMs).toBe(T0 + 5_000);
  });
});
