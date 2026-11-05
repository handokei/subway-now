/**
 * #2510 재오픈 (2026-11-02) — "알람(alarm.wav)은 취침모드에서만" whole-trip replay.
 *
 * 사용자 지시: "글씨가 아니라 제대로 나가는지에 대해서 테스트를 해야할 것 같은데" →
 * 문구가 아니라 **실제로 나간 APNs 요청**(push 종류·aps.sound·interruption-level·횟수·tick)을 assert한다.
 *
 * 입력은 불변 실측(통과시키려 조정 금지):
 *   - `fixtures/replay_20261021_trip173/` — 비취침 lock 트립(2호선 뚝섬→건대입구 환승→7호선). 11/02 트립 186과 같은
 *     형태(성수→건대입구 환승, 7호선 1역 전 prepare)이며 R2 캡처 + D1 이 repo에 있다.
 *   - `fixtures/replay_20261020_sleep_171/` — 취침 트립(하차 1역 전). 여기서는 취침을 끈 변형(캡처·D1 불변,
 *     trip 설정만 seed)으로 "비취침 하차 1역 전"을 재현한다.
 * 모든 push를 닫힌 분류 집합으로 나누고 `unclassified`는 빈 배열이어야 한다(새 producer가 생기면 red).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCaptureReplay, type CapturedPush } from './helpers/replayHarness';
import {
  buildTransferSeedTrip,
  createDeviceReplayer,
  loadCapsFixture,
  loadD1Events,
  loadTripMetricsRow,
  makeTripEventSink,
  parseRouteSig,
  routeSigOf,
  stubReplayFetch,
} from './helpers/replay20261019';
import { SLEEP_ALARM_MIN_STOPS_BEFORE } from '../../../../src/shared/constants/sleepAlarm';
import { useApnsHarness } from './helpers/sleepAlarmHarness';
import type { Env, Waypoint } from '../types';

afterEach(() => vi.unstubAllGlobals());
useApnsHarness();

type Body = Record<string, unknown>;

type PushClass =
  | 'one-stop-sleep'
  | 'one-stop-prepare'
  | 'one-stop-unknown'
  | 'station-arrival'
  | 'station-intermediate'
  | 'prompt'
  | 'trip-ended'
  | 'train-reconfirm'
  | 'la'
  | 'companion'
  | 'silent-other'
  | 'unclassified';

interface Classified {
  cls: PushClass;
  tickMs: number;
  /** cron 경로 push만 collapse-id를 안다(HTTP 핸들러 push는 본문만 캡처된다). */
  collapseId?: string;
  sound: unknown;
  hasSoundKey: boolean;
  level: unknown;
  dataKind: unknown;
  body: Body;
}

const apsOf = (body: Body) => (body.aps ?? {}) as Record<string, unknown>;
const dataOf = (body: Body) => (body.data ?? {}) as Body;

/** 닫힌 분류. alarm.wav 판정은 분류와 무관하게 모든 push의 aps.sound / aps.alert.sound 를 본다(아래 alarmWavCount). */
function classify(body: Body, collapseId?: string, pushType?: string): PushClass {
  const aps = apsOf(body);
  const data = dataOf(body);
  const kind = data.kind ?? ((body.body ?? {}) as Body).kind;
  if (pushType === 'liveactivity' || aps.event !== undefined || aps['content-state'] !== undefined) return 'la';
  const isAlert = aps.alert !== undefined;
  if (!isAlert) return kind === 'sleep-alarm-companion' ? 'companion' : 'silent-other';
  if (kind === 'boarding-prompt') return 'prompt';
  if (kind === 'trip-ended') return 'trip-ended';
  if (kind === 'train-reconfirm') return 'train-reconfirm';
  if (kind === 'transfer' || kind === 'destination') return 'station-arrival';
  if (kind === 'intermediate') return 'station-intermediate';
  if (/^alarm-/.test(collapseId ?? '')) return 'one-stop-sleep';
  if (/^prepare-/.test(collapseId ?? '')) return 'one-stop-prepare';
  // HTTP 핸들러(sync 소비)가 보낸 1역 전 alert는 collapse-id 없이 본문만 잡힌다 — alarm.wav + data.kind 없음.
  if (aps.sound === 'alarm.wav' && kind === undefined) return 'one-stop-unknown';
  return 'unclassified';
}

function toClassified(body: Body, tickMs: number, collapseId?: string, pushType?: string): Classified {
  const aps = apsOf(body);
  return {
    cls: classify(body, collapseId, pushType),
    tickMs,
    collapseId,
    sound: aps.sound,
    hasSoundKey: 'sound' in aps,
    level: aps['interruption-level'],
    dataKind: dataOf(body).kind ?? ((body.body ?? {}) as Body).kind,
    body,
  };
}

const alarmWavCount = (pushes: Classified[]) =>
  pushes.filter((p) => p.sound === 'alarm.wav' || (apsOf(p.body).alert as { sound?: unknown } | undefined)?.sound === 'alarm.wav')
    .length;
const ofClass = (pushes: Classified[], ...classes: PushClass[]) => pushes.filter((p) => classes.includes(p.cls));

const promptPayload = (push: CapturedPush) => {
  const payload = push.body.body as Body | undefined;
  return payload?.kind === 'boarding-prompt' ? payload : undefined;
};

interface ReplayOpts {
  sleep: boolean;
}

/** 트립 173 — replay_20261023_one_stop_alarm_baseline.test.ts `replay173` 와 동일 재생(설정만 seed). */
async function replay173({ sleep }: ReplayOpts) {
  const dir = 'replay_20261021_trip173';
  const fixture = loadCapsFixture(dir);
  const d1 = loadD1Events(dir, 'events_173.json');
  const metrics = loadTripMetricsRow(dir, 173, 'trip_metrics_173.json');
  const firstMismatch = d1.find((e) => e.kind === 'route-signature-mismatch');
  if (!firstMismatch) throw new Error('fixture 전제 실패');
  const seedWaypoints: Waypoint[] = parseRouteSig(routeSigOf(firstMismatch, 'incomingSig'));
  const transfer = seedWaypoints.find((w) => w.kind === 'transfer') as Waypoint;
  const leg2Line = seedWaypoints[seedWaypoints.indexOf(transfer) + 1].line;
  const leg1Line = transfer.line;
  const token = 'replay-2510-173';
  const seedTrip = buildTransferSeedTrip({
    token,
    waypoints: seedWaypoints,
    originStationName: metrics.origin_station as string,
    now: fixture.window.fromMs,
    overrides: {
      infoModeEnabled: true,
      activityPushToken: 'ab'.repeat(32),
      activityState: 'live',
      ...(sleep ? { sleepModeEnabled: true } : {}),
    },
  });
  const { db } = makeTripEventSink();
  const stub = stubReplayFetch(fixture);
  const replayer = createDeviceReplayer({
    rows: d1,
    token,
    stub,
    tapBody: (tapIndex, pushes) => {
      const tapLine = tapIndex === 0 ? leg1Line : leg2Line;
      const station = tapIndex === 0 ? (metrics.origin_station as string) : transfer.stationName;
      const prompt = pushes.map(promptPayload).find((p) => p?.line === tapLine && Array.isArray(p?.candidateTrains));
      if (!prompt) throw new Error('사슬 단절');
      return { station, line: tapLine, trainCode: prompt.trainCode as string };
    },
    mergeSyncByTs: true,
  });
  const result = await runCaptureReplay({
    locklessAdvanceLegacy: true, // K5 #2926 PR-A: lockless 전진을 전제로 쓰인 구 replay - 구 경로(kill switch legacy) 보호용 고정
    fixture,
    seedTrips: [seedTrip],
    apns: 'capture',
    twoPass: true,
    beforeTick: async ({ tick, env, pushes }) => {
      (env as unknown as { DB: D1Database }).DB = db;
      stub.setNow(tick);
      await replayer.beforeTick({ tick, env: env as Env, pushes });
    },
  });
  return { fixture, result, seedWaypoints, httpPushes: stub.httpPushes };
}

/** 트립 171 — replay_20261023_one_stop_alarm_baseline.test.ts `replay171` 과 동일 재생. 취침 여부만 변형. */
async function replay171({ sleep }: ReplayOpts) {
  const dir = 'replay_20261020_sleep_171';
  const token = 'replay-2510-171';
  const fixture = loadCapsFixture(dir);
  const d1 = loadD1Events(dir, 'events_171.json');
  const metrics = loadTripMetricsRow(dir, 171, 'trip_metrics_171.json');
  const firstMismatch = d1.find((e) => e.kind === 'route-signature-mismatch');
  if (!firstMismatch) throw new Error('fixture 전제 실패');
  const seedWaypoints: Waypoint[] = parseRouteSig(routeSigOf(firstMismatch, 'existingSig'));
  const seedTrip = buildTransferSeedTrip({
    token,
    waypoints: seedWaypoints,
    originStationName: metrics.origin_station as string,
    now: fixture.window.fromMs,
    overrides: { sleepModeEnabled: sleep, infoModeEnabled: true, activityPushToken: 'ab'.repeat(32), activityState: 'live' },
  });
  const { db } = makeTripEventSink();
  const stub = stubReplayFetch(fixture);
  const replayer = createDeviceReplayer({
    rows: d1,
    token,
    stub,
    tapBody: () => {
      throw new Error('트립 171 D1에는 boarding-confirm-result 행이 없다');
    },
    mergeSyncByTs: true,
    register: {
      fromMs: fixture.window.fromMs,
      body: {
        destination: metrics.destination_station,
        route: seedTrip.route,
        createdAt: seedTrip.createdAt,
        infoModeEnabled: true,
        sleepModeEnabled: sleep,
      },
    },
  });
  const result = await runCaptureReplay({
    locklessAdvanceLegacy: true, // K5 #2926 PR-A: lockless 전진을 전제로 쓰인 구 replay - 구 경로(kill switch legacy) 보호용 고정
    fixture,
    seedTrips: [seedTrip],
    apns: 'capture',
    twoPass: true,
    beforeTick: async ({ tick, env, pushes }) => {
      (env as unknown as { DB: D1Database }).DB = db;
      stub.setNow(tick);
      await replayer.beforeTick({ tick, env: env as Env, pushes });
    },
  });
  return { fixture, result, seedWaypoints, httpPushes: stub.httpPushes };
}

/** cron 1차·mid pass push(헤더 포함) + HTTP 핸들러 push(본문만)를 한 목록으로. */
function collect(r: { result: Awaited<ReturnType<typeof runCaptureReplay>>; httpPushes: Body[] }): Classified[] {
  const cron = r.result.pushes.map((p) =>
    toClassified(p.body, p.simNowMs, p.headers.collapseId, p.headers.pushType),
  );
  const http = r.httpPushes.map((b) => toClassified(b, -1));
  return [...cron, ...http];
}

/** D1 baseline(현 dev 코드로 재생해 박은 값, red 커밋 PR 본문 첨부). */
const NORMAL_ARRIVAL_SOUND_KEY = false; // D1 기본 S: aps.sound 키 부재
const NORMAL_ARRIVAL_LEVEL = 'active';

describe('#2510 재오픈 — 트립 173(비취침, 환승 후 7호선) 실제 APNs 요청', () => {
  it('T1·T5 비취침: alarm.wav 0건(전 push), 분류 안 되는 push 0', async () => {
    const all = collect(await replay173({ sleep: false }));
    expect(ofClass(all, 'unclassified')).toEqual([]);
    expect(alarmWavCount(all)).toBe(0);
  });

  it('T2 비취침: 1정거장 전 push(prepare/sleep/미상)와 companion silent 0건', async () => {
    const all = collect(await replay173({ sleep: false }));
    expect(ofClass(all, 'one-stop-sleep', 'one-stop-prepare', 'one-stop-unknown', 'companion')).toEqual([]);
  });

  it('T3 비취침: 환승·하차 도착 push는 발사되며(0건 아님) 전부 sound 키 부재 + interruption-level active', async () => {
    const all = collect(await replay173({ sleep: false }));
    const arrivals = ofClass(all, 'station-arrival');
    expect(arrivals.length).toBeGreaterThan(0);
    for (const p of arrivals) {
      expect({ kind: p.dataKind, hasSoundKey: p.hasSoundKey, level: p.level }).toEqual({
        kind: p.dataKind,
        hasSoundKey: NORMAL_ARRIVAL_SOUND_KEY,
        level: NORMAL_ARRIVAL_LEVEL,
      });
    }
  });

  it('T8·T9 취침 변형(같은 캡처·D1): 1역 전 alarm.wav 정확히 1(환승역) + companion 정확히 1 + prepare 0 + 매역 0', async () => {
    const r = await replay173({ sleep: true });
    const all = collect(r);
    expect(ofClass(all, 'unclassified')).toEqual([]);
    expect(ofClass(all, 'one-stop-prepare')).toEqual([]);
    expect(ofClass(all, 'station-intermediate')).toEqual([]);
    const oneStop = ofClass(all, 'one-stop-sleep', 'one-stop-unknown');
    expect(oneStop).toHaveLength(1);
    expect(oneStop[0].sound).toBe('alarm.wav');
    expect(oneStop[0].level).toBe('time-sensitive');
    expect(ofClass(all, 'companion')).toHaveLength(1);
  });

  it('T8 취침 변형: 환승·하차 도착 push는 전부 alarm.wav + time-sensitive', async () => {
    const all = collect(await replay173({ sleep: true }));
    for (const p of ofClass(all, 'station-arrival')) {
      expect({ kind: p.dataKind, sound: p.sound, level: p.level }).toEqual({
        kind: p.dataKind,
        sound: 'alarm.wav',
        level: 'time-sensitive',
      });
    }
  });

  it('T4 같은 입력에서 도착 push 발사 tick은 모드(비취침/취침)와 무관하게 동일 — sound만 달라지고 시점은 불변', async () => {
    const normal = ofClass(collect(await replay173({ sleep: false })), 'station-arrival').map((p) => p.tickMs);
    const sleep = ofClass(collect(await replay173({ sleep: true })), 'station-arrival').map((p) => p.tickMs);
    expect(normal.length).toBeGreaterThan(0);
    expect(normal).toEqual(sleep);
  });
});

describe('#2510 재오픈 — 트립 171(하차 1역 전) 비취침 변형 실제 APNs 요청', () => {
  it('T1·T2 비취침: 하차 1역 전 push·companion·alarm.wav 0건', async () => {
    const all = collect(await replay171({ sleep: false }));
    expect(ofClass(all, 'unclassified')).toEqual([]);
    expect(ofClass(all, 'one-stop-sleep', 'one-stop-prepare', 'one-stop-unknown', 'companion')).toEqual([]);
    expect(alarmWavCount(all)).toBe(0);
  });

  it('T6·T7 취침(원본 설정): 하차 1역 전 alarm.wav 정확히 1 + time-sensitive + companion 정확히 1', async () => {
    const all = collect(await replay171({ sleep: true }));
    expect(ofClass(all, 'unclassified')).toEqual([]);
    const oneStop = ofClass(all, 'one-stop-sleep', 'one-stop-unknown');
    expect(oneStop).toHaveLength(1);
    expect(oneStop[0].sound).toBe('alarm.wav');
    expect(oneStop[0].level).toBe('time-sensitive');
    expect(ofClass(all, 'companion')).toHaveLength(1);
    expect(ofClass(all, 'one-stop-prepare')).toEqual([]);
    expect(SLEEP_ALARM_MIN_STOPS_BEFORE).toBe(1);
  });
});
