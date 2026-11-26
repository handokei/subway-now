import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useMapMode } from '../useMapMode';
import { MAP_MODE_KEY } from '../../../../shared/constants/storageKeys';

function setOS(os: 'ios' | 'web') {
  (Platform as { OS: typeof Platform.OS }).OS = os;
}

beforeEach(async () => {
  await AsyncStorage.clear();
  setOS('ios');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useMapMode', () => {
  it('로드 전에는 지도 모드(기존 동작)', async () => {
    const { result } = renderHook(() => useMapMode());
    expect(result.current.mode).toBe('map');
    expect(result.current.loaded).toBe(false);
    await waitFor(() => expect(result.current.loaded).toBe(true));
  });

  it('저장값 없음 → 지도 모드', async () => {
    const { result } = renderHook(() => useMapMode());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.mode).toBe('map');
  });

  it('setMode → AsyncStorage에 저장', async () => {
    const { result } = renderHook(() => useMapMode());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.setMode('schematic'));
    expect(result.current.mode).toBe('schematic');
    await waitFor(async () => expect(await AsyncStorage.getItem(MAP_MODE_KEY)).toBe('schematic'));
  });

  it('저장된 노선도 모드를 복원한다(재시작)', async () => {
    await AsyncStorage.setItem(MAP_MODE_KEY, 'schematic');
    const { result } = renderHook(() => useMapMode());
    await waitFor(() => expect(result.current.mode).toBe('schematic'));
    expect(result.current.loaded).toBe(true);
  });

  it('로드 전에 사용자가 지도 모드로 전환했다면 저장값(노선도)이 덮지 않는다', async () => {
    await AsyncStorage.setItem(MAP_MODE_KEY, 'schematic');
    const { result } = renderHook(() => useMapMode());
    act(() => result.current.setMode('map'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.mode).toBe('map');
  });

  it('알 수 없는 저장값은 지도 모드', async () => {
    await AsyncStorage.setItem(MAP_MODE_KEY, 'garbage');
    const { result } = renderHook(() => useMapMode());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.mode).toBe('map');
  });

  it('읽기 실패해도 지도 모드로 loaded', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useMapMode());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.mode).toBe('map');
  });

  it('쓰기 실패해도 state는 바뀐다', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useMapMode());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.setMode('schematic'));
    expect(result.current.mode).toBe('schematic');
  });

  it('웹: 전환 불가(switchAvailable=false)이고 저장값이 노선도여도 지도 모드', async () => {
    setOS('web');
    await AsyncStorage.setItem(MAP_MODE_KEY, 'schematic');
    const { result } = renderHook(() => useMapMode());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.switchAvailable).toBe(false);
    expect(result.current.mode).toBe('map');
  });

  it('네이티브: switchAvailable=true', async () => {
    const { result } = renderHook(() => useMapMode());
    expect(result.current.switchAvailable).toBe(true);
    await waitFor(() => expect(result.current.loaded).toBe(true));
  });
});
