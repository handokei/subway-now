import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSubsurfaceState, setSubsurfaceState } from '../subsurfaceState';
import { SUBSURFACE_STATE_KEY } from '../../constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

describe('subsurfaceState', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('setSubsurfaceState', () => {
    it('subsurface=true를 JSON으로 직렬화해 SUBSURFACE_STATE_KEY에 저장', async () => {
      const before = Date.now();
      await setSubsurfaceState(true);
      const after = Date.now();

      expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
      const [key, raw] = (AsyncStorage.setItem as jest.Mock).mock.calls[0] as [string, string];
      expect(key).toBe(SUBSURFACE_STATE_KEY);
      const parsed = JSON.parse(raw) as { subsurface: boolean; updatedAt: number };
      expect(parsed.subsurface).toBe(true);
      expect(parsed.updatedAt).toBeGreaterThanOrEqual(before);
      expect(parsed.updatedAt).toBeLessThanOrEqual(after);
    });

    it('subsurface=false도 저장', async () => {
      await setSubsurfaceState(false);
      const [, raw] = (AsyncStorage.setItem as jest.Mock).mock.calls[0] as [string, string];
      expect(JSON.parse(raw)).toMatchObject({ subsurface: false });
    });

    it('AsyncStorage 오류 시 throw 없이 swallow', async () => {
      (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('storage'));
      await expect(setSubsurfaceState(true)).resolves.toBeUndefined();
    });
  });

  describe('getSubsurfaceState', () => {
    it('키 부재 시 false 반환', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      expect(await getSubsurfaceState()).toBe(false);
      expect(AsyncStorage.getItem).toHaveBeenCalledWith(SUBSURFACE_STATE_KEY);
    });

    it('유효한 stamp(subsurface=true)를 정상 반환', async () => {
      const stamp = { subsurface: true, updatedAt: Date.now() };
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(stamp));
      expect(await getSubsurfaceState()).toBe(true);
    });

    it('유효한 stamp(subsurface=false)를 정상 반환', async () => {
      const stamp = { subsurface: false, updatedAt: Date.now() };
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(stamp));
      expect(await getSubsurfaceState()).toBe(false);
    });

    it('TTL 만료 stamp는 false 반환', async () => {
      const stamp = { subsurface: true, updatedAt: Date.now() - 91_000 };
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(stamp));
      // 기본 TTL 90_000ms 초과
      expect(await getSubsurfaceState()).toBe(false);
    });

    it('커스텀 ttlMs 내에 있으면 정상 반환', async () => {
      const stamp = { subsurface: true, updatedAt: Date.now() - 5_000 };
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(stamp));
      expect(await getSubsurfaceState(10_000)).toBe(true);
    });

    it('커스텀 ttlMs 초과 시 false 반환', async () => {
      const stamp = { subsurface: true, updatedAt: Date.now() - 11_000 };
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(stamp));
      expect(await getSubsurfaceState(10_000)).toBe(false);
    });

    it('parse 오류(invalid JSON) 시 false 반환', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('not-json');
      expect(await getSubsurfaceState()).toBe(false);
    });

    it('subsurface 필드 누락 시 false 반환', async () => {
      const broken = { updatedAt: Date.now() };
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(broken));
      expect(await getSubsurfaceState()).toBe(false);
    });

    it('updatedAt 필드 누락 시 false 반환', async () => {
      const broken = { subsurface: true };
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(broken));
      expect(await getSubsurfaceState()).toBe(false);
    });

    it('subsurface가 boolean이 아니면 false 반환', async () => {
      const broken = { subsurface: 'yes', updatedAt: Date.now() };
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(broken));
      expect(await getSubsurfaceState()).toBe(false);
    });

    it('updatedAt이 number가 아니면 false 반환', async () => {
      const broken = { subsurface: true, updatedAt: 'now' };
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(broken));
      expect(await getSubsurfaceState()).toBe(false);
    });

    it('루트가 null이면 false 반환', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(null));
      expect(await getSubsurfaceState()).toBe(false);
    });

    it('AsyncStorage 오류 시 false 반환 (graceful)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage'));
      expect(await getSubsurfaceState()).toBe(false);
    });
  });
});
