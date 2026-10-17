import { describe, expect, it, vi } from 'vitest';
import {
  CORR_ID_PATTERN,
  MAX_DUMP_ENTRIES,
  RAW_SIGNAL_DUMP_KEY_PREFIX,
  RAW_SIGNAL_DUMP_TTL_SEC,
  dumpKey,
  readSignalDump,
  storeSignalDump,
  validateSignalDumpUpload,
} from '../rawSignalDump';
import { InMemoryKV } from './inMemoryKv';

function validBody(): Record<string, unknown> {
  return {
    corrId: '1700000000000-deadbeef',
    token: 'aabbccdd11223344',
    entries: [{ ts: 1, kind: 'cycle' }, { ts: 2, kind: 'enter' }],
  };
}

describe('CORR_ID_PATTERN', () => {
  it('accepts valid format', () => {
    expect(CORR_ID_PATTERN.test('1700000000000-deadbeef')).toBe(true);
    expect(CORR_ID_PATTERN.test('1-00000000')).toBe(true);
  });

  it('rejects invalid format', () => {
    expect(CORR_ID_PATTERN.test('foo')).toBe(false);
    expect(CORR_ID_PATTERN.test('1700000000000-DEADBEEF')).toBe(false); // uppercase
    expect(CORR_ID_PATTERN.test('1700000000000-dead')).toBe(false); // <8 hex
    expect(CORR_ID_PATTERN.test('abc-deadbeef')).toBe(false); // non-digit prefix
  });
});

describe('dumpKey', () => {
  it('prefixes corrId', () => {
    expect(dumpKey('xyz')).toBe(`${RAW_SIGNAL_DUMP_KEY_PREFIX}xyz`);
  });
});

describe('validateSignalDumpUpload', () => {
  it('accepts valid payload', () => {
    const out = validateSignalDumpUpload(validBody());
    expect(out).not.toBeNull();
    expect(out?.corrId).toBe('1700000000000-deadbeef');
    expect(out?.entries.length).toBe(2);
  });

  it('rejects non-object input', () => {
    expect(validateSignalDumpUpload(null)).toBeNull();
    expect(validateSignalDumpUpload('x')).toBeNull();
    expect(validateSignalDumpUpload(42)).toBeNull();
  });

  it('rejects bad corrId format', () => {
    expect(validateSignalDumpUpload({ ...validBody(), corrId: 'bad' })).toBeNull();
    expect(validateSignalDumpUpload({ ...validBody(), corrId: 123 })).toBeNull();
  });

  it('rejects empty token', () => {
    expect(validateSignalDumpUpload({ ...validBody(), token: '' })).toBeNull();
    expect(validateSignalDumpUpload({ ...validBody(), token: 42 })).toBeNull();
  });

  it('rejects non-array entries', () => {
    expect(validateSignalDumpUpload({ ...validBody(), entries: 'x' })).toBeNull();
    expect(validateSignalDumpUpload({ ...validBody(), entries: {} })).toBeNull();
  });

  it('rejects empty entries', () => {
    expect(validateSignalDumpUpload({ ...validBody(), entries: [] })).toBeNull();
  });

  it('rejects entries above cap', () => {
    const tooMany = Array.from({ length: MAX_DUMP_ENTRIES + 1 }, (_, i) => ({ ts: i }));
    expect(validateSignalDumpUpload({ ...validBody(), entries: tooMany })).toBeNull();
  });

  it('accepts entries exactly at cap', () => {
    const exact = Array.from({ length: MAX_DUMP_ENTRIES }, (_, i) => ({ ts: i }));
    expect(validateSignalDumpUpload({ ...validBody(), entries: exact })).not.toBeNull();
  });

  it('rejects primitive entries (non-object)', () => {
    expect(
      validateSignalDumpUpload({ ...validBody(), entries: [1, 2] }),
    ).toBeNull();
    expect(
      validateSignalDumpUpload({ ...validBody(), entries: [null] }),
    ).toBeNull();
  });
});

describe('storeSignalDump / readSignalDump', () => {
  it('writes tokenPrefix(8) + entries + uploadedAt', async () => {
    const kv = new InMemoryKV();
    const upload = validateSignalDumpUpload(validBody())!;
    await storeSignalDump(kv as unknown as KVNamespace, upload, 9999);

    const raw = await kv.get(dumpKey(upload.corrId));
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.tokenPrefix).toBe('aabbccdd'); // 8자 prefix
    expect(parsed.entries.length).toBe(2);
    expect(parsed.uploadedAt).toBe(9999);
  });

  it('sets 60-day TTL', async () => {
    const kv = new InMemoryKV();
    const putSpy = vi.fn(kv.put.bind(kv));
    (kv as unknown as { put: typeof putSpy }).put = putSpy;
    const upload = validateSignalDumpUpload(validBody())!;
    await storeSignalDump(kv as unknown as KVNamespace, upload, 0);
    expect(putSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      { expirationTtl: RAW_SIGNAL_DUMP_TTL_SEC },
    );
  });

  it('readSignalDump round-trips', async () => {
    const kv = new InMemoryKV();
    const upload = validateSignalDumpUpload(validBody())!;
    await storeSignalDump(kv as unknown as KVNamespace, upload, 12345);
    const stored = await readSignalDump(
      kv as unknown as KVNamespace,
      upload.corrId,
    );
    expect(stored).not.toBeNull();
    expect(stored?.tokenPrefix).toBe('aabbccdd');
    expect(stored?.uploadedAt).toBe(12345);
    expect(stored?.entries.length).toBe(2);
  });

  it('readSignalDump returns null for invalid corrId pattern', async () => {
    const kv = new InMemoryKV();
    const out = await readSignalDump(kv as unknown as KVNamespace, 'bad');
    expect(out).toBeNull();
  });

  it('readSignalDump returns null for missing key', async () => {
    const kv = new InMemoryKV();
    const out = await readSignalDump(
      kv as unknown as KVNamespace,
      '1700000000000-deadbeef',
    );
    expect(out).toBeNull();
  });

  it('readSignalDump returns null for corrupt JSON', async () => {
    const kv = new InMemoryKV();
    await kv.put(dumpKey('1700000000000-deadbeef'), 'not-json{');
    const out = await readSignalDump(
      kv as unknown as KVNamespace,
      '1700000000000-deadbeef',
    );
    expect(out).toBeNull();
  });

  it('readSignalDump returns null when stored shape is wrong', async () => {
    const kv = new InMemoryKV();
    await kv.put(dumpKey('1700000000000-deadbeef'), JSON.stringify({ entries: 'x' }));
    const out = await readSignalDump(
      kv as unknown as KVNamespace,
      '1700000000000-deadbeef',
    );
    expect(out).toBeNull();
  });

  it('readSignalDump returns null when stored payload is null literal', async () => {
    const kv = new InMemoryKV();
    await kv.put(dumpKey('1700000000000-deadbeef'), 'null');
    const out = await readSignalDump(
      kv as unknown as KVNamespace,
      '1700000000000-deadbeef',
    );
    expect(out).toBeNull();
  });
});
