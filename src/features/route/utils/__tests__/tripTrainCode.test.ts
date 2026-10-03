import AsyncStorage from '@react-native-async-storage/async-storage';
import { clearTripTrainCode } from '../tripTrainCode';
import { TRIP_TRAIN_CODE_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('../../../../shared/utils/logger', () => ({
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

  it('저장된 키를 삭제한다', async () => {
    await AsyncStorage.setItem(TRIP_TRAIN_CODE_KEY, 'dest-1:T1234');
    await clearTripTrainCode();
    expect(await AsyncStorage.getItem(TRIP_TRAIN_CODE_KEY)).toBeNull();
  });

  it('AsyncStorage.removeItem 실패 시 throw하지 않는다', async () => {
    jest
      .spyOn(AsyncStorage, 'removeItem')
      .mockRejectedValueOnce(new Error('storage error'));
    await expect(clearTripTrainCode()).resolves.toBeUndefined();
  });
});
