/* eslint-disable import/no-restricted-paths --
 * Cross-feature test mirroring source's disable. ADR Phase 5 (#890).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook } from '@testing-library/react-native';
import { useFgPositionUpload } from '../useFgPositionUpload';
import { GOOD_FIX_ACCURACY_MAX_M } from '../useBoardingLockSync';
import { uploadPosition } from '../../../nearest-station/api/positionUpload';
import { FG_POSITION_UPLOAD_THROTTLE_MS } from '../../../../shared/constants/location';
import { APNS_TOKEN_KEY, ACTIVE_TRIP_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('../../../nearest-station/api/positionUpload', () => ({
  uploadPosition: jest.fn(),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockedUpload = uploadPosition as jest.MockedFunction<typeof uploadPosition>;

const SEOUL = { lat: 37.5, lng: 127.0 };

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  await AsyncStorage.setItem(APNS_TOKEN_KEY, 'apns-tok');
  await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'trip-tok');
  mockedUpload.mockResolvedValue({ ok: true, status: 200 });
  jest.useFakeTimers();
  jest.setSystemTime(0);
});

afterEach(() => {
  jest.useRealTimers();
});

async function flushAsyncStorage(): Promise<void> {
  // AsyncStorage getItem은 microtask 큐로 처리 — fake timers 사용 중에도 promise를 흘려보낸다.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useFgPositionUpload (#1280)', () => {
  type Inputs = Parameters<typeof useFgPositionUpload>[0];
  const defaults: Inputs = { userLocation: SEOUL, accuracyMeters: 10, tripActive: true };
  const renderUpload = (overrides: Partial<Inputs> = {}) =>
    renderHook((props: Partial<Inputs>) => useFgPositionUpload({ ...defaults, ...props }), {
      initialProps: overrides,
    });

  it.each<{ label: string; overrides: Partial<Inputs> }>([
    { label: 'tripActive=false', overrides: { tripActive: false } },
    { label: 'userLocation=null', overrides: { userLocation: null } },
    { label: 'accuracy=null', overrides: { accuracyMeters: null } },
    { label: 'accuracy > 50m', overrides: { accuracyMeters: GOOD_FIX_ACCURACY_MAX_M + 1 } },
  ])('게이트 실패 ($label) → 미업로드', async ({ overrides }) => {
    renderUpload(overrides);
    await flushAsyncStorage();
    expect(mockedUpload).not.toHaveBeenCalled();
  });

  it('좋은 fix + activeTrip → 즉시 1회 업로드 (motion/payload 포함)', async () => {
    renderUpload({ motionStationary: true });
    await flushAsyncStorage();
    expect(mockedUpload).toHaveBeenCalledTimes(1);
    expect(mockedUpload.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        token: 'apns-tok',
        lat: SEOUL.lat,
        lng: SEOUL.lng,
        accuracy: 10,
        motion: 'stationary',
      }),
    );
  });

  it('motionStationary 미지정 → motion=unknown', async () => {
    renderUpload();
    await flushAsyncStorage();
    expect(mockedUpload.mock.calls[0][0]).toEqual(expect.objectContaining({ motion: 'unknown' }));
  });

  it('throttle 내 연속 fix → 1회만 업로드, 간격 경과 후 재발사', async () => {
    const { rerender } = renderUpload();
    await flushAsyncStorage();
    expect(mockedUpload).toHaveBeenCalledTimes(1);

    // throttle 간격 미만에서 새 fix → 미발사
    act(() => jest.advanceTimersByTime(FG_POSITION_UPLOAD_THROTTLE_MS - 1));
    rerender({ userLocation: { lat: 37.51, lng: 127.01 } });
    await flushAsyncStorage();
    expect(mockedUpload).toHaveBeenCalledTimes(1);

    // throttle 간격 경과 후 새 fix → 재발사
    act(() => jest.advanceTimersByTime(2));
    rerender({ userLocation: { lat: 37.52, lng: 127.02 } });
    await flushAsyncStorage();
    expect(mockedUpload).toHaveBeenCalledTimes(2);
  });

  it('trip 비활성 → 활성 전환 시 throttle 리셋 → 첫 fix 즉시 발사', async () => {
    const { rerender } = renderUpload({ tripActive: false });
    await flushAsyncStorage();
    expect(mockedUpload).not.toHaveBeenCalled();

    rerender({ tripActive: true });
    await flushAsyncStorage();
    expect(mockedUpload).toHaveBeenCalledTimes(1);
  });

  it.each<{ label: string; key: typeof APNS_TOKEN_KEY | typeof ACTIVE_TRIP_KEY }>([
    { label: 'apns token 부재', key: APNS_TOKEN_KEY },
    { label: 'active trip 부재', key: ACTIVE_TRIP_KEY },
  ])('$label → graceful no-op', async ({ key }) => {
    await AsyncStorage.removeItem(key);
    renderUpload();
    await flushAsyncStorage();
    expect(mockedUpload).not.toHaveBeenCalled();
  });

  describe('#1363 — currentStationName payload (log 진단 이원화)', () => {
    it('currentStationName 전달 → payload에 그대로 송신', async () => {
      renderUpload({ currentStationName: '강남' });
      await flushAsyncStorage();
      expect(mockedUpload.mock.calls[0][0]).toEqual(
        expect.objectContaining({ currentStationName: '강남' }),
      );
    });

    it.each([
      { label: 'null', value: null },
      { label: 'undefined', value: undefined },
      { label: '빈 문자열', value: '' },
    ])('currentStationName=$label → payload omit (트래픽 절감)', async ({ value }) => {
      renderUpload({ currentStationName: value });
      await flushAsyncStorage();
      const payload = mockedUpload.mock.calls[0][0];
      expect(payload.currentStationName).toBeUndefined();
    });
  });
});
