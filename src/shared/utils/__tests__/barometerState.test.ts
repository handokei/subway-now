import {
  appendBarometerReading,
  evaluateLatestStop,
  evaluateLatestSubsurface,
  getBarometerReadings,
  narrowStationsByDepthAndEta,
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
    appendBarometerReading({ t: NOW, pressureHpa: 1013 });
    appendBarometerReading({ t: NOW + 1_000, pressureHpa: 10135 });
    expect(getBarometerReadings()).toHaveLength(2);
  });

  it('append 시 TTL 초과 reading 자동 제거', () => {
    appendBarometerReading({
      t: NOW - BAROMETER_RING_BUFFER_TTL_MS - 5_000,
      pressureHpa: 1012,
    });
    // 새 reading의 t를 now로 사용하므로, 위 entry는 cutoff 밖으로 즉시 제거됨.
    appendBarometerReading({ t: NOW, pressureHpa: 1013 });
    expect(getBarometerReadings()).toHaveLength(1);
    expect(getBarometerReadings()[0].pressureHpa).toBeCloseTo(1013);
  });

  it('충분한 readings 누적 후 평가 → detected', () => {
    appendBarometerReading({
      t: NOW - BAROMETER_DPDT_WINDOW_MS,
      pressureHpa: 1013,
    });
    appendBarometerReading({
      t: NOW,
      pressureHpa: 1013 + BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA,
    });
    const v = evaluateLatestSubsurface(NOW);
    expect(v).not.toBeNull();
    expect(v!.detected).toBe(true);
  });

  it('evaluateLatestStop — readings 부족 시 null, 정차 패턴이면 detected', () => {
    expect(evaluateLatestStop(NOW)).toBeNull();
    appendBarometerReading({
      t: NOW - BAROMETER_DPDT_WINDOW_MS,
      pressureHpa: 1013,
    });
    appendBarometerReading({ t: NOW, pressureHpa: 1013 });
    const v = evaluateLatestStop(NOW);
    expect(v).not.toBeNull();
    expect(v!.detected).toBe(true);
  });

  it('resetBarometerState → 비움', () => {
    appendBarometerReading({ t: NOW, pressureHpa: 1013 });
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

describe('narrowStationsByDepthAndEta (#920 후속)', () => {
  // 라인5 인접 hop: 광화문(5-024 depth 32m) ↔ 종로3가(5-025 depth 35m), 100s.
  const GWANGHWAMUN_5: Station = {
    id: '5-024',
    name: '광화문',
    line: '5',
    lineColor: '#996CAC',
    lat: 37.5715,
    lng: 126.9769,
  };
  const JONGNO3GA_5: Station = {
    id: '5-025',
    name: '종로3가',
    line: '5',
    lineColor: '#996CAC',
    lat: 37.5717,
    lng: 126.9919,
  };
  // 라인2 인접 hop: 삼성(2-019 depth 21m) ↔ 선릉(2-020 depth 18m), 90s.
  const SAMSEONG_2: Station = {
    id: '2-019',
    name: '삼성',
    line: '2',
    lineColor: '#00A84D',
    lat: 37.5089,
    lng: 127.0631,
  };
  const SEOLLEUNG_2: Station = {
    id: '2-020',
    name: '선릉',
    line: '2',
    lineColor: '#00A84D',
    lat: 37.5044,
    lng: 127.0489,
  };
  // 데이터에 없는 역 — 깊이 lookup 실패.
  const UNKNOWN_2: Station = {
    id: 'unknown-x',
    name: '없음',
    line: '2',
    lineColor: '#00A84D',
    lat: 0,
    lng: 0,
  };
  // 인접 hop 데이터 없음(다른 노선/먼 역).
  const SURFACE = 1013;

  it('candidates 0개면 빈 배열', () => {
    const result = narrowStationsByDepthAndEta({
      measuredPressureHpa: SURFACE,
      surfacePressureHpa: SURFACE,
      candidates: [],
      previousStation: GWANGHWAMUN_5,
      secondsSincePrevious: 90,
    });
    expect(result).toEqual([]);
  });

  it('candidates 1개면 no-op (입력 그대로)', () => {
    const result = narrowStationsByDepthAndEta({
      measuredPressureHpa: SURFACE,
      surfacePressureHpa: SURFACE,
      candidates: [JONGNO3GA_5],
      previousStation: GWANGHWAMUN_5,
      secondsSincePrevious: 100,
    });
    expect(result).toEqual([JONGNO3GA_5]);
  });

  it('secondsSincePrevious 음수면 baseline 그대로', () => {
    const result = narrowStationsByDepthAndEta({
      measuredPressureHpa: SURFACE + 35 * DEPTH_TO_PRESSURE_HPA_PER_M,
      surfacePressureHpa: SURFACE,
      candidates: [JONGNO3GA_5, SEOLLEUNG_2],
      previousStation: GWANGHWAMUN_5,
      secondsSincePrevious: -1,
    });
    expect(result).toEqual([JONGNO3GA_5, SEOLLEUNG_2]);
  });

  it('winner 명확(다른 노선 후보 평가 불가 + 인접 후보 단일) → 인접 후보 반환', () => {
    // previousStation=광화문(5호선). 후보: 종로3가(5호선 인접), 선릉(2호선, 평가 불가).
    // 평가 가능한 후보 1개 → 그 후보 반환.
    const result = narrowStationsByDepthAndEta({
      measuredPressureHpa: SURFACE + 35 * DEPTH_TO_PRESSURE_HPA_PER_M,
      surfacePressureHpa: SURFACE,
      candidates: [JONGNO3GA_5, SEOLLEUNG_2],
      previousStation: GWANGHWAMUN_5,
      secondsSincePrevious: 100,
    });
    expect(result).toEqual([JONGNO3GA_5]);
  });

  it('winner 점수가 너무 약하면 baseline 그대로 (TOO_WEAK 가드)', () => {
    // 측정값/elapsed 모두 expected에서 크게 어긋남.
    const result = narrowStationsByDepthAndEta({
      measuredPressureHpa: SURFACE + 100, // depthError ≈ 100 → score 매우 큼
      surfacePressureHpa: SURFACE,
      candidates: [JONGNO3GA_5, SEOLLEUNG_2],
      previousStation: GWANGHWAMUN_5,
      secondsSincePrevious: 100,
    });
    expect(result).toEqual([JONGNO3GA_5, SEOLLEUNG_2]);
  });

  it('previousStation이 모든 후보와 다른 노선 → baseline 그대로', () => {
    // previousStation=2호선 삼성, 후보=5호선 — 평가 가능한 후보 0개.
    const result = narrowStationsByDepthAndEta({
      measuredPressureHpa: SURFACE + 35 * DEPTH_TO_PRESSURE_HPA_PER_M,
      surfacePressureHpa: SURFACE,
      candidates: [JONGNO3GA_5, GWANGHWAMUN_5],
      previousStation: SAMSEONG_2,
      secondsSincePrevious: 90,
    });
    expect(result).toEqual([JONGNO3GA_5, GWANGHWAMUN_5]);
  });

  it('인접 hop은 있지만 깊이 데이터 없는 후보는 점수화에서 skip', () => {
    // 서대문(5-023) ↔ 충정로(5-022) hop 존재(60s). 충정로는 depth 데이터 없음.
    // previousStation=서대문, candidates=[충정로, 광화문] → 충정로는 depth 없어 skip,
    // 광화문(인접+데이터)만 평가 → 단일 후보 반환.
    const CHUNGJEONGNO_5: Station = {
      id: '5-022',
      name: '충정로',
      line: '5',
      lineColor: '#996CAC',
      lat: 37.5602,
      lng: 126.9629,
    };
    const result = narrowStationsByDepthAndEta({
      measuredPressureHpa: SURFACE + 32 * DEPTH_TO_PRESSURE_HPA_PER_M, // 광화문 depth
      surfacePressureHpa: SURFACE,
      candidates: [CHUNGJEONGNO_5, GWANGHWAMUN_5],
      previousStation: SEODAEMUN_5,
      secondsSincePrevious: 90,
    });
    expect(result).toEqual([GWANGHWAMUN_5]);
  });

  it('데이터에 없는 후보는 점수화에서 제외(graceful skip)', () => {
    // previousStation=삼성, 후보=선릉(인접+데이터 있음), UNKNOWN_2(데이터 없음).
    // 평가 가능한 후보 1개 → 선릉 반환.
    const result = narrowStationsByDepthAndEta({
      measuredPressureHpa: SURFACE + 18 * DEPTH_TO_PRESSURE_HPA_PER_M,
      surfacePressureHpa: SURFACE,
      candidates: [SEOLLEUNG_2, UNKNOWN_2],
      previousStation: SAMSEONG_2,
      secondsSincePrevious: 90,
    });
    expect(result).toEqual([SEOLLEUNG_2]);
  });

  // 라인5: 5-024 광화문 기준 양방향 인접 = 5-023 서대문(depth 30), 5-025 종로3가(depth 35).
  // hop sec: 5-024↔5-023 = 90s, 5-024↔5-025 = 100s.
  const SEODAEMUN_5: Station = {
    id: '5-023',
    name: '서대문',
    line: '5',
    lineColor: '#996CAC',
    lat: 37.5657,
    lng: 126.9666,
  };

  it('두 후보 모두 평가 가능 + winner 명확 → winner 단일 반환', () => {
    // 측정 1017.2 hPa(=35m), elapsed 100s → 종로3가 score 0.0, 서대문 score는 depthError 0.6/1.0 + etaError 10/30 ≈ 0.93.
    // gap=0.93 ≥ DECISIVE_GAP(1.0)? 아래에서 정밀히 — DEPTH_ETA_DECISIVE_GAP는 함수 내 1.0.
    // 두 점수 차이가 ≥ 1.0이어야 winner 선택. 이 시나리오는 약 0.93 → fallback.
    // → 더 명확한 시나리오: depth 35m + elapsed 100s 정확히.
    //   서대문 expected 1016.6 → depthError 0.6, hopSec 90 → etaError 10. score = 0.6/1.0 + 10/30 = 0.933.
    //   종로3가 expected 1017.2 → depthError 0, hopSec 100 → etaError 0. score = 0.
    //   gap = 0.933 ≥ 1.0? 미달. → 시나리오 변경: elapsed 130 + 측정 1018.4 (50m 가까운 가공값).
    //   대신 "winner=종로3가, 서대문은 명확히 어긋남" 시나리오로 elapsed 200s + 측정 1017.2 사용.
    //   종로3가: depthError 0, etaError |200-100|=100. score = 100/30 = 3.33. > TOO_WEAK(2.0) → fallback.
    //   → 결국 본 데이터 폭에서는 winner를 명확하게 가르되 TOO_WEAK 미만으로 만들기 어렵다.
    // 대신 etaToleranceSec를 크게 override해 score를 누른다.
    const result = narrowStationsByDepthAndEta({
      measuredPressureHpa: SURFACE + 35 * DEPTH_TO_PRESSURE_HPA_PER_M, // 1017.2
      surfacePressureHpa: SURFACE,
      candidates: [SEODAEMUN_5, JONGNO3GA_5],
      previousStation: GWANGHWAMUN_5,
      secondsSincePrevious: 100,
      etaToleranceSec: 5, // 압축 → etaError 10/5=2.0, depthError 0.6/1.0=0.6 → 서대문 score 2.6
    });
    // 종로3가 score 0, 서대문 score 2.6, gap=2.6 ≥ 1.0 → winner=종로3가.
    expect(result).toEqual([JONGNO3GA_5]);
  });

  it('두 후보 모두 평가 가능 + gap 미달 → baseline 그대로', () => {
    // 측정/elapsed를 두 후보 중간값으로 → 점수 비슷, gap < 1.0.
    // 광화문 출발, elapsed 95(평균), 측정 = (1016.6+1017.2)/2 = 1016.9.
    //   서대문: depthError |1016.9-1016.6|=0.3, etaError |95-90|=5. score = 0.3 + 5/30 ≈ 0.467.
    //   종로3가: depthError |1016.9-1017.2|=0.3, etaError |95-100|=5. score ≈ 0.467.
    //   gap ≈ 0 < 1.0 → baseline candidates 그대로 (입력 순서 유지).
    const result = narrowStationsByDepthAndEta({
      measuredPressureHpa: 1016.9,
      surfacePressureHpa: SURFACE,
      candidates: [SEODAEMUN_5, JONGNO3GA_5],
      previousStation: GWANGHWAMUN_5,
      secondsSincePrevious: 95,
    });
    expect(result).toEqual([SEODAEMUN_5, JONGNO3GA_5]);
  });
});
