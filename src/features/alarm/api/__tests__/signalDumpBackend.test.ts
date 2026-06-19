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

function entry(ts: number, kind: RawSignalEntry['kind'] = 'cycle'): RawSignalEntry {
  return {
    ts,
    corrId: '1700000000000-deadbeef',
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
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    const result = await uploadSignalDump('1-00000000', '', [entry(1)]);
    expect(result.skipReason).toBe('no-token');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('빈 entries이면 skipped=true (no-entries)', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    const result = await uploadSignalDump('1-00000000', 'tok', []);
    expect(result.skipReason).toBe('no-entries');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('성공 시 outbox 비우고 마지막 corrId 기록', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

    const result = await uploadSignalDump('1700000000000-deadbeef', 'tok', [entry(1)]);
    expect(result).toEqual({ ok: true, status: 200 });

    expect(await AsyncStorage.getItem(RAW_SIGNAL_OUTBOX_KEY)).toBeNull();
    expect(
      await AsyncStorage.getItem(LAST_UPLOADED_SIGNAL_DUMP_CORR_ID_KEY),
    ).toBe('1700000000000-deadbeef');

    const [url, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.test/signals/dump');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.corrId).toBe('1700000000000-deadbeef');
    expect(body.token).toBe('tok');
    expect(body.entries.length).toBe(1);
  });

  it('실패 시 outbox에 남고 last corrId 미기록', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });

    const result = await uploadSignalDump('1700000000000-deadbeef', 'tok', [entry(1)]);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);

    const outbox = await AsyncStorage.getItem(RAW_SIGNAL_OUTBOX_KEY);
    expect(outbox).not.toBeNull();
    const parsed = JSON.parse(outbox!);
    expect(parsed.corrId).toBe('1700000000000-deadbeef');
    expect(parsed.entries.length).toBe(1);
    expect(
      await AsyncStorage.getItem(LAST_UPLOADED_SIGNAL_DUMP_CORR_ID_KEY),
    ).toBeNull();
  });

  it('fetch throw 시 ok=false, outbox 보존', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    (globalThis.fetch as jest.Mock).mockRejectedValue(new Error('network'));

    const result = await uploadSignalDump('1700000000000-deadbeef', 'tok', [entry(1)]);
    expect(result).toEqual({ ok: false });
    expect(await AsyncStorage.getItem(RAW_SIGNAL_OUTBOX_KEY)).not.toBeNull();
  });

  it('같은 corrId 재시도 skip (duplicate)', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    await AsyncStorage.setItem(
      LAST_UPLOADED_SIGNAL_DUMP_CORR_ID_KEY,
      '1700000000000-deadbeef',
    );

    const result = await uploadSignalDump(
      '1700000000000-deadbeef',
      'tok',
      [entry(1)],
    );
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
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    const result = await flushSignalDumpOutbox();
    expect(result.skipReason).toBe('no-entries');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('outbox JSON 손상이면 skip (no-entries)', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    await AsyncStorage.setItem(RAW_SIGNAL_OUTBOX_KEY, 'not-json{');
    const result = await flushSignalDumpOutbox();
    expect(result.skipReason).toBe('no-entries');
  });

  it('outbox shape 부적합도 skip', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    await AsyncStorage.setItem(RAW_SIGNAL_OUTBOX_KEY, JSON.stringify({ corrId: 1 }));
    const result = await flushSignalDumpOutbox();
    expect(result.skipReason).toBe('no-entries');
  });

  it('outbox.corrId가 이미 업로드된 corrId면 outbox만 정리 (duplicate)', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    await AsyncStorage.setItem(
      RAW_SIGNAL_OUTBOX_KEY,
      JSON.stringify({ corrId: 'c1', token: 'tok', entries: [entry(1)] }),
    );
    await AsyncStorage.setItem(LAST_UPLOADED_SIGNAL_DUMP_CORR_ID_KEY, 'c1');

    const result = await flushSignalDumpOutbox();
    expect(result.skipReason).toBe('duplicate');
    expect(await AsyncStorage.getItem(RAW_SIGNAL_OUTBOX_KEY)).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('outbox flush 성공 시 outbox 정리 + last corrId 기록', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    await AsyncStorage.setItem(
      RAW_SIGNAL_OUTBOX_KEY,
      JSON.stringify({
        corrId: '1700000000000-deadbeef',
        token: 'tok',
        entries: [entry(1)],
      }),
    );

    const result = await flushSignalDumpOutbox();
    expect(result.ok).toBe(true);
    expect(await AsyncStorage.getItem(RAW_SIGNAL_OUTBOX_KEY)).toBeNull();
    expect(
      await AsyncStorage.getItem(LAST_UPLOADED_SIGNAL_DUMP_CORR_ID_KEY),
    ).toBe('1700000000000-deadbeef');
  });

  it('outbox flush 실패 시 outbox 보존', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });
    await AsyncStorage.setItem(
      RAW_SIGNAL_OUTBOX_KEY,
      JSON.stringify({
        corrId: '1700000000000-deadbeef',
        token: 'tok',
        entries: [entry(1)],
      }),
    );

    const result = await flushSignalDumpOutbox();
    expect(result.ok).toBe(false);
    expect(await AsyncStorage.getItem(RAW_SIGNAL_OUTBOX_KEY)).not.toBeNull();
  });

  it('outbox flush fetch throw 시에도 outbox 보존', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    (globalThis.fetch as jest.Mock).mockRejectedValue(new Error('network'));
    await AsyncStorage.setItem(
      RAW_SIGNAL_OUTBOX_KEY,
      JSON.stringify({
        corrId: '1700000000000-deadbeef',
        token: 'tok',
        entries: [entry(1)],
      }),
    );

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

  it('AsyncStorage.getItem(LAST_UPLOADED) throw → null fallback, upload 정상 진행', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

    const original = AsyncStorage.getItem;
    const spy = jest
      .spyOn(AsyncStorage, 'getItem')
      .mockImplementation(async (key: string) => {
        if (key === LAST_UPLOADED_SIGNAL_DUMP_CORR_ID_KEY) {
          throw new Error('storage fail');
        }
        return original(key);
      });

    const result = await uploadSignalDump(
      '1700000000000-deadbeef',
      'tok',
      [entry(1)],
    );
    expect(result.ok).toBe(true);
    spy.mockRestore();
  });

  it('AsyncStorage.setItem(LAST_UPLOADED) throw 시 ok=true 유지', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

    const spy = jest
      .spyOn(AsyncStorage, 'setItem')
      .mockImplementation(async (key: string) => {
        if (key === LAST_UPLOADED_SIGNAL_DUMP_CORR_ID_KEY) {
          throw new Error('storage fail');
        }
      });

    const result = await uploadSignalDump(
      '1700000000000-deadbeef',
      'tok',
      [entry(1)],
    );
    expect(result.ok).toBe(true);
    spy.mockRestore();
  });

  it('AsyncStorage.setItem(outbox) throw 시 upload는 계속 진행', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

    const spy = jest
      .spyOn(AsyncStorage, 'setItem')
      .mockImplementation(async (key: string) => {
        if (key === RAW_SIGNAL_OUTBOX_KEY) {
          throw new Error('storage fail');
        }
      });

    const result = await uploadSignalDump(
      '1700000000000-deadbeef',
      'tok',
      [entry(1)],
    );
    expect(result.ok).toBe(true);
    spy.mockRestore();
  });

  it('AsyncStorage.removeItem(outbox) throw 시 ok=true 유지', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

    const spy = jest
      .spyOn(AsyncStorage, 'removeItem')
      .mockImplementation(async () => {
        throw new Error('storage fail');
      });

    const result = await uploadSignalDump(
      '1700000000000-deadbeef',
      'tok',
      [entry(1)],
    );
    expect(result.ok).toBe(true);
    spy.mockRestore();
  });
});
