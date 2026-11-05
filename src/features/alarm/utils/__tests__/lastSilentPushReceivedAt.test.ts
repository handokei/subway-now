import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearLastSilentPushReceivedAt,
  getLastSilentPushReceivedAt,
  setLastSilentPushReceivedAt,
} from '../lastSilentPushReceivedAt';
import { LAST_SILENT_PUSH_RECEIVED_AT_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    setItem: jest.fn(),
    getItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

const setItemMock = AsyncStorage.setItem as jest.Mock;
const getItemMock = AsyncStorage.getItem as jest.Mock;
const removeItemMock = AsyncStorage.removeItem as jest.Mock;

describe('lastSilentPushReceivedAt (#2045 Signal 4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setItemMock.mockResolvedValue(undefined);
    removeItemMock.mockResolvedValue(undefined);
  });

  it('setLastSilentPushReceivedAt — at 인자를 문자열로 직렬화해 last-received 키에 저장', async () => {
    await setLastSilentPushReceivedAt(1_700_000_000_000);
    expect(setItemMock).toHaveBeenCalledWith(
      LAST_SILENT_PUSH_RECEIVED_AT_KEY,
      '1700000000000',
    );
  });

  it('setLastSilentPushReceivedAt — 기본값은 Date.now()', async () => {
    const now = 1_710_000_000_000;
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await setLastSilentPushReceivedAt();
    } finally {
      spy.mockRestore();
    }
    expect(setItemMock).toHaveBeenCalledWith(LAST_SILENT_PUSH_RECEIVED_AT_KEY, String(now));
  });

  it('setLastSilentPushReceivedAt — AsyncStorage 실패는 흡수 (graceful, 9h force-end backstop이 흡수)', async () => {
    setItemMock.mockRejectedValueOnce(new Error('disk full'));
    await expect(setLastSilentPushReceivedAt(1)).resolves.toBeUndefined();
  });

  it.each<[string, unknown, number | null]>([
    ['숫자 문자열', '1700000000000', 1_700_000_000_000],
    ['키 부재(null)', null, null],
    ['NaN 문자열', 'abc', null],
    ['빈 문자열은 Number("")=0이라 0 반환', '', 0],
  ])('getLastSilentPushReceivedAt — %s → %s', async (_label, raw, expected) => {
    getItemMock.mockResolvedValueOnce(raw);
    await expect(getLastSilentPushReceivedAt()).resolves.toBe(expected);
  });

  it('getLastSilentPushReceivedAt — AsyncStorage 실패 시 null', async () => {
    getItemMock.mockRejectedValueOnce(new Error('boom'));
    await expect(getLastSilentPushReceivedAt()).resolves.toBeNull();
  });

  it('clearLastSilentPushReceivedAt — removeItem 호출', async () => {
    await clearLastSilentPushReceivedAt();
    expect(removeItemMock).toHaveBeenCalledWith(LAST_SILENT_PUSH_RECEIVED_AT_KEY);
  });

  it('clearLastSilentPushReceivedAt — 실패는 흡수', async () => {
    removeItemMock.mockRejectedValueOnce(new Error('boom'));
    await expect(clearLastSilentPushReceivedAt()).resolves.toBeUndefined();
  });
});
