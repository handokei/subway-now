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

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { updateLiveActivityFromMirrorStation } from '../liveActivityMirrorSync';

const mirrorStation = { id: '0226', name: '역삼', line: '2' as const, lat: 37.5, lng: 127.04, lineColor: '#00A84D' };
const destination = { id: '0228', name: '강남', line: '2' as const, lat: 37.5, lng: 127.0, lineColor: '#00A84D' };
const directRoute = { type: 'direct' as const, line: '2' as const, stops: 1, travelSeconds: 120 };

describe('updateLiveActivityFromMirrorStation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHasActiveLiveActivity.mockReturnValue(true);
  });

  it('활성 LA가 없으면 no-op (update-only 가드)', async () => {
    mockHasActiveLiveActivity.mockReturnValue(false);
    await updateLiveActivityFromMirrorStation(mirrorStation, destination, directRoute);
    expect(mockBuild).not.toHaveBeenCalled();
    expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
  });

  it('활성 LA가 있으면 buildLiveActivityData(distance 0m) → updateLiveActivity', async () => {
    await updateLiveActivityFromMirrorStation(mirrorStation, destination, directRoute);
    expect(mockBuild).toHaveBeenCalledWith(
      mirrorStation,
      0,
      destination,
      directRoute,
      null,
      false,
      null,
    );
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
  });

  it('route가 null이어도 정상 동작', async () => {
    await updateLiveActivityFromMirrorStation(mirrorStation, destination, null);
    expect(mockBuild).toHaveBeenCalledWith(
      mirrorStation,
      0,
      destination,
      null,
      null,
      false,
      null,
    );
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
  });
});
