import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocaleStore } from '../useLocaleStore';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('useLocaleStore', () => {
  beforeEach(() => {
    useLocaleStore.setState({ localePreference: 'auto' });
    jest.clearAllMocks();
  });

  it('초기 localePreference는 auto이다', () => {
    expect(useLocaleStore.getState().localePreference).toBe('auto');
  });

  it('setLocalePreference: 상태를 업데이트하고 AsyncStorage에 저장한다', async () => {
    await useLocaleStore.getState().setLocalePreference('en');
    expect(useLocaleStore.getState().localePreference).toBe('en');
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:locale-preference',
      JSON.stringify('en'),
    );
  });

  it('loadLocalePreference: AsyncStorage에서 ko를 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify('ko'));
    await useLocaleStore.getState().loadLocalePreference();
    expect(useLocaleStore.getState().localePreference).toBe('ko');
  });

  it.each([
    ['invalid value', JSON.stringify('jp')],
    ['null', null],
    ['storage error', new Error('storage error')],
  ])('loadLocalePreference: %s이면 auto 유지', async (_label, raw) => {
    if (raw instanceof Error) {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(raw);
    } else {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(raw);
    }
    useLocaleStore.setState({ localePreference: 'auto' });
    await useLocaleStore.getState().loadLocalePreference();
    expect(useLocaleStore.getState().localePreference).toBe('auto');
  });
});
