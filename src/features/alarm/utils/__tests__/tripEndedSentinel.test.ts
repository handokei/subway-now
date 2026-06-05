import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearTripEndedSentinel,
  getTripEndedSentinel,
  setTripEndedSentinel,
} from '../tripEndedSentinel';
import { TRIP_ENDED_BY_BACKEND_AT_KEY } from '../../../../shared/constants/storageKeys';

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

describe('tripEndedSentinel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setItemMock.mockResolvedValue(undefined);
    removeItemMock.mockResolvedValue(undefined);
  });

  it('setTripEndedSentinel — at 인자를 문자열로 직렬화해 sentinel 키에 저장', async () => {
    await setTripEndedSentinel(1_700_000_000_000);
    expect(setItemMock).toHaveBeenCalledWith(TRIP_ENDED_BY_BACKEND_AT_KEY, '1700000000000');
  });

  it('setTripEndedSentinel — 기본값은 Date.now()', async () => {
    const now = 1_710_000_000_000;
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await setTripEndedSentinel();
    } finally {
      spy.mockRestore();
    }
    expect(setItemMock).toHaveBeenCalledWith(TRIP_ENDED_BY_BACKEND_AT_KEY, String(now));
  });

  it('setTripEndedSentinel — AsyncStorage 실패는 흡수 (graceful)', async () => {
    setItemMock.mockRejectedValueOnce(new Error('disk full'));
    await expect(setTripEndedSentinel(1)).resolves.toBeUndefined();
  });

  it.each<[string, unknown, number | null]>([
    ['숫자 문자열', '1700000000000', 1_700_000_000_000],
    ['키 부재(null)', null, null],
    ['NaN 문자열', 'abc', null],
    ['빈 문자열은 Number("")=0이라 0 반환', '', 0],
  ])('getTripEndedSentinel — %s → %s', async (_label, raw, expected) => {
    getItemMock.mockResolvedValueOnce(raw);
    await expect(getTripEndedSentinel()).resolves.toBe(expected);
  });

  it('getTripEndedSentinel — AsyncStorage 실패 시 null', async () => {
    getItemMock.mockRejectedValueOnce(new Error('boom'));
    await expect(getTripEndedSentinel()).resolves.toBeNull();
  });

  it('clearTripEndedSentinel — removeItem 호출', async () => {
    await clearTripEndedSentinel();
    expect(removeItemMock).toHaveBeenCalledWith(TRIP_ENDED_BY_BACKEND_AT_KEY);
  });

  it('clearTripEndedSentinel — 실패는 흡수', async () => {
    removeItemMock.mockRejectedValueOnce(new Error('boom'));
    await expect(clearTripEndedSentinel()).resolves.toBeUndefined();
  });
});
