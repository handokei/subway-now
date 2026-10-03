import AsyncStorage from '@react-native-async-storage/async-storage';
import { AsyncStorageAdapter } from '../AsyncStorageAdapter';

describe('AsyncStorageAdapter', () => {
  let adapter: AsyncStorageAdapter;

  beforeEach(() => {
    adapter = new AsyncStorageAdapter();
    (AsyncStorage.getItem as jest.Mock).mockReset();
    (AsyncStorage.setItem as jest.Mock).mockReset();
    (AsyncStorage.removeItem as jest.Mock).mockReset();
  });

  it('getItem은 AsyncStorage.getItem 값을 그대로 반환한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue('value');
    const result = await adapter.getItem('key');
    expect(AsyncStorage.getItem).toHaveBeenCalledWith('key');
    expect(result).toBe('value');
  });

  it('getItem은 키가 없으면 null을 반환한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    const result = await adapter.getItem('missing');
    expect(result).toBeNull();
  });

  it('setItem은 AsyncStorage.setItem에 key/value를 전달한다', async () => {
    (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
    await adapter.setItem('key', 'value');
    expect(AsyncStorage.setItem).toHaveBeenCalledWith('key', 'value');
  });

  it('removeItem은 AsyncStorage.removeItem을 호출한다', async () => {
    (AsyncStorage.removeItem as jest.Mock).mockResolvedValue(undefined);
    await adapter.removeItem('key');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('key');
  });
});
