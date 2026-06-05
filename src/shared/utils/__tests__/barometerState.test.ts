import {
  appendBarometerReading,
  evaluateLatestSubsurface,
  getBarometerReadings,
  resetBarometerState,
} from '../barometerState';
import {
  BAROMETER_DPDT_WINDOW_MS,
  BAROMETER_RING_BUFFER_TTL_MS,
  BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA,
} from '../../constants/barometer';

const NOW = 1_700_000_000_000;

beforeEach(() => {
  resetBarometerState();
});

describe('barometerState (#875)', () => {
  it('초기 상태 → readings 비어있음, verdict null', () => {
    expect(getBarometerReadings()).toEqual([]);
    expect(evaluateLatestSubsurface(NOW)).toBeNull();
  });

  it('append 시 readings에 누적', () => {
    appendBarometerReading({ t: NOW, pressureHpa: 1013.0 });
    appendBarometerReading({ t: NOW + 1_000, pressureHpa: 1013.05 });
    expect(getBarometerReadings()).toHaveLength(2);
  });

  it('append 시 TTL 초과 reading 자동 제거', () => {
    appendBarometerReading({
      t: NOW - BAROMETER_RING_BUFFER_TTL_MS - 5_000,
      pressureHpa: 1012.0,
    });
    // 새 reading의 t를 now로 사용하므로, 위 entry는 cutoff 밖으로 즉시 제거됨.
    appendBarometerReading({ t: NOW, pressureHpa: 1013.0 });
    expect(getBarometerReadings()).toHaveLength(1);
    expect(getBarometerReadings()[0].pressureHpa).toBeCloseTo(1013.0);
  });

  it('충분한 readings 누적 후 평가 → detected', () => {
    appendBarometerReading({
      t: NOW - BAROMETER_DPDT_WINDOW_MS,
      pressureHpa: 1013.0,
    });
    appendBarometerReading({
      t: NOW,
      pressureHpa: 1013.0 + BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA,
    });
    const v = evaluateLatestSubsurface(NOW);
    expect(v).not.toBeNull();
    expect(v!.detected).toBe(true);
  });

  it('resetBarometerState → 비움', () => {
    appendBarometerReading({ t: NOW, pressureHpa: 1013.0 });
    expect(getBarometerReadings()).toHaveLength(1);
    resetBarometerState();
    expect(getBarometerReadings()).toEqual([]);
  });
});
