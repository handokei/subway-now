import { create } from 'zustand';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import { isBoardingLockExpired } from '../../../shared/types/boardingLock';
import {
  clearBoardingLock,
  getBoardingLock,
  setBoardingLock,
} from '../utils/boardingLockStorage';
import { clearDismissSilence } from '../utils/dismissSilenceStorage';

/**
 * BoardingLock 전역 store (#584 PR A).
 *
 * Single Lock only — trip 1개에 leg 1개. multi-transfer는 createLock으로 교체(PR E).
 * 모든 mutation은 in-memory state + AsyncStorage 양쪽 동기 — Fusion/스케줄러가 둘 중 어디든
 * 읽어도 같은 결과를 얻게 한다.
 */
export interface BoardingLockState {
  lock: BoardingLock | null;
  /** Trip 진입 또는 환승 전환 시 호출. 기존 Lock은 자동 교체. */
  createLock: (lock: BoardingLock) => Promise<void>;
  /** 사용자가 "하차" 탭하거나 trip 종료 시 호출. */
  releaseLock: () => Promise<void>;
  /** 앱 마운트 시 storage에서 복원. */
  loadLock: () => Promise<void>;
  /**
   * 자동 만료 확인. 만료 시 lock=null로 상태 갱신 + storage 정리 후 true 반환.
   * now 인자는 테스트 시각 주입용 — 기본 Date.now().
   */
  checkExpiry: (now?: number) => Promise<boolean>;
}

export const useBoardingLockStore = create<BoardingLockState>((set, get) => ({
  lock: null,

  createLock: async (lock: BoardingLock) => {
    set({ lock });
    await setBoardingLock(lock);
    // #746: 새 lock 생성 = 사용자가 새 leg에 탑승 의사 명시 → 이전 dismiss silence는 무효.
    // 동일 trip 내 환승으로 lock이 교체되는 경우에도 같은 의미 — 즉시 클리어.
    await clearDismissSilence();
  },

  releaseLock: async () => {
    set({ lock: null });
    await clearBoardingLock();
  },

  loadLock: async () => {
    const stored = await getBoardingLock();
    set({ lock: stored });
  },

  checkExpiry: async (now: number = Date.now()) => {
    const { lock } = get();
    if (!lock) return false;
    if (!isBoardingLockExpired(lock, now)) return false;
    set({ lock: null });
    await clearBoardingLock();
    return true;
  },
}));
