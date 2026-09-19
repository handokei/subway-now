import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearLegAdvance,
  getLegAdvance,
  setLegAdvance,
} from '../legAdvanceStorage';
import { LEG_ADVANCE_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

const sample = { nextLine: '2' as const, stampedAt: 1_700_000_000_000 };

describe('legAdvanceStorage (#2278 P1-2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getLegAdvance', () => {
    it('AsyncStorage가 null이면 null 반환', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      expect(await getLegAdvance()).toBeNull();
      expect(AsyncStorage.getItem).toHaveBeenCalledWith(LEG_ADVANCE_KEY);
    });

    it('유효한 JSON을 그대로 반환', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(sample));
      expect(await getLegAdvance()).toEqual(sample);
    });

    it('파싱 실패 시 null', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('not-json');
      expect(await getLegAdvance()).toBeNull();
    });

    it('nextLine이 유효하지 않은 LineNumber면 null', async () => {
      const broken = { nextLine: 'K', stampedAt: 1 };
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(broken));
      expect(await getLegAdvance()).toBeNull();
    });

    it('nextLine 자체가 누락(undefined)이면 null', async () => {
      const broken = { stampedAt: 1 };
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(broken));
      expect(await getLegAdvance()).toBeNull();
    });

    it('stampedAt 누락/타입 오염 시 null', async () => {
      const broken = { nextLine: '2' };
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(broken));
      expect(await getLegAdvance()).toBeNull();
    });

    it('AsyncStorage.getItem reject 시 null', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      expect(await getLegAdvance()).toBeNull();
    });
  });

  describe('setLegAdvance', () => {
    it('JSON.stringify해 setItem 호출', async () => {
      (AsyncStorage.setItem as jest.Mock).mockResolvedValueOnce(undefined);
      await setLegAdvance(sample);
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(LEG_ADVANCE_KEY, JSON.stringify(sample));
    });

    it('setItem reject해도 throw 없이 graceful', async () => {
      (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      await expect(setLegAdvance(sample)).resolves.toBeUndefined();
    });
  });

  describe('clearLegAdvance', () => {
    it('removeItem 호출', async () => {
      (AsyncStorage.removeItem as jest.Mock).mockResolvedValueOnce(undefined);
      await clearLegAdvance();
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(LEG_ADVANCE_KEY);
    });

    it('removeItem reject해도 throw 없이 graceful', async () => {
      (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      await expect(clearLegAdvance()).resolves.toBeUndefined();
    });
  });
});
