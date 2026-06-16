/**
 * #1389 — silent push 정합성 게이트 helper 단독 테스트.
 *
 * silentPushTask BG 컨텍스트의 WiFi/motion 신호 수집 + helper 호출 패턴을 검증.
 */
import type { Station } from '../../../../shared/types/station';
import { evaluateSilentPushConsistency } from '../silentPushConsistencyGate';

const mockGetCurrentWifiSsid = jest.fn<Promise<string | null>, []>();
jest.mock('../../../nearest-station/utils/wifiSsidNative', () => ({
  getCurrentWifiSsid: () => mockGetCurrentWifiSsid(),
}));

const mockLookupStationBySsid = jest.fn<Station | null, [string | null]>();
jest.mock('../../../nearest-station/utils/wifiSsidLookup', () => ({
  lookupStationBySsid: (ssid: string | null) => mockLookupStationBySsid(ssid),
}));

const stationFor = (name: string, line: Station['line'] = '7'): Station => ({
  id: `${line}-${name}`,
  name,
  line,
  lineColor: '#000000',
  lat: 37.5,
  lng: 127,
});

describe('evaluateSilentPushConsistency (#1389)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCurrentWifiSsid.mockResolvedValue(null);
    mockLookupStationBySsid.mockReturnValue(null);
  });

  it('WiFi 미상 + motion=false → unknown 신호로 자연 allow', async () => {
    const result = await evaluateSilentPushConsistency({
      targetStationName: '중곡',
      targetLine: '7',
      motionStationary: false,
    });
    expect(result).toEqual({ allowed: true });
  });

  it('WiFi 매칭 target 동일역 → 강 확증 allow', async () => {
    mockGetCurrentWifiSsid.mockResolvedValue('Subway_중곡');
    mockLookupStationBySsid.mockReturnValue(stationFor('중곡', '7'));
    const result = await evaluateSilentPushConsistency({
      targetStationName: '중곡',
      targetLine: '7',
      motionStationary: false,
    });
    expect(result).toEqual({ allowed: true });
  });

  it('WiFi != target + motion=stationary → wifi-mismatch로 block', async () => {
    mockGetCurrentWifiSsid.mockResolvedValue('Subway_용마산');
    mockLookupStationBySsid.mockReturnValue(stationFor('용마산', '7'));
    const result = await evaluateSilentPushConsistency({
      targetStationName: '중곡',
      targetLine: '7',
      motionStationary: true,
    });
    expect(result).toEqual({ allowed: false, reason: 'wifi-mismatch' });
  });

  it('getCurrentWifiSsid throw → graceful (WiFi 미상으로 처리, allow)', async () => {
    mockGetCurrentWifiSsid.mockRejectedValue(new Error('native bridge unavailable'));
    const result = await evaluateSilentPushConsistency({
      targetStationName: '중곡',
      targetLine: '7',
      motionStationary: false,
    });
    expect(result).toEqual({ allowed: true });
  });
});
