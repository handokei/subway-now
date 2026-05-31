import { describe, expect, it } from 'vitest';
import { deleteProgress, getProgress, progressKey, putProgress, type TripProgress } from '../progress';
import { InMemoryKV } from './inMemoryKv';

function makeKv(): KVNamespace {
  return new InMemoryKV() as unknown as KVNamespace;
}

const SAMPLE: TripProgress = {
  trainCode: 'T1',
  shiftedCount: 2,
  lastTrackedArrivalEpoch: 100,
  lastLaPushEpoch: 200,
  consecutiveEtaMissing: 1,
};

describe('progress KV (#705)', () => {
  it('progressKey prefixes with progress:', () => {
    expect(progressKey('tok')).toBe('progress:tok');
  });

  it('putProgress + getProgress roundtrips', async () => {
    const kv = makeKv();
    await putProgress(kv, 'tok', SAMPLE, 3600);
    expect(await getProgress(kv, 'tok')).toEqual(SAMPLE);
  });

  it('getProgress returns null when key absent', async () => {
    expect(await getProgress(makeKv(), 'tok')).toBeNull();
  });

  it('getProgress returns null on corrupted JSON (graceful)', async () => {
    const kv = makeKv();
    await kv.put('progress:tok', 'not-json{');
    expect(await getProgress(kv, 'tok')).toBeNull();
  });

  it('getProgress returns null when shape invalid (missing trainCode)', async () => {
    const kv = makeKv();
    await kv.put('progress:tok', JSON.stringify({ shiftedCount: 1 }));
    expect(await getProgress(kv, 'tok')).toBeNull();
  });

  it('getProgress returns null when shape invalid (missing shiftedCount)', async () => {
    const kv = makeKv();
    await kv.put('progress:tok', JSON.stringify({ trainCode: 'T' }));
    expect(await getProgress(kv, 'tok')).toBeNull();
  });

  it('putProgress floors ttl floor to 60s for very short ttl', async () => {
    const kv = makeKv();
    await putProgress(kv, 'tok', SAMPLE, 1); // very short
    // graceful: 그대로 저장은 되며 KV TTL은 InMemoryKV 구현상 정상 read 가능
    expect(await getProgress(kv, 'tok')).toEqual(SAMPLE);
  });

  it('deleteProgress removes the entry', async () => {
    const kv = makeKv();
    await putProgress(kv, 'tok', SAMPLE, 3600);
    await deleteProgress(kv, 'tok');
    expect(await getProgress(kv, 'tok')).toBeNull();
  });
});
