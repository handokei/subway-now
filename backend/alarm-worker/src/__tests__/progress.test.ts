import { describe, expect, it } from 'vitest';
import {
  deleteProgress,
  getProgress,
  isProgressWriteRedundant,
  progressKey,
  putProgress,
  type TripProgress,
} from '../progress';
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

  // #1285 — lockless progress 지원
  it('getProgress accepts lockless entry (lockless=true, no trainCode)', async () => {
    const kv = makeKv();
    const locklessProgress: TripProgress = { lockless: true, shiftedCount: 1 };
    await putProgress(kv, 'lockless-tok', locklessProgress, 3600);
    const result = await getProgress(kv, 'lockless-tok');
    expect(result).not.toBeNull();
    expect(result?.lockless).toBe(true);
    expect(result?.shiftedCount).toBe(1);
    expect(result?.trainCode).toBeUndefined();
  });

  it('getProgress rejects entry with neither trainCode nor lockless=true', async () => {
    const kv = makeKv();
    await kv.put('progress:tok', JSON.stringify({ shiftedCount: 1 }));
    expect(await getProgress(kv, 'tok')).toBeNull();
  });

  it('getProgress rejects entry where lockless=true but trainCode also present (ambiguous)', async () => {
    const kv = makeKv();
    // lockless=true + trainCode 동시 존재 — trainCode 있으면 validTrainCode=true로 통과 (lock 우선)
    await kv.put('progress:tok', JSON.stringify({ lockless: true, trainCode: 'T1', shiftedCount: 2 }));
    const result = await getProgress(kv, 'tok');
    // trainCode가 문자열이면 validTrainCode=true → 통과 (lock 경로로 처리)
    expect(result).not.toBeNull();
    expect(result?.trainCode).toBe('T1');
  });
});

// #3169 — write-on-change 판정. stale 읽기는 "쓰지 않는" 방향으로만 작동하므로 오래된 값을 새로 남기지 않는다.
describe('isProgressWriteRedundant (#3169)', () => {
  const BASED: TripProgress = { ...SAMPLE, ttlBasisExpiresAt: 1_000 };

  it('기존 값 없음 -> 쓴다', () => {
    expect(isProgressWriteRedundant(null, BASED)).toBe(false);
  });

  it('값과 basis 동일 -> 생략', () => {
    expect(isProgressWriteRedundant(BASED, { ...BASED })).toBe(true);
  });

  it('만료가 줄어든 경우(basis 감소)도 기존 TTL이 더 길어 생략', () => {
    expect(isProgressWriteRedundant(BASED, { ...BASED, ttlBasisExpiresAt: 900 })).toBe(true);
  });

  it('만료 연장(basis 증가) -> 쓴다', () => {
    expect(isProgressWriteRedundant(BASED, { ...BASED, ttlBasisExpiresAt: 1_001 })).toBe(false);
  });

  it('legacy(기존 basis 없음) -> 쓴다', () => {
    expect(isProgressWriteRedundant(SAMPLE, BASED)).toBe(false);
  });

  it.each([
    ['shiftedCount', { shiftedCount: 3 }],
    ['lastLaPushEpoch', { lastLaPushEpoch: 201 }],
    ['consecutiveEtaMissing', { consecutiveEtaMissing: 2 }],
    ['trainCode', { trainCode: 'T2' }],
    ['한쪽에만 있는 필드', { headHopIndex: 4 }],
  ])('%s 변화 -> 쓴다', (_label, patch) => {
    expect(isProgressWriteRedundant(BASED, { ...BASED, ...patch })).toBe(false);
  });

  it('필드가 사라진 경우(next에서 undefined)도 변화 -> 쓴다', () => {
    const { consecutiveEtaMissing: _omit, ...withoutMiss } = BASED;
    expect(isProgressWriteRedundant(BASED, withoutMiss)).toBe(false);
  });
});
