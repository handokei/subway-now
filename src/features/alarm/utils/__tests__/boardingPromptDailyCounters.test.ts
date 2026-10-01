import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  BOARDING_PROMPT_DAILY_COUNTERS_RETENTION_DAYS,
  clearBoardingPromptDailyCounters,
  getBoardingPromptDailyCounters,
  recordBoardingPromptDailyCount,
  _resetBoardingPromptDailyCountersForTests,
} from '../boardingPromptDailyCounters';
import { toLocalDayKey } from '../boardingPromptMonitor';
import { BOARDING_PROMPT_DAILY_COUNTERS_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const T0 = new Date('2026-06-12T10:00:00+09:00').getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

describe('boardingPromptDailyCounters (#2861 T2)', () => {
  beforeEach(async () => {
    _resetBoardingPromptDailyCountersForTests();
    await AsyncStorage.clear();
  });

  it('빈 상태에서 읽으면 빈 record', async () => {
    expect(await getBoardingPromptDailyCounters()).toEqual({});
  });

  it('displayed 1건 기록 — responded는 증가하지 않는다', async () => {
    await recordBoardingPromptDailyCount('displayed', T0);
    const counters = await getBoardingPromptDailyCounters();
    expect(counters[toLocalDayKey(T0)]).toEqual({
      displayed: 1,
      responded: 0,
      boarded: 0,
      dismissed: 0,
    });
  });

  it.each<['boarded' | 'dismissed']>([['boarded'], ['dismissed']])(
    '%s 기록 — responded도 함께 +1',
    async (bucket) => {
      await recordBoardingPromptDailyCount(bucket, T0);
      const counters = await getBoardingPromptDailyCounters();
      expect(counters[toLocalDayKey(T0)]).toEqual({
        displayed: 0,
        responded: 1,
        boarded: bucket === 'boarded' ? 1 : 0,
        dismissed: bucket === 'dismissed' ? 1 : 0,
      });
    },
  );

  it('같은 날 여러 건 누적된다', async () => {
    await recordBoardingPromptDailyCount('displayed', T0);
    await recordBoardingPromptDailyCount('displayed', T0 + 1000);
    await recordBoardingPromptDailyCount('boarded', T0 + 2000);
    const counters = await getBoardingPromptDailyCounters();
    expect(counters[toLocalDayKey(T0)]).toEqual({
      displayed: 2,
      responded: 1,
      boarded: 1,
      dismissed: 0,
    });
  });

  it('다른 날짜는 별도 bucket으로 적재된다', async () => {
    await recordBoardingPromptDailyCount('displayed', T0);
    await recordBoardingPromptDailyCount('displayed', T0 + DAY_MS);
    const counters = await getBoardingPromptDailyCounters();
    expect(Object.keys(counters)).toHaveLength(2);
    expect(counters[toLocalDayKey(T0)].displayed).toBe(1);
    expect(counters[toLocalDayKey(T0 + DAY_MS)].displayed).toBe(1);
  });

  it(
    `#2861 (T2) — 링 회전(가정: alarmLog 200-cap가 수 분 내 회전)과 무관하게 ` +
      `${BOARDING_PROMPT_DAILY_COUNTERS_RETENTION_DAYS}일 이내 일자는 보존된다`,
    async () => {
      // 과거 일자에 기록.
      await recordBoardingPromptDailyCount('displayed', T0);
      // 많은 시간이 흘러도(링이라면 이미 여러 번 회전했을 시간) retention 이내면 살아있다.
      const laterButWithinRetention =
        T0 + (BOARDING_PROMPT_DAILY_COUNTERS_RETENTION_DAYS - 1) * DAY_MS;
      await recordBoardingPromptDailyCount('displayed', laterButWithinRetention);
      const counters = await getBoardingPromptDailyCounters();
      expect(counters[toLocalDayKey(T0)]).toBeDefined();
      expect(counters[toLocalDayKey(T0)].displayed).toBe(1);
    },
  );

  it(
    `retention(${BOARDING_PROMPT_DAILY_COUNTERS_RETENTION_DAYS}일) 초과 날짜는 다음 write 시 정리된다`,
    async () => {
      await recordBoardingPromptDailyCount('displayed', T0);
      const beyondRetention =
        T0 + (BOARDING_PROMPT_DAILY_COUNTERS_RETENTION_DAYS + 1) * DAY_MS;
      await recordBoardingPromptDailyCount('displayed', beyondRetention);
      const counters = await getBoardingPromptDailyCounters();
      expect(counters[toLocalDayKey(T0)]).toBeUndefined();
      expect(counters[toLocalDayKey(beyondRetention)]).toBeDefined();
    },
  );

  it('손상된 JSON은 graceful 무시 (빈 record로 시작)', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('not-json{{{');
    expect(await getBoardingPromptDailyCounters()).toEqual({});
  });

  it('비-object JSON(배열)은 graceful 무시', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('[1,2,3]');
    expect(await getBoardingPromptDailyCounters()).toEqual({});
  });

  it('AsyncStorage.setItem 실패해도 throw하지 않는다 (graceful)', async () => {
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
    await expect(recordBoardingPromptDailyCount('displayed', T0)).resolves.toBeUndefined();
  });

  it('clearBoardingPromptDailyCounters가 전체 키를 제거한다', async () => {
    await recordBoardingPromptDailyCount('displayed', T0);
    await clearBoardingPromptDailyCounters();
    expect(await getBoardingPromptDailyCounters()).toEqual({});
  });

  it('clearBoardingPromptDailyCounters 실패해도 throw하지 않는다', async () => {
    (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('fail'));
    await expect(clearBoardingPromptDailyCounters()).resolves.toBeUndefined();
  });

  it('write race — 동시 호출이 둘 다 반영된다 (직렬화 큐)', async () => {
    await Promise.all([
      recordBoardingPromptDailyCount('displayed', T0),
      recordBoardingPromptDailyCount('displayed', T0 + 1),
      recordBoardingPromptDailyCount('boarded', T0 + 2),
    ]);
    const counters = await getBoardingPromptDailyCounters();
    expect(counters[toLocalDayKey(T0)]).toEqual({
      displayed: 2,
      responded: 1,
      boarded: 1,
      dismissed: 0,
    });
  });

  it('BOARDING_PROMPT_DAILY_COUNTERS_KEY로 저장된다', async () => {
    await recordBoardingPromptDailyCount('displayed', T0);
    const raw = await AsyncStorage.getItem(BOARDING_PROMPT_DAILY_COUNTERS_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed[toLocalDayKey(T0)].displayed).toBe(1);
  });
});
