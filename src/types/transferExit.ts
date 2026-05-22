import type { LineNumber } from './station';

// 한 환승역에서 (fromLine → toLine, 진행방면)에 따른 빠른 환승 도어 위치.
// 출처: scripts/fetch-transfer-exit.js (나무위키 "빠른 환승" 섹션).
// 분기 노선·순환선의 행 다양성을 보존하기 위해 terminal/loop을 별도 필드로 보존.
export interface TransferExitEntry {
  fromLine: LineNumber;
  toLine: LineNumber;
  fromLoop?: '외선순환' | '내선순환';
  toLoop?: '외선순환' | '내선순환';
  fromTerminal?: string;
  toTerminal?: string;
  doorNumber: string;
}

export type TransferExitMap = Record<string, TransferExitEntry[]>;
