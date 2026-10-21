/**
 * #3155 — KV 어댑터(anchorDeparturesQuery): sync corroboration 보강(isTrainSeenAtAnchor)과 GET 목록용 뷰
 * (loadAnchorDepartures). 판정 자체는 anchorDepartures.test.ts; 여기서는 KV 부재/장애 degrade를 고정한다.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryKV } from './inMemoryKv';
import { isTrainSeenAtAnchor, loadAnchorDepartures } from '../anchorDeparturesQuery';
import { inferLegDirection } from '../legDirection';
import type { Trip } from '../types';

const NOW = Date.now();
const IS_UP = inferLegDirection('7', '용마산', '중곡') === 'up';
const SEGMENT = ['용마산', '중곡', '군자'];

function kvWith(entry: unknown): KVNamespace {
  const kv = new InMemoryKV();
  if (entry !== undefined) void kv.put('realtime-position:7', JSON.stringify(entry));
  return kv as unknown as KVNamespace;
}

const brokenKv = {
  get: async () => {
    throw new Error('kv down');
  },
} as unknown as KVNamespace;

function trip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 't',
    route: { type: 'direct', line: '7', stops: 3 } as unknown as Trip['route'],
    destination: '군자',
    waypoints: [
      { stationName: '중곡', line: '7', kind: 'intermediate' },
      { stationName: '군자', line: '7', kind: 'destination' },
    ],
    expiresAt: NOW + 3_600_000,
    createdAt: NOW - 60_000,
    alarmAtEpochMs: NOW,
    promptDisplay: { originStation: '용마산', line: '7' },
    ...overrides,
  };
}

describe('isTrainSeenAtAnchor', () => {
  const positions = [{ trainCode: '7039', stationName: '사가정', trainSttus: 0, isUp: IS_UP, recptnMs: NOW }];

  it('앵커 이전 역에서 접근 중이면 true', async () => {
    expect(await isTrainSeenAtAnchor(kvWith({ positions, fetchedAt: NOW }), '7039', '7', SEGMENT, NOW)).toBe(true);
  });

  it('stamp가 없으면 false', async () => {
    expect(await isTrainSeenAtAnchor(kvWith(undefined), '7039', '7', SEGMENT, NOW)).toBe(false);
  });

  it('KV 장애는 false로 degrade(기존 거부 동작 유지)', async () => {
    expect(await isTrainSeenAtAnchor(brokenKv, '7039', '7', SEGMENT, NOW)).toBe(false);
  });

  it('방향을 알 수 없는 구간(역 1개)은 fail-closed false', async () => {
    expect(await isTrainSeenAtAnchor(kvWith({ positions, fetchedAt: NOW }), '7039', '7', ['용마산'], NOW)).toBe(false);
  });
});

describe('loadAnchorDepartures', () => {
  it('앵커를 알 수 없으면 null', async () => {
    expect(await loadAnchorDepartures(kvWith(undefined), trip({ promptDisplay: undefined }), NOW)).toBeNull();
  });

  it('KV 장애는 null', async () => {
    expect(await loadAnchorDepartures(brokenKv, trip(), NOW)).toBeNull();
  });

  it('stamp가 없으면 앵커만 있는 빈 목록', async () => {
    expect(await loadAnchorDepartures(kvWith(undefined), trip(), NOW)).toEqual({
      station: '용마산',
      line: '7',
      departed: [],
    });
  });

  it('waypoints가 앵커 역으로 시작해도 구간에 앵커를 중복 prepend하지 않는다', async () => {
    const view = await loadAnchorDepartures(
      kvWith(undefined),
      trip({
        waypoints: [
          { stationName: '용마산', line: '7', kind: 'intermediate' },
          { stationName: '중곡', line: '7', kind: 'intermediate' },
          { stationName: '군자', line: '7', kind: 'destination' },
        ],
      }),
      NOW,
    );
    expect(view?.station).toBe('용마산');
  });

  it('현재 leg 구간이 비었거나(waypoints 없음) 방향을 모르는 역이면 null — fail-closed', async () => {
    expect(await loadAnchorDepartures(kvWith(undefined), trip({ waypoints: [] }), NOW)).toBeNull();
    expect(
      await loadAnchorDepartures(
        kvWith(undefined),
        trip({
          promptDisplay: { originStation: '없는역', line: '7' },
          waypoints: [{ stationName: '없는역2', line: '7', kind: 'destination' }],
        }),
        NOW,
      ),
    ).toBeNull();
  });

  it('currentStation은 같은 코드·같은 방향 position만 쓴다(다른 열차/반대 방향 무시)', async () => {
    const stamp = {
      positions: [
        { trainCode: '7777', stationName: '군자', trainSttus: 1, isUp: IS_UP, recptnMs: NOW },
        { trainCode: '7039', stationName: '군자', trainSttus: 1, isUp: !IS_UP, recptnMs: NOW },
        { trainCode: '7039', stationName: '중곡', trainSttus: 1, isUp: IS_UP, recptnMs: NOW },
      ],
      fetchedAt: NOW,
      stationLogs: { 용마산: { present: [], departed: [{ trainCode: '7039', isUp: IS_UP, departedAt: NOW - 60_000 }] } },
    };
    const view = await loadAnchorDepartures(kvWith(stamp), trip(), NOW);
    expect(view?.departed[0].currentStation).toBe('중곡');
  });

  it('출발 기록이 있으나 피드에서 사라진 열차는 currentStation null', async () => {
    const stamp = {
      positions: [],
      fetchedAt: NOW,
      stationLogs: { 용마산: { present: [], departed: [{ trainCode: '7039', isUp: IS_UP, departedAt: NOW - 60_000 }] } },
    };
    const view = await loadAnchorDepartures(kvWith(stamp), trip(), NOW);
    expect(view?.departed).toEqual([{ trainCode: '7039', departedAt: NOW - 60_000, currentStation: null }]);
  });
});
