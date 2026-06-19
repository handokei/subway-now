import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  uploadSignalDump,
  flushSignalDumpOutbox,
} from '../signalDumpBackend';
import {
  RAW_SIGNAL_OUTBOX_KEY,
  LAST_UPLOADED_SIGNAL_DUMP_CORR_ID_KEY,
} from '../../../../shared/constants/storageKeys';
import type { RawSignalEntry } from '../../../observability/utils/rawSignalBuffer';

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const ORIGINAL_FETCH = globalThis.fetch;
const TEST_URL = 'https://api.test/';
const CORR_ID = '1700000000000-deadbeef';

function entry(ts: number, kind: RawSignalEntry['kind'] = 'cycle'): RawSignalEntry {
  return {
    ts,
    corrId: CORR_ID,
    kind,
    gps: null,
    motion: null,
    subsurface: null,
    arvlCd: null,
    line: null,
    dir: null,
    arcIdx: null,
    arcProgress: null,
    stationId: null,
    source: null,
    confidence: null,
  };
}

function configureBackend(fetchResult?: { ok: boolean; status?: number } | Error): void {
  process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = TEST_URL;
  if (fetchResult instanceof Error) {
    (globalThis.fetch as jest.Mock).mockRejectedValue(fetchResult);
  } else if (fetchResult) {
    (globalThis.fetch as jest.Mock).mockResolvedValue(fetchResult);
  }
}

async function seedOutbox(
  overrides: Partial<{ corrId: string; token: string; entries: RawSignalEntry[] }> = {},
): Promise<void> {
  await AsyncStorage.setItem(
    RAW_SIGNAL_OUTBOX_KEY,
    JSON.stringify({
      corrId: CORR_ID,
      token: 'tok',
      entries: [entry(1)],
      ...overrides,
    }),
  );
}

describe('uploadSignalDump', () => {
  beforeEach(async () => {
    delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
    globalThis.fetch = jest.fn();
    await AsyncStorage.clear();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('URL 미설정이면 skipped=true (no-url)', async () => {
    const result = await uploadSignalDump('1-00000000', 'tok', [entry(1)]);
    expect(result).toEqual({ ok: false, skipped: true, skipReason: 'no-url' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('빈 token이면 skipped=true (no-token)', async () => {
    configureBackend();
    const result = await uploadSignalDump('1-00000000', '', [entry(1)]);
    expect(result.skipReason).toBe('no-token');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('빈 entries이면 skipped=true (no-entries)', async () => {
    configureBackend();
    const result = await uploadSignalDump('1-00000000', 'tok', []);
    expect(result.skipReason).toBe('no-entries');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('성공 시 outbox 비우고 마지막 corrId 기록', async () => {
    configureBackend({ ok: true, status: 200 });

    const result = await uploadSignalDump(CORR_ID, 'tok', [entry(1)]);
    expect(result).toEqual({ ok: true, status: 200 });

    expect(await AsyncStorage.getItem(RAW_SIGNAL_OUTBOX_KEY)).toBeNull();
    expect(
      await AsyncStorage.getItem(LAST_UPLOADED_SIGNAL_DUMP_CORR_ID_KEY),
    ).toBe(CORR_ID);

    const [url, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(`${TEST_URL}signals/dump`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.corrId).toBe(CORR_ID);
    expect(body.token).toBe('tok');
    expect(body.entries.length).toBe(1);
  });

  it('실패 시 outbox에 남고 last corrId 미기록', async () => {
    configureBackend({ ok: false, status: 500 });

    const result = await uploadSignalDump(CORR_ID, 'tok', [entry(1)]);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);

    const outbox = await AsyncStorage.getItem(RAW_SIGNAL_OUTBOX_KEY);
    expect(outbox).not.toBeNull();
    const parsed = JSON.parse(outbox ?? '');
    expect(parsed.corrId).toBe(CORR_ID);
    expect(parsed.entries.length).toBe(1);
    expect(
      await AsyncStorage.getItem(LAST_UPLOADED_SIGNAL_DUMP_CORR_ID_KEY),
    ).toBeNull();
  });

  it('fetch throw 시 ok=false, outbox 보존', async () => {
    configureBackend(new Error('network'));

    const result = await uploadSignalDump(CORR_ID, 'tok', [entry(1)]);
    expect(result).toEqual({ ok: false });
    expect(await AsyncStorage.getItem(RAW_SIGNAL_OUTBOX_KEY)).not.toBeNull();
  });

  it('같은 corrId 재시도 skip (duplicate)', async () => {
    configureBackend();
    await AsyncStorage.setItem(LAST_UPLOADED_SIGNAL_DUMP_CORR_ID_KEY, CORR_ID);

    const result = await uploadSignalDump(CORR_ID, 'tok', [entry(1)]);
    expect(result.skipReason).toBe('duplicate');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('flushSignalDumpOutbox', () => {
  beforeEach(async () => {
    delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
    globalThis.fetch = jest.fn();
    await AsyncStorage.clear();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('URL 미설정이면 skip', async () => {
    const result = await flushSignalDumpOutbox();
    expect(result.skipReason).toBe('no-url');
  });

  it('outbox 비어있으면 skip (no-entries)', async () => {
    configureBackend();
    const result = await flushSignalDumpOutbox();
    expect(result.skipReason).toBe('no-entries');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['JSON 손상', 'not-json{'],
    ['shape 부적합', JSON.stringify({ corrId: 1 })],
  ])('outbox %s이면 skip (no-entries)', async (_label, payload) => {
    configureBackend();
    await AsyncStorage.setItem(RAW_SIGNAL_OUTBOX_KEY, payload);
    const result = await flushSignalDumpOutbox();
    expect(result.skipReason).toBe('no-entries');
  });

  it('outbox.corrId가 이미 업로드된 corrId면 outbox만 정리 (duplicate)', async () => {
    configureBackend();
    await seedOutbox({ corrId: 'c1' });
    await AsyncStorage.setItem(LAST_UPLOADED_SIGNAL_DUMP_CORR_ID_KEY, 'c1');

    const result = await flushSignalDumpOutbox();
    expect(result.skipReason).toBe('duplicate');
    expect(await AsyncStorage.getItem(RAW_SIGNAL_OUTBOX_KEY)).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('outbox flush 성공 시 outbox 정리 + last corrId 기록', async () => {
    configureBackend({ ok: true, status: 200 });
    await seedOutbox();

    const result = await flushSignalDumpOutbox();
    expect(result.ok).toBe(true);
    expect(await AsyncStorage.getItem(RAW_SIGNAL_OUTBOX_KEY)).toBeNull();
    expect(
      await AsyncStorage.getItem(LAST_UPLOADED_SIGNAL_DUMP_CORR_ID_KEY),
    ).toBe(CORR_ID);
  });

  it.each([
    ['실패 응답', { ok: false, status: 500 } as { ok: boolean; status?: number }],
    ['fetch throw', new Error('network')],
  ])('outbox flush %s 시 outbox 보존', async (_label, fetchResult) => {
    configureBackend(fetchResult);
    await seedOutbox();

    const result = await flushSignalDumpOutbox();
    expect(result.ok).toBe(false);
    expect(await AsyncStorage.getItem(RAW_SIGNAL_OUTBOX_KEY)).not.toBeNull();
  });
});

describe('storage failure handling (graceful)', () => {
  beforeEach(async () => {
    delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
    globalThis.fetch = jest.fn();
    await AsyncStorage.clear();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    jest.restoreAllMocks();
  });

  type StorageMethod = 'getItem' | 'setItem' | 'removeItem';

  async function expectUploadOkWithFailingStorage(
    method: StorageMethod,
    keyMatcher: (key: string) => boolean,
  ): Promise<void> {
    configureBackend({ ok: true, status: 200 });
    const originalGetItem = AsyncStorage.getItem.bind(AsyncStorage);
    const spy = jest
      .spyOn(AsyncStorage, method)
      .mockImplementation((async (key: string) => {
        if (keyMatcher(key)) {
          throw new Error('storage fail');
        }
        if (method === 'getItem') {
          return originalGetItem(key);
        }
        return undefined;
      }) as never);

    const result = await uploadSignalDump(CORR_ID, 'tok', [entry(1)]);
    expect(result.ok).toBe(true);
    spy.mockRestore();
  }

  it.each<[string, StorageMethod, (key: string) => boolean]>([
    [
      'getItem(LAST_UPLOADED) throw → null fallback, upload 정상 진행',
      'getItem',
      (key) => key === LAST_UPLOADED_SIGNAL_DUMP_CORR_ID_KEY,
    ],
    [
      'setItem(LAST_UPLOADED) throw 시 ok=true 유지',
      'setItem',
      (key) => key === LAST_UPLOADED_SIGNAL_DUMP_CORR_ID_KEY,
    ],
    [
      'setItem(outbox) throw 시 upload는 계속 진행',
      'setItem',
      (key) => key === RAW_SIGNAL_OUTBOX_KEY,
    ],
    [
      'removeItem(outbox) throw 시 ok=true 유지',
      'removeItem',
      () => true,
    ],
  ])('AsyncStorage.%s', async (_label, method, matcher) => {
    await expectUploadOkWithFailingStorage(method, matcher);
  });
});
