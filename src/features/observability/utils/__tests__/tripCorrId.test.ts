import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  generateTripCorrId,
  setTripCorrId,
  getCurrentTripCorrId,
  getCurrentTripCorrIdSync,
  clearTripCorrId,
  __resetTripCorrIdForTests__,
} from '../tripCorrId';
import { TRIP_CORR_ID_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('tripCorrId (#1501 PR-A)', () => {
  beforeEach(async () => {
    __resetTripCorrIdForTests__();
    await AsyncStorage.clear();
  });

  describe('generateTripCorrId', () => {
    it('`${ms}-${8 hex}` 형식 — deps 주입으로 결정적 결과', () => {
      const id = generateTripCorrId({ now: () => 1_700_000_000_000, random: () => 0.5 });
      expect(id).toMatch(/^\d+-[0-9a-f]{8}$/);
      expect(id.startsWith('1700000000000-')).toBe(true);
    });

    it('hex suffix는 항상 8자(작은 random값도 zero-pad)', () => {
      const id = generateTripCorrId({ now: () => 1, random: () => 0 });
      expect(id).toBe('1-00000000');
    });

    it('hex suffix max — random=0.9999999는 8자 유지', () => {
      const id = generateTripCorrId({ now: () => 2, random: () => 0.99999999 });
      // 32-bit 영역. 9자 넘지 않음 확인.
      const [, hex] = id.split('-');
      expect(hex.length).toBe(8);
    });

    it('기본 deps도 형식 일치 (Date.now/Math.random)', () => {
      const id = generateTripCorrId();
      expect(id).toMatch(/^\d+-[0-9a-f]{8}$/);
    });
  });

  describe('set/get/clear', () => {
    it('setTripCorrId 후 getCurrentTripCorrId가 같은 값을 반환', async () => {
      await setTripCorrId('1700000000000-deadbeef');
      const id = await getCurrentTripCorrId();
      expect(id).toBe('1700000000000-deadbeef');
    });

    it('clearTripCorrId 후 getCurrentTripCorrId는 null', async () => {
      await setTripCorrId('x');
      await clearTripCorrId();
      const id = await getCurrentTripCorrId();
      expect(id).toBeNull();
    });

    it('키 부재 시 getCurrentTripCorrId는 null', async () => {
      const id = await getCurrentTripCorrId();
      expect(id).toBeNull();
    });
  });

  describe('storage 실패 graceful', () => {
    it('setItem reject 시 throw 안 함', async () => {
      (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      await expect(setTripCorrId('x')).resolves.toBeUndefined();
    });

    it('getItem reject 시 null 반환', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      const id = await getCurrentTripCorrId();
      expect(id).toBeNull();
    });

    it('removeItem reject 시 throw 안 함', async () => {
      (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      await expect(clearTripCorrId()).resolves.toBeUndefined();
    });

    it('setTripCorrId가 올바른 키로 저장', async () => {
      await setTripCorrId('abc');
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(TRIP_CORR_ID_KEY, 'abc');
    });
  });

  describe('sync cache', () => {
    it('set 후 sync read 즉시 같은 값 (fusion hot path 보장)', async () => {
      await setTripCorrId('cid-sync-1');
      expect(getCurrentTripCorrIdSync()).toBe('cid-sync-1');
    });

    it('clear 후 sync read 즉시 null', async () => {
      await setTripCorrId('cid-sync-2');
      await clearTripCorrId();
      expect(getCurrentTripCorrIdSync()).toBeNull();
    });

    it('boot 시 sync read는 null (cache 미초기화)', () => {
      expect(getCurrentTripCorrIdSync()).toBeNull();
    });

    it('async get이 storage에서 hydrate → sync cache 갱신', async () => {
      await AsyncStorage.setItem(TRIP_CORR_ID_KEY, 'cid-hydrated');
      expect(getCurrentTripCorrIdSync()).toBeNull();
      const got = await getCurrentTripCorrId();
      expect(got).toBe('cid-hydrated');
      expect(getCurrentTripCorrIdSync()).toBe('cid-hydrated');
    });

    it('async get이 reject 시 cache 보존 (마지막 sync 값 유지)', async () => {
      await setTripCorrId('cid-prev');
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      const got = await getCurrentTripCorrId();
      expect(got).toBe('cid-prev'); // catch path returns cache
      expect(getCurrentTripCorrIdSync()).toBe('cid-prev');
    });
  });
});
