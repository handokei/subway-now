import { renderHook, act, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSleepModeGuide } from '../useSleepModeGuide';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.spyOn(Alert, 'alert').mockImplementation(() => {});

describe('useSleepModeGuide', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
  });

  it('should show Alert on first call when AsyncStorage has no stored value', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    const { result } = renderHook(() => useSleepModeGuide());

    await waitFor(() => {
      expect(AsyncStorage.getItem).toHaveBeenCalled();
    });

    const onConfirm = jest.fn();
    act(() => {
      result.current(onConfirm);
    });

    expect(Alert.alert).toHaveBeenCalledWith(
      '취침 모드 안내',
      expect.any(String),
      [{ text: '확인', onPress: onConfirm }],
    );
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('should save true to AsyncStorage on first call', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    const { result } = renderHook(() => useSleepModeGuide());

    await waitFor(() => {
      expect(AsyncStorage.getItem).toHaveBeenCalled();
    });

    const onConfirm = jest.fn();
    act(() => {
      result.current(onConfirm);
    });

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:sleep-mode-guide-shown',
      'true',
    );
  });

  it('should call onConfirm via Alert button press on first call', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (Alert.alert as jest.Mock).mockImplementationOnce((_title, _msg, buttons) => {
      buttons[0].onPress();
    });

    const { result } = renderHook(() => useSleepModeGuide());

    await waitFor(() => {
      expect(AsyncStorage.getItem).toHaveBeenCalled();
    });

    const onConfirm = jest.fn();
    act(() => {
      result.current(onConfirm);
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('should skip Alert on second call and call onConfirm directly', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    const { result } = renderHook(() => useSleepModeGuide());

    await waitFor(() => {
      expect(AsyncStorage.getItem).toHaveBeenCalled();
    });

    const firstConfirm = jest.fn();
    act(() => {
      result.current(firstConfirm);
    });

    const secondConfirm = jest.fn();
    act(() => {
      result.current(secondConfirm);
    });

    expect(Alert.alert).toHaveBeenCalledTimes(1);
    expect(secondConfirm).toHaveBeenCalledTimes(1);
  });

  it('should skip Alert and call onConfirm directly when AsyncStorage has stored true', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue('true');
    const { result } = renderHook(() => useSleepModeGuide());

    await waitFor(() => {
      expect(AsyncStorage.getItem).toHaveBeenCalled();
    });

    const onConfirm = jest.fn();
    act(() => {
      result.current(onConfirm);
    });

    expect(Alert.alert).not.toHaveBeenCalled();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('should still show Alert when AsyncStorage.getItem rejects', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValue(new Error('storage error'));
    const { result } = renderHook(() => useSleepModeGuide());

    await waitFor(() => {
      expect(AsyncStorage.getItem).toHaveBeenCalled();
    });

    const onConfirm = jest.fn();
    act(() => {
      result.current(onConfirm);
    });

    expect(Alert.alert).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('should not throw when AsyncStorage.setItem rejects', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (AsyncStorage.setItem as jest.Mock).mockRejectedValue(new Error('setItem error'));
    const { result } = renderHook(() => useSleepModeGuide());

    await waitFor(() => {
      expect(AsyncStorage.getItem).toHaveBeenCalled();
    });

    const onConfirm = jest.fn();
    expect(() => {
      act(() => {
        result.current(onConfirm);
      });
    }).not.toThrow();
  });
});
