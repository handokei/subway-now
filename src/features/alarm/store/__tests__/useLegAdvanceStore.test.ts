import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLegAdvanceStore } from '../useLegAdvanceStore';
import { LEG_ADVANCE_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

describe('useLegAdvanceStore (#2278)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useLegAdvanceStore.setState({ nextLine: null, stampedAt: null });
    (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
    (AsyncStorage.removeItem as jest.Mock).mockResolvedValue(undefined);
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
  });

  it('초기 상태는 nextLine=null, stampedAt=null', () => {
    expect(useLegAdvanceStore.getState().nextLine).toBeNull();
    expect(useLegAdvanceStore.getState().stampedAt).toBeNull();
  });

  describe('stampLegAdvance', () => {
    it('nextLine + stampedAt(now)을 세팅하고 storage에 영속화한다', async () => {
      const before = Date.now();
      await useLegAdvanceStore.getState().stampLegAdvance('2');
      const after = Date.now();

      const { nextLine, stampedAt } = useLegAdvanceStore.getState();
      expect(nextLine).toBe('2');
      expect(stampedAt).not.toBeNull();
      expect(stampedAt as number).toBeGreaterThanOrEqual(before);
      expect(stampedAt as number).toBeLessThanOrEqual(after);
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        LEG_ADVANCE_KEY,
        JSON.stringify({ nextLine: '2', stampedAt }),
      );
    });

    it('storage write 실패해도 throw 없이 graceful (memory는 반영 유지)', async () => {
      (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
      await expect(useLegAdvanceStore.getState().stampLegAdvance('7')).resolves.toBeUndefined();
      expect(useLegAdvanceStore.getState().nextLine).toBe('7');
    });
  });

  describe('clearLegAdvance', () => {
    it('nextLine/stampedAt을 null로 되돌리고 storage를 제거한다', async () => {
      await useLegAdvanceStore.getState().stampLegAdvance('2');
      await useLegAdvanceStore.getState().clearLegAdvance();

      expect(useLegAdvanceStore.getState().nextLine).toBeNull();
      expect(useLegAdvanceStore.getState().stampedAt).toBeNull();
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(LEG_ADVANCE_KEY);
    });

    it('storage 삭제 실패해도 throw 없이 graceful', async () => {
      (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('disk error'));
      await expect(useLegAdvanceStore.getState().clearLegAdvance()).resolves.toBeUndefined();
      expect(useLegAdvanceStore.getState().nextLine).toBeNull();
    });
  });

  // #2278 (PR #2287 리뷰 P1-2) — 재기동 후 stamp 복원. 지하에서 앱이 kill되면 in-memory
  // stamp(nextLine)가 사라진다 — loadLegAdvance가 storage에서 복원하지 못하면 원 버그
  // (releaseLock 직후 route.stopsToTransfer frozen → fromLine 고착)가 그대로 재현된다.
  describe('loadLegAdvance (cold-start hydrate, #2278 RCA 가설 1 재기동 변형 재현)', () => {
    it('storage에 유효한 stamp가 있으면 재기동 후에도 memory state로 복원된다', async () => {
      // "재기동" 시뮬레이션: 이전 세션이 stampLegAdvance로 storage에 남겨둔 값을 storage에서만
      // 관찰 가능한 상태로 두고(in-memory는 모듈 재로드로 초기화된 것과 동일하게 beforeEach에서
      // 이미 null), loadLegAdvance가 storage를 읽어 memory를 복원하는지 검증한다.
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({ nextLine: '2', stampedAt: 1_700_000_000_000 }),
      );

      await useLegAdvanceStore.getState().loadLegAdvance();

      expect(useLegAdvanceStore.getState().nextLine).toBe('2');
      expect(useLegAdvanceStore.getState().stampedAt).toBe(1_700_000_000_000);
    });

    it('storage에 stamp가 없으면 null 유지', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      await useLegAdvanceStore.getState().loadLegAdvance();
      expect(useLegAdvanceStore.getState().nextLine).toBeNull();
      expect(useLegAdvanceStore.getState().stampedAt).toBeNull();
    });

    it('storage read 실패해도 throw 없이 graceful (null 유지)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('disk error'));
      await expect(useLegAdvanceStore.getState().loadLegAdvance()).resolves.toBeUndefined();
      expect(useLegAdvanceStore.getState().nextLine).toBeNull();
    });
  });

  it('재-stamp — 이전 값을 덮어쓴다 (다음 leg로 갱신)', async () => {
    await useLegAdvanceStore.getState().stampLegAdvance('2');
    await useLegAdvanceStore.getState().stampLegAdvance('8');
    expect(useLegAdvanceStore.getState().nextLine).toBe('8');
  });
});
