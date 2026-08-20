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
  demoteToUndergroundIfNeeded,
  releaseFromUndergroundIfNeeded,
  resetUndergroundFailCount,
} from '../bgLocationProfile';
import {
  BG_LOCATION_PROFILE_KEY,
  BG_LOCATION_PROFILE_FLIP_COUNT_KEY,
  BG_FOREGROUND_SERVICE_TEXT_KEY,
  BG_UNDERGROUND_FAIL_COUNT_KEY,
} from '../../../../shared/constants/storageKeys';
import {
  LOCATION_TRACKING_OPTIONS_STATIONARY,
  LOCATION_TRACKING_OPTIONS_UNDERGROUND,
  BG_UNDERGROUND_DEMOTE_FAIL_THRESHOLD,
} from '../../../../shared/constants/locationTracking';

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

  // #2345 — 지하 accuracy 강등 gate.
  describe('demoteToUndergroundIfNeeded', () => {
    it('임계값 미만이면 카운터만 올리고 profile 전환은 하지 않는다', async () => {
      mockGetItem.mockImplementation((key: string) => {
        if (key === BG_UNDERGROUND_FAIL_COUNT_KEY) return Promise.resolve(String(BG_UNDERGROUND_DEMOTE_FAIL_THRESHOLD - 2));
        return Promise.resolve(null);
      });

      await demoteToUndergroundIfNeeded(TASK_NAME);

      expect(mockSetItem).toHaveBeenCalledWith(
        BG_UNDERGROUND_FAIL_COUNT_KEY,
        String(BG_UNDERGROUND_DEMOTE_FAIL_THRESHOLD - 1),
      );
      expect(mockStopLocationUpdatesAsync).not.toHaveBeenCalled();
    });

    it('임계값에 도달하면 카운터를 올리고 profile을 underground로 강등한다', async () => {
      mockGetItem.mockImplementation((key: string) => {
        if (key === BG_UNDERGROUND_FAIL_COUNT_KEY) return Promise.resolve(String(BG_UNDERGROUND_DEMOTE_FAIL_THRESHOLD - 1));
        if (key === BG_LOCATION_PROFILE_KEY) return Promise.resolve(null); // surface
        return Promise.resolve(null);
      });

      await demoteToUndergroundIfNeeded(TASK_NAME);

      expect(mockSetItem).toHaveBeenCalledWith(
        BG_UNDERGROUND_FAIL_COUNT_KEY,
        String(BG_UNDERGROUND_DEMOTE_FAIL_THRESHOLD),
      );
      expect(mockStopLocationUpdatesAsync).toHaveBeenCalledWith(TASK_NAME);
      expect(mockStartLocationUpdatesAsync).toHaveBeenCalledWith(
        TASK_NAME,
        expect.objectContaining(LOCATION_TRACKING_OPTIONS_UNDERGROUND),
      );
      expect(mockSetItem).toHaveBeenCalledWith(BG_LOCATION_PROFILE_KEY, 'underground');
    });

    it('카운터 read 예외 시 0에서 시작해 1로 증가시킨다 (graceful)', async () => {
      mockGetItem.mockImplementation((key: string) => {
        if (key === BG_UNDERGROUND_FAIL_COUNT_KEY) return Promise.reject(new Error('storage down'));
        return Promise.resolve(null);
      });

      await demoteToUndergroundIfNeeded(TASK_NAME);

      expect(mockSetItem).toHaveBeenCalledWith(BG_UNDERGROUND_FAIL_COUNT_KEY, '1');
    });

    it('카운터 파싱 실패 시 0에서 시작해 1로 증가시킨다', async () => {
      mockGetItem.mockImplementation((key: string) => {
        if (key === BG_UNDERGROUND_FAIL_COUNT_KEY) return Promise.resolve('not-a-number');
        return Promise.resolve(null);
      });

      await demoteToUndergroundIfNeeded(TASK_NAME);

      expect(mockSetItem).toHaveBeenCalledWith(BG_UNDERGROUND_FAIL_COUNT_KEY, '1');
    });

    it('카운터 저장 실패는 graceful하게 흡수하고 임계값 판정은 계속 진행한다', async () => {
      mockGetItem.mockImplementation((key: string) => {
        if (key === BG_UNDERGROUND_FAIL_COUNT_KEY) return Promise.resolve(String(BG_UNDERGROUND_DEMOTE_FAIL_THRESHOLD - 1));
        return Promise.resolve(null);
      });
      mockSetItem.mockImplementation((key: string, value: string) => {
        if (key === BG_UNDERGROUND_FAIL_COUNT_KEY) return Promise.reject(new Error('fail'));
        return Promise.resolve(undefined);
      });

      await expect(demoteToUndergroundIfNeeded(TASK_NAME)).resolves.toBeUndefined();
      expect(mockStopLocationUpdatesAsync).toHaveBeenCalledWith(TASK_NAME);
    });
  });

  describe('releaseFromUndergroundIfNeeded', () => {
    it('현재 profile이 underground가 아니면 카운터만 reset하고 false를 반환한다', async () => {
      mockGetItem.mockImplementation((key: string) => {
        if (key === BG_LOCATION_PROFILE_KEY) return Promise.resolve(null); // surface
        return Promise.resolve(null);
      });

      const released = await releaseFromUndergroundIfNeeded(TASK_NAME);

      expect(released).toBe(false);
      expect(mockSetItem).toHaveBeenCalledWith(BG_UNDERGROUND_FAIL_COUNT_KEY, '0');
      expect(mockStopLocationUpdatesAsync).not.toHaveBeenCalled();
    });

    it('현재 profile이 underground면 즉시 surface로 eager release하고 true를 반환한다', async () => {
      mockGetItem.mockImplementation((key: string) => {
        if (key === BG_LOCATION_PROFILE_KEY) return Promise.resolve('underground');
        return Promise.resolve(null);
      });

      const released = await releaseFromUndergroundIfNeeded(TASK_NAME);

      expect(released).toBe(true);
      expect(mockSetItem).toHaveBeenCalledWith(BG_UNDERGROUND_FAIL_COUNT_KEY, '0');
      expect(mockStopLocationUpdatesAsync).toHaveBeenCalledWith(TASK_NAME);
      expect(mockStartLocationUpdatesAsync).toHaveBeenCalledWith(
        TASK_NAME,
        expect.objectContaining({ timeInterval: 30_000 }),
      );
      expect(mockSetItem).toHaveBeenCalledWith(BG_LOCATION_PROFILE_KEY, 'surface');
    });
  });

  describe('resetUndergroundFailCount', () => {
    it('BG_UNDERGROUND_FAIL_COUNT_KEY를 0으로 초기화한다', async () => {
      await resetUndergroundFailCount();

      expect(mockSetItem).toHaveBeenCalledWith(BG_UNDERGROUND_FAIL_COUNT_KEY, '0');
    });

    it('저장 실패는 graceful하게 흡수한다', async () => {
      mockSetItem.mockRejectedValue(new Error('fail'));

      await expect(resetUndergroundFailCount()).resolves.toBeUndefined();
    });
  });
});
