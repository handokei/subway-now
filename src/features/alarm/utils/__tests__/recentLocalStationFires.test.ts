import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  markLocalStationFired,
  hasRecentLocalStationFire,
  RECENT_LOCAL_STATION_FIRE_TTL_MS,
} from '../recentLocalStationFires';
import { RECENT_LOCAL_STATION_FIRES_KEY } from '../../../../shared/constants/storageKeys';

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

const NOW = 1_700_000_000_000;

describe('recentLocalStationFires (#2122)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
  });

  describe('markLocalStationFired', () => {
    it('기존 storage가 없으면 단일 entry로 저장 (key = `${kind}:${stationName}`)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      await markLocalStationFired('중곡', 'station-passed', NOW);
      const [, json] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      expect(JSON.parse(json)).toEqual({ 'station-passed:중곡': NOW });
    });

    it('기존 entry에 추가', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({ 'station-passed:군자': NOW - 1000 }),
      );
      await markLocalStationFired('중곡', 'station-passed', NOW);
      const [, json] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      expect(JSON.parse(json)).toEqual({
        'station-passed:군자': NOW - 1000,
        'station-passed:중곡': NOW,
      });
    });

    it('TTL 초과 entry는 prune 후 저장', async () => {
      const stale = NOW - RECENT_LOCAL_STATION_FIRE_TTL_MS - 1;
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({ 'station-passed:stale': stale, 'station-passed:recent': NOW - 1000 }),
      );
      await markLocalStationFired('중곡', 'station-passed', NOW);
      const [, json] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      expect(JSON.parse(json)).toEqual({
        'station-passed:recent': NOW - 1000,
        'station-passed:중곡': NOW,
      });
    });

    it('손상된 JSON은 빈 map으로 초기화 후 add', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('not-json{');
      await markLocalStationFired('중곡', 'station-passed', NOW);
      const [, json] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      expect(JSON.parse(json)).toEqual({ 'station-passed:중곡': NOW });
    });

    it('비-객체 JSON(배열 등)도 빈 map으로 초기화', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(['a']));
      await markLocalStationFired('중곡', 'station-passed', NOW);
      const [, json] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      expect(JSON.parse(json)).toEqual({ 'station-passed:중곡': NOW });
    });

    it('비-숫자 ts 항목은 prune (구버전 호환)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({ 'station-passed:bad': 'string', 'station-passed:good': NOW }),
      );
      await markLocalStationFired('중곡', 'station-passed', NOW);
      const [, json] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      expect(JSON.parse(json)).toEqual({
        'station-passed:good': NOW,
        'station-passed:중곡': NOW,
      });
    });

    it('AsyncStorage 실패 시 throw 안 함 (fire-and-forget)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      await expect(markLocalStationFired('중곡', 'station-passed', NOW)).resolves.toBeUndefined();
    });

    it('setItem 실패도 swallow', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
      await expect(markLocalStationFired('중곡', 'station-passed', NOW)).resolves.toBeUndefined();
    });

    it('default now (인자 미주입)는 Date.now() 사용', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(NOW);
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      await markLocalStationFired('중곡', 'station-passed');
      const [, json] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      expect(JSON.parse(json)['station-passed:중곡']).toBe(NOW);
      (Date.now as jest.Mock).mockRestore?.();
    });
  });

  describe('hasRecentLocalStationFire', () => {
    it('TTL 내 (station,kind) entry는 true', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({ 'station-passed:중곡': NOW - 1000 }),
      );
      expect(await hasRecentLocalStationFire('중곡', 'station-passed', NOW)).toBe(true);
    });

    it('TTL 초과 entry는 false', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({
          'station-passed:중곡': NOW - RECENT_LOCAL_STATION_FIRE_TTL_MS - 1,
        }),
      );
      expect(await hasRecentLocalStationFire('중곡', 'station-passed', NOW)).toBe(false);
    });

    it('미존재 (station,kind)는 false', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify({}));
      expect(await hasRecentLocalStationFire('중곡', 'station-passed', NOW)).toBe(false);
    });

    it('같은 station이라도 kind가 다르면 false (kind-scoped key)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({ 'transfer:중곡': NOW - 1000 }),
      );
      expect(await hasRecentLocalStationFire('중곡', 'station-passed', NOW)).toBe(false);
    });

    it('비-숫자 ts entry는 false (방어)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({ 'station-passed:중곡': 'string' }),
      );
      expect(await hasRecentLocalStationFire('중곡', 'station-passed', NOW)).toBe(false);
    });

    it('AsyncStorage 실패 시 false (빈 map fallback)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      expect(await hasRecentLocalStationFire('중곡', 'station-passed', NOW)).toBe(false);
    });

    it('default now (인자 미주입)는 Date.now()', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(NOW);
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({ 'station-passed:중곡': NOW - 1000 }),
      );
      expect(await hasRecentLocalStationFire('중곡', 'station-passed')).toBe(true);
      (Date.now as jest.Mock).mockRestore?.();
    });
  });

  it('RECENT_LOCAL_STATION_FIRE_TTL_MS는 2분으로 노출', () => {
    expect(RECENT_LOCAL_STATION_FIRE_TTL_MS).toBe(2 * 60 * 1000);
  });

  it('AsyncStorage key는 storageKeys 상수', () => {
    expect(RECENT_LOCAL_STATION_FIRES_KEY).toBe('subway-now:recent-local-station-fires');
  });

  describe('동시성 직렬화 큐', () => {
    it('두 mark가 동시에 진입해도 두 entry 모두 저장된다 (read-modify-write race 차단)', async () => {
      let storage: string | null = null;
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async () => storage);
      (AsyncStorage.setItem as jest.Mock).mockImplementation(async (_key, value) => {
        storage = value;
      });
      await Promise.all([
        markLocalStationFired('중곡', 'station-passed', NOW),
        markLocalStationFired('군자', 'station-passed', NOW + 1),
      ]);
      const final = JSON.parse(storage!);
      expect(final).toEqual({
        'station-passed:중곡': NOW,
        'station-passed:군자': NOW + 1,
      });
    });

    it('mark 후 has는 same-tick에서도 직전 write를 본다', async () => {
      let storage: string | null = null;
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async () => storage);
      (AsyncStorage.setItem as jest.Mock).mockImplementation(async (_key, value) => {
        storage = value;
      });
      const markP = markLocalStationFired('중곡', 'station-passed', NOW);
      const hasP = hasRecentLocalStationFire('중곡', 'station-passed', NOW);
      await Promise.all([markP, hasP]);
      expect(await hasP).toBe(true);
    });
  });
});
