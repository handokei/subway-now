import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  addFiredPushId,
  hasFiredPushId,
  FIRED_PUSH_ID_TTL_MS,
} from '../firedPushIds';
import { FIRED_PUSH_IDS_KEY } from '../../constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

jest.mock('../logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const NOW = 1_700_000_000_000;

describe('firedPushIds (#574 P2e)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
  });

  describe('addFiredPushId', () => {
    it('기존 storage가 없으면 단일 entry로 저장', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      await addFiredPushId('p1', NOW);
      const [, json] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      expect(JSON.parse(json)).toEqual({ p1: NOW });
    });

    it('기존 entry에 추가', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({ old: NOW - 1000 }),
      );
      await addFiredPushId('new', NOW);
      const [, json] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      expect(JSON.parse(json)).toEqual({ old: NOW - 1000, new: NOW });
    });

    it('TTL 초과 entry는 prune 후 저장', async () => {
      const stale = NOW - FIRED_PUSH_ID_TTL_MS - 1;
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({ stale_old: stale, recent: NOW - 1000 }),
      );
      await addFiredPushId('new', NOW);
      const [, json] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      expect(JSON.parse(json)).toEqual({ recent: NOW - 1000, new: NOW });
    });

    it('손상된 JSON은 빈 map으로 초기화 후 add', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('not-json{');
      await addFiredPushId('p1', NOW);
      const [, json] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      expect(JSON.parse(json)).toEqual({ p1: NOW });
    });

    it('비-객체 JSON(배열 등)도 빈 map으로 초기화', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(['a']));
      await addFiredPushId('p1', NOW);
      const [, json] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      expect(JSON.parse(json)).toEqual({ p1: NOW });
    });

    it('비-숫자 ts 항목은 prune (구버전 호환)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({ bad: 'string', good: NOW }),
      );
      await addFiredPushId('new', NOW);
      const [, json] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      expect(JSON.parse(json)).toEqual({ good: NOW, new: NOW });
    });

    it('AsyncStorage 실패 시 throw 안 함 (fire-and-forget)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      await expect(addFiredPushId('p1', NOW)).resolves.toBeUndefined();
    });

    it('setItem 실패도 swallow', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
      await expect(addFiredPushId('p1', NOW)).resolves.toBeUndefined();
    });

    it('default now (인자 미주입)는 Date.now() 사용', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(NOW);
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      await addFiredPushId('p1');
      const [, json] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      expect(JSON.parse(json).p1).toBe(NOW);
      (Date.now as jest.Mock).mockRestore?.();
    });
  });

  describe('hasFiredPushId', () => {
    it('TTL 내 entry는 true', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({ p1: NOW - 1000 }),
      );
      expect(await hasFiredPushId('p1', NOW)).toBe(true);
    });

    it('TTL 초과 entry는 false', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({ p1: NOW - FIRED_PUSH_ID_TTL_MS - 1 }),
      );
      expect(await hasFiredPushId('p1', NOW)).toBe(false);
    });

    it('미존재 id는 false', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify({}));
      expect(await hasFiredPushId('missing', NOW)).toBe(false);
    });

    it('비-숫자 ts entry는 false (방어)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({ p1: 'string' }),
      );
      expect(await hasFiredPushId('p1', NOW)).toBe(false);
    });

    it('AsyncStorage 실패 시 false (빈 map fallback)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      expect(await hasFiredPushId('p1', NOW)).toBe(false);
    });

    it('default now (인자 미주입)는 Date.now()', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(NOW);
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({ p1: NOW - 1000 }),
      );
      expect(await hasFiredPushId('p1')).toBe(true);
      (Date.now as jest.Mock).mockRestore?.();
    });
  });

  it('FIRED_PUSH_ID_TTL_MS는 5분으로 노출', () => {
    expect(FIRED_PUSH_ID_TTL_MS).toBe(5 * 60 * 1000);
  });

  it('AsyncStorage key는 storageKeys 상수', () => {
    expect(FIRED_PUSH_IDS_KEY).toBe('subway-now:fired-push-ids');
  });

  describe('동시성 직렬화 큐', () => {
    it('두 add가 동시에 진입해도 두 entry 모두 저장된다 (read-modify-write race 차단)', async () => {
      let storage: string | null = null;
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async () => storage);
      (AsyncStorage.setItem as jest.Mock).mockImplementation(async (_key, value) => {
        storage = value;
      });
      // 동시 호출 — Promise.all로 발사. 큐가 없으면 두 read가 동일 빈 state 보고 마지막 write가 첫 entry 덮어씀.
      await Promise.all([addFiredPushId('a', NOW), addFiredPushId('b', NOW + 1)]);
      const final = JSON.parse(storage!);
      expect(final).toEqual({ a: NOW, b: NOW + 1 });
    });

    it('add 후 has는 same-tick에서도 직전 write를 본다', async () => {
      let storage: string | null = null;
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async () => storage);
      (AsyncStorage.setItem as jest.Mock).mockImplementation(async (_key, value) => {
        storage = value;
      });
      // 큐로 직렬화되므로 has는 add 이후 결과를 본다.
      const addP = addFiredPushId('p1', NOW);
      const hasP = hasFiredPushId('p1', NOW);
      await Promise.all([addP, hasP]);
      expect(await hasP).toBe(true);
    });

    it('AsyncStorage 실패는 add/has 모두 try/catch로 swallow하므로 큐가 끊기지 않는다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage-down'));
      (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('storage-down'));
      // 실패 직후 정상 동작 — 큐 fulfilled 유지.
      await addFiredPushId('after-error', NOW);
      expect(await hasFiredPushId('after-error', NOW)).toBe(false); // storage 미반영이지만 throw 없음
    });
  });
});
