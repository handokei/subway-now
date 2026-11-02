/**
 * #2629 PR-3 — 2026-10-31 09:57:45 tick 단독 replay: lock 열차 위치 따라잡기.
 *
 * 운영 상태 그대로(D1 1926 = head 강남구청, lock 7077) + 실캡처 1793408265543(7077 학동 sttus=1, recptn 09:57:13)을
 * 한 tick만 재생한다. 따라잡기가 없으면 이 tick은 강남구청만 소비하고 학동 알림은 한 cycle 뒤로 밀린다.
 * 입력은 #3282가 만든 불변 fixture(`replay_20261031_reregister_storm/caps`)를 그대로 쓴다 — 통과시키려 조정 금지.
 * assert는 실제로 나간 APNs 요청(종류·tick·횟수) 기준이다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, Trip, Waypoint } from '../types';
import { sleepAlarmCollapseId } from '../collapseId';
import { stationPassedFiredKey } from '../scheduled';
import { waypointSignatureKey } from '../trips';
import { buildReplayFixture, parseSeoulCaptureCycle } from '../replayFixture';
import { runCaptureReplay } from './helpers/replayHarness';
import { loadD1Events, makeTripEventSink, parseRouteSig, routeSigOf, stubReplayFetch } from './helpers/replay20261019';
import { attachDb, makeLagKv, primeReplayKv } from './helpers/progressAuthorityReplay';
import { firedStationOccurrences } from './helpers/pushAssertions';
import { useApnsHarness } from './helpers/sleepAlarmHarness';

useApnsHarness();

const DIR = 'replay_20261031_reregister_storm';
const CAPTURE_FILE = '1793408265543.json';
const TOKEN = 'replay-2629-1031';
const HOUR_MS = 60 * 60_000;

const rows = loadD1Events(DIR, 'events.json');
const rowOf = (id: number) => {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`D1 행 ${id}이 fixture에 없다`);
  return row;
};
/** D1 1877 existingSig(군자 head) 앞에 lock 부착 시점에 소비된 중곡을 더하면 원본 노선(#3282 replay와 동일). */
const FULL_ROUTE_NAMES = ['중곡', ...parseRouteSig(routeSigOf(rowOf(1877), 'existingSig')).map((w) => w.stationName)];
/** lock 7077 segment = 탑승역(용마산, D1 1865) + 부착 시점 잔여 노선 전체. */
const SEGMENT_STATIONS = [rowOf(1865).station as string, ...FULL_ROUTE_NAMES];

const fixture = buildReplayFixture([
  parseSeoulCaptureCycle(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', DIR, 'caps', CAPTURE_FILE), 'utf-8'))),
]);

/** headName부터 끝까지 남긴 waypoints. 마지막은 destination. */
const waypointsFrom = (headName: string): Waypoint[] => {
  const from = FULL_ROUTE_NAMES.indexOf(headName);
  return FULL_ROUTE_NAMES.slice(from).map((stationName, i, rest) => ({
    stationName,
    line: '7',
    kind: i === rest.length - 1 ? 'destination' : 'intermediate',
    hopIndex: from + i,
  }));
};

function seedTrip(headName: string, overrides: { trainCode?: string; segment?: string[]; sleep?: boolean } = {}): Trip {
  const now = fixture.window.fromMs;
  return {
    token: TOKEN,
    route: { type: 'direct', line: '7', stops: FULL_ROUTE_NAMES.length } as Trip['route'],
    destination: FULL_ROUTE_NAMES[FULL_ROUTE_NAMES.length - 1],
    originStationName: SEGMENT_STATIONS[0],
    waypoints: waypointsFrom(headName),
    boardingLock: {
      trainCode: overrides.trainCode ?? '7077',
      line: '7',
      subwayId: '1007',
      selectedDepartureTime: now - 14 * 60_000,
      segmentStations: overrides.segment ?? SEGMENT_STATIONS,
      expiresAt: now + HOUR_MS,
    },
    expiresAt: now + 3 * HOUR_MS,
    createdAt: now - 18 * 60_000,
    alarmAtEpochMs: now,
    infoModeEnabled: true,
    consecutiveEtaMissing: 0,
    ...(overrides.sleep ? { sleepModeEnabled: true } : {}),
  } as Trip;
}

async function replayTick(trip: Trip, opts: { dedupStamped?: string[] } = {}) {
  const { db, events } = makeTripEventSink();
  const stub = stubReplayFetch(fixture);
  vi.setSystemTime(fixture.window.fromMs - 10 * 60_000);
  const result = await runCaptureReplay({
    fixture,
    seedTrips: [trip],
    apns: 'capture',
    makeKv: makeLagKv,
    beforeTick: async ({ tick, env, kv }) => {
      // progress가 이미 head를 가리키는 운영 상태(재등록 없음) — 진입 맞춤(#3282)은 no-op이어야 한다.
      await primeReplayKv(kv, tick, {
        token: TOKEN,
        progress: {
          trainCode: trip.boardingLock!.trainCode,
          shiftedCount: FULL_ROUTE_NAMES.indexOf(trip.waypoints[0].stationName),
          headHopIndex: trip.waypoints[0].hopIndex,
          headKey: waypointSignatureKey(trip.waypoints[0]),
          ttlBasisExpiresAt: trip.expiresAt,
        },
      });
      for (const station of opts.dedupStamped ?? []) {
        await kv.put(stationPassedFiredKey(TOKEN, trip.boardingLock!.trainCode, station), '1', { expirationTtl: 3600 });
      }
      attachDb(env as Env, db);
      stub.setNow(tick);
      vi.setSystemTime(tick);
    },
  });
  return { result, cycle: result.cycles[0], events };
}

type Run = Awaited<ReturnType<typeof replayTick>>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const alertStations = (r: Run) => firedStationOccurrences(r.cycle.pushes);
const catchupRows = (r: Run) =>
  r.events
    .filter((e) => e.kind === 'cron-fire-attempt' && e.meta.path === 'cron-catchup')
    .map((e) => ({ station: e.station, outcome: e.meta.outcome }));

describe('#2629 10/31 09:57:45 tick 단독 — 학동은 이 tick에 나간다', () => {
  it('head 강남구청(이미 09:55:45에 발사·dedup) + 열차 학동 sttus1: 학동 alert 1건 + 강남구청 중복 push 0', async () => {
    const r = await replayTick(seedTrip('강남구청'), { dedupStamped: ['강남구청'] });
    expect(alertStations(r)).toEqual(['학동']);
  });

  it('실패 사유 단언: 따라잡기 소비 역(강남구청) 1행이 path=cron-catchup, outcome=skipped-reason(dedup)으로 남는다', async () => {
    const r = await replayTick(seedTrip('강남구청'), { dedupStamped: ['강남구청'] });
    expect(catchupRows(r)).toEqual([{ station: '강남구청', outcome: 'skipped-reason' }]);
  });

  it('취침 변형: 같은 tick에 논현 1역 전 알람(alarm.wav)이 정확히 1건', async () => {
    const r = await replayTick(seedTrip('강남구청', { sleep: true }), { dedupStamped: ['강남구청'] });
    const alarmId = sleepAlarmCollapseId(TOKEN, '논현');
    expect(r.cycle.pushes.filter((p) => p.headers.collapseId === alarmId)).toHaveLength(1);
  });

  it('2역 뒤처진 head(청담): 발사 상한 1 — 가장 최근 역(강남구청)만 발사, 청담은 skipped-by-shift, 이어서 학동 정규 발사', async () => {
    const r = await replayTick(seedTrip('청담'));
    expect({ alerts: alertStations(r), catchup: catchupRows(r) }).toEqual({
      alerts: ['강남구청', '학동'],
      catchup: [
        { station: '강남구청', outcome: 'sent' },
        { station: '청담', outcome: 'skipped-by-shift' },
      ],
    });
  });
});

describe('#2629 거부 — 게이트 하나만 깨면 현행(1 tick 1 waypoint)으로 남는다', () => {
  it('G1: lock trainCode가 캡처의 열차와 다르면 따라잡지 않는다 (학동 alert 0, cron-catchup 행 0)', async () => {
    const r = await replayTick(seedTrip('강남구청', { trainCode: '9999' }));
    expect({ alerts: alertStations(r), catchup: catchupRows(r) }).toEqual({ alerts: [], catchup: [] });
  });

  it('G2: segment가 반대 방향이면(isUp 불일치) 따라잡지 않는다 — 학동 alert 0, cron-catchup 행 0', async () => {
    const r = await replayTick(seedTrip('강남구청', { segment: [...SEGMENT_STATIONS].reverse() }));
    expect({ alerts: alertStations(r).includes('학동'), catchup: catchupRows(r) }).toEqual({ alerts: false, catchup: [] });
  });
});
