/**
 * #2629 / #3055 PR-4b — 10/31 09:57:45 tick 단독 replay(lock 열차 위치 따라잡기) 재생 공용 helper.
 * 원 테스트와 진행 셀 테스트(`replay_20261031_catchup_progress_cell.test.ts`)가 같은 재생을 쓴다. 입력은 불변 실측 —
 * `fixtures/replay_20261031_reregister_storm/caps/1793408265543.json`. 통과시키려 조정 금지. `cells`가 지정되면 TripDO fake를 바인딩한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import type { Env, Trip, Waypoint } from '../../types';
import { stationPassedFiredKey } from '../../scheduled';
import { waypointSignatureKey } from '../../trips';
import { buildReplayFixture, parseSeoulCaptureCycle } from '../../replayFixture';
import { runCaptureReplay } from './replayHarness';
import { loadD1Events, makeTripEventSink, parseRouteSig, routeSigOf, stubReplayFetch } from './replay20261019';
import { attachDb, makeLagKv, primeReplayKv } from './progressAuthorityReplay';
import { firedStationOccurrences } from './pushAssertions';
import { makeLockCellReplayEnv, type LockCellFlag } from './lockCellReplayEnv';

export const DIR = 'replay_20261031_reregister_storm';
const CAPTURE_FILE = '1793408265543.json';
export const TOKEN = 'replay-2629-1031';
const HOUR_MS = 60 * 60_000;

export const rows = loadD1Events(DIR, 'events.json');
const rowOf = (id: number) => {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`D1 행 ${id}이 fixture에 없다`);
  return row;
};
/** D1 1877 existingSig(군자 head) 앞에 lock 부착 시점에 소비된 중곡을 더하면 원본 노선(#3282 replay와 동일). */
export const FULL_ROUTE_NAMES = ['중곡', ...parseRouteSig(routeSigOf(rowOf(1877), 'existingSig')).map((w) => w.stationName)];
/** lock 7077 segment = 탑승역(용마산, D1 1865) + 부착 시점 잔여 노선 전체. */
export const SEGMENT_STATIONS = [rowOf(1865).station as string, ...FULL_ROUTE_NAMES];

export const fixture = buildReplayFixture([
  parseSeoulCaptureCycle(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', DIR, 'caps', CAPTURE_FILE), 'utf-8'))),
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

export function seedTrip(headName: string, overrides: { trainCode?: string; segment?: string[]; sleep?: boolean } = {}): Trip {
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

export async function replayTick(trip: Trip, opts: {
    dedupStamped?: string[];
    cells?: LockCellFlag | `progress@${number}`;
    /** 첫 tick 직전(셀 설치 직후)에 호출 — 셀 상태를 미리 만드는 용도. */
    beforeFirstTick?: (env: Pick<Env, 'TRIPS' | 'TRIP_DO'>) => Promise<void>;
  } = {}) {
  const { db, events } = makeTripEventSink();
  const stub = stubReplayFetch(fixture);
  const cells = opts.cells ? makeLockCellReplayEnv(opts.cells as LockCellFlag) : undefined;
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
      if (cells) await cells.install(env as Env, kv);
      if (cells && opts.beforeFirstTick) await opts.beforeFirstTick({ TRIPS: kv, TRIP_DO: cells.doNs.ns });
      attachDb(env as Env, db);
      stub.setNow(tick);
      vi.setSystemTime(tick);
    },
  });
  return { result, cycle: result.cycles[0], events, cells };
}

export type Run = Awaited<ReturnType<typeof replayTick>>;

export const alertStations = (r: Run) => firedStationOccurrences(r.cycle.pushes);
export const catchupRows = (r: Run) =>
  r.events
    .filter((e) => e.kind === 'cron-fire-attempt' && e.meta.path === 'cron-catchup')
    .map((e) => ({ station: e.station, outcome: e.meta.outcome }));
