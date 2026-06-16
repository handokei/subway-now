/**
 * #1389 — preschedule 정합성 게이트 helper 단독 테스트.
 *
 * boardingLockScheduler / tripBoundScheduler가 공유하는 helper이므로
 * helper 단독 테스트로 차단/허용 분기를 평가한다.
 * 두 호출자는 별도 테스트에서 helper return false → return [] 경로만 검증.
 */
import type { Station } from '../../../../shared/types/station';
import { evaluatePreScheduleConsistency } from '../preScheduleConsistencyGate';

const mockGetCurrentWifiSsid = jest.fn<Promise<string | null>, []>();
jest.mock('../../../nearest-station/utils/wifiSsidNative', () => ({
  getCurrentWifiSsid: () => mockGetCurrentWifiSsid(),
}));

const mockLookupStationBySsid = jest.fn<Station | null, [string | null]>();
jest.mock('../../../nearest-station/utils/wifiSsidLookup', () => ({
  lookupStationBySsid: (ssid: string | null) => mockLookupStationBySsid(ssid),
}));

const mockAppendAlarmLog = jest.fn();
jest.mock('../alarmLog', () => ({
  logLocalFireConsistencyBlocked: (input: unknown) => mockAppendAlarmLog(input),
}));

const mockLoggerInfo = jest.fn();
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const stationFor = (name: string, line: Station['line'] = '7'): Station => ({
  id: `${line}-${name}`,
  name,
  line,
  lineColor: '#000000',
  lat: 37.5,
  lng: 127,
});

describe('evaluatePreScheduleConsistency (#1389)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCurrentWifiSsid.mockResolvedValue(null);
    mockLookupStationBySsid.mockReturnValue(null);
  });

  it('boardingStation=null → allow (lockless / 컨텍스트 부재)', async () => {
    const result = await evaluatePreScheduleConsistency({
      boardingStation: null,
      motionStationary: false,
      channel: 'bl',
      destinationName: '강남',
    });
    expect(result).toBe(true);
    expect(mockAppendAlarmLog).not.toHaveBeenCalled();
  });

  it('WiFi 미상 + motion=false → helper의 unknown 신호 fallback (allow)', async () => {
    const result = await evaluatePreScheduleConsistency({
      boardingStation: { stationName: '중곡', line: '7' },
      motionStationary: false,
      channel: 'tba',
      destinationName: '강남',
    });
    expect(result).toBe(true);
    expect(mockAppendAlarmLog).not.toHaveBeenCalled();
  });

  it('WiFi 매칭 동일역 → allow (강 확증)', async () => {
    mockGetCurrentWifiSsid.mockResolvedValue('Subway_중곡');
    mockLookupStationBySsid.mockReturnValue(stationFor('중곡', '7'));
    const result = await evaluatePreScheduleConsistency({
      boardingStation: { stationName: '중곡', line: '7' },
      motionStationary: false,
      channel: 'bl',
      destinationName: '강남',
    });
    expect(result).toBe(true);
  });

  it('WiFi != target + motion=stationary → block (wifi-mismatch) + log', async () => {
    mockGetCurrentWifiSsid.mockResolvedValue('Subway_용마산');
    mockLookupStationBySsid.mockReturnValue(stationFor('용마산', '7'));
    const result = await evaluatePreScheduleConsistency({
      boardingStation: { stationName: '중곡', line: '7' },
      motionStationary: true,
      channel: 'bl',
      destinationName: '강남',
    });
    expect(result).toBe(false);
    expect(mockAppendAlarmLog).toHaveBeenCalledWith({
      source: 'bg-scheduled',
      stationName: '중곡',
      reason: 'wifi-mismatch',
    });
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('channel=bl reason=wifi-mismatch destination=강남'),
    );
  });

  it('channel=tba + destinationName 미상 → log에 unknown 출력', async () => {
    mockGetCurrentWifiSsid.mockResolvedValue('Subway_용마산');
    mockLookupStationBySsid.mockReturnValue(stationFor('용마산', '7'));
    const result = await evaluatePreScheduleConsistency({
      boardingStation: { stationName: '중곡', line: '7' },
      motionStationary: true,
      channel: 'tba',
      destinationName: undefined,
    });
    expect(result).toBe(false);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('channel=tba reason=wifi-mismatch destination=unknown'),
    );
  });

  it('getCurrentWifiSsid throw → graceful (WiFi 미상으로 처리, allow)', async () => {
    mockGetCurrentWifiSsid.mockRejectedValue(new Error('native bridge unavailable'));
    const result = await evaluatePreScheduleConsistency({
      boardingStation: { stationName: '중곡', line: '7' },
      motionStationary: false,
      channel: 'bl',
      destinationName: '강남',
    });
    expect(result).toBe(true);
    expect(mockAppendAlarmLog).not.toHaveBeenCalled();
  });
});
