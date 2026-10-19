import { create } from 'zustand';
import type { LineNumber } from '../../types/station';

// 화면 배경 글로우가 따라갈 "현재 노선". HomeScreen(useSyncLineTint)만 탑승/진행/현재역 노선을 set한다. MapScreen은 store 없이 LineGlowBackground line prop으로 직접 넘긴다.
interface LineTintState {
  line: LineNumber | null;
  setLine: (line: LineNumber | null) => void;
}

export const useLineTintStore = create<LineTintState>((set) => ({
  line: null,
  setLine: (line) => set((s) => (s.line === line ? s : { line })),
}));
