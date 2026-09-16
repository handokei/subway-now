import AsyncStorage from '@react-native-async-storage/async-storage';
import { useThemeStore } from '../useThemeStore';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('useThemeStore', () => {
  beforeEach(() => {
    useThemeStore.setState({ themeMode: 'auto' });
    jest.clearAllMocks();
  });

  it('초기 themeMode는 auto이다', () => {
    expect(useThemeStore.getState().themeMode).toBe('auto');
  });

  it('setThemeMode: 테마 모드를 설정하면 상태가 업데이트된다', async () => {
    await useThemeStore.getState().setThemeMode('dark');
    expect(useThemeStore.getState().themeMode).toBe('dark');
  });

  it('setThemeMode: AsyncStorage에 저장한다', async () => {
    await useThemeStore.getState().setThemeMode('light');
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:theme-mode',
      JSON.stringify('light'),
    );
  });

  it('loadThemeMode: AsyncStorage에서 데이터를 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify('dark'));
    await useThemeStore.getState().loadThemeMode();
    expect(useThemeStore.getState().themeMode).toBe('dark');
  });

  it('loadThemeMode: 유효하지 않은 값이면 auto를 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify('invalid'));
    await useThemeStore.getState().loadThemeMode();
    expect(useThemeStore.getState().themeMode).toBe('auto');
  });

  it('loadThemeMode: AsyncStorage가 비어있으면 auto를 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
    await useThemeStore.getState().loadThemeMode();
    expect(useThemeStore.getState().themeMode).toBe('auto');
  });

  it('loadThemeMode: AsyncStorage 오류 시 auto를 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage error'));
    await useThemeStore.getState().loadThemeMode();
    expect(useThemeStore.getState().themeMode).toBe('auto');
  });
});
