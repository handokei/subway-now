import { act, renderHook } from '@testing-library/react-native';
import { useSleepModeRef } from '../useSleepModeRef';
import { useSettingsStore } from '../../store/useSettingsStore';

describe('useSleepModeRef', () => {
  beforeEach(() => {
    useSettingsStore.setState({ sleepMode: false });
  });

  it('현재 sleepMode 값을 ref로 노출한다', () => {
    useSettingsStore.setState({ sleepMode: true });
    const { result } = renderHook(() => useSleepModeRef());
    expect(result.current.current).toBe(true);
  });

  it('store sleepMode 변경 시 ref.current가 다음 렌더에서 갱신된다', () => {
    const { result, rerender } = renderHook(() => useSleepModeRef());
    expect(result.current.current).toBe(false);

    act(() => {
      useSettingsStore.setState({ sleepMode: true });
    });
    rerender({});
    expect(result.current.current).toBe(true);
  });
});
