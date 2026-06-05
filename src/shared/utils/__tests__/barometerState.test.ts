import {
  appendBarometerReading,
  evaluateLatestSubsurface,
  getBarometerReadings,
  narrowStationsByPressure,
  resetBarometerState,
} from '../barometerState';
import {
  BAROMETER_DPDT_WINDOW_MS,
  BAROMETER_RING_BUFFER_TTL_MS,
  BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA,
  DEPTH_TO_PRESSURE_HPA_PER_M,
} from '../../constants/barometer';
import type { Station } from '../../types/station';

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

describe('narrowStationsByPressure (#920)', () => {
  // stationAbsolutePressure.json 실재 entry — 종로3가 1호선 depth_m=14.
  const JONGNO3GA_LINE1: Station = {
    id: '1-031',
    name: '종로3가',
    line: '1',
    lineColor: '#0052A4',
    lat: 37.571607,
    lng: 126.991806,
  };
  const JONGNO3GA_LINE5: Station = {
    id: '5-025',
    name: '종로3가',
    line: '5',
    lineColor: '#996CAC',
    lat: 37.571607,
    lng: 126.991806,
  };
  const GURO_SURFACE: Station = {
    id: '1-042',
    name: '구로',
    line: '1',
    lineColor: '#0052A4',
    lat: 37.5,
    lng: 126.88,
  };
  const NOT_IN_DATA: Station = {
    id: 'unknown-999',
    name: '없는역',
    line: '1',
    lineColor: '#0052A4',
    lat: 0,
    lng: 0,
  };

  const SURFACE = 1013;
  const PRESSURE_AT_14M = SURFACE + 14 * DEPTH_TO_PRESSURE_HPA_PER_M; // 1014.68
  const PRESSURE_AT_35M = SURFACE + 35 * DEPTH_TO_PRESSURE_HPA_PER_M; // 1017.2

  it('candidates 비어있으면 빈 배열 반환', () => {
    expect(narrowStationsByPressure(PRESSURE_AT_14M, SURFACE, [])).toEqual([]);
  });

  it('candidates 인자 생략 시 default [] → 빈 결과', () => {
    expect(narrowStationsByPressure(PRESSURE_AT_14M, SURFACE)).toEqual([]);
  });

  it('얕은 깊이(14m) 압력이 14m 역만 매칭', () => {
    const result = narrowStationsByPressure(PRESSURE_AT_14M, SURFACE, [
      JONGNO3GA_LINE1,
      JONGNO3GA_LINE5,
    ]);
    expect(result).toEqual([JONGNO3GA_LINE1]);
  });

  it('깊은 깊이(35m) 압력이 35m 역만 매칭', () => {
    const result = narrowStationsByPressure(PRESSURE_AT_35M, SURFACE, [
      JONGNO3GA_LINE1,
      JONGNO3GA_LINE5,
    ]);
    expect(result).toEqual([JONGNO3GA_LINE5]);
  });

  it('지상 압력은 depth_m=0 역(구로) 매칭', () => {
    const result = narrowStationsByPressure(SURFACE, SURFACE, [
      GURO_SURFACE,
      JONGNO3GA_LINE5,
    ]);
    expect(result).toEqual([GURO_SURFACE]);
  });

  it('데이터에 없는 stationId는 후보로 포함돼도 제외', () => {
    const result = narrowStationsByPressure(PRESSURE_AT_14M, SURFACE, [
      NOT_IN_DATA,
      JONGNO3GA_LINE1,
    ]);
    expect(result).toEqual([JONGNO3GA_LINE1]);
  });

  it('tolerance 내(±1 hPa default)면 매칭', () => {
    const result = narrowStationsByPressure(PRESSURE_AT_14M + 0.5, SURFACE, [
      JONGNO3GA_LINE1,
    ]);
    expect(result).toEqual([JONGNO3GA_LINE1]);
  });

  it('tolerance 밖이면 매칭 없음', () => {
    const result = narrowStationsByPressure(PRESSURE_AT_14M + 5, SURFACE, [
      JONGNO3GA_LINE1,
    ]);
    expect(result).toEqual([]);
  });

  it('tolerance 명시 override 가능', () => {
    const result = narrowStationsByPressure(
      PRESSURE_AT_14M + 2,
      SURFACE,
      [JONGNO3GA_LINE1],
      3,
    );
    expect(result).toEqual([JONGNO3GA_LINE1]);
  });

  it('surfacePressure 변동(저기압)에도 동일 depth 매칭 가능', () => {
    const lowSurface = 1005;
    const measured = lowSurface + 14 * DEPTH_TO_PRESSURE_HPA_PER_M;
    const result = narrowStationsByPressure(measured, lowSurface, [
      JONGNO3GA_LINE1,
    ]);
    expect(result).toEqual([JONGNO3GA_LINE1]);
  });
});
