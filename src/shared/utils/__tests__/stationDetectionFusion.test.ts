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
});
