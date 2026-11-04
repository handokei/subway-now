/**
 * #3319 PR-b — lock 부착·reanchor 시 SSoT 재앵커.
 *
 * 2026-11-04 17:25 실측(D1 2169 lock-attached 건대입구/7 trainCode 7252, 2176 lock-reanchor): 7호선 구간 내내
 * backend SSoT.currentStationId가 2호선 '성수'에 고착 → 기기 LA가 '성수' 미러. lock이 붙어도 SSoT는 안 움직였다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index';
import { readSsot, reanchorSsotToLock, seedSsot, writeSsot } from '../tripPositionSsot';
import type { TripPositionSSoT } from '../tripPositionSsot';
import type { BoardingLockMeta, Env } from '../types';
import { InMemoryKV } from './inMemoryKv';

const NOW = 1_793_780_696_865; // D1 2169 lock-attached
const TOKEN = 'tok-la';
const ANCHOR = '건대입구';

function lock(over: Partial<BoardingLockMeta> = {}): BoardingLockMeta {
  return {
    trainCode: '7252',
    line: '7',
    subwayId: '1007',
    selectedDepartureTime: NOW,
    segmentStations: [ANCHOR, '어린이대공원', '군자', '중곡'],
    expiresAt: NOW + 3_600_000,
    ...over,
  };
}

async function seed(kv: InMemoryKV, station: string, line: string, extra: Partial<TripPositionSSoT> = {}) {
  const s = await seedSsot(kv as unknown as KVNamespace, TOKEN, station, { line });
  if (Object.keys(extra).length > 0) await writeSsot(kv as unknown as KVNamespace, { ...s, ...extra });
}

describe('reanchorSsotToLock (#3319 PR-b)', () => {
  let kv: InMemoryKV;
  const k = () => kv as unknown as KVNamespace;
  beforeEach(() => {
    kv = new InMemoryKV();
  });

  it('11/04 실측: SSoT 성수/2 + lock 건대입구/7 -> SSoT 건대입구/7', async () => {
    await seed(kv, '성수', '2');
    expect(await reanchorSsotToLock(k(), TOKEN, lock())).toBe('reanchored');
    const s = await readSsot(k(), TOKEN);
    expect(s?.currentStationId).toBe(ANCHOR);
    expect(s?.currentStationLine).toBe('7');
  });

  it('같은 역명이어도 노선이 다르면(건대입구/2 -> 건대입구/7) 노선을 정정한다', async () => {
    await seed(kv, ANCHOR, '2');
    expect(await reanchorSsotToLock(k(), TOKEN, lock())).toBe('reanchored');
    expect((await readSsot(k(), TOKEN))?.currentStationLine).toBe('7');
  });

  it('이미 lock 탑승역/노선이면 쓰지 않는다(KV 쓰기 0)', async () => {
    await seed(kv, ANCHOR, '7');
    const putSpy = vi.spyOn(kv, 'put');
    expect(await reanchorSsotToLock(k(), TOKEN, lock())).toBe('unchanged');
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('거부: 같은 노선에서 SSoT가 lock 구간의 뒤쪽 역(이미 전진)이면 되감지 않는다', async () => {
    await seed(kv, '군자', '7');
    const putSpy = vi.spyOn(kv, 'put');
    expect(await reanchorSsotToLock(k(), TOKEN, lock())).toBe('skipped-ahead');
    expect(putSpy).not.toHaveBeenCalled();
    expect((await readSsot(k(), TOKEN))?.currentStationId).toBe('군자');
  });

  it('SSoT가 다른 노선이면 같은 역명이 구간 뒤쪽에 있어도 재앵커한다', async () => {
    await seed(kv, '군자', '5');
    expect(await reanchorSsotToLock(k(), TOKEN, lock())).toBe('reanchored');
    expect((await readSsot(k(), TOKEN))?.currentStationId).toBe(ANCHOR);
  });

  it('SSoT가 없으면 키를 만들지 않는다', async () => {
    expect(await reanchorSsotToLock(k(), TOKEN, lock())).toBe('no-ssot');
    expect(await readSsot(k(), TOKEN)).toBeNull();
  });

  it('segmentStations가 비면 아무것도 하지 않는다', async () => {
    await seed(kv, '성수', '2');
    expect(await reanchorSsotToLock(k(), TOKEN, lock({ segmentStations: [] }))).toBe('no-anchor');
    expect((await readSsot(k(), TOKEN))?.currentStationId).toBe('성수');
  });

  it('최신 값 위에 쓴다 — 다른 필드(passedStations)는 보존', async () => {
    await seed(kv, '성수', '2', { passedStations: ['뚝섬'] });
    await reanchorSsotToLock(k(), TOKEN, lock());
    expect((await readSsot(k(), TOKEN))?.passedStations).toEqual(['뚝섬']);
  });
});

// ---- boarding-confirm 배선 ----
function makeEnv(): Env {
  return {
    TRIPS: new InMemoryKV() as unknown as Env['TRIPS'],
    APNS_HOST: 'a',
    APNS_HOST_SANDBOX: 'a',
    SEOUL_API_HOST: 'h',
    SEOUL_API_KEY: 'k',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: 'p',
    APNS_BUNDLE_ID: 'b',
  } as Env;
}

const LEG2_TRIP = {
  token: TOKEN,
  route: { type: 'direct', line: '7', stops: 3 },
  destination: '중곡',
  waypoints: [
    { stationName: '어린이대공원', line: '7', kind: 'intermediate' },
    { stationName: '군자', line: '7', kind: 'intermediate' },
    { stationName: '중곡', line: '7', kind: 'destination' },
  ],
  expiresAt: NOW + 3_600_000,
  alarmAtEpochMs: NOW + 1_800_000,
  createdAt: NOW - 3_600_000,
  infoModeEnabled: true,
  promptDisplay: { originStation: '뚝섬유원지', line: '7' },
  currentLegAnchor: { boardingStation: ANCHOR, line: '7' },
  legBoardingEligibleAt: NOW - 30_000,
};

describe('boarding-confirm 배선 (#3319 PR-b)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('탑승 응답으로 lock이 붙으면 SSoT가 lock 탑승역/노선으로 재앵커된다', async () => {
    const env = makeEnv();
    await env.TRIPS.put(`trip:${TOKEN}`, JSON.stringify(LEG2_TRIP));
    await seedSsot(env.TRIPS, TOKEN, '성수', { line: '2' });
    const recptnDt = new Date(NOW + 9 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
    const positions = ['0', '1'].map((updnLine) => ({
      trainNo: '7252',
      statnNm: ANCHOR,
      trainSttus: 1,
      updnLine,
      recptnDt,
      lastRecptnDt: recptnDt.slice(0, 10).replace(/-/g, ''),
    }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ realtimePositionList: positions }), { status: 200 })));
    const res = await app.fetch(
      new Request(`http://example.com/trips/${TOKEN}/boarding-confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'boarded', station: ANCHOR, line: '7호선', source: 'prompt-tap' }),
      }),
      env,
    );
    const json = (await res.json()) as { lockState: string; resolvedTrainCode?: string };
    expect(json.resolvedTrainCode).toBe('7252');
    const s = await readSsot(env.TRIPS, TOKEN);
    expect(s?.currentStationId).toBe(ANCHOR);
    expect(s?.currentStationLine).toBe('7');
  });
});

describe('/boarding-lock/sync 승격 배선 (#3319 PR-b)', () => {
  it('수동 목록 탭 sync로 lock이 승격되면 SSoT가 lock 탑승역/노선으로 재앵커된다', async () => {
    const env = makeEnv();
    const now = Date.now();
    await env.TRIPS.put(
      'trip:sync-tok',
      JSON.stringify({
        token: 'sync-tok',
        route: { type: 'direct', line: '7', stops: 3 },
        destination: '군자',
        waypoints: [
          { stationName: '중곡', line: '7', kind: 'intermediate' },
          { stationName: '군자', line: '7', kind: 'destination' },
        ],
        expiresAt: now + 3_600_000,
        createdAt: now - 600_000,
        alarmAtEpochMs: now,
        infoModeEnabled: true,
      }),
    );
    await seedSsot(env.TRIPS, 'sync-tok', '성수', { line: '2' });
    const res = await app.fetch(
      new Request('http://example.com/boarding-lock/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: 'sync-tok',
          observedStationName: '용마산',
          observedAtMs: now,
          accuracy: 20,
          trainCode: '7039',
          boardingLine: '7',
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const stored = JSON.parse((await env.TRIPS.get('trip:sync-tok')) as string) as { boardingLock: BoardingLockMeta };
    const { segmentStations, line } = stored.boardingLock;
    const ssot = await readSsot(env.TRIPS, 'sync-tok');
    expect(ssot?.currentStationId).toBe(segmentStations[0]);
    expect(ssot?.currentStationLine).toBe(line);
  });
});

describe('reanchorSsotToLock KV 오류 (#3319 PR-b)', () => {
  it('KV 쓰기가 실패해도 throw하지 않는다(lock 부착 응답·cron tick 보호)', async () => {
    const kv = new InMemoryKV();
    await seedSsot(kv as unknown as KVNamespace, TOKEN, '성수', { line: '2' });
    vi.spyOn(kv, 'put').mockRejectedValue(new Error('kv quota'));
    expect(await reanchorSsotToLock(kv as unknown as KVNamespace, TOKEN, lock())).toBe('error');
  });
});
