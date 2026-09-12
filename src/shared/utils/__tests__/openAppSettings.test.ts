import { Linking } from 'react-native';
import { openAppSettings } from '../openAppSettings';

describe('openAppSettings', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('Linking.openSettings를 호출한다', async () => {
    const spy = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);

    await openAppSettings();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('Linking.openSettings가 reject되어도 throw하지 않고 warn 로그를 남긴다', async () => {
    const failure = new Error('settings unavailable');
    jest.spyOn(Linking, 'openSettings').mockRejectedValue(failure);

    await expect(openAppSettings()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith('[OpenAppSettings]', 'openSettings failed', failure);
  });
});
