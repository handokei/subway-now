import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearBoardingLock,
  getBoardingLock,
  setBoardingLock,
} from '../boardingLockStorage';
import { BOARDING_LOCK_KEY } from '../../../../shared/constants/storageKeys';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const sample: BoardingLock = {
  destinationId: 'dest-1',
  trainCode: 'T-100',
  boardingStationId: 'stn-A',
  boardingLine: '2',
  boardedAt: 1_700_000_000_000,
  expectedDurationMs: 600_000,
};

describe('boardingLockStorage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getBoardingLock', () => {
    it('AsyncStorage가 null이면 null 반환', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      expect(await getBoardingLock()).toBeNull();
      expect(AsyncStorage.getItem).toHaveBeenCalledWith(BOARDING_LOCK_KEY);
    });

    it('유효한 JSON을 파싱해 반환', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(sample));
      expect(await getBoardingLock()).toEqual(sample);
    });

    it('JSON 파싱 실패 시 null 반환 (오염된 페이로드 차단)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('not-json');
      expect(await getBoardingLock()).toBeNull();
    });

    it('필수 필드 누락 시 null 반환', async () => {
      const broken = { ...sample, trainCode: undefined };
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(broken));
      expect(await getBoardingLock()).toBeNull();
    });

    it('루트가 객체가 아니면 null 반환', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify('a string'));
      expect(await getBoardingLock()).toBeNull();
    });

    it('AsyncStorage 오류 시 null 반환 (graceful)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage'));
      expect(await getBoardingLock()).toBeNull();
    });
  });

  describe('setBoardingLock', () => {
    it('Lock을 JSON 직렬화해 저장', async () => {
      await setBoardingLock(sample);
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        BOARDING_LOCK_KEY,
        JSON.stringify(sample),
      );
    });

    it('AsyncStorage 오류 시 throw 없이 swallow', async () => {
      (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('storage'));
      await expect(setBoardingLock(sample)).resolves.toBeUndefined();
    });
  });

  describe('clearBoardingLock', () => {
    it('BOARDING_LOCK_KEY 제거', async () => {
      await clearBoardingLock();
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(BOARDING_LOCK_KEY);
    });

    it('AsyncStorage 오류 시 swallow', async () => {
      (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('storage'));
      await expect(clearBoardingLock()).resolves.toBeUndefined();
    });
  });
});
