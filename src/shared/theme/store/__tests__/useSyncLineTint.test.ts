import { renderHook } from '@testing-library/react-native';
import { useSyncLineTint } from '../useSyncLineTint';
import { useLineTintStore } from '../useLineTintStore';
import type { LineNumber } from '../../../types/station';

describe('useSyncLineTint', () => {
  beforeEach(() => {
    useLineTintStore.setState({ line: null });
  });

  it('홈 노선이 바뀌면 store에 반영된다', () => {
    const { rerender } = renderHook(({ line }: { line: LineNumber | null }) => useSyncLineTint(line), {
      initialProps: { line: '2' as LineNumber | null },
    });
    expect(useLineTintStore.getState().line).toBe('2');
    rerender({ line: '5' });
    expect(useLineTintStore.getState().line).toBe('5');
  });

  it('노선이 없어지면(트립 종료) 기본 틴트(null)로 복귀한다', () => {
    const { rerender } = renderHook(({ line }: { line: LineNumber | null }) => useSyncLineTint(line), {
      initialProps: { line: '2' as LineNumber | null },
    });
    rerender({ line: null });
    expect(useLineTintStore.getState().line).toBeNull();
  });

  it('언마운트 시 null로 복귀한다', () => {
    const { unmount } = renderHook(() => useSyncLineTint('3'));
    expect(useLineTintStore.getState().line).toBe('3');
    unmount();
    expect(useLineTintStore.getState().line).toBeNull();
  });
});
