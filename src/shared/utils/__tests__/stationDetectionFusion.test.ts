/**
 * #921 — 신호 fusion (B1 첫 PR) 테스트.
 *
 * pure JS 알고리즘만 검증. 실제 hook 통합은 후속 PR.
 */
import {
  fuseStationDetectionSignals,
  STATION_DETECTION_SIGNALS,
  type StationDetectionSignalName,
  type StationDetectionSignalInput,
} from '../stationDetectionFusion';

describe('fuseStationDetectionSignals', () => {
  const ALL_TRUE: StationDetectionSignalInput = {
    'barometer-stop': true,
    'motion-stationary': true,
    'arvlcd-arrived': true,
  };

  it('3개 합의 → detected high', () => {
    const v = fuseStationDetectionSignals(ALL_TRUE);
    expect(v.detected).toBe(true);
    expect(v.confidence).toBe('high');
    expect(v.signalsAgreed).toBe(3);
    expect(v.signalsAvailable).toBe(3);
  });

  it.each<[string, StationDetectionSignalName, StationDetectionSignalName]>([
    ['barometer + motion', 'barometer-stop', 'motion-stationary'],
    ['barometer + arvlcd', 'barometer-stop', 'arvlcd-arrived'],
    ['motion + arvlcd', 'motion-stationary', 'arvlcd-arrived'],
  ])('2개 합의 (%s) → detected medium', (_label, a, b) => {
    const v = fuseStationDetectionSignals({ [a]: true, [b]: true });
    expect(v.detected).toBe(true);
    expect(v.confidence).toBe('medium');
    expect(v.signalsAgreed).toBe(2);
  });

  it.each<StationDetectionSignalName>([...STATION_DETECTION_SIGNALS])(
    '1개 합의 (%s) → detected=false low',
    (signal) => {
      const v = fuseStationDetectionSignals({ [signal]: true });
      expect(v.detected).toBe(false);
      expect(v.confidence).toBe('low');
      expect(v.signalsAgreed).toBe(1);
    },
  );

  it('0개 합의 → detected=false low', () => {
    const v = fuseStationDetectionSignals({});
    expect(v.detected).toBe(false);
    expect(v.confidence).toBe('low');
    expect(v.signalsAgreed).toBe(0);
  });

  it('false로 명시한 신호는 합의에 포함하지 않는다', () => {
    const v = fuseStationDetectionSignals({
      'barometer-stop': false,
      'motion-stationary': false,
      'arvlcd-arrived': false,
    });
    expect(v.detected).toBe(false);
    expect(v.signalsAgreed).toBe(0);
  });

  it('undefined 신호는 unavailable로 분류한다 (signalsAvailable 감소)', () => {
    const v = fuseStationDetectionSignals({
      'barometer-stop': true,
      'motion-stationary': true,
      // arvlcd-arrived 미제공
    });
    expect(v.detected).toBe(true);
    expect(v.confidence).toBe('medium');
    expect(v.signalsAgreed).toBe(2);
    expect(v.signalsAvailable).toBe(2);
  });

  it('알려지지 않은 신호 키는 무시한다 (데이터 주도 — 신호 목록 외 입력 안전)', () => {
    const v = fuseStationDetectionSignals({
      'barometer-stop': true,
      // @ts-expect-error — 의도적 unknown key
      'unknown-signal': true,
    });
    expect(v.signalsAgreed).toBe(1);
    expect(v.signalsAvailable).toBe(1);
  });

  it('STATION_DETECTION_SIGNALS 목록은 readonly이며 비어있지 않다', () => {
    expect(STATION_DETECTION_SIGNALS.length).toBeGreaterThan(0);
  });

  /**
   * #921 acceptance — 지하 시청→을지로3가 방향 2호선 7정거장 시뮬레이션.
   *
   * 지하 구간이라 GPS는 stale. 3개 fusion 신호(기압 dP/dt 정차,
   * motion stationary, ArvlCd ARRIVED)가 매 역마다 모두 true가 되는
   * 사이클을 7회 반복했을 때 매 역에서 detected=true / confidence='high'
   * 100% 인식되는지 검증. 1개라도 인식 실패하면 본 테스트 실패한다.
   *
   * 데이터 주도: 정거장 이름 리스트만 늘리면 hop 수와 무관하게 확장.
   */
  it('지하 7정거장(2호선 시청→을지로3가 방향) 매역 인식 100%', () => {
    const UNDERGROUND_HOPS = [
      '시청',
      '을지로입구',
      '을지로3가',
      '을지로4가',
      '동대문역사문화공원',
      '신당',
      '상왕십리',
    ] as const;

    const verdicts = UNDERGROUND_HOPS.map((stationName) => {
      // 도착 사이클: 3개 신호 모두 true (기압 정차 + motion stationary + arvlCd ARRIVED).
      const arrival = fuseStationDetectionSignals({
        'barometer-stop': true,
        'motion-stationary': true,
        'arvlcd-arrived': true,
      });
      // 발차 사이클: 3개 신호 모두 false → 인식 끊김 (다음 hop 준비).
      const depart = fuseStationDetectionSignals({
        'barometer-stop': false,
        'motion-stationary': false,
        'arvlcd-arrived': false,
      });
      return { stationName, arrival, depart };
    });

    // 매역 도착 사이클 인식 100% — 7/7 detected=true.
    const detectedCount = verdicts.filter((v) => v.arrival.detected).length;
    expect(detectedCount).toBe(UNDERGROUND_HOPS.length);
    // 매역 confidence='high' — 3 신호 합의.
    verdicts.forEach(({ arrival, depart }) => {
      expect(arrival.confidence).toBe('high');
      expect(arrival.signalsAgreed).toBe(3);
      // 발차 cycle은 detected=false로 사이클 분리.
      expect(depart.detected).toBe(false);
    });
  });
});
