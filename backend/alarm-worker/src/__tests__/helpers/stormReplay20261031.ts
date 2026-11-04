/**
 * #2308 / #3055 PR-4b — 10/31 재등록 폭주(`replay_20261031_reregister_storm`) 재생 공용 helper.
 *
 * 원 테스트(`replay_20261031_reregister_storm.test.ts`)와 진행 셀 테스트(`replay_20261031_progress_cell.test.ts`)가 같은 재생을 쓴다.
 * 입력은 불변 실측 — `fixtures/replay_20261031_reregister_storm/`(caps 5 cycle, D1 events 1861~1940). 통과시키려 조정 금지.
 * 셀 단계(`cells`)가 지정되면 TripDO fake를 바인딩한다. `primeProgress:false`는 progress KV를 심지 않는다(맞춤이 복구할 근거 제거).
 */
import { vi } from 'vitest';
import type { Env, Trip, Waypoint } from '../../types';
import { waypointSignatureKey } from '../../trips';
import { runCaptureReplay } from './replayHarness';
import {
  createDeviceReplayer,
  loadCapsFixture,
  loadD1Events,
  makeTripEventSink,
  parseRouteSig,
  routeSigOf,
  stubReplayFetch,
} from './replay20261019';
import { attachDb, latestTrip, makeLagKv, primeReplayKv } from './progressAuthorityReplay';
import { firedStationOccurrences } from './pushAssertions';
import { makeLockCellReplayEnv, type LockCellFlag } from './lockCellReplayEnv';

export const DIR = 'replay_20261031_reregister_storm';
export const TOKEN = 'replay-2308-1031';
const HOUR_MS = 60 * 60_000;
/** D1 1912(09:55:40) — 재생 시작 상태 직전. 이 시각 이후의 재등록만 주입한다(1913 09:55:43 포함). */
export const REGISTER_FROM_MS = 1793408140000;
/** 학동 도착(R2 캡처 1793408265543, sttus=1, recptn 09:57:13)을 볼 수 있는 첫 cron tick = 3번째 cycle. */
export const ARRIVAL_TICK_INDEX = 2;
export const STORM_STATIONS = { head: '강남구청', next: '학동', destination: '논현' } as const;

export const rows = loadD1Events(DIR, 'events.json');
const rowOf = (id: number) => {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`D1 행 ${id}이 fixture에 없다`);
  return row;
};
/** D1 1877(09:43:28)의 existingSig = 군자 head 시점 전체 잔여 노선. lock 부착(09:41)에서 소비된 중곡을 앞에 더하면 원본 노선. */
export const FULL_ROUTE_NAMES = ['중곡', ...parseRouteSig(routeSigOf(rowOf(1877), 'existingSig')).map((w) => w.stationName)];
/** D1 1912(09:55:40) existingSig = 재생 시작 시점 backend 진행분 = [강남구청, 학동, 논현]. */
const seedWaypoints = (): Waypoint[] =>
  parseRouteSig(routeSigOf(rowOf(1912), 'existingSig')).map((w) => ({ ...w, hopIndex: FULL_ROUTE_NAMES.indexOf(w.stationName) }));
/** lock 7077 segment = 탑승역(용마산, D1 1865 lock-attached station) + 부착 시점 잔여 노선 전체. */
const SEGMENT_STATIONS = [rowOf(1865).station as string, ...FULL_ROUTE_NAMES];

export const fixture = loadCapsFixture(DIR);

function seedTrip(overrides: Partial<Trip> = {}): Trip {
  const now = fixture.window.fromMs;
  const waypoints = seedWaypoints();
  return {
    token: TOKEN,
    route: { type: 'direct', line: '7', stops: FULL_ROUTE_NAMES.length } as Trip['route'],
    destination: STORM_STATIONS.destination,
    originStationName: SEGMENT_STATIONS[0],
    waypoints,
    routeWaypoints: FULL_ROUTE_NAMES.map((stationName, hopIndex) => ({
      stationName,
      line: '7',
      kind: stationName === STORM_STATIONS.destination ? 'destination' : 'intermediate',
      hopIndex,
    })),
    boardingLock: {
      trainCode: '7077',
      line: '7',
      subwayId: '1007',
      selectedDepartureTime: now - 14 * 60_000,
      segmentStations: SEGMENT_STATIONS,
      expiresAt: now + HOUR_MS,
    },
    expiresAt: now + 3 * HOUR_MS,
    createdAt: now - 18 * 60_000,
    alarmAtEpochMs: now,
    infoModeEnabled: true,
    consecutiveEtaMissing: 0,
    ...overrides,
  } as Trip;
}

export interface StormOpts {
  /** 재등록 payload에 lock을 싣는가(10/31 payload의 lock 실림 여부는 D1에 기록이 없어 두 변형을 모두 돌린다). */
  registerCarriesLock: boolean;
  sleep?: boolean;
  /** 재등록 주입을 끈다(대조군 — "재등록이 LA push를 늘리지 않음" 등식의 기준). */
  noRegisters?: boolean;
  laLive?: boolean;
  /** 셀 권위 단계(미지정=flag off, DO 바인딩 없음). */
  cells?: LockCellFlag | `progress@${number}`;
  /** false면 운영 상태의 progress KV 시드를 생략한다(기본 true). */
  primeProgress?: boolean;
}

export async function replayStorm(opts: StormOpts) {
  const trip = seedTrip({
    ...(opts.sleep ? { sleepModeEnabled: true } : {}),
    ...(opts.laLive ? { activityPushToken: 'ab'.repeat(32), activityState: 'live' as const } : {}),
  });
  const { db, events } = makeTripEventSink();
  const stub = stubReplayFetch(fixture);
  const cells = opts.cells ? makeLockCellReplayEnv(opts.cells as LockCellFlag) : undefined;
  const registerBody: Record<string, unknown> = {
    destination: trip.destination,
    route: trip.route,
    createdAt: trip.createdAt,
    infoModeEnabled: true,
    sleepModeEnabled: opts.sleep === true,
    ...(opts.registerCarriesLock ? { boardingLock: trip.boardingLock } : {}),
  };
  const replayer = createDeviceReplayer({
    rows: opts.noRegisters ? [] : rows.filter((r) => r.ts >= REGISTER_FROM_MS),
    token: TOKEN,
    stub,
    tapBody: () => {
      throw new Error('이 구간 D1에는 재생 대상 boarding-confirm이 없다');
    },
    mergeSyncByTs: true,
    register: { fromMs: REGISTER_FROM_MS, body: registerBody },
  });
  // seed trip과 progress는 지연 창 밖(과거)에 쓴다.
  vi.setSystemTime(fixture.window.fromMs - 10 * 60_000);
  const headsAfterTick: Array<string | undefined> = [];
  let kvRef: KVNamespace | undefined;
  const eventCountAtTickStart: number[] = [];
  const result = await runCaptureReplay({
    fixture,
    seedTrips: [trip],
    apns: 'capture',
    makeKv: makeLagKv,
    beforeTick: async ({ tick, tickIndex, env, kv, pushes }) => {
      kvRef = kv;
      if (tickIndex === 0) {
        await primeReplayKv(kv, tick, {
          token: TOKEN,
          // 운영 상태: lock 부착 이후 tick마다 mirror된 progress가 이미 있다(구 형식 — headKey 없음, 배포 직후 상태).
          progress:
            opts.primeProgress === false
              ? undefined
              : {
                  trainCode: '7077',
                  shiftedCount: FULL_ROUTE_NAMES.indexOf(STORM_STATIONS.head),
                  headHopIndex: FULL_ROUTE_NAMES.indexOf(STORM_STATIONS.head),
                  headKey: waypointSignatureKey(trip.waypoints[0]),
                  ttlBasisExpiresAt: trip.expiresAt,
                },
        });
        if (cells) await cells.install(env as Env, kv);
      } else {
        headsAfterTick.push(latestTrip(kv, TOKEN)?.waypoints[0]?.stationName);
      }
      attachDb(env as Env, db);
      eventCountAtTickStart.push(events.length);
      stub.setNow(tick);
      await replayer.beforeTick({ tick, env: env as Env, pushes });
      vi.setSystemTime(tick);
    },
  });
  eventCountAtTickStart.push(events.length);
  if (kvRef) headsAfterTick.push(latestTrip(kvRef, TOKEN)?.waypoints[0]?.stationName);
  return { result, events, eventCountAtTickStart, headsAfterTick, registers: replayer.registers, httpPushes: stub.httpPushes };
}

export const stationAlertTicks = (r: Awaited<ReturnType<typeof replayStorm>>, station: string): number[] =>
  r.result.cycles.flatMap((cycle) =>
    firedStationOccurrences(cycle.pushes)
      .filter((name) => name === station)
      .map(() => cycle.simNowMs),
  );
/** tick별 cron-fire-attempt 행의 station(어떤 outcome이든 그 tick에 그 역을 소비 대상으로 평가했다는 뜻). */
export function attemptStationsByTick(r: Awaited<ReturnType<typeof replayStorm>>): string[][] {
  return r.result.cycles.map((_, i) =>
    r.events
      .slice(r.eventCountAtTickStart[i], r.eventCountAtTickStart[i + 1])
      .filter((e) => e.kind === 'cron-fire-attempt')
      .map((e) => e.station as string),
  );
}
