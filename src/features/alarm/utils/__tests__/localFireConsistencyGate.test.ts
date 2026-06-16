/**
 * #1389 — FG fire 정합성 게이트 helper 단독 테스트.
 *
 * useStationAlarm의 4개 fire effect가 공유하는 helper. 본 테스트는 차단/허용 분기를 직접 검증.
 * hook 단위 테스트(useStationAlarm.test.ts)는 helper를 mock해 callsite 흡수 경로만 검증.
 */
import type { Station } from '../../../../shared/types/station';
import {
  evaluateLocalFireConsistency,
  resolveTargetLine,
} from '../localFireConsistencyGate';

const mockAppendAlarmLog = jest.fn();
jest.mock('../alarmLog', () => ({
  logLocalFireConsistencyBlocked: (input: unknown) => mockAppendAlarmLog(input),
}));

const NOW = 1_750_000_000_000;

const stationFor = (name: string, line: Station['line'] = '7'): Station => ({
  id: `${line}-${name}`,
  name,
  line,
  lineColor: '#000000',
  lat: 37.5,
  lng: 127,
});

describe('resolveTargetLine (#1389)', () => {
  const target = '중곡';
  const arc = [stationFor('용마산', '7'), stationFor('중곡', '7'), stationFor('군자', '7')];

  it('arcStations에서 매칭 시 그 line 반환', () => {
    expect(resolveTargetLine(target, arc, null)).toBe('7');
  });

  it('arcStations 미전달 + nearestStation 있으면 nearestStation.line', () => {
    expect(resolveTargetLine(target, undefined, stationFor('A', '2'))).toBe('2');
  });

  it('arcStations에서 매칭 실패 + nearestStation 있으면 nearestStation.line fallback', () => {
    expect(resolveTargetLine('없는역', arc, stationFor('A', '5'))).toBe('5');
  });

  it('arcStations 미전달 + nearestStation null → 빈 문자열', () => {
    expect(resolveTargetLine(target, undefined, null)).toBe('');
  });
});

describe('evaluateLocalFireConsistency (#1389)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const baseInput = {
    targetStationName: '중곡',
    targetLine: '7' as const,
    source: 'fg' as const,
    kind: 'station-passed' as const,
    phaseId: 'imminent' as const,
    nearestStation: null,
    motionStationary: undefined,
    wifiStation: null,
    arcStations: undefined,
    now: NOW,
  };

  it('모든 신호 null/unknown → 허용 (지하 보호)', () => {
    expect(evaluateLocalFireConsistency(baseInput)).toEqual({ allowed: true });
    expect(mockAppendAlarmLog).not.toHaveBeenCalled();
  });

  it('WiFi 일치 → 허용 (강 확증)', () => {
    expect(
      evaluateLocalFireConsistency({
        ...baseInput,
        wifiStation: stationFor('중곡', '7'),
      }),
    ).toEqual({ allowed: true });
  });

  it('WiFi != target + motion=stationary → 차단 + log', () => {
    const result = evaluateLocalFireConsistency({
      ...baseInput,
      wifiStation: stationFor('용마산', '7'),
      motionStationary: true,
    });
    expect(result).toEqual({ allowed: false });
    expect(mockAppendAlarmLog).toHaveBeenCalledWith({
      source: 'fg',
      stationName: '중곡',
      reason: 'wifi-mismatch',
      kind: 'station-passed',
      phaseId: 'imminent',
    });
  });

  it('device가 target보다 2 hop 이상 뒤 → device-station-mismatch 차단', () => {
    const arc = [stationFor('용마산', '7'), stationFor('중곡', '7'), stationFor('군자', '7')];
    const result = evaluateLocalFireConsistency({
      ...baseInput,
      targetStationName: '군자',
      nearestStation: stationFor('용마산', '7'),
      motionStationary: false,
      arcStations: arc,
    });
    expect(result).toEqual({ allowed: false });
    expect(mockAppendAlarmLog).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'device-station-mismatch' }),
    );
  });

  it('source=fg-arvlcd로 log source 그대로 전파', () => {
    evaluateLocalFireConsistency({
      ...baseInput,
      source: 'fg-arvlcd',
      wifiStation: stationFor('용마산', '7'),
      motionStationary: true,
    });
    expect(mockAppendAlarmLog).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'fg-arvlcd' }),
    );
  });
});
