import { describe, expect, it } from 'vitest';
import {
  REGISTER_COOLDOWN_MS,
  TRIP_STATUS_RETENTION_MS,
  TRIP_STATUS_TTL_SEC,
  deleteTripEndedStatus,
  readTripEndedStatus,
  toTripStatusEndReason,
  tripStatusKey,
  writeTripEndedStatus,
} from '../tripStatus';
import { InMemoryKV } from './inMemoryKv';

describe('tripStatusKey', () => {
  it('prefixes the token with tripStatus:', () => {
    expect(tripStatusKey('abc')).toBe('tripStatus:abc');
  });
});

describe('toTripStatusEndReason', () => {
  it('shortens destination-arrived to destination', () => {
    expect(toTripStatusEndReason('destination-arrived')).toBe('destination');
  });

  it('passes through other reasons unchanged', () => {
    expect(toTripStatusEndReason('expired')).toBe('expired');
    expect(toTripStatusEndReason('eta-missing')).toBe('eta-missing');
    expect(toTripStatusEndReason('push-unrecoverable')).toBe('push-unrecoverable');
  });

  it('passes through seoul-outage unchanged (#1663)', () => {
    expect(toTripStatusEndReason('seoul-outage')).toBe('seoul-outage');
  });
});

describe('writeTripEndedStatus', () => {
  it('persists endedAt + mapped endReason in JSON form', async () => {
    const kv = new InMemoryKV();
    await writeTripEndedStatus(
      kv as unknown as KVNamespace,
      'tok',
      'destination-arrived',
      1_000_000,
    );
    const raw = kv.store.get(tripStatusKey('tok'));
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!.value)).toEqual({
      endedAt: 1_000_000,
      endReason: 'destination',
    });
  });

  it('writes with the long TTL retention horizon', async () => {
    const kv = new InMemoryKV();
    const before = Date.now();
    await writeTripEndedStatus(kv as unknown as KVNamespace, 'tok', 'expired', before);
    const entry = kv.store.get(tripStatusKey('tok'))!;
    // expiresAt = now + TRIP_STATUS_TTL_SEC * 1000 (in-memory KV records absolute deadline)
    const after = Date.now();
    expect(entry.expiresAt).toBeGreaterThanOrEqual(before + TRIP_STATUS_TTL_SEC * 1000);
    expect(entry.expiresAt).toBeLessThanOrEqual(after + TRIP_STATUS_TTL_SEC * 1000);
  });
});

describe('readTripEndedStatus', () => {
  it('returns null when no record exists', async () => {
    const kv = new InMemoryKV();
    const got = await readTripEndedStatus(kv as unknown as KVNamespace, 'tok');
    expect(got).toBeNull();
  });

  it('returns parsed record after write', async () => {
    const kv = new InMemoryKV();
    await writeTripEndedStatus(kv as unknown as KVNamespace, 'tok', 'eta-missing', 500);
    const got = await readTripEndedStatus(kv as unknown as KVNamespace, 'tok');
    expect(got).toEqual({ endedAt: 500, endReason: 'eta-missing' });
  });

  it('returns parsed record for seoul-outage (#1663)', async () => {
    const kv = new InMemoryKV();
    await writeTripEndedStatus(kv as unknown as KVNamespace, 'tok', 'seoul-outage', 999);
    const got = await readTripEndedStatus(kv as unknown as KVNamespace, 'tok');
    expect(got).toEqual({ endedAt: 999, endReason: 'seoul-outage' });
  });

  it('returns null when stored JSON is malformed', async () => {
    const kv = new InMemoryKV();
    kv.store.set(tripStatusKey('tok'), { value: '{not-json' });
    const got = await readTripEndedStatus(kv as unknown as KVNamespace, 'tok');
    expect(got).toBeNull();
  });

  it('returns null when endedAt is missing', async () => {
    const kv = new InMemoryKV();
    kv.store.set(tripStatusKey('tok'), {
      value: JSON.stringify({ endReason: 'expired' }),
    });
    expect(await readTripEndedStatus(kv as unknown as KVNamespace, 'tok')).toBeNull();
  });

  it('returns null when endReason is unknown', async () => {
    const kv = new InMemoryKV();
    kv.store.set(tripStatusKey('tok'), {
      value: JSON.stringify({ endedAt: 1, endReason: 'made-up' }),
    });
    expect(await readTripEndedStatus(kv as unknown as KVNamespace, 'tok')).toBeNull();
  });
});

describe('deleteTripEndedStatus (#2144)', () => {
  it('removes an existing record', async () => {
    const kv = new InMemoryKV();
    await writeTripEndedStatus(kv as unknown as KVNamespace, 'tok', 'expired', 1000);
    expect(await readTripEndedStatus(kv as unknown as KVNamespace, 'tok')).not.toBeNull();

    await deleteTripEndedStatus(kv as unknown as KVNamespace, 'tok');
    expect(await readTripEndedStatus(kv as unknown as KVNamespace, 'tok')).toBeNull();
  });

  it('is a no-op when no record exists', async () => {
    const kv = new InMemoryKV();
    await expect(
      deleteTripEndedStatus(kv as unknown as KVNamespace, 'never-existed'),
    ).resolves.toBeUndefined();
  });

  it('does not affect a different token', async () => {
    const kv = new InMemoryKV();
    await writeTripEndedStatus(kv as unknown as KVNamespace, 'tok-a', 'expired', 1000);
    await writeTripEndedStatus(kv as unknown as KVNamespace, 'tok-b', 'expired', 1000);

    await deleteTripEndedStatus(kv as unknown as KVNamespace, 'tok-a');
    expect(await readTripEndedStatus(kv as unknown as KVNamespace, 'tok-a')).toBeNull();
    expect(await readTripEndedStatus(kv as unknown as KVNamespace, 'tok-b')).not.toBeNull();
  });
});

describe('constants', () => {
  it('status 보존은 10시간 (기기 SIGNAL_4_KTX_ETA_UPPER_BOUND_MS와 정렬, #3005 PR-D-b)', () => {
    expect(TRIP_STATUS_RETENTION_MS).toBe(10 * 60 * 60 * 1000);
  });

  it('재등록 쿨다운은 status 보존과 분리되어 1시간 유지', () => {
    expect(REGISTER_COOLDOWN_MS).toBe(60 * 60 * 1000);
  });

  it('TTL well exceeds retention so 410 is observable before record disappears', () => {
    expect(TRIP_STATUS_TTL_SEC * 1000).toBeGreaterThan(TRIP_STATUS_RETENTION_MS);
  });
});

describe('marker corrId (#3005 PR-D-b)', () => {
  it('corrId를 저장하고 읽는다', async () => {
    const kv = new InMemoryKV();
    await writeTripEndedStatus(kv as unknown as KVNamespace, 'tok', 'destination-arrived', 1000, 'corr-A');
    expect(await readTripEndedStatus(kv as unknown as KVNamespace, 'tok')).toEqual({
      endedAt: 1000,
      endReason: 'destination',
      corrId: 'corr-A',
    });
  });

  it('corrId 미지정이면 필드를 생략한다 (구 레코드 호환)', async () => {
    const kv = new InMemoryKV();
    await writeTripEndedStatus(kv as unknown as KVNamespace, 'tok', 'expired', 1000);
    const read = await readTripEndedStatus(kv as unknown as KVNamespace, 'tok');
    expect(read).toEqual({ endedAt: 1000, endReason: 'expired' });
    expect(read).not.toHaveProperty('corrId');
  });

  it('문자열이 아닌 corrId는 무시한다', async () => {
    const kv = new InMemoryKV();
    kv.store.set('tripStatus:tok', {
      value: JSON.stringify({ endedAt: 1, endReason: 'expired', corrId: 7 }),
    });
    expect(await readTripEndedStatus(kv as unknown as KVNamespace, 'tok')).toEqual({
      endedAt: 1,
      endReason: 'expired',
    });
  });
});
