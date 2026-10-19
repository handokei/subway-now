/**
 * #3089 — 2026-10-19 오후 **정상 완주** 트립 whole-trip replay (회귀 가드, 지금 green).
 *
 * 실측: 15:29~15:46 KST, 용마산(7) 탑승 -> 건대입구 환승 -> 2호선 뚝섬(destination), D1
 * `trip_metrics` id=166(token_hash b00dd879). 입력은 전부 불변 실측이다(통과시키려 조정 금지):
 *   - `fixtures/replay_20261019_afternoon_full_chain/caps/*.json` — R2 seoul-capture 17 cycle
 *     (backend cron이 그 시각 실제로 본 Seoul 응답. admin `/admin/seoul-capture/keys` -> r2 object get).
 *   - `events_166.json` — D1 `trip_events` 전수(`ts BETWEEN 1792391300000 AND 1792392420000`).
 *   - `trip_metrics_166_168.json` — D1 `trip_metrics` id IN (166,168).
 *
 * 재생 방식: seed trip(D1 `route-signature-mismatch.incomingSig`에서 파생한 waypoints)을 넣고,
 * D1 device 기원 행(`sync-received` = POST /boarding-lock/sync, `boarding-confirm-result` = 사용자
 * 탭)을 **D1 ts 순서대로 그 자리에 주입**하며 실 `runScheduled`를 cron cycle마다 돌린다. 재생 중
 * backend가 쓰는 `trip_events`를 fake D1로 가로채 **실측 D1과 같은 라벨 어휘**(gateDecision /
 * outcome / reason)로 assert하고, 핵심 라벨열은 D1 원본과 **직접 대조**한다.
 *
 * 이 테스트가 막는 회귀: 정상 체인(leg-1 confirm -> 매역 -> 환승 -> leg-2 프롬프트가 "도착 확정"에서만
 * 발사 -> leg-2 confirm)이 어느 한 구간에서 끊기는 것. #3083(환승 체류 중 가짜 전진 fix)이 이 정상
 * 환승을 건드리면 여기서 깨진다(#3083 acceptance "오후 라이드 replay 무변경 green").
 *
 * ## 재생으로 재현되지 않는 것 (정직한 한계 — green 보증 범위 밖)
 *   1. mid-cycle(+30s) 폴링은 R2 캡처에 기록되지 않는다 -> D1의 `station-passed-dedup`(군자/어대,
 *      mid-cycle 선발사 후 정각 cycle이 dedup) 쌍과 15:44:15 성수 mid-cycle sent는 재생에서 나오지 않는다
 *      (재생은 정각 cycle에서 1회 sent). 중복 발사 0은 assert한다.
 *   2. 목적지(뚝섬) destination push는 D1상 15:46:16 mid-cycle이고 trip은 15:46:03 user-clear로 이미
 *      끝난 뒤다(`trip-end user-clear/http-delete`). 마지막 캡처가 15:45:46이라 재생 창 밖이다.
 *   3. leg-1 탭 body의 `trainCode`는 D1에 없다 — 캡처에서 출발역에 ARRIVED(arvlCd=1)로 떠 있던 유일
 *      열차로 둔다(추정 입력, 아래 `resolveLeg1TapTrainCode`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARRIVAL_CODE } from '../alarm';
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
import type { Env, Waypoint } from '../types';

const FIXTURE_DIR = 'replay_20261019_afternoon_full_chain';
const TRIP_METRICS_ID = 166;
const TOKEN = 'replay-20261019-afternoon';

afterEach(() => vi.unstubAllGlobals());

/** D1 label 비교용 — `leg-boarding-prompt` 이벤트의 (outcome, gateDecision). */
function legPromptLabels(events: readonly { kind: string; meta: unknown }[]): { outcome: string; gateDecision: string }[] {
  return events
    .filter((e) => e.kind === 'leg-boarding-prompt')
    .map((e) => {
      const meta = e.meta as { outcome: string; gateDecision: string };
      return { outcome: meta.outcome, gateDecision: meta.gateDecision };
    });
}

function d1Meta(row: D1TripEventRow): Record<string, unknown> {
  return JSON.parse(row.meta ?? '{}') as Record<string, unknown>;
}

function promptPayload(push: CapturedPush): Record<string, unknown> | undefined {
  const payload = push.body.body as Record<string, unknown> | undefined;
  return payload?.kind === 'boarding-prompt' ? payload : undefined;
}

/** station-passed 채널(alert, `cron-fire-attempt` sent)로 발사된 역 — 시간순. */
function sentStationPassed(events: readonly RecordedTripEvent[]): string[] {
  return events
    .filter((e) => e.kind === 'cron-fire-attempt' && e.meta.waypointKind === 'station-passed' && e.meta.outcome === 'sent')
    .map((e) => e.station as string);
}

/**
 * leg-1 탭 body trainCode(추정 입력) — D1 `boarding-confirm-result`에는 body가 없다. 출발역 첫
 * 캡처 cycle에서 arvlCd=ARRIVED인 열차가 **유일**함을 확인하고 그것으로 둔다(유일하지 않으면
 * 추정이 성립하지 않으므로 여기서 멈춘다).
 */
function resolveLeg1TapTrainCode(fixtureEntries: ReturnType<typeof loadCapsFixture>['entries'], originStation: string): string {
  const entry = fixtureEntries.find((e) => e.kind === 'arrival' && e.target === originStation);
  if (!entry) throw new Error('fixture 전제 실패 — 출발역 arrival 캡처 없음');
  const list = (JSON.parse(entry.body) as { realtimeArrivalList: { btrainNo: string; arvlCd: string }[] }).realtimeArrivalList;
  const arrived = list.filter((a) => Number(a.arvlCd) === ARRIVAL_CODE.ARRIVED);
  expect(arrived, '출발역에 ARRIVED 열차가 유일해야 탭 trainCode 추정이 성립한다').toHaveLength(1);
  return arrived[0].btrainNo;
}

interface Replayed {
  seedWaypoints: Waypoint[];
  transfer: Waypoint;
  leg2Line: string;
  leg1Intermediates: string[];
  events: RecordedTripEvent[];
  pushes: CapturedPush[];
  cycles: { simNowMs: number; pushes: CapturedPush[] }[];
  taps: ReturnType<typeof createDeviceReplayer>['taps'];
  leg1TapTrainCode: string;
  d1: D1TripEventRow[];
  originStation: string;
}

async function replayAfternoon(): Promise<Replayed> {
  const fixture = loadCapsFixture(FIXTURE_DIR);
  const d1 = loadD1Events(FIXTURE_DIR, 'events_166.json');
  const metrics = loadTripMetricsRow(FIXTURE_DIR, TRIP_METRICS_ID);
  const originStation = metrics.origin_station as string;

  const firstMismatch = d1.find((e) => e.kind === 'route-signature-mismatch');
  if (!firstMismatch) throw new Error('fixture 전제 실패 — route-signature-mismatch 행 없음');
  const seedWaypoints = parseRouteSig(routeSigOf(firstMismatch, 'incomingSig'));
  const transfer = seedWaypoints.find((w) => w.kind === 'transfer') as Waypoint;
  const leg2Line = seedWaypoints[seedWaypoints.indexOf(transfer) + 1].line;
  const leg1Intermediates = seedWaypoints
    .filter((w) => w.kind === 'intermediate' && w.line === transfer.line)
    .map((w) => w.stationName);

  const seedTrip = buildTransferSeedTrip({
    token: TOKEN,
    waypoints: seedWaypoints,
    originStationName: originStation,
    now: fixture.window.fromMs,
    overrides: {
      // trip-register 시점 device 상태(추정 입력): origin 프롬프트 anchor + 정보 모드. D1
      // boarding-confirm-result(anchorSource='promptDisplay')가 promptDisplay 존재를 뒷받침한다.
      promptDisplay: { originStation, line: seedWaypoints[0].line },
      infoModeEnabled: true,
      // D1 `la-token-register {outcome:'stored'}` 15:29:26 — LA push 경로를 연다(토큰 값은 임의).
      activityPushToken: 'ab'.repeat(32),
      activityState: 'live',
    },
  });

  const leg1TapTrainCode = resolveLeg1TapTrainCode(fixture.entries, originStation);
  const { db, events } = makeTripEventSink();
  const stub = stubReplayFetch(fixture);
  const replayer = createDeviceReplayer({
    rows: d1,
    token: TOKEN,
    stub,
    tapBody: (tapIndex, pushes) => {
      if (tapIndex === 0) return { station: originStation, line: seedWaypoints[0].line, trainCode: leg1TapTrainCode };
      // leg-2 탭 — 프롬프트가 payload에 실은 열차를 그대로 돌려보낸다(#2989 기법, 하드코딩 금지).
      const prompt = pushes.map(promptPayload).find((p) => p?.line === leg2Line && Array.isArray(p?.candidateTrains));
      if (!prompt) throw new Error('leg-2 탭 시점에 leg-2 프롬프트 push가 없다 — 사슬 단절');
      return { station: transfer.stationName, line: leg2Line, trainCode: prompt.trainCode as string };
    },
  });

  const result = await runCaptureReplay({
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

  return {
    seedWaypoints,
    transfer,
    leg2Line,
    leg1Intermediates,
    events,
    pushes: result.pushes,
    cycles: result.cycles,
    taps: replayer.taps,
    leg1TapTrainCode,
    d1,
    originStation,
  };
}

describe('#3089 10/19 오후 정상 완주 — whole-trip replay (회귀 가드)', () => {
  it('leg-1 confirm: 탭이 수락되고 lock이 그 열차로 생긴다 (D1: lockState=leg1)', async () => {
    const r = await replayAfternoon();
    const [leg1Tap] = r.taps;
    expect(leg1Tap.status).toBe(200);
    expect(leg1Tap.response.lockState).toBe('leg1');
    expect(leg1Tap.response.resolvedTrainCode).toBe(r.leg1TapTrainCode);
    // D1 원본 라벨과 동일(`boarding-confirm-result {lockState:'leg1'}` 첫 탭).
    const d1Taps = r.d1.filter((e) => e.kind === 'boarding-confirm-result').map((e) => d1Meta(e).lockState);
    expect(d1Taps[0]).toBe('leg1');
    expect(r.events.filter((e) => e.kind === 'boarding-confirm-result')[0].meta.lockState).toBe('leg1');
  });

  it('매역: leg-1 중간역마다 station-passed가 정확히 1회 sent, 중복 0, D1 sent 순서와 일치', async () => {
    const r = await replayAfternoon();
    const sent = sentStationPassed(r.events);
    // leg-1 중간역(seed waypoints 파생) 전부가 순서대로 1회씩.
    expect(sent.filter((s) => r.leg1Intermediates.includes(s))).toEqual(r.leg1Intermediates);
    // alert 채널 실발사도 같은 역들이 중복 없이(같은 역 2회 발사 = 회귀).
    const alerts = firedStationOccurrences(r.pushes);
    for (const station of r.leg1Intermediates) {
      expect(alerts.filter((s) => s === station), `${station} 매역 alert 발사 횟수`).toHaveLength(1);
    }
    // D1 실측 sent 순서(leg-1 중간역 한정)와 같다 — D1: 중곡 -> 군자 -> 어대 각 1회 sent.
    const d1Sent = r.d1
      .filter((e) => e.kind === 'cron-fire-attempt' && d1Meta(e).waypointKind === 'station-passed' && d1Meta(e).outcome === 'sent')
      .map((e) => e.station as string)
      .filter((s) => r.leg1Intermediates.includes(s));
    expect(sent.filter((s) => r.leg1Intermediates.includes(s))).toEqual(d1Sent);
  });

  it('transfer: 환승역 advance(lock-active) + transfer sent + 하차 hop-end 프롬프트 발사 (D1과 동일 라벨)', async () => {
    const r = await replayAfternoon();
    const { stationName } = r.transfer;
    const advance = r.events.find((e) => e.kind === 'transfer-advance' && e.station === stationName);
    expect(advance?.meta).toEqual({ path: 'lock-active', outcome: 'advanced' });
    const transferSent = r.events.find(
      (e) => e.kind === 'cron-fire-attempt' && e.meta.waypointKind === 'transfer' && e.station === stationName,
    );
    expect(transferSent?.meta).toMatchObject({ outcome: 'sent', phase: 'imminent', path: 'vanish-fallback' });
    const hopEnd = r.events.find((e) => e.kind === 'hop-end-prompt' && e.station === stationName);
    expect(hopEnd?.meta).toEqual({ outcome: 'fired' });
    // D1 원본도 같은 3개 라벨.
    const d1Advance = r.d1.find((e) => e.kind === 'transfer-advance');
    expect(d1Meta(d1Advance as D1TripEventRow)).toEqual({ path: 'lock-active', outcome: 'advanced' });
  });

  it('leg-2 프롬프트: 미도착(ETA>0)에서 suppressed-not-imminent 2회 -> 도착 확정(arvlCd=1)에서 position-confirmed 발사, D1 라벨열과 동일', async () => {
    const r = await replayAfternoon();
    const labels = legPromptLabels(r.events);
    expect(labels).toEqual([
      { outcome: 'suppressed-not-imminent', gateDecision: 'suppressed-not-imminent' },
      { outcome: 'suppressed-not-imminent', gateDecision: 'suppressed-not-imminent' },
      { outcome: 'fired', gateDecision: 'position-confirmed' },
    ]);
    // D1 원본 라벨열(실측)과 1:1 동일 — 재생이 실제 backend 판단을 재현했다는 증거.
    expect(labels).toEqual(legPromptLabels(r.d1.map((e) => ({ kind: e.kind, meta: d1Meta(e) }))));

    const leg = r.events.filter((e) => e.kind === 'leg-boarding-prompt');
    const [first, second, fired] = leg.map((e) => e.meta as { candidateArvlCds: (number | null)[]; candidateEtaSeconds: number[] });
    // 억제된 두 tick은 어떤 후보도 도착 확정(arvlCd 1/2)이 아니고 ETA가 남아 있다.
    for (const suppressed of [first, second]) {
      expect(suppressed.candidateArvlCds.some((cd) => cd === ARRIVAL_CODE.ARRIVED || cd === ARRIVAL_CODE.DEPARTED)).toBe(false);
      expect(Math.min(...suppressed.candidateEtaSeconds)).toBeGreaterThan(0);
    }
    // 발사 tick은 후보 중 도착(1)이 있고 ETA 0.
    expect(fired.candidateArvlCds).toContain(ARRIVAL_CODE.ARRIVED);
    expect(Math.min(...fired.candidateEtaSeconds)).toBe(0);

    // push는 도착 확정 cycle에서만 정확히 1건(#3058: 프롬프트는 도착 확정 때만).
    const prompts = r.pushes.map(promptPayload).filter((p) => p?.line === r.leg2Line && Array.isArray(p?.candidateTrains));
    expect(prompts).toHaveLength(1);
  });

  it('LA 축: leg-2 프롬프트 발사 tick에 LA가 프롬프트 phase(alert 포함)로 갱신된다 — 억제된 tick에는 alert LA 없음', async () => {
    const r = await replayAfternoon();
    const laOf = (push: CapturedPush) => (push.body.aps as { 'content-state'?: Record<string, unknown>; alert?: unknown } | undefined);
    const promptCycles = r.cycles.filter((c) => c.pushes.some((p) => promptPayload(p)?.line === r.leg2Line));
    expect(promptCycles).toHaveLength(1);
    const laInPromptCycle = promptCycles[0].pushes
      .filter((p) => p.headers.pushType === 'liveactivity')
      .map(laOf)
      .filter((aps) => aps?.['content-state']?.boardingAlertTitle !== undefined);
    expect(laInPromptCycle).toHaveLength(1);
    const [la] = laInPromptCycle;
    const state = la?.['content-state'] as Record<string, unknown>;
    expect(state.boardingPhase).toBe('pre-boarding');
    expect(state.boardingPromptLine).toBe(r.leg2Line);
    expect(la?.alert).toBeDefined();
    // 프롬프트 alert LA는 전 재생에서 이 1건뿐(억제 tick에서 미리 배너를 띄우면 "조기" 회귀).
    const allPromptLa = r.cycles
      .flatMap((c) => c.pushes)
      .filter((p) => p.headers.pushType === 'liveactivity')
      .filter((p) => laOf(p)?.['content-state']?.boardingAlertTitle !== undefined);
    expect(allPromptLa.filter((p) => laOf(p)?.['content-state']?.boardingPromptLine === r.leg2Line)).toHaveLength(1);
    // 시각 렌더(배너/소리 실제 표시)는 device 영역 — 이 assert는 backend가 발신한 payload까지.
  });

  it('leg-2 confirm: 프롬프트가 제시한 열차로 탭이 수락되고 leg-2 lock이 생긴다 (D1: lockState=leg2, trainCodeSource=body)', async () => {
    const r = await replayAfternoon();
    const [, leg2Tap] = r.taps;
    const prompt = r.pushes.map(promptPayload).find((p) => p?.line === r.leg2Line && Array.isArray(p?.candidateTrains));
    expect(leg2Tap.status).toBe(200);
    expect(leg2Tap.response.lockState).toBe('leg2');
    expect(leg2Tap.response.resolvedTrainCode).toBe(prompt?.trainCode);
    expect(r.events.filter((e) => e.kind === 'boarding-confirm-result')[1].meta).toEqual({
      lockState: 'leg2',
      anchorSource: 'currentLegAnchor',
      trainCodeSource: 'body',
    });
    const d1Leg2 = r.d1.filter((e) => e.kind === 'boarding-confirm-result')[1];
    expect(d1Meta(d1Leg2)).toEqual({ lockState: 'leg2', anchorSource: 'currentLegAnchor', trainCodeSource: 'body' });
  });

  it('leg-2 진행: sync로 destination까지 advance하고 leg-2 추정이 matched=true로 끝난다 (D1 마지막 advance와 동일)', async () => {
    const r = await replayAfternoon();
    const advances = r.events.filter((e) => e.kind === 'advance').map((e) => e.station);
    const d1Advances = r.d1.filter((e) => e.kind === 'advance').map((e) => e.station);
    // 마지막 advance = destination(D1 15:44:27 성수 sync -> advance 뚝섬). 한계(보증 범위 밖): D1에는
    // 15:37:19 `advance 성수`(sync 건대입구 직후)가 더 있으나 재생은 그 시점 이미 환승 advance가 끝나
    // 나오지 않는다 — 이 차이 이후의 라벨열(leg-2 프롬프트/confirm)은 위 테스트들이 D1과 1:1 대조한다.
    expect(advances.at(-1)).toBe(d1Advances.at(-1));
    expect(advances.at(-1)).toBe(r.seedWaypoints[r.seedWaypoints.length - 1].stationName);
    // 환승 후 leg-2 추정이 matched=true로 끝난다(D1 마지막 leg2-estimate도 matched=true).
    const lastEstimate = r.events.filter((e) => e.kind === 'leg2-estimate').at(-1);
    expect(lastEstimate?.meta.matched).toBe(true);
  });
});
