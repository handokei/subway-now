import { create } from 'zustand';

/**
 * Debug overlay store — ADR 후속 Step 6 (#892).
 *
 * 5-tap gesture로 DebugModal을 토글하기 위한 메모리 전용 flag. 영속화 안 함.
 *
 * 원본: `src/store/useAppStore.ts` debugVisible slice (god object 분해).
 */
export interface DebugState {
  debugVisible: boolean;
  setDebugVisible: (visible: boolean) => void;
}

export const useDebugStore = create<DebugState>((set) => ({
  debugVisible: false,

  setDebugVisible: (visible: boolean) => {
    set({ debugVisible: visible });
  },
}));
