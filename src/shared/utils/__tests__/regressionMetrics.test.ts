/**
 * regressionMetrics: 인메모리/AsyncStorage 카운터 + backend POST /telemetry/regression flush.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  KNOWN_REGRESSION_IDS,
  __waitForPendingPersists,
  flushRegressionCounters,
  getRegressionCountsSnapshot,
  recordRegression,
  type RegressionId,
} from '../regressionMetrics';

jest.mock('../logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const ORIGINAL_FETCH = globalThis.fetch;
const FIXED_NOW = 1_700_000_000_000;
const STORAGE_PREFIX = '@regression_counts:';

const allIds = KNOWN_REGRESSION_IDS;

async function clearAllStorage(): Promise<void> {
  await AsyncStorage.clear();
}

/**
 * recordRegression의 fire-and-forget persist 체인이 settle될 때까지 대기.
 */
async function flushPersistQueue(): Promise<void> {
  await __waitForPendingPersists();
}

async function resetModuleCounters(): Promise<void> {
  // 모듈 스코프 메모리 카운터는 flush 200 응답으로만 reset된다.
  // 테스트 격리를 위해 매번 빈 flush로 reset.
  process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
  (globalThis.fetch as jest.Mock | undefined)?.mockClear?.();
  globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
  // 카운트가 모두 0이면 fetch 호출 없이 since만 갱신되므로 직접 flush해도 reset 효과가 없음.
  // → 메모리 카운터에 1 넣고 flush로 reset.
  recordRegression(allIds[0]);
  await flushPersistQueue();
  await flushRegressionCounters('reset-token');
  await AsyncStorage.clear();
  delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
}

describe('regressionMetrics', () => {
  const ORIGINAL_DATE_NOW = Date.now;

  beforeEach(async () => {
    await clearAllStorage();
    await resetModuleCounters();
    globalThis.fetch = jest.fn();
    Date.now = () => FIXED_NOW;
  });

  afterEach(async () => {
    // 이전 테스트의 fire-and-forget persist 체인이 다음 테스트의 beforeEach clearAllStorage
    // 이후에 setItem을 완료하는 race를 방지한다.
    await flushPersistQueue();
    globalThis.fetch = ORIGINAL_FETCH;
    Date.now = ORIGINAL_DATE_NOW;
    delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
    // jest.restoreAllMocks()는 AsyncStorage mock(jest.fn()로 구성)의 implementation까지
    // 리셋해 다음 테스트의 setItem이 no-op이 되는 사이드이펙트가 있으므로 사용하지 않는다.
  });

  describe('KNOWN_REGRESSION_IDS', () => {
    it('단일 SSOT 배열에 예상 id가 모두 포함된다', () => {
      expect(KNOWN_REGRESSION_IDS).toEqual(['8', '10', '11', '12']);
    });
  });

  describe('recordRegression', () => {
    it('메모리 카운터를 즉시 +1 한다', () => {
      const id: RegressionId = '8';
      const before = getRegressionCountsSnapshot()[id];
      recordRegression(id);
      expect(getRegressionCountsSnapshot()[id]).toBe(before + 1);
    });

    it('stationName ctx 제공 시에도 정상 동작한다', () => {
      const id: RegressionId = '10';
      recordRegression(id, { stationName: '강남' });
      expect(getRegressionCountsSnapshot()[id]).toBeGreaterThan(0);
    });

    it('AsyncStorage에도 누적된다 (fire-and-forget)', async () => {
      const id: RegressionId = '11';
      recordRegression(id);
      recordRegression(id);
      await flushPersistQueue();
      const raw = await AsyncStorage.getItem(`${STORAGE_PREFIX}${id}`);
      expect(raw).toBe('2');
    });

    it('AsyncStorage 쓰기 실패해도 throw 하지 않는다', async () => {
      const id: RegressionId = '12';
      const originalSetItem = AsyncStorage.setItem;
      // 직접 교체 — spyOn은 mockRestore가 jest.fn() 모듈 mock의 implementation을 잃게 만들어
      // 다음 테스트의 setItem이 no-op이 되는 사이드이펙트가 있어 회피한다.
      AsyncStorage.setItem = jest.fn().mockRejectedValueOnce(new Error('disk'));
      try {
        expect(() => recordRegression(id)).not.toThrow();
        await flushPersistQueue();
      } finally {
        AsyncStorage.setItem = originalSetItem;
      }
    });

    it('AsyncStorage에 손상된 값이 있으면 0으로 취급해 1로 덮어쓴다', async () => {
      const id: RegressionId = '8';
      await AsyncStorage.setItem(`${STORAGE_PREFIX}${id}`, 'not-a-number');
      recordRegression(id);
      await flushPersistQueue();
      const raw = await AsyncStorage.getItem(`${STORAGE_PREFIX}${id}`);
      expect(raw).toBe('1');
    });

    it('AsyncStorage 음수 값은 0으로 취급한다', async () => {
      const id: RegressionId = '10';
      await AsyncStorage.setItem(`${STORAGE_PREFIX}${id}`, '-5');
      recordRegression(id);
      await flushPersistQueue();
      const raw = await AsyncStorage.getItem(`${STORAGE_PREFIX}${id}`);
      expect(raw).toBe('1');
    });
  });

  describe('getRegressionCountsSnapshot', () => {
    it('현재 메모리 스냅샷의 복사본을 반환하며 외부 변경에 영향받지 않는다', () => {
      const id: RegressionId = '11';
      recordRegression(id);
      const snap1 = getRegressionCountsSnapshot();
      snap1[id] = 9999;
      const snap2 = getRegressionCountsSnapshot();
      expect(snap2[id]).not.toBe(9999);
    });
  });

  describe('flushRegressionCounters', () => {
    it('URL 미설정 시 fetch 호출 없이 graceful return', async () => {
      recordRegression('8');
      await flushRegressionCounters('tok');
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('빈 token 시 fetch 호출 없이 graceful return', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
      recordRegression('8');
      await flushRegressionCounters('');
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('합계 0이면 fetch 호출 없이 since만 갱신한다', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
      await flushRegressionCounters('tok');
      expect(globalThis.fetch).not.toHaveBeenCalled();
      const since = await AsyncStorage.getItem(`${STORAGE_PREFIX}__since`);
      expect(since).toBe(String(FIXED_NOW));
    });

    it('카운트가 있으면 token/since/until/counts를 POST 한다', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
      (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
      recordRegression('8');
      recordRegression('11');
      recordRegression('11');
      await flushPersistQueue();

      await flushRegressionCounters('tok');

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe('https://api.test/telemetry/regression');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body.token).toBe('tok');
      expect(body.since).toBe(0);
      expect(body.until).toBe(FIXED_NOW);
      // 메모리 + storage 합산: 메모리 1+2, storage 1+2 = 총 2+4.
      expect(body.counts['8']).toBe(2);
      expect(body.counts['11']).toBe(4);
      expect(body.counts['10']).toBe(0);
      expect(body.counts['12']).toBe(0);
    });

    it('200 응답 시 메모리/스토리지 카운터를 reset한다', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
      (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
      recordRegression('8');
      await flushPersistQueue();

      await flushRegressionCounters('tok');

      expect(getRegressionCountsSnapshot()['8']).toBe(0);
      const raw = await AsyncStorage.getItem(`${STORAGE_PREFIX}8`);
      expect(raw).toBeNull();
      const since = await AsyncStorage.getItem(`${STORAGE_PREFIX}__since`);
      expect(since).toBe(String(FIXED_NOW));
    });

    it('non-OK 응답 시 카운터를 유지한다 (다음 flush에서 재시도)', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
      (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });
      recordRegression('10');
      await flushPersistQueue();

      await flushRegressionCounters('tok');

      expect(getRegressionCountsSnapshot()['10']).toBeGreaterThan(0);
      const raw = await AsyncStorage.getItem(`${STORAGE_PREFIX}10`);
      expect(raw).toBe('1');
    });

    it('fetch throw 시 throw 없이 graceful return + 카운터 유지', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
      (globalThis.fetch as jest.Mock).mockRejectedValue(new Error('net'));
      recordRegression('12');
      await flushPersistQueue();

      await expect(flushRegressionCounters('tok')).resolves.toBeUndefined();
      const raw = await AsyncStorage.getItem(`${STORAGE_PREFIX}12`);
      expect(raw).toBe('1');
    });

    it('이전 since 값이 있으면 body에 포함된다', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
      (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
      await AsyncStorage.setItem(`${STORAGE_PREFIX}__since`, '1234567890');
      recordRegression('8');
      await flushPersistQueue();

      await flushRegressionCounters('tok');

      const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
      expect(JSON.parse(init.body).since).toBe(1234567890);
    });

    it('손상된 since 값(non-number)은 0으로 취급', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
      (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
      await AsyncStorage.setItem(`${STORAGE_PREFIX}__since`, 'bad');
      recordRegression('8');
      await flushPersistQueue();

      await flushRegressionCounters('tok');

      const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
      expect(JSON.parse(init.body).since).toBe(0);
    });

    it('try 블록 내 AsyncStorage 예외도 흡수한다', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
      const originalGetItem = AsyncStorage.getItem;
      AsyncStorage.getItem = jest.fn().mockRejectedValueOnce(new Error('disk'));
      try {
        await expect(flushRegressionCounters('tok')).resolves.toBeUndefined();
      } finally {
        AsyncStorage.getItem = originalGetItem;
      }
    });
  });
});
