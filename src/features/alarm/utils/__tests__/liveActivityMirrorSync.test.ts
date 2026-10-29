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
const mockReconcileLiveActivityToken = jest.fn((..._args: unknown[]) => Promise.resolve());
jest.mock('../liveActivityPushChannel', () => ({
  shouldSkipDeviceLiveActivityWrite: (...args: unknown[]) =>
    mockShouldSkipDeviceLiveActivityWrite(...args),
  reconcileLiveActivityToken: (...args: unknown[]) => mockReconcileLiveActivityToken(...args),
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
const mockLogLaWrite = jest.fn();
jest.mock('../alarmLog', () => ({
  logLaWrite: (...args: unknown[]) => mockLogLaWrite(...args),
  logLiveActivityUpdated: () => mockLogLiveActivityUpdated(),
  logLiveActivityMirrorSkip: (...args: unknown[]) => mockLogLiveActivityMirrorSkip(...args),
  resetLiveActivityMirrorSkipTracking: () => mockResetLiveActivityMirrorSkipTracking(),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { ACTIVE_TRIP_KEY } from '../../../../shared/constants/storageKeys';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';
import { calculateStaticETA, findRoute, getStationsOnLine } from '../../../../shared/utils/stationRoute';
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

  it('#3163 P1-b — mirror sync 진입 시 토큰 복구를 data 없이 호출한다(GPS writer 양보/활성 LA 없음이어도)', async () => {
    mockHasActiveLiveActivity.mockReturnValue(false);
    await updateLiveActivityFromMirrorStation(mirrorStation, destination, directRoute);
    expect(mockReconcileLiveActivityToken).toHaveBeenCalledTimes(1);
    expect(mockReconcileLiveActivityToken).toHaveBeenCalledWith();
  });

  it('#3163 P1-b [거부] dismiss sentinel 활성이면 토큰 복구도 하지 않는다', async () => {
    mockIsLaDismissed.mockResolvedValue(true);
    await updateLiveActivityFromMirrorStation(mirrorStation, destination, directRoute);
    expect(mockReconcileLiveActivityToken).not.toHaveBeenCalled();
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

  // #2735 PR-1 — writer D2(BG)/D4(FG) 쓰기 관측.
  describe('#2735 PR-1 la-write (D2/D4)', () => {
    it('기본 writer는 D2 — source=backend-ssot, 빌드된 content의 역/eta/stops, 권위는 caller가 모르면 unknown', async () => {
      mockBuild.mockReturnValueOnce({
        stationName: '중곡',
        lineName: 'L',
        lineColorHex: '#000',
        distanceM: 0,
        etaMinutes: 7,
        stopsRemaining: 3,
      } as never);
      await updateLiveActivityFromMirrorStation(mirrorStation, destination, directRoute);
      expect(mockLogLaWrite).toHaveBeenCalledTimes(1);
      expect(mockLogLaWrite).toHaveBeenCalledWith({
        writer: 'D2',
        source: 'backend-ssot',
        data: expect.objectContaining({ stationName: '중곡', etaMinutes: 7, stopsRemaining: 3 }),
        authority: 'unknown',
      });
    });

    it('opts로 writer(D4)·권위를 넘기면 그대로 싣는다', async () => {
      await updateLiveActivityFromMirrorStation(mirrorStation, destination, directRoute, {
        writer: 'D4',
        authority: 'backend-active',
      });
      expect(mockLogLaWrite).toHaveBeenCalledWith(
        expect.objectContaining({ writer: 'D4', authority: 'backend-active' }),
      );
    });

    it('opts 일부만 넘기면 나머지는 기본값(D2/unknown)', async () => {
      await updateLiveActivityFromMirrorStation(mirrorStation, destination, directRoute, {
        authority: 'not-active',
      });
      expect(mockLogLaWrite).toHaveBeenCalledWith(
        expect.objectContaining({ writer: 'D2', authority: 'not-active' }),
      );
    });

    it('쓰기가 일어나지 않은 경로(dismiss / GPS 양보 / LA 없음)에서는 적재하지 않는다', async () => {
      mockIsLaDismissed.mockResolvedValueOnce(true);
      await updateLiveActivityFromMirrorStation(mirrorStation, destination, directRoute);
      markDeviceGpsLiveActivityWrite(Date.now());
      await updateLiveActivityFromMirrorStation(mirrorStation, destination, directRoute);
      mockHasActiveLiveActivity.mockReturnValue(false);
      await updateLiveActivityFromMirrorStation(mirrorStation, destination, directRoute);
      expect(mockLogLaWrite).not.toHaveBeenCalled();
    });

    it('native update가 throw하면 적재하지 않는다(실패 쓰기는 쓰기가 아니다)', async () => {
      mockUpdateLiveActivity.mockRejectedValueOnce(new Error('native down'));
      await expect(
        updateLiveActivityFromMirrorStation(mirrorStation, destination, directRoute),
      ).rejects.toThrow('native down');
      expect(mockLogLaWrite).not.toHaveBeenCalled();
    });
  });

  // #2811 RED: route가 트립 시작 시점에 고정된 전체 경로라도, mirrorStation이 실제 stations.json
  // 위 station이면 anchorRouteToCurrentStation이 남은 구간만 재앵커링해 etaMinutes/stopsRemaining이
  // 줄어들어야 한다. fix 전에는 원본 route를 그대로 써 fullEta와 동일해 실패한다.
  it('#2811 mirrorStation이 route 중반이면 남은 구간만 반영한 ETA를 싣는다', async () => {
    const fullRoute = findRoute('7-015', '2-010')!; // 용마산 → 건대입구 환승 → 뚝섬
    expect(fullRoute).not.toBeNull();
    const seongsu = getStationsOnLine('2').find((s) => s.id === '2-011')!; // 성수(뚝섬 직전)
    const realDestination = getStationsOnLine('2').find((s) => s.id === '2-010')!;
    const fullEta = calculateStaticETA(fullRoute, { excludeOriginWait: true });

    await updateLiveActivityFromMirrorStation(seongsu, realDestination, fullRoute);

    expect(mockBuild).toHaveBeenCalledTimes(1);
    const [, , , routeArg, etaArg] = mockBuild.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      { type: string; stopsToTransfer: number },
      number | null,
    ];
    expect(etaArg).not.toBeNull();
    expect(etaArg as number).toBeLessThan(fullEta!);
    // route도 남은 구간만 반영 — 전체 route(fromLine=7 구간 포함)가 아니라 stopsToTransfer=0.
    expect(routeArg.type).toBe('transfer');
    expect(routeArg.stopsToTransfer).toBe(0);
  });
});
