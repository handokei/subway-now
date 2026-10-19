import type { LineNumber } from '../types/station';

interface TintLineSources {
  /** 탑승 lock 노선 */
  boardingLine?: LineNumber | null;
  /** 진행 노선 */
  approachLine?: LineNumber | null;
  /** 현재역 노선 */
  originLine?: LineNumber | null;
}

/** Line Glass 화면 틴트 노선 결정: 탑승 lock > 진행 노선 > 현재역 노선 > null. */
export function resolveTintLine({ boardingLine, approachLine, originLine }: TintLineSources): LineNumber | null {
  return boardingLine ?? approachLine ?? originLine ?? null;
}
