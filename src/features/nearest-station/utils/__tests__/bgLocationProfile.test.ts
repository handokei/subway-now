const mockStopLocationUpdatesAsync = jest.fn();
const mockStartLocationUpdatesAsync = jest.fn();
jest.mock('expo-location', () => ({
  Accuracy: { High: 6, Balanced: 3 },
  LocationActivityType: { AutomotiveNavigation: 2 },
  stopLocationUpdatesAsync: (...args: unknown[]) => mockStopLocationUpdatesAsync(...args),
  startLocationUpdatesAsync: (...args: unknown[]) => mockStartLocationUpdatesAsync(...args),
}));

const mockGetItem = jest.fn();
const mockSetItem = jest.fn();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (...args: unknown[]) => mockGetItem(...args),
  setItem: (...args: unknown[]) => mockSetItem(...args),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import {
  applyBgLocationProfile,
  saveForegroundServiceNotification,
  resetBgLocationProfile,
} from '../bgLocationProfile';
import {
  BG_LOCATION_PROFILE_KEY,
  BG_LOCATION_PROFILE_FLIP_COUNT_KEY,
  BG_FOREGROUND_SERVICE_TEXT_KEY,
} from '../../../../shared/constants/storageKeys';
import { LOCATION_TRACKING_OPTIONS_STATIONARY } from '../../../../shared/constants/locationTracking';

const TASK_NAME = 'background-location-task';

describe('bgLocationProfile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetItem.mockResolvedValue(null);
    mockSetItem.mockResolvedValue(undefined);
    mockStopLocationUpdatesAsync.mockResolvedValue(undefined);
    mockStartLocationUpdatesAsync.mockResolvedValue(undefined);
  });

  describe('applyBgLocationProfile', () => {
    it('현재 프로파일과 desiredProfile이 같으면(default surface) 재시작하지 않는다', async () => {
      mockGetItem.mockImplementation((key: string) =>
        key === BG_LOCATION_PROFILE_KEY ? Promise.resolve(null) : Promise.resolve(null),
      );

      await applyBgLocationProfile(TASK_NAME, 'surface');

      expect(mockStopLocationUpdatesAsync).not.toHaveBeenCalled();
      expect(mockStartLocationUpdatesAsync).not.toHaveBeenCalled();
    });

    it('surface → stationary 전환 시 stop→start로 재시작하고 flip count를 증가시킨다', async () => {
      mockGetItem.mockImplementation((key: string) => {
        if (key === BG_LOCATION_PROFILE_KEY) return Promise.resolve(null); // surface
        if (key === BG_LOCATION_PROFILE_FLIP_COUNT_KEY) return Promise.resolve('2');
        if (key === BG_FOREGROUND_SERVICE_TEXT_KEY)
          return Promise.resolve(
            JSON.stringify({ notificationTitle: '제목', notificationBody: '본문' }),
          );
        return Promise.resolve(null);
      });

      await applyBgLocationProfile(TASK_NAME, 'stationary');

      expect(mockStopLocationUpdatesAsync).toHaveBeenCalledWith(TASK_NAME);
      expect(mockStartLocationUpdatesAsync).toHaveBeenCalledWith(TASK_NAME, {
        ...LOCATION_TRACKING_OPTIONS_STATIONARY,
        foregroundService: { notificationTitle: '제목', notificationBody: '본문' },
      });
      expect(mockSetItem).toHaveBeenCalledWith(BG_LOCATION_PROFILE_KEY, 'stationary');
      expect(mockSetItem).toHaveBeenCalledWith(BG_LOCATION_PROFILE_FLIP_COUNT_KEY, '3');
    });

    it('stationary → surface(이동 재개) 전환도 즉시 재시작한다', async () => {
      mockGetItem.mockImplementation((key: string) => {
        if (key === BG_LOCATION_PROFILE_KEY) return Promise.resolve('stationary');
        return Promise.resolve(null);
      });

      await applyBgLocationProfile(TASK_NAME, 'surface');

      expect(mockStopLocationUpdatesAsync).toHaveBeenCalledWith(TASK_NAME);
      expect(mockStartLocationUpdatesAsync).toHaveBeenCalledWith(
        TASK_NAME,
        expect.objectContaining({ timeInterval: 30_000 }),
      );
      expect(mockSetItem).toHaveBeenCalledWith(BG_LOCATION_PROFILE_KEY, 'surface');
    });

    it('foregroundService 텍스트 캐시 부재 시 폴백 텍스트를 사용한다', async () => {
      mockGetItem.mockResolvedValue(null);

      await applyBgLocationProfile(TASK_NAME, 'stationary');

      expect(mockStartLocationUpdatesAsync).toHaveBeenCalledWith(
        TASK_NAME,
        expect.objectContaining({
          foregroundService: { notificationTitle: 'Subway Now', notificationBody: 'Tracking your location' },
        }),
      );
    });

    it('foregroundService 텍스트 캐시가 파싱 불가면 폴백 텍스트를 사용한다', async () => {
      mockGetItem.mockImplementation((key: string) => {
        if (key === BG_FOREGROUND_SERVICE_TEXT_KEY) return Promise.resolve('not-json');
        return Promise.resolve(null);
      });

      await applyBgLocationProfile(TASK_NAME, 'stationary');

      expect(mockStartLocationUpdatesAsync).toHaveBeenCalledWith(
        TASK_NAME,
        expect.objectContaining({
          foregroundService: { notificationTitle: 'Subway Now', notificationBody: 'Tracking your location' },
        }),
      );
    });

    it('foregroundService 텍스트 캐시 shape이 잘못되면 폴백 텍스트를 사용한다', async () => {
      mockGetItem.mockImplementation((key: string) => {
        if (key === BG_FOREGROUND_SERVICE_TEXT_KEY) return Promise.resolve(JSON.stringify({ foo: 'bar' }));
        return Promise.resolve(null);
      });

      await applyBgLocationProfile(TASK_NAME, 'stationary');

      expect(mockStartLocationUpdatesAsync).toHaveBeenCalledWith(
        TASK_NAME,
        expect.objectContaining({
          foregroundService: { notificationTitle: 'Subway Now', notificationBody: 'Tracking your location' },
        }),
      );
    });

    it('AsyncStorage.getItem(profile) 예외 시 surface로 graceful fallback한다', async () => {
      mockGetItem.mockImplementation((key: string) => {
        if (key === BG_LOCATION_PROFILE_KEY) return Promise.reject(new Error('storage down'));
        return Promise.resolve(null);
      });

      await applyBgLocationProfile(TASK_NAME, 'surface');

      // fallback profile('surface') === desiredProfile('surface') → 재시작 없음
      expect(mockStopLocationUpdatesAsync).not.toHaveBeenCalled();
    });

    it('flip count 파싱 실패 시 0에서 시작해 1로 증가시킨다', async () => {
      mockGetItem.mockImplementation((key: string) => {
        if (key === BG_LOCATION_PROFILE_KEY) return Promise.resolve(null);
        if (key === BG_LOCATION_PROFILE_FLIP_COUNT_KEY) return Promise.resolve('not-a-number');
        return Promise.resolve(null);
      });

      await applyBgLocationProfile(TASK_NAME, 'stationary');

      expect(mockSetItem).toHaveBeenCalledWith(BG_LOCATION_PROFILE_FLIP_COUNT_KEY, '1');
    });

    it('flip count 저장 실패 시 graceful하게 0을 반환하고 계속 진행한다', async () => {
      mockGetItem.mockImplementation((key: string) => {
        if (key === BG_LOCATION_PROFILE_KEY) return Promise.resolve(null);
        return Promise.resolve(null);
      });
      mockSetItem.mockImplementation((key: string) => {
        if (key === BG_LOCATION_PROFILE_FLIP_COUNT_KEY) return Promise.reject(new Error('fail'));
        return Promise.resolve(undefined);
      });

      await expect(applyBgLocationProfile(TASK_NAME, 'stationary')).resolves.toBeUndefined();
    });

    it('stopLocationUpdatesAsync 실패 시 예외를 흡수한다(graceful)', async () => {
      mockGetItem.mockImplementation((key: string) => {
        if (key === BG_LOCATION_PROFILE_KEY) return Promise.resolve(null);
        return Promise.resolve(null);
      });
      mockStopLocationUpdatesAsync.mockRejectedValue(new Error('stop failed'));

      await expect(applyBgLocationProfile(TASK_NAME, 'stationary')).resolves.toBeUndefined();
      expect(mockStartLocationUpdatesAsync).not.toHaveBeenCalled();
      // 재시작이 실패했으므로 프로파일 키를 갱신하지 않는다.
      expect(mockSetItem).not.toHaveBeenCalledWith(BG_LOCATION_PROFILE_KEY, 'stationary');
    });
  });

  describe('saveForegroundServiceNotification', () => {
    it('AsyncStorage에 JSON으로 저장한다', async () => {
      await saveForegroundServiceNotification({
        notificationTitle: '제목',
        notificationBody: '본문',
      });

      expect(mockSetItem).toHaveBeenCalledWith(
        BG_FOREGROUND_SERVICE_TEXT_KEY,
        JSON.stringify({ notificationTitle: '제목', notificationBody: '본문' }),
      );
    });

    it('저장 실패는 graceful하게 흡수한다', async () => {
      mockSetItem.mockRejectedValue(new Error('fail'));

      await expect(
        saveForegroundServiceNotification({ notificationTitle: 'a', notificationBody: 'b' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('resetBgLocationProfile', () => {
    it('BG_LOCATION_PROFILE_KEY를 surface로 초기화한다', async () => {
      await resetBgLocationProfile();

      expect(mockSetItem).toHaveBeenCalledWith(BG_LOCATION_PROFILE_KEY, 'surface');
    });

    it('저장 실패는 graceful하게 흡수한다', async () => {
      mockSetItem.mockRejectedValue(new Error('fail'));

      await expect(resetBgLocationProfile()).resolves.toBeUndefined();
    });
  });
});
