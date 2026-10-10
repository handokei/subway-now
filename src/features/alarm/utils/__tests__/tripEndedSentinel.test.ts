import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearTripEndedSentinel,
  getTripEndedSentinel,
  isTripEndedSentinelStale,
  resolveTripEndedSentinelVerdict,
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

  describe('setTripEndedSentinel (#2114 방안 C′ — JSON {endedAt, corrId})', () => {
    it('at + corrId를 JSON으로 직렬화해 sentinel 키에 저장', async () => {
      await setTripEndedSentinel(1_700_000_000_000, 'corr-abc');
      expect(setItemMock).toHaveBeenCalledWith(
        TRIP_ENDED_BY_BACKEND_AT_KEY,
        JSON.stringify({ endedAt: 1_700_000_000_000, corrId: 'corr-abc' }),
      );
    });

    it('corrId 미전달 시 null로 저장 (legacy 호출부 하위호환)', async () => {
      await setTripEndedSentinel(1_700_000_000_000);
      expect(setItemMock).toHaveBeenCalledWith(
        TRIP_ENDED_BY_BACKEND_AT_KEY,
        JSON.stringify({ endedAt: 1_700_000_000_000, corrId: null }),
      );
    });

    it('기본값은 Date.now()', async () => {
      const now = 1_710_000_000_000;
      const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
      try {
        await setTripEndedSentinel();
      } finally {
        spy.mockRestore();
      }
      expect(setItemMock).toHaveBeenCalledWith(
        TRIP_ENDED_BY_BACKEND_AT_KEY,
        JSON.stringify({ endedAt: now, corrId: null }),
      );
    });

    it('AsyncStorage 실패는 흡수 (graceful)', async () => {
      setItemMock.mockRejectedValueOnce(new Error('disk full'));
      await expect(setTripEndedSentinel(1)).resolves.toBeUndefined();
    });
  });

  describe('getTripEndedSentinel', () => {
    it('신규 JSON 스키마 파싱 — {endedAt, corrId} 그대로 반환', async () => {
      getItemMock.mockResolvedValueOnce(
        JSON.stringify({ endedAt: 1_700_000_000_000, corrId: 'corr-abc' }),
      );
      await expect(getTripEndedSentinel()).resolves.toEqual({
        endedAt: 1_700_000_000_000,
        corrId: 'corr-abc',
      });
    });

    it('신규 JSON 스키마 + corrId=null', async () => {
      getItemMock.mockResolvedValueOnce(
        JSON.stringify({ endedAt: 1_700_000_000_000, corrId: null }),
      );
      await expect(getTripEndedSentinel()).resolves.toEqual({
        endedAt: 1_700_000_000_000,
        corrId: null,
      });
    });

    it('legacy plain-number 문자열 — corrId=null로 fallback 파싱', async () => {
      getItemMock.mockResolvedValueOnce('1700000000000');
      await expect(getTripEndedSentinel()).resolves.toEqual({
        endedAt: 1_700_000_000_000,
        corrId: null,
      });
    });

    it('JSON이지만 endedAt 필드가 숫자가 아니면 legacy 숫자 파싱으로 재시도 후 실패 시 null', async () => {
      getItemMock.mockResolvedValueOnce(JSON.stringify({ endedAt: 'not-a-number' }));
      await expect(getTripEndedSentinel()).resolves.toBeNull();
    });

    it('JSON이지만 corrId 필드가 문자열이 아니면 null로 정규화', async () => {
      getItemMock.mockResolvedValueOnce(
        JSON.stringify({ endedAt: 1_700_000_000_000, corrId: 123 }),
      );
      await expect(getTripEndedSentinel()).resolves.toEqual({
        endedAt: 1_700_000_000_000,
        corrId: null,
      });
    });

    it('키 부재(null) → null', async () => {
      getItemMock.mockResolvedValueOnce(null);
      await expect(getTripEndedSentinel()).resolves.toBeNull();
    });

    it('NaN 문자열(legacy도 아님) → null', async () => {
      getItemMock.mockResolvedValueOnce('abc');
      await expect(getTripEndedSentinel()).resolves.toBeNull();
    });

    it('빈 문자열은 legacy Number("")=0으로 파싱 (corrId=null)', async () => {
      getItemMock.mockResolvedValueOnce('');
      await expect(getTripEndedSentinel()).resolves.toEqual({ endedAt: 0, corrId: null });
    });

    it('AsyncStorage 실패 시 null', async () => {
      getItemMock.mockRejectedValueOnce(new Error('boom'));
      await expect(getTripEndedSentinel()).resolves.toBeNull();
    });
  });

  it('clearTripEndedSentinel — removeItem 호출', async () => {
    await clearTripEndedSentinel();
    expect(removeItemMock).toHaveBeenCalledWith(TRIP_ENDED_BY_BACKEND_AT_KEY);
  });

  it('clearTripEndedSentinel — 실패는 흡수', async () => {
    removeItemMock.mockRejectedValueOnce(new Error('boom'));
    await expect(clearTripEndedSentinel()).resolves.toBeUndefined();
  });

  describe('isTripEndedSentinelStale (#2114 방안 A)', () => {
    it('tripStartedAt이 sentinelAt보다 나중이면 stale=true', () => {
      expect(isTripEndedSentinelStale(1_000, 2_000)).toBe(true);
    });

    it('tripStartedAt이 sentinelAt과 같으면 stale=false', () => {
      expect(isTripEndedSentinelStale(1_000, 1_000)).toBe(false);
    });

    it('tripStartedAt이 sentinelAt보다 이전이면 stale=false', () => {
      expect(isTripEndedSentinelStale(2_000, 1_000)).toBe(false);
    });

    it('tripStartedAt이 null이면 stale=false (활성 trip 없음)', () => {
      expect(isTripEndedSentinelStale(1_000, null)).toBe(false);
    });
  });

  describe('resolveTripEndedSentinelVerdict (#2114 방안 C′ + A fallback)', () => {
    it('corrId 둘 다 non-null + 불일치 → stale (timestamp 무관)', () => {
      // timestamp만 보면 fresh로 보일 상황(tripStartedAt < sentinelAt)이어도 corrId mismatch면 stale.
      const verdict = resolveTripEndedSentinelVerdict(
        { endedAt: 2_000, corrId: 'corr-old' },
        1_000,
        'corr-new',
      );
      expect(verdict).toBe('stale');
    });

    it('corrId 둘 다 non-null + 일치 → fresh (timestamp 무관)', () => {
      // timestamp만 보면 stale로 보일 상황(tripStartedAt > sentinelAt)이어도 corrId 일치면 fresh.
      const verdict = resolveTripEndedSentinelVerdict(
        { endedAt: 1_000, corrId: 'corr-same' },
        2_000,
        'corr-same',
      );
      expect(verdict).toBe('fresh');
    });

    it('sentinel.corrId=null (legacy) → timestamp fallback (stale)', () => {
      const verdict = resolveTripEndedSentinelVerdict(
        { endedAt: 1_000, corrId: null },
        2_000,
        'corr-new',
      );
      expect(verdict).toBe('stale');
    });

    it('sentinel.corrId=null (legacy) → timestamp fallback (fresh)', () => {
      const verdict = resolveTripEndedSentinelVerdict(
        { endedAt: 2_000, corrId: null },
        1_000,
        'corr-new',
      );
      expect(verdict).toBe('fresh');
    });

    it('currentCorrId=null(sync cache 미수화) → timestamp fallback (stale)', () => {
      const verdict = resolveTripEndedSentinelVerdict(
        { endedAt: 1_000, corrId: 'corr-old' },
        2_000,
        null,
      );
      expect(verdict).toBe('stale');
    });

    it('currentCorrId=null(sync cache 미수화) → timestamp fallback (fresh)', () => {
      const verdict = resolveTripEndedSentinelVerdict(
        { endedAt: 2_000, corrId: 'corr-old' },
        1_000,
        null,
      );
      expect(verdict).toBe('fresh');
    });

    it('둘 다 null → timestamp fallback (tripStartedAt null → fresh)', () => {
      const verdict = resolveTripEndedSentinelVerdict(
        { endedAt: 1_000, corrId: null },
        null,
        null,
      );
      expect(verdict).toBe('fresh');
    });
  });
});
