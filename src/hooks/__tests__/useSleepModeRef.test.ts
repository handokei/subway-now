import { act, renderHook } from '@testing-library/react-native';
import { useSleepModeRef } from '../useSleepModeRef';
import { useAppStore } from '../../store/useAppStore';

describe('useSleepModeRef', () => {
  beforeEach(() => {
    useAppStore.setState({ sleepMode: false });
  });

  it('현재 sleepMode 값을 ref로 노출한다', () => {
    useAppStore.setState({ sleepMode: true });
    const { result } = renderHook(() => useSleepModeRef());
    expect(result.current.current).toBe(true);
  });

  it('store sleepMode 변경 시 ref.current가 다음 렌더에서 갱신된다', () => {
    const { result, rerender } = renderHook(() => useSleepModeRef());
    expect(result.current.current).toBe(false);

    act(() => {
      useAppStore.setState({ sleepMode: true });
    });
    rerender({});
    expect(result.current.current).toBe(true);
  });
});
