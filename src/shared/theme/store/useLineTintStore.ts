import { create } from 'zustand';
import type { LineNumber } from '../../types/station';

// 화면 배경 글로우가 따라갈 "현재 노선". HomeScreen이 탑승/현재역 노선을, MapScreen이 선택 역 노선을 set.
interface LineTintState {
  line: LineNumber | null;
  setLine: (line: LineNumber | null) => void;
}

export const useLineTintStore = create<LineTintState>((set) => ({
  line: null,
  setLine: (line) => set((s) => (s.line === line ? s : { line })),
}));
