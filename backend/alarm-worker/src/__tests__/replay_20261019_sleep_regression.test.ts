/**
 * #3089 — 2026-10-19 저녁 **취침모드 실패** 트립 whole-trip replay (결함 문서화: `it.fails`).
 *
 * 실측: 17:58~18:11 KST, 뚝섬(2) -> 건대입구 환승 -> 7호선 용마산(destination), 취침모드 ON,
 * D1 `trip_metrics` id=168(token_hash b00dd879, end_reason destination-arrived). 실도착은 18:17:34
 * (기기 덤프 `텍스트-91AC77DE33DA-1.txt` Raw Signal 7-015 arvlCd=1) — trip은 5분 40초 일찍 끝났다.
 * 입력은 불변 실측(통과시키려 조정 금지): `fixtures/replay_20261019_sleep_regression/` 의
 * `caps/*.json`(R2 seoul-capture 18 cycle), `events_168.json`(D1 trip_events, ts BETWEEN
 * 1792400200000 AND 1792401200000), `trip_metrics_166_168.json`.
 *
 * root = #3083(환승 체류 중 leg-2 탑승 확증 전 가짜 전진) + #2801(탭 거부가 확증 지연의 공범).
 *
 * ## 재현 충실도 (D1을 oracle로)
 * 재생은 D1 device 기원 행(`sync-received`, `boarding-confirm-result`)을 D1 ts 순서대로 주입한다.
 * 아래가 **D1과 같게 재현**됨을 확인했다: advance 3건(18:04:10/18:04:29/18:05:43 상당), 탭 2회의
 * `walk-gated`, 3번째 탭 `lockState=leg2/anchorSource=currentLegAnchor/trainCodeSource=body`,
 * leg-2 프롬프트 발사 시각(18:08:45), `leg-resolve-attempt` 후보(7268).
 *
 * ## 추정 입력 (D1/캡처에 없어 둔 값 — `확정` 아님)
 *   1. 탭 1·2의 body에 `trainCode` 없음(LA 버튼 모양). `walk-gated`는 live resolve 경로에서만
 *      나온다(body-promote 경로는 walk-gate를 평가하지 않는다 — index.ts resolveBodyTrainCodeLock).
 *      D1 outcome=walk-gated가 이 모양을 뒷받침한다. 탭 3은 프롬프트 payload의 열차(body, D1 일치).
 *   2. `/position` motion series: backend KV `pos:<token>`은 trip 종료 시 폐기돼 D1/R2 어디에도 없다.
 *      lockless 전진은 motion 최빈값(walking/automotive)으로만 게이트되므로(scheduled.ts
 *      isAdvanceAllowedByMotion) 기기 덤프의 motion 라벨(18:04:28~18:17:36 automotive 연속)에 맞춰
 *      **motion/accuracy만** 실측 라벨을 쓰고 lat/lng는 고정 placeholder다(좌표는 실측 아님).
 *   3. seed trip: `sleepModeEnabled=true`(덤프 `sleepMode=on`), `infoModeEnabled=true`, promptDisplay 없음
 *      (D1에 origin 프롬프트 이벤트 없음), LA 토큰 있음(D1 la-token-register stored).
 *   4. sync body `accuracy`=20(D1에 없음, #901 게이트 ≤50m 통과 값).
 *
 * ## 재생으로 재현되지 않아 `it.todo`인 것
 *   - "실도착 전 destination-arrived 조기 종료"(D1 18:11:50 `lockless-destination-waypoints-exhausted`).
 *     D1상 18:10:22 탭 이후에도 18:10:45/18:11:45에 `leg-resolve-attempt`(lockless 연속확증)가 계속 도는데,
 *     재생은 그 탭의 leg-2 lock이 유지되어 lock-active 경로로 간다. 차이를 만드는 입력(18:10:49~
 *     device trip-register 재등록 payload, SSoT/KV 스냅샷)이 D1에 남지 않아 재현 불가 — 합성으로 지어내지 않는다.
 *
 * ## 이 파일이 요구하는 것
 * `it.fails` 는 "현재 결함" 문서화다(CI green). 수정(#3083/#2801) 머지 시 해당 `it.fails`가
 * 통과로 바뀌어 **CI가 빨개지므로** 그때 `.fails`를 떼고 [현재 결함 고정] 짝 테스트를 지운다.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRAIN_STATUS } from '../alarm';
import { runCaptureReplay, type CapturedPush } from './helpers/replayHarness';
import { firedStationOccurrences } from './helpers/pushAssertions';
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
  type D1TripEventRow,
  type RecordedTripEvent,
} from './helpers/replay20261019';
import type { Env, PositionPoint, Waypoint } from '../types';

const FIXTURE_DIR = 'replay_20261019_sleep_regression';
const TRIP_METRICS_ID = 168;
const TOKEN = 'replay-20261019-sleep';
/** 기기 덤프 Raw Signal의 motion 라벨 주기(`/position` 업로드 간격 근사). */
const MOTION_SAMPLE_INTERVAL_MS = 30_000;

afterEach(() => vi.unstubAllGlobals());

function d1Meta(row: D1TripEventRow): Record<string, unknown> {
  return JSON.parse(row.meta ?? '{}') as Record<string, unknown>;
}

function promptPayload(push: CapturedPush): Record<string, unknown> | undefined {
  const payload = push.body.body as Record<string, unknown> | undefined;
  return payload?.kind === 'boarding-prompt' ? payload : undefined;
}

function pushData(push: CapturedPush): Record<string, unknown> | undefined {
  return push.body.data as Record<string, unknown> | undefined;
}

/** 취침 "하차 알람" companion — backend `maybeFireSleepAlarm`의 silent companion push(목적지 대상). */
function isDestinationSleepAlarm(push: CapturedPush): boolean {
  const data = pushData(push);
  return data?.kind === 'sleep-alarm-companion' && data?.targetKind === 'destination';
}

interface Replayed {
  seedWaypoints: Waypoint[];
  destination: Waypoint;
  leg2Line: string;
  events: RecordedTripEvent[];
  pushes: CapturedPush[];
  cycles: { simNowMs: number; pushes: CapturedPush[] }[];
  taps: ReturnType<typeof createDeviceReplayer>['taps'];
  d1: D1TripEventRow[];
  /** 추적 열차가 목적지 직전 역에 진입/도착(realtimePosition trainSttus 0/1)으로 처음 관측된 캡처 시각 = "1정거장 전" 실측 시점. */
  oneStopBeforeMs: number;
  fixtureEntries: ReturnType<typeof loadCapsFixture>['entries'];
}

async function replaySleepTrip(): Promise<Replayed> {
  const fixture = loadCapsFixture(FIXTURE_DIR);
  const d1 = loadD1Events(FIXTURE_DIR, 'events_168.json');
  const metrics = loadTripMetricsRow(FIXTURE_DIR, TRIP_METRICS_ID);
  const originStation = metrics.origin_station as string;

  // 원본 전체 route = 첫 route-signature-mismatch의 existingSig(backend 진행 전 상태).
  const firstMismatch = d1.find((e) => e.kind === 'route-signature-mismatch');
  if (!firstMismatch) throw new Error('fixture 전제 실패 — route-signature-mismatch 행 없음');
  const seedWaypoints = parseRouteSig(routeSigOf(firstMismatch, 'existingSig'));
  const transfer = seedWaypoints.find((w) => w.kind === 'transfer') as Waypoint;
  const leg2Line = seedWaypoints[seedWaypoints.indexOf(transfer) + 1].line;
  const destination = seedWaypoints[seedWaypoints.length - 1];
  const penultimate = seedWaypoints[seedWaypoints.length - 2];

  const seedTrip = buildTransferSeedTrip({
    token: TOKEN,
    waypoints: seedWaypoints,
    originStationName: originStation,
    now: fixture.window.fromMs,
    overrides: {
      sleepModeEnabled: true,
      infoModeEnabled: true,
      activityPushToken: 'ab'.repeat(32),
      activityState: 'live',
    },
  });

  // motion series(추정 입력 2): 환승역 첫 sync 시각부터 마지막 캡처까지 automotive 라벨.
  const firstTransferSync = d1.find((e) => e.kind === 'sync-received' && e.station === transfer.stationName);
  const seriesStart = (firstTransferSync as D1TripEventRow).ts;
  const motionSeries: PositionPoint[] = [];
  for (let ts = seriesStart; ts <= fixture.window.toMs; ts += MOTION_SAMPLE_INTERVAL_MS) {
    motionSeries.push({ lat: 37.5, lng: 127.0, accuracy: 20, ts, motion: 'automotive' });
  }

  const { db, events } = makeTripEventSink();
  const stub = stubReplayFetch(fixture);
  const replayer = createDeviceReplayer({
    rows: d1,
    token: TOKEN,
    stub,
    tapBody: (tapIndex, pushes) => {
      const base = { station: transfer.stationName, line: leg2Line };
      // 추정 입력 1: 탭 1·2는 trainCode 없음(LA 버튼), 탭 3은 프롬프트가 실은 열차(body).
      if (tapIndex < 2) return base;
      const prompt = pushes.map(promptPayload).find((p) => p?.line === leg2Line && Array.isArray(p?.candidateTrains));
      if (!prompt) throw new Error('3번째 탭 시점에 leg-2 프롬프트 push가 없다 — 사슬 단절');
      return { ...base, trainCode: prompt.trainCode as string };
    },
  });

  const result = await runCaptureReplay({
    fixture,
    seedTrips: [seedTrip],
    apns: 'capture',
    twoPass: true,
    seedPositionSeries: { [TOKEN]: motionSeries },
    beforeTick: async ({ tick, env, pushes }) => {
      (env as unknown as { DB: D1Database }).DB = db;
      stub.setNow(tick);
      await replayer.beforeTick({ tick, env: env as Env, pushes });
    },
  });

  // "1정거장 전" 실측 시점: 프롬프트가 제시한 열차(3번째 탭이 lock)가 목적지 직전 역에 진입/도착으로 캡처된 최초 시각.
  const leg2Prompt = result.pushes.map(promptPayload).find((p) => p?.line === leg2Line && Array.isArray(p?.candidateTrains));
  const trackedTrain = leg2Prompt?.trainCode as string;
  const approachingStatuses: number[] = [TRAIN_STATUS.APPROACHING, TRAIN_STATUS.ARRIVED];
  const oneStopEntry = fixture.entries
    .filter((e) => e.kind === 'position')
    .find((e) => {
      const list = (JSON.parse(e.body) as { realtimePositionList: { trainNo: string; statnNm: string; trainSttus: string }[] })
        .realtimePositionList;
      return list.some(
        (p) => p.trainNo === trackedTrain && p.statnNm === penultimate.stationName && approachingStatuses.includes(Number(p.trainSttus)),
      );
    });
  if (!oneStopEntry) throw new Error('fixture 전제 실패 — 추적 열차의 목적지 직전 역 도착 캡처 없음');

  return {
    seedWaypoints,
    destination,
    leg2Line,
    events,
    pushes: result.pushes,
    cycles: result.cycles,
    taps: replayer.taps,
    d1,
    oneStopBeforeMs: oneStopEntry.tMs,
    fixtureEntries: fixture.entries,
  };
}

describe('#3089 10/19 저녁 취침 트립 — 현재 결함 문서화 (it.fails = 수정 시 통과로 바뀌어 CI가 알린다)', () => {
  // ── 결함 1: 탑승 탭 거부 (#2801 / #3083) ────────────────────────────────────────────────
  it.fails('탑승 탭(18:08:52 상당)이 수락된다 — 현재: walk-gate가 거부(outcome=walk-gated, lock 없음) [#2801/#3083]', async () => {
    const r = await replaySleepTrip();
    const [firstTap] = r.taps;
    // 사용자는 열차 도착(프롬프트 18:08:45) 7초 뒤 명시 의향으로 탭했다 — 수락돼 lock이 생겨야 한다.
    expect(firstTap.response.lockState).not.toBe('none');
  });

  it('[현재 결함 고정] 탭 1·2는 walk-gated로 거부되고 3번째 탭만 수락된다 — D1과 동일 라벨', async () => {
    const r = await replaySleepTrip();
    const confirmEvents = r.events.filter((e) => e.kind === 'boarding-confirm-result').map((e) => e.meta);
    expect(confirmEvents.slice(0, 2)).toEqual([
      { lockState: 'none', outcome: 'walk-gated' },
      { lockState: 'none', outcome: 'walk-gated' },
    ]);
    expect(confirmEvents[2]).toMatchObject({ lockState: 'leg2', anchorSource: 'currentLegAnchor', trainCodeSource: 'body' });
    // D1 실측과 동일(탭 3회: walk-gated, walk-gated, leg2/body).
    const d1Taps = r.d1.filter((e) => e.kind === 'boarding-confirm-result').map(d1Meta);
    expect(d1Taps.slice(0, 2)).toEqual([
      { lockState: 'none', outcome: 'walk-gated' },
      { lockState: 'none', outcome: 'walk-gated' },
    ]);
    expect(d1Taps[2]).toMatchObject({ lockState: 'leg2', anchorSource: 'currentLegAnchor', trainCodeSource: 'body' });
    expect(r.taps.map((t) => t.response.lockState)).toEqual(['none', 'none', 'leg2']);
  });

  // ── 결함 2: 하차(취침 companion) 알람 조기 발사 (#3083) ─────────────────────────────────
  it.fails('하차(취침 companion) 알람이 실제 1정거장 전(추적 열차가 목적지 직전 역에 진입/도착한 시점) 이후에 발사된다 — 현재: 수 분 일찍 [#3083]', async () => {
    const r = await replaySleepTrip();
    const alarms = r.cycles.flatMap((c) => c.pushes.filter(isDestinationSleepAlarm).map(() => c.simNowMs));
    expect(alarms.length).toBeGreaterThan(0);
    // 실측 기준: 목적지 직전 역에 추적 열차가 진입/도착한 최초 캡처 시각(1 cron 주기 여유).
    for (const firedAt of alarms) {
      expect(firedAt).toBeGreaterThanOrEqual(r.oneStopBeforeMs - 60_000);
    }
  });

  it('[현재 결함 고정] 취침 하차 알람은 환승 체류 중의 가짜 전진 직후 "1정거장 전" 실측 시점보다 훨씬 일찍 발사된다', async () => {
    const r = await replaySleepTrip();
    const alarmCycles = r.cycles.filter((c) => c.pushes.some(isDestinationSleepAlarm));
    expect(alarmCycles).toHaveLength(1);
    const firedAt = alarmCycles[0].simNowMs;
    // 이유: D1 `advance`가 환승역 이후 구간을 sync/lockless로 빠르게 소비 -> 남은 waypoint가 목적지뿐.
    expect(r.events.filter((e) => e.kind === 'advance').length).toBeGreaterThanOrEqual(3);
    // 실도착(18:17:34) 전 5분 이상 일찍 — 기기 덤프 18:09:49 companion / 18:05:34·18:08:59 safety-net과 같은 계열.
    expect(r.oneStopBeforeMs - firedAt).toBeGreaterThan(5 * 60_000);
    // 목적지 대상(`nextStation`)이 실제 destination이다.
    const alarm = alarmCycles[0].pushes.find(isDestinationSleepAlarm);
    expect(pushData(alarm as CapturedPush)?.nextStation).toBe(r.destination.stationName);
  });

  // ── 결함 3: 실도착 전 destination-arrived 조기 종료 — 재생 불가 ─────────────────────────
  it.todo(
    '실도착 전에 destination-arrived로 종료되지 않는다 — D1 18:11:50 lockless-destination-waypoints-exhausted(실도착 18:17:34보다 5분40초 조기). ' +
      '재생 불가: 18:10:49~ device trip-register 재등록/KV 스냅샷이 D1에 없어 lock 유지(lock-active)로 흐른다 — 합성 금지 [#3083]',
  );
});

describe('#3089 10/19 저녁 취침 트립 — 통과 가드 (의도 동작 고정)', () => {
  it('매역 알림은 취침모드에서 억제된다 — station-passed alert 0건, cron sent 0건 (ADR-023: 알림 채널만 mute)', async () => {
    const r = await replaySleepTrip();
    // backend는 취침 trip의 매역 "alert"를 mute한다(`station-notif-sleep`). silent intermediate는 device 게이트 소관.
    expect(firedStationOccurrences(r.pushes)).toEqual([]);
    const sent = r.events.filter(
      (e) => e.kind === 'cron-fire-attempt' && e.meta.waypointKind === 'station-passed' && e.meta.outcome === 'sent',
    );
    expect(sent).toEqual([]);
    // 대조: D1에도 이 트립의 station-passed sent는 0건(fired_count=0).
    const d1Sent = r.d1.filter((e) => e.kind === 'cron-fire-attempt' && d1Meta(e).outcome === 'sent');
    expect(d1Sent).toEqual([]);
  });

  it('leg-2 프롬프트는 도착 확정 때만 1회 발사된다 — D1 발사 시각과 일치 (#3058 유지 보증)', async () => {
    const r = await replaySleepTrip();
    const promptCycles = r.cycles.filter((c) => c.pushes.some((p) => promptPayload(p)?.line === r.leg2Line));
    expect(promptCycles).toHaveLength(1);
    const d1Fired = r.d1.find((e) => e.kind === 'leg-boarding-prompt' && d1Meta(e).outcome === 'fired') as D1TripEventRow;
    // D1 gateDecision = position-confirmed(도착 확정). 재생 cycle 시각이 D1 발사 시각과 같은 cron tick(< 5s).
    expect(d1Meta(d1Fired).gateDecision).toBe('position-confirmed');
    expect(Math.abs(promptCycles[0].simNowMs - d1Fired.ts)).toBeLessThan(5_000);
    // 프롬프트가 제시한 열차 = D1 leg-resolve-attempt 후보 열차.
    const prompt = promptCycles[0].pushes.map(promptPayload).find((p) => p?.line === r.leg2Line);
    const d1Candidates = r.d1
      .filter((e) => e.kind === 'leg-resolve-attempt')
      .flatMap((e) => (d1Meta(e).candidates as { trainCode: string }[]).map((c) => c.trainCode));
    expect(d1Candidates).toContain(prompt?.trainCode);
    // 프롬프트 이전 tick(미도착 구간)에는 leg-2 프롬프트가 없다.
    const earlier = r.cycles.filter((c) => c.simNowMs < promptCycles[0].simNowMs);
    expect(earlier.some((c) => c.pushes.some((p) => promptPayload(p)?.line === r.leg2Line))).toBe(false);
  });

  it('LA 축: leg-2 프롬프트 tick에 LA가 프롬프트 phase(alert 포함)로 갱신된다', async () => {
    const r = await replaySleepTrip();
    const laStates = r.cycles.flatMap((c) =>
      c.pushes
        .filter((p) => p.headers.pushType === 'liveactivity')
        .map((p) => ({ simNowMs: c.simNowMs, state: (p.body.aps as { 'content-state'?: Record<string, unknown> })['content-state'] ?? {} })),
    );
    const promptLa = laStates.filter((s) => s.state.boardingAlertTitle !== undefined && s.state.boardingPromptLine === r.leg2Line);
    expect(promptLa).toHaveLength(1);
    expect(promptLa[0].state.boardingPhase).toBe('pre-boarding');
    const promptCycle = r.cycles.find((c) => c.pushes.some((p) => promptPayload(p)?.line === r.leg2Line));
    expect(promptLa[0].simNowMs).toBe(promptCycle?.simNowMs);
    // 시각 렌더(배너/소리 실제 표시)는 device 영역 — 여기서는 backend 발신 payload까지.
  });
});
