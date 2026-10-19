import { useEffect } from 'react';
import type { LineNumber } from '../../types/station';
import { useLineTintStore } from './useLineTintStore';

/**
 * 화면이 결정한 현재 노선을 useLineTintStore에 반영한다(탭바·타 탭 틴트 연동).
 * line이 바뀔 때만 쓰고, line이 null(트립 종료/노선 없음)이면 기본 틴트로 복귀하며,
 * 언마운트 시에도 null로 되돌린다.
 */
export function useSyncLineTint(line: LineNumber | null): void {
  const setLine = useLineTintStore((st) => st.setLine);
  useEffect(() => {
    setLine(line);
    return () => setLine(null);
  }, [line, setLine]);
}
