import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  captureTripTrainCodeIfAbsent,
  clearTripTrainCode,
  getStoredTripTrainCode,
  setTripTrainCode,
} from '../tripTrainCode';
import { TRIP_TRAIN_CODE_KEY } from '../../shared/constants/storageKeys';
import type { StationArrival, ArrivalInfo } from '../../api/arrivalApi';
import { makeArrivalInfo } from '../../testUtils/fixtures';

function info(overrides: Partial<ArrivalInfo> = {}): ArrivalInfo {
  return makeArrivalInfo({ destination: 'D', arrivalSeconds: 100, trainCode: 'T-1', ...overrides });
}

jest.mock('../logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

describe('tripTrainCode', () => {
  beforeEach(async () => {
    await AsyncStorage.removeItem(TRIP_TRAIN_CODE_KEY);
    jest.restoreAllMocks();
  });

  it('set → get 라운드트립 (같은 destinationId)', async () => {
    await setTripTrainCode('dest-1', 'T1234');
    expect(await getStoredTripTrainCode('dest-1')).toBe('T1234');
  });

  it('다른 destinationId로 get하면 null — 다른 트립의 lock은 자동 거부', async () => {
    await setTripTrainCode('dest-1', 'T1234');
    expect(await getStoredTripTrainCode('dest-2')).toBeNull();
  });

  it('clear 이후에는 null', async () => {
    await setTripTrainCode('dest-1', 'T1234');
    await clearTripTrainCode();
    expect(await getStoredTripTrainCode('dest-1')).toBeNull();
  });

  it('저장된 값이 없으면 null', async () => {
    expect(await getStoredTripTrainCode('dest-1')).toBeNull();
  });

  it('seprator가 없는 잘못된 형식이면 null', async () => {
    await AsyncStorage.setItem(TRIP_TRAIN_CODE_KEY, 'malformed-no-separator');
    expect(await getStoredTripTrainCode('dest-1')).toBeNull();
  });

  it('seprator가 첫 문자면 destinationId가 빈 문자열 → null', async () => {
    await AsyncStorage.setItem(TRIP_TRAIN_CODE_KEY, ':T1234');
    expect(await getStoredTripTrainCode('dest-1')).toBeNull();
  });

  it('trainCode가 빈 문자열이면 null', async () => {
    await AsyncStorage.setItem(TRIP_TRAIN_CODE_KEY, 'dest-1:');
    expect(await getStoredTripTrainCode('dest-1')).toBeNull();
  });

  it('AsyncStorage.getItem 실패 시 null로 안전 폴백', async () => {
    jest
      .spyOn(AsyncStorage, 'getItem')
      .mockRejectedValueOnce(new Error('storage error'));
    expect(await getStoredTripTrainCode('dest-1')).toBeNull();
  });

  it('AsyncStorage.setItem 실패 시 throw하지 않는다', async () => {
    jest
      .spyOn(AsyncStorage, 'setItem')
      .mockRejectedValueOnce(new Error('storage error'));
    await expect(setTripTrainCode('dest-1', 'T1')).resolves.toBeUndefined();
  });

  it('AsyncStorage.removeItem 실패 시 throw하지 않는다', async () => {
    jest
      .spyOn(AsyncStorage, 'removeItem')
      .mockRejectedValueOnce(new Error('storage error'));
    await expect(clearTripTrainCode()).resolves.toBeUndefined();
  });

  describe('captureTripTrainCodeIfAbsent', () => {
    const arrival: StationArrival = {
      up: [info({ arrivalSeconds: 240, trainCode: 'T-UP' })],
      down: [info({ arrivalSeconds: 30, trainCode: 'T-DN' })],
    };

    it('저장된 코드가 있으면 그대로 반환하고 setItem 호출하지 않는다', async () => {
      await setTripTrainCode('dest-1', 'EXISTING');
      const setSpy = jest.spyOn(AsyncStorage, 'setItem');
      setSpy.mockClear();
      const result = await captureTripTrainCodeIfAbsent('dest-1', arrival, 'up');
      expect(result).toBe('EXISTING');
      expect(setSpy).not.toHaveBeenCalled();
    });

    it('저장된 코드가 없으면 방향-필터 min-ETA trainCode를 캡처해 저장한다', async () => {
      const result = await captureTripTrainCodeIfAbsent('dest-1', arrival, 'up');
      expect(result).toBe('T-UP');
      expect(await getStoredTripTrainCode('dest-1')).toBe('T-UP');
    });

    it('arrival이 null이면 캡처 후보 없음 → null 반환, 저장 안 함', async () => {
      const result = await captureTripTrainCodeIfAbsent('dest-1', null, 'up');
      expect(result).toBeNull();
      expect(await getStoredTripTrainCode('dest-1')).toBeNull();
    });

    it('해당 방향에 양수 후보가 없으면 null 반환, 저장 안 함', async () => {
      const empty: StationArrival = {
        up: [info({ arrivalSeconds: 0, trainCode: 'T-UP' })],
        down: [info({ arrivalSeconds: 100, trainCode: 'T-DN' })],
      };
      const result = await captureTripTrainCodeIfAbsent('dest-1', empty, 'up');
      expect(result).toBeNull();
      expect(await getStoredTripTrainCode('dest-1')).toBeNull();
    });

    it('picker의 trainCode가 빈 문자열이면 null 반환, 저장 안 함', async () => {
      const blank: StationArrival = {
        up: [info({ arrivalSeconds: 100, trainCode: '' })],
        down: [],
      };
      const result = await captureTripTrainCodeIfAbsent('dest-1', blank, 'up');
      expect(result).toBeNull();
      expect(await getStoredTripTrainCode('dest-1')).toBeNull();
    });
  });
});
