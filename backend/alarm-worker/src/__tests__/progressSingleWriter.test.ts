/**
 * #2308 PR-2 — progress KV 작성자는 cron 경로의 `mirrorProgress` 하나다 (D1 결정 b2).
 *
 * /boarding-lock/sync(순수 intermediate 전진 · 승격 fast-forward · transfer/destination 혼합 분기)는 trip.waypoints만 전진시키고
 * progress를 쓰지 않는다 — cron 맞춤이 "앞선 쪽 유지"로 존중하고 tick 끝 mirror가 기록한다.
 * `completeWaypointAdvance`의 mirror는 기본 켜짐(cron 호출자 무변경), sync-mixed만 `mirrorProgress:false`로 끈다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { progressKey, type TripProgress } from '../progress';
import { putTrip, waypointSignatureKey } from '../trips';
import type { Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';
import { advance, captureFetch, useApnsHarness, wp } from './helpers/sleepAlarmHarness';
import { lockActiveTrip, syncObserved, syncPromote } from './helpers/sleepAlarmSyncHttp';
import { vi } from 'vitest';

useApnsHarness();
afterEach(() => vi.unstubAllGlobals());

const chain = () => [
  wp('중곡', 'intermediate'),
  wp('군자', 'intermediate'),
  wp('건대입구', 'transfer'),
  wp('뚝섬유원지', 'intermediate'),
  wp('학동', 'destination'),
];

const readProgress = async (kv: InMemoryKV, token: string): Promise<TripProgress | null> => {
  const raw = await kv.get(progressKey(token));
  return raw === null ? null : (JSON.parse(raw) as TripProgress);
};

describe('sync는 progress를 쓰지 않는다 (b2, #2308)', () => {
  it('순수 intermediate 전진(관측 군자 -> 중곡 소비): trip은 전진하고 progress 키는 생기지 않는다', async () => {
    const trip = lockActiveTrip(chain());
    const r = await syncObserved(trip, '군자');
    expect(r.stored?.waypoints.map((w) => w.stationName)).not.toContain('중곡'); // 전제: sync가 실제로 소비했다
    expect(r.stored?.waypoints.length).toBeLessThan(chain().length);
    expect(await r.kv.get(progressKey(trip.token))).toBeNull();
  });

  it('혼합 분기(관측 건대입구 = transfer 소비): trip은 전진하고 progress 키는 생기지 않는다', async () => {
    const trip = lockActiveTrip(chain());
    const r = await syncObserved(trip, '뚝섬유원지');
    expect(r.stored?.waypoints.length).toBeLessThan(chain().length);
    expect(await r.kv.get(progressKey(trip.token))).toBeNull();
  });

  it('승격 fast-forward(열차가 이미 지난 역을 건너뜀): progress 키는 생기지 않는다', async () => {
    const r = await syncPromote('destination', {}, { stationName: '군자', trainSttus: 2 });
    expect(r.stored?.waypoints.length).toBeLessThan(4);
    expect(await r.kv.get(progressKey(r.stored?.token ?? 'sync-pr2-tok'))).toBeNull();
  });
});

describe('completeWaypointAdvance — mirrorProgress 옵션 (#2308)', () => {
  const lockTrip = (): Trip => lockActiveTrip([wp('군자', 'intermediate'), wp('중곡', 'intermediate'), wp('학동', 'destination')]);

  it('기본(cron 호출자): 새 head의 내용 키(headKey)를 stamp한 progress를 쓴다', async () => {
    const kv = new InMemoryKV();
    const trip = lockTrip();
    await putTrip(kv as unknown as KVNamespace, trip);
    await advance(trip, kv, captureFetch().fetchImpl);
    const progress = await readProgress(kv, trip.token);
    expect(progress).toMatchObject({ trainCode: '7246', headKey: waypointSignatureKey(wp('중곡', 'intermediate')) });
  });

  it('{ mirrorProgress: false }(sync-mixed): trip은 전진하지만 progress는 쓰지 않는다', async () => {
    const kv = new InMemoryKV();
    const trip = lockTrip();
    await putTrip(kv as unknown as KVNamespace, trip);
    await advance(trip, kv, captureFetch().fetchImpl, { advanceOptions: { mirrorProgress: false } });
    expect(trip.waypoints.map((w) => w.stationName)).toEqual(['중곡', '학동']);
    expect(await kv.get(progressKey(trip.token))).toBeNull();
  });
});
