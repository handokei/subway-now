/**
 * #3191 PR-0 — BG last fix 레코드(BG_LAST_FIX_KEY)에 acc/speed를 싣고 읽는다.
 * 기존 레코드(acc/speed 없음)는 그대로 읽혀야 한다(jump gate 입력 lat/lng/timestamp 불변).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { readBgLastFix } from '../bgLastFix';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const getItem = AsyncStorage.getItem as jest.Mock;

describe('readBgLastFix (#3191 PR-0)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('키 부재 → null', async () => {
    getItem.mockResolvedValueOnce(null);
    expect(await readBgLastFix()).toBeNull();
  });

  it('acc/speed 포함 레코드를 그대로 돌려준다', async () => {
    getItem.mockResolvedValueOnce(
      JSON.stringify({ lat: 37.5, lng: 127, timestamp: 1000, acc: 12, speed: 0.2 }),
    );
    expect(await readBgLastFix()).toEqual({ lat: 37.5, lng: 127, timestamp: 1000, acc: 12, speed: 0.2 });
  });

  it('구 레코드(acc/speed 없음)는 acc/speed=null로 읽힌다', async () => {
    getItem.mockResolvedValueOnce(JSON.stringify({ lat: 37.5, lng: 127, timestamp: 1000 }));
    expect(await readBgLastFix()).toEqual({ lat: 37.5, lng: 127, timestamp: 1000, acc: null, speed: null });
  });

  it('acc/speed가 숫자가 아니면 null로 정규화', async () => {
    getItem.mockResolvedValueOnce(
      JSON.stringify({ lat: 37.5, lng: 127, timestamp: 1000, acc: 'x', speed: null }),
    );
    expect(await readBgLastFix()).toEqual({ lat: 37.5, lng: 127, timestamp: 1000, acc: null, speed: null });
  });

  it('형식 불일치 / 손상 JSON / 예외 → null', async () => {
    getItem.mockResolvedValueOnce(JSON.stringify({ foo: 'bar' }));
    expect(await readBgLastFix()).toBeNull();
    getItem.mockResolvedValueOnce('not-json');
    expect(await readBgLastFix()).toBeNull();
    getItem.mockRejectedValueOnce(new Error('io'));
    expect(await readBgLastFix()).toBeNull();
  });
});
