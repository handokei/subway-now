jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
}));

const mockUpdateLiveActivity = jest.fn().mockResolvedValue(undefined);
const mockHasActiveLiveActivity = jest.fn(() => true);
jest.mock('live-activity', () => ({
  updateLiveActivity: (...args: unknown[]) => mockUpdateLiveActivity(...args),
  hasActiveLiveActivity: () => mockHasActiveLiveActivity(),
}));

const mockBuild = jest.fn((..._args: unknown[]) => ({
  stationName: 'STN',
  lineName: 'L',
  lineColorHex: '#000',
  distanceM: 0,
}));
jest.mock('../stationNotification', () => ({
  buildLiveActivityData: (...args: unknown[]) => mockBuild(...args),
}));

const mockIsLaDismissed = jest.fn(async () => false);
jest.mock('../laDismissSentinel', () => ({
  isLaDismissed: () => mockIsLaDismissed(),
}));

const mockShouldSkipDeviceLiveActivityWrite = jest.fn((..._args: unknown[]) => false);
jest.mock('../liveActivityPushChannel', () => ({
  shouldSkipDeviceLiveActivityWrite: (...args: unknown[]) =>
    mockShouldSkipDeviceLiveActivityWrite(...args),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockLogLiveActivityUpdated = jest.fn();
const mockLogLiveActivityMirrorSkip = jest.fn();
const mockResetLiveActivityMirrorSkipTracking = jest.fn();
jest.mock('../alarmLog', () => ({
  logLiveActivityUpdated: () => mockLogLiveActivityUpdated(),
  logLiveActivityMirrorSkip: (...args: unknown[]) => mockLogLiveActivityMirrorSkip(...args),
  resetLiveActivityMirrorSkipTracking: () => mockResetLiveActivityMirrorSkipTracking(),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { ACTIVE_TRIP_KEY } from '../../../../shared/constants/storageKeys';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';
import { calculateStaticETA } from '../../../../shared/utils/stationRoute';
import { updateLiveActivityFromMirrorStation } from '../liveActivityMirrorSync';
import {
  markDeviceGpsLiveActivityWrite,
  __test__ as arbitrationTestHelpers,
} from '../liveActivityGpsWriteArbitration';

const mirrorStation = {
  id: '0226',
  name: canonicalStationName('역삼', '2'),
  line: '2' as const,
  lat: 37.5,
  lng: 127.04,
  lineColor: '#00A84D',
};
const destination = {
  id: '0228',
  name: canonicalStationName('강남', '2'),
  line: '2' as const,
  lat: 37.5,
  lng: 127.0,
  lineColor: '#00A84D',
};
const directRoute = { type: 'direct' as const, line: '2' as const, stops: 1, travelSeconds: 120 };

describe('updateLiveActivityFromMirrorStation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHasActiveLiveActivity.mockReturnValue(true);
    mockIsLaDismissed.mockResolvedValue(false);
    mockShouldSkipDeviceLiveActivityWrite.mockReturnValue(false);
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    arbitrationTestHelpers.reset();
  });

  it('활성 LA가 있고 다른 가드가 모두 통과하면 buildLiveActivityData(distance 0m, static ETA) → updateLiveActivity, true 반환', async () => {
    // #2805 — mirror sync가 null 대신 남은 구간 static ETA를 싣는지 assert(root: "약 0분" 지속).
    const expectedEta = calculateStaticETA(directRoute, { excludeOriginWait: true });
    const applied = await updateLiveActivityFromMirrorStation(mirrorStation, destination, directRoute);
    expect(expectedEta).not.toBeNull();
    expect(mockBuild).toHaveBeenCalledWith(
      mirrorStation,
      0,
      destination,
      directRoute,
      expectedEta,
      false,
      null,
    );
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
    expect(applied).toBe(true);
    // #2768 — 성공 tick은 skip 로그를 남기지 않고, 상태 전이 추적을 리셋해 다음 skip이 다시 적재되게 한다.
    expect(mockLogLiveActivityMirrorSkip).not.toHaveBeenCalled();
    expect(mockResetLiveActivityMirrorSkipTracking).toHaveBeenCalledTimes(1);
  });

  it('route가 null이면 etaMinutes도 null(기존대로) — #2805 거부 케이스', async () => {
    const applied = await updateLiveActivityFromMirrorStation(mirrorStation, destination, null);
    expect(mockBuild).toHaveBeenCalledWith(mirrorStation, 0, destination, null, null, false, null);
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
    expect(applied).toBe(true);
  });

  it('활성 LA가 없으면 no-op (update-only 가드), false 반환', async () => {
    mockHasActiveLiveActivity.mockReturnValue(false);
    const applied = await updateLiveActivityFromMirrorStation(mirrorStation, destination, directRoute);
    expect(mockBuild).not.toHaveBeenCalled();
    expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
    expect(applied).toBe(false);
    // #2768 — update-only skip 사유가 alarmLog로 배선된다.
    expect(mockLogLiveActivityMirrorSkip).toHaveBeenCalledWith(
      'la-mirror-skip-no-active-la',
      mirrorStation.name,
    );
  });

  it('LA dismiss sentinel 활성이면 no-op, false 반환 (#926 대칭)', async () => {
    mockIsLaDismissed.mockResolvedValue(true);
    const applied = await updateLiveActivityFromMirrorStation(mirrorStation, destination, directRoute);
    expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
    expect(applied).toBe(false);
    // #2768 — dismiss sentinel skip 사유가 alarmLog로 배선된다.
    expect(mockLogLiveActivityMirrorSkip).toHaveBeenCalledWith(
      'la-mirror-skip-dismissed',
      mirrorStation.name,
    );
  });

  it('#2659 — backend-authority 활성 trip이어도 mirror-sourced 쓰기는 진행된다 (게이트는 GPS 전용)', async () => {
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) =>
      key === ACTIVE_TRIP_KEY ? 'apns-token-abc' : null,
    );
    mockShouldSkipDeviceLiveActivityWrite.mockReturnValue(true);
    const applied = await updateLiveActivityFromMirrorStation(mirrorStation, destination, directRoute);
    expect(mockShouldSkipDeviceLiveActivityWrite).not.toHaveBeenCalled();
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
    expect(applied).toBe(true);
  });

  it('GPS writer가 arbitration 창 내에 최근 썼으면 양보(no-op), false 반환', async () => {
    markDeviceGpsLiveActivityWrite(Date.now());
    const applied = await updateLiveActivityFromMirrorStation(mirrorStation, destination, directRoute);
    expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
    expect(applied).toBe(false);
    // #2768 — GPS writer 양보 skip 사유가 alarmLog로 배선된다.
    expect(mockLogLiveActivityMirrorSkip).toHaveBeenCalledWith(
      'la-mirror-skip-gps-writer-recent',
      mirrorStation.name,
    );
  });

  it('GPS writer가 arbitration 창 밖에 썼으면 정상 update 진행', async () => {
    markDeviceGpsLiveActivityWrite(Date.now() - 10_000);
    const applied = await updateLiveActivityFromMirrorStation(mirrorStation, destination, directRoute);
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
    expect(applied).toBe(true);
  });
});
