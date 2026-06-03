import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearDismissSilence,
  getDismissSilence,
  setDismissSilence,
} from '../dismissSilenceStorage';
import { DISMISS_SILENCE_KEY } from '../../constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

const sample = { sinceTs: 1_700_000_000_000, sinceLat: 37.5, sinceLng: 127 };

describe('dismissSilenceStorage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getDismissSilence', () => {
    it('AsyncStorage가 null이면 null 반환', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      expect(await getDismissSilence()).toBeNull();
      expect(AsyncStorage.getItem).toHaveBeenCalledWith(DISMISS_SILENCE_KEY);
    });

    it('유효한 JSON을 그대로 반환', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(sample));
      expect(await getDismissSilence()).toEqual(sample);
    });

    it('좌표 null인 유효한 entry도 그대로 반환 (시간 단독 silence)', async () => {
      const noPos = { sinceTs: 1, sinceLat: null, sinceLng: null };
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(noPos));
      expect(await getDismissSilence()).toEqual(noPos);
    });

    it('파싱 실패 시 null', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('not-json');
      expect(await getDismissSilence()).toBeNull();
    });

    it('sinceTs 누락 시 null', async () => {
      const broken = { sinceLat: 0, sinceLng: 0 };
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(broken));
      expect(await getDismissSilence()).toBeNull();
    });

    it('sinceLat 타입 오염 시 null', async () => {
      const broken = { sinceTs: 1, sinceLat: 'x', sinceLng: 0 };
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(broken));
      expect(await getDismissSilence()).toBeNull();
    });

    it('sinceLng 타입 오염 시 null', async () => {
      const broken = { sinceTs: 1, sinceLat: 0, sinceLng: 'x' };
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(broken));
      expect(await getDismissSilence()).toBeNull();
    });

    it('루트가 객체가 아니면 null', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify('a string'));
      expect(await getDismissSilence()).toBeNull();
    });

    it('AsyncStorage 오류 시 null (graceful)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage'));
      expect(await getDismissSilence()).toBeNull();
    });
  });

  describe('setDismissSilence', () => {
    it('state를 JSON 직렬화해 저장', async () => {
      await setDismissSilence(sample);
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        DISMISS_SILENCE_KEY,
        JSON.stringify(sample),
      );
    });

    it('AsyncStorage 오류 시 throw 없이 swallow', async () => {
      (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('storage'));
      await expect(setDismissSilence(sample)).resolves.toBeUndefined();
    });
  });

  describe('clearDismissSilence', () => {
    it('DISMISS_SILENCE_KEY 제거', async () => {
      await clearDismissSilence();
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(DISMISS_SILENCE_KEY);
    });

    it('AsyncStorage 오류 시 swallow', async () => {
      (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('storage'));
      await expect(clearDismissSilence()).resolves.toBeUndefined();
    });
  });
});
