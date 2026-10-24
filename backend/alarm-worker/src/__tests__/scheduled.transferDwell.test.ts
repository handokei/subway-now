/**
 * #3083 PR-1 — 환승 체류(transfer dwell) 중 `/boarding-lock/sync` 관측 전진 hold.
 *
 * 실측(10/19 168): 환승 waypoint 소비 직후(`currentLegAnchor`+`legBoardingEligibleAt` stamp) lock 없이
 * 승강장 대기 중인데 device sync(18:05:43 어린이대공원)가 leg-2 waypoint를 소비했다 — 먼저 떠난 앞 열차를
 * 따라간 가짜 전진. hold 술어: anchor ∧ 활성·비PENDING lock 0개(노선 무관) ∧ now < eligibleAt + WAIT.
 * 입력(스펙)은 plan `tasks/plan-2026-10-23-3083-transfer-dwell.md` §2.1/§7 PR-1 + v4.1 — 구현을 보지 않고 작성.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exportPKCS8, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { resetApnsJwtCache } from '../apns';
import {
  TRANSFER_DWELL_WAIT_MS,
  capLockSyncAdvance,
  dwellFirstLegWaypointIndex,
  isTransferDwell,
  PENDING_TRAIN_CODE_SENTINEL,
  SYNC_SKIPPED_STATION_FIRE_CAP,
} from '../scheduled';
import { getTrip, putTrip } from '../trips';
import type { BoardingLockMeta, Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';
import { makeTripEventSink } from './helpers/replay20261019';

const NOW = 1_792_400_669_000;
let TOKEN = 'dwell-3083-tok';
let tokenSeq = 0;
/** 168 형태: 환승(건대입구 2→7) 소비 후 leg-2(7호선) 대기. */
const ANCHOR = { boardingStation: '건대입구', line: '7' };
const LEG2_WAYPOINTS: Trip['waypoints'] = [
  { stationName: '어린이대공원', line: '7', kind: 'intermediate' },
  { stationName: '군자', line: '7', kind: 'intermediate' },
  { stationName: '중곡', line: '7', kind: 'intermediate' },
  { stationName: '용마산', line: '7', kind: 'destination' },
];

function makeLock(overrides: Partial<BoardingLockMeta> = {}): BoardingLockMeta {
  return {
    trainCode: '7268',
    line: '7',
    subwayId: '1007',
    selectedDepartureTime: NOW - 60_000,
    segmentStations: ['어린이대공원', '군자', '중곡', '용마산'],
    expiresAt: NOW + 3_600_000,
    ...overrides,
  };
}

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: TOKEN,
    route: {
      type: 'transfer',
      fromLine: '2',
      toLine: '7',
      transferName: '건대입구',
      stops: 7,
      stopsToTransfer: 3,
      stopsFromTransfer: 4,
    } as unknown as Trip['route'],
    destination: '용마산',
    waypoints: LEG2_WAYPOINTS,
    expiresAt: NOW + 3_600_000,
    createdAt: NOW - 600_000,
    alarmAtEpochMs: NOW,
    currentLegAnchor: ANCHOR,
    legBoardingEligibleAt: NOW - 60_000,
    infoModeEnabled: true,
    ...overrides,
  };
}

describe('TRANSFER_DWELL_WAIT_MS — 데이터 근거', () => {
  it('lineHeadways.json 전체 최댓값(초) × 1000 이상이다 (데이터가 올라가면 빨개진다)', () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'src', 'data', 'lineHeadways.json'), 'utf-8'),
    ) as unknown;
    const numbers: number[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'number') numbers.push(v);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(raw);
    expect(numbers.length).toBeGreaterThan(0);
    expect(TRANSFER_DWELL_WAIT_MS).toBeGreaterThanOrEqual(Math.max(...numbers) * 1000);
  });

  it('실측 lock − eligibleAt 최댓값(+78.9s, 트립 168)보다 크다', () => {
    expect(TRANSFER_DWELL_WAIT_MS).toBeGreaterThan(78_900);
  });
});

describe('isTransferDwell — 술어', () => {
  it('anchor ∧ lock 없음 ∧ 창 안 → true', () => {
    expect(isTransferDwell(makeTrip(), NOW)).toBe(true);
  });

  it('anchor 없음 → false (leg-1 출발 대기는 이 술어 소관 아님)', () => {
    expect(isTransferDwell(makeTrip({ currentLegAnchor: undefined }), NOW)).toBe(false);
  });

  it('legBoardingEligibleAt 없음 → false', () => {
    expect(isTransferDwell(makeTrip({ legBoardingEligibleAt: undefined }), NOW)).toBe(false);
  });

  it('창 경계: eligibleAt+WAIT-1 hold, eligibleAt+WAIT 해제', () => {
    const eligibleAt = NOW;
    const trip = makeTrip({ legBoardingEligibleAt: eligibleAt });
    expect(isTransferDwell(trip, eligibleAt + TRANSFER_DWELL_WAIT_MS - 1)).toBe(true);
    expect(isTransferDwell(trip, eligibleAt + TRANSFER_DWELL_WAIT_MS)).toBe(false);
  });

  it('활성 비PENDING lock → false (노선 무관: leg-1 노선 lock 포함)', () => {
    expect(isTransferDwell(makeTrip({ boardingLock: makeLock() }), NOW)).toBe(false);
    expect(isTransferDwell(makeTrip({ boardingLock: makeLock({ line: '2', trainCode: '2011' }) }), NOW)).toBe(false);
  });

  it('PENDING sentinel lock / 만료 lock → hold 유지', () => {
    expect(
      isTransferDwell(makeTrip({ boardingLock: makeLock({ trainCode: PENDING_TRAIN_CODE_SENTINEL }) }), NOW),
    ).toBe(true);
    expect(isTransferDwell(makeTrip({ boardingLock: makeLock({ expiresAt: NOW }) }), NOW)).toBe(true);
  });
});

describe('dwellFirstLegWaypointIndex / capLockSyncAdvance', () => {
  it('환승 waypoint 소비 완료(t<0) → 0', () => {
    expect(dwellFirstLegWaypointIndex(makeTrip(), NOW)).toBe(0);
  });

  it('환승 waypoint가 남아 있으면 그 다음 인덱스 (이름 정규화 비교)', () => {
    const trip = makeTrip({
      waypoints: [{ stationName: '건대입구', line: '7', kind: 'transfer' }, ...LEG2_WAYPOINTS],
    });
    expect(dwellFirstLegWaypointIndex(trip, NOW)).toBe(1);
  });

  it('체류 아님 → null', () => {
    expect(dwellFirstLegWaypointIndex(makeTrip({ currentLegAnchor: undefined }), NOW)).toBeNull();
  });

  it('cap: leg-2 관측은 0으로, 환승까지는 통과, 체류 아니면 그대로', () => {
    expect(capLockSyncAdvance({ shiftedCount: 2 }, makeTrip(), NOW)).toEqual({ shiftedCount: 0 });
    const withTransfer = makeTrip({
      waypoints: [{ stationName: '건대입구', line: '7', kind: 'transfer' }, ...LEG2_WAYPOINTS],
    });
    expect(capLockSyncAdvance({ shiftedCount: 1 }, withTransfer, NOW)).toEqual({ shiftedCount: 1 });
    expect(capLockSyncAdvance({ shiftedCount: 3 }, withTransfer, NOW)).toEqual({ shiftedCount: 1 });
    expect(capLockSyncAdvance({ shiftedCount: 0 }, withTransfer, NOW)).toEqual({ shiftedCount: 0 });
    expect(capLockSyncAdvance({ shiftedCount: 2 }, makeTrip({ currentLegAnchor: undefined }), NOW)).toEqual({
      shiftedCount: 2,
    });
  });

  it('셀 14 문서화: 같은 이름 transfer가 두 번이면 뒤의 것이 t로 잡혀 cap이 느슨해진다(수정 전 동작으로 후퇴)', () => {
    const trip = makeTrip({
      waypoints: [
        { stationName: '건대입구', line: '7', kind: 'transfer' },
        { stationName: '군자', line: '7', kind: 'intermediate' },
        { stationName: '건대입구', line: '2', kind: 'transfer' },
        { stationName: '용마산', line: '2', kind: 'destination' },
      ],
    });
    expect(dwellFirstLegWaypointIndex(trip, NOW)).toBe(1);
  });
});

describe('POST /boarding-lock/sync — 체류 hold (엔드포인트)', () => {
  let kv: InMemoryKV;
  let env: Env;
  let events: ReturnType<typeof makeTripEventSink>['events'];
  let fetchSpy: ReturnType<typeof vi.fn>;
  let apnsPem: string;

  beforeAll(async () => {
    const { privateKey } = await generateKeyPair('ES256');
    apnsPem = await exportPKCS8(privateKey);
  });

  beforeEach(() => {
    TOKEN = `dwell-3083-tok-${(tokenSeq += 1)}`;
    resetApnsJwtCache();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    kv = new InMemoryKV();
    const sink = makeTripEventSink();
    events = sink.events;
    env = {
      TRIPS: kv as unknown as KVNamespace,
      DB: sink.db,
      APNS_HOST: 'api.push.apple.com',
      APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
      SEOUL_API_HOST: 'seoul.api',
      SEOUL_API_KEY: 'KEY',
      APNS_KEY_ID: 'K',
      APNS_TEAM_ID: 'T',
      APNS_PRIVATE_KEY: apnsPem,
      APNS_BUNDLE_ID: 'com.example.app',
    } as Env;
    fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function sync(observedStationName: string) {
    const res = await app.fetch(
      new Request('http://example.com/boarding-lock/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, observedStationName, observedAtMs: NOW, accuracy: 20 }),
      }),
      env,
    );
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    return { status: res.status, body: (await res.json()) as { ok: boolean; advanced: boolean } };
  }

  const heads = async () => (await getTrip(kv as unknown as KVNamespace, TOKEN))?.waypoints.map((w) => w.stationName);

  it('★체류 중 leg-2 intermediate 관측(168 18:05:43형)은 전진하지 않는다 — waypoints 불변, advance 행 없음, advance-held 행 1건', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip());

    const { status, body } = await sync('군자');

    expect(status).toBe(200);
    expect(body.advanced).toBe(false);
    expect(await heads()).toEqual(LEG2_WAYPOINTS.map((w) => w.stationName));
    expect(events.filter((e) => e.kind === 'advance')).toEqual([]);
    const held = events.filter((e) => e.kind === 'advance-held');
    expect(held).toHaveLength(1);
    expect(held[0].station).toBe('군자');
    expect(held[0].meta).toMatchObject({ requested: 2, cappedTo: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('창 경계: eligibleAt+WAIT-1 에서는 hold, eligibleAt+WAIT 에서는 전진', async () => {
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({ legBoardingEligibleAt: NOW - TRANSFER_DWELL_WAIT_MS + 1 }),
    );
    expect((await sync('군자')).body.advanced).toBe(false);
    expect(await heads()).toEqual(LEG2_WAYPOINTS.map((w) => w.stationName));

    await putTrip(kv as unknown as KVNamespace, makeTrip({ legBoardingEligibleAt: NOW - TRANSFER_DWELL_WAIT_MS }));
    expect((await sync('군자')).body.advanced).toBe(true);
    expect(await heads()).toEqual(['중곡', '용마산']);
  });

  it('거부(수정 후에도 전진해야 함): 활성 lock 6종 생성 형태 — segmentStations[0] 무관', async () => {
    const shapes: Record<string, Partial<BoardingLockMeta>> = {
      'stamp 승격([0]=leg-2 첫 waypoint)': { segmentStations: ['어린이대공원', '군자', '중곡'] },
      'sync 승격([0]=관측역)': { segmentStations: ['군자', '중곡', '용마산'] },
      'device payload([0]=anchor 역)': { segmentStations: ['건대입구', '어린이대공원', '군자'] },
      '앵커 resolve([0]=anchor 역, 다른 열차)': { segmentStations: ['건대입구'], trainCode: '7269' },
      'body-tap(자동 합성 마커 없음)': { selectedDepartureTime: NOW - 600_000 },
      'vanish swap 상속(autoLockedAt)': { autoLockedAt: NOW - 30_000, trainCode: '7270' },
    };
    for (const [label, lockOverrides] of Object.entries(shapes)) {
      await putTrip(kv as unknown as KVNamespace, makeTrip({ boardingLock: makeLock(lockOverrides) }));
      const { body } = await sync('군자');
      expect(body.advanced, label).toBe(true);
      expect(await heads(), label).toEqual(['중곡', '용마산']);
    }
    expect(events.filter((e) => e.kind === 'advance-held')).toEqual([]);
  });

  it('셀 3: PENDING sentinel lock(탭 수락했지만 backend lock 미확정)도 창 안 hold 유지', async () => {
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({ boardingLock: makeLock({ trainCode: PENDING_TRAIN_CODE_SENTINEL }) }),
    );
    expect((await sync('군자')).body.advanced).toBe(false);
    expect(await heads()).toEqual(LEG2_WAYPOINTS.map((w) => w.stationName));
  });

  it('셀 7: 창 안에서 lock이 소실되면 hold 재개 / 활성 lock이면 전진', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip({ boardingLock: makeLock() }));
    expect((await sync('어린이대공원')).body.advanced).toBe(true);
    await putTrip(kv as unknown as KVNamespace, makeTrip({ boardingLock: undefined }));
    expect((await sync('어린이대공원')).body.advanced).toBe(false);
  });

  it('셀 10: anchor 없는 트립(leg-1)은 기존대로 전진 — advance-held 없음', async () => {
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({ currentLegAnchor: undefined, legBoardingEligibleAt: undefined }),
    );
    expect((await sync('군자')).body.advanced).toBe(true);
    expect(events.filter((e) => e.kind === 'advance-held')).toEqual([]);
  });

  it('셀 9: 환승 waypoint가 남은 상태에서 leg-2 역 관측 → 환승까지만 소비(cap=t+1)', async () => {
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({ waypoints: [{ stationName: '건대입구', line: '7', kind: 'transfer' }, ...LEG2_WAYPOINTS] }),
    );
    const { body } = await sync('군자');
    expect(body.advanced).toBe(true);
    const after = await heads();
    expect(after?.[0]).toBe('어린이대공원');
    expect(after).toEqual(LEG2_WAYPOINTS.map((w) => w.stationName));
    const held = events.filter((e) => e.kind === 'advance-held');
    expect(held).toHaveLength(1);
    expect(held[0].meta).toMatchObject({ requested: 3, cappedTo: 1 });
  });

  it('같은 (관측역, requested)의 반복 sync는 advance-held 행을 한 번만 남긴다 (isolate 메모리 dedup, KV 쓰기 0)', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip());
    await sync('군자');
    await sync('군자');
    await sync('군자');
    expect(events.filter((e) => e.kind === 'advance-held')).toHaveLength(1);
    // 다른 관측(requested 변경)은 새 행.
    await sync('중곡');
    const held = events.filter((e) => e.kind === 'advance-held');
    expect(held).toHaveLength(2);
    expect(held[1].meta).toMatchObject({ requested: 3, cappedTo: 0 });
  });

  it('창 중간 늦은 lock 부착 후 첫 sync가 여러 역을 소비해도 매역 push는 SYNC_SKIPPED_STATION_FIRE_CAP(1)건 이하다 (몰림 없음)', async () => {
    const longWaypoints: Trip['waypoints'] = [
      ...LEG2_WAYPOINTS.slice(0, 3),
      { stationName: '용마산', line: '7', kind: 'intermediate' },
      { stationName: '사가정', line: '7', kind: 'intermediate' },
      { stationName: '면목', line: '7', kind: 'intermediate' },
      { stationName: '상봉', line: '7', kind: 'destination' },
    ];
    await putTrip(kv as unknown as KVNamespace, makeTrip({ waypoints: longWaypoints }));
    // 체류 중 lockless sync 여러 번 -> 전부 hold
    for (const station of ['어린이대공원', '군자', '중곡']) {
      expect((await sync(station)).body.advanced).toBe(false);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    // 창 중간 lock 부착(늦은 탭), 다음 sync는 건너뛴 역들을 한 번에 소비
    const held = await getTrip(kv as unknown as KVNamespace, TOKEN);
    await putTrip(kv as unknown as KVNamespace, {
      ...(held as Trip),
      boardingLock: makeLock({ segmentStations: longWaypoints.map((w) => w.stationName) }),
    });
    expect((await sync('면목')).body.advanced).toBe(true);
    // 재현 시도 결과: 몰림 없음. 건너뛴 5역 중 newest-first(#2625 P1-2) 1건(사가정)만 발사되고 나머지는 skipped-by-shift.
    const attempts = events.filter((e) => e.kind === 'cron-fire-attempt');
    const sent = attempts.filter((e) => (e.meta as { outcome?: string }).outcome === 'sent');
    expect(sent.map((e) => e.station)).toEqual(['사가정']);
    expect(sent.length).toBeLessThanOrEqual(SYNC_SKIPPED_STATION_FIRE_CAP);
    expect(attempts.filter((e) => (e.meta as { outcome?: string }).outcome === 'skipped-by-shift')).toHaveLength(4);
    // 1역 전 알람 catch-up(#3157)은 그대로 정확히 1회 (면목 -> "곧 상봉").
    const prepare = events.filter(
      (e) => e.kind === 'prepare-alarm' && (e.meta as { outcome?: string }).outcome === 'fired',
    );
    expect(prepare).toHaveLength(1);
    expect(prepare[0].meta).toMatchObject({ targetStation: '상봉' });
  });
});
