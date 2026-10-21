/**
 * #3158 — 2026-10-21 트립 173 whole-trip replay: 성수 번호 변경(3009 -> 3045) 시 lock이 시간표 후속으로 이동.
 * 입력은 불변 실측 `fixtures/replay_20261021_trip173/` — 통과시키려 조정 금지.
 * 오라클(후속 열차)은 하드코딩하지 않고 fixture 마지막 캡처의 2호선 position에서 도출한다:
 * 성수에 있고 종착 표시가 '성수종착'이며 외선(updnLine '1')인 열차.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCaptureReplay } from './helpers/replayHarness';
import {
  buildTransferSeedTrip,
  createDeviceReplayer,
  loadD1Events,
  loadTripMetricsRow,
  makeTripEventSink,
  parseRouteSig,
  routeSigOf,
  stubReplayFetch,
} from './helpers/replay20261019';
import { buildReplayFixture, parseSeoulCaptureCycle } from '../replayFixture';
import { getTrip } from '../trips';
import type { CapturedPush } from './helpers/replayHarness';
import type { Env, Waypoint } from '../types';

const FIXTURE_DIR = 'replay_20261021_trip173';
const CAPS_DIR = path.join(__dirname, 'fixtures', FIXTURE_DIR, 'caps');
const TOKEN = 'replay-20261021-trip173-renumber';

afterEach(() => vi.unstubAllGlobals());

function capFiles(): string[] {
  return fs.readdirSync(CAPS_DIR).filter((n) => n.endsWith('.json')).sort();
}

function promptPayload(push: CapturedPush): Record<string, unknown> | undefined {
  const payload = push.body.body as Record<string, unknown> | undefined;
  return payload?.kind === 'boarding-prompt' ? payload : undefined;
}

/** 마지막 캡처의 2호선 position에서 성수 종착 후속 열차(외선)를 도출한다. */
function oracleSuccessor(): string {
  const last = JSON.parse(fs.readFileSync(path.join(CAPS_DIR, capFiles().at(-1) as string), 'utf-8'));
  const entry = last.entries.find((e: { kind: string; target: string }) => e.kind === 'position' && e.target === '2호선');
  const rows = JSON.parse(entry.body).realtimePositionList as Record<string, string>[];
  const hits = rows.filter((r) => r.statnNm === '성수' && r.statnTnm === '성수종착' && r.updnLine === '1');
  if (hits.length !== 1) throw new Error(`fixture 전제 실패 — 후속 후보 ${hits.length}건`);
  return hits[0].trainNo;
}

async function replay173(opts: { dropLastCaps?: number } = {}) {
  const files = capFiles();
  const used = files.slice(0, files.length - (opts.dropLastCaps ?? 0));
  const fixture = buildReplayFixture(used.map((n) => parseSeoulCaptureCycle(JSON.parse(fs.readFileSync(path.join(CAPS_DIR, n), 'utf-8')))));
  const d1 = loadD1Events(FIXTURE_DIR, 'events_173.json');
  const metrics = loadTripMetricsRow(FIXTURE_DIR, 173, 'trip_metrics_173.json');
  const firstMismatch = d1.find((e) => e.kind === 'route-signature-mismatch');
  if (!firstMismatch) throw new Error('fixture 전제 실패 — route-signature-mismatch 행 없음');
  const seedWaypoints: Waypoint[] = parseRouteSig(routeSigOf(firstMismatch, 'incomingSig'));
  const transfer = seedWaypoints.find((w) => w.kind === 'transfer') as Waypoint;
  const leg2Line = seedWaypoints[seedWaypoints.indexOf(transfer) + 1].line;
  const leg1Line = transfer.line;
  const seedTrip = buildTransferSeedTrip({
    token: TOKEN,
    waypoints: seedWaypoints,
    originStationName: metrics.origin_station as string,
    now: fixture.window.fromMs,
    overrides: { infoModeEnabled: true, activityPushToken: 'ab'.repeat(32), activityState: 'live' },
  });
  const { db, events } = makeTripEventSink();
  const stub = stubReplayFetch(fixture);
  const replayer = createDeviceReplayer({
    rows: d1,
    token: TOKEN,
    stub,
    tapBody: (tapIndex, pushes) => {
      const tapLine = tapIndex === 0 ? leg1Line : leg2Line;
      const station = tapIndex === 0 ? (metrics.origin_station as string) : transfer.stationName;
      const prompt = pushes.map(promptPayload).find((p) => p?.line === tapLine && Array.isArray(p?.candidateTrains));
      if (!prompt) throw new Error(`탭 ${tapIndex} 시점에 ${tapLine}호선 프롬프트 push가 없다 — 사슬 단절`);
      return { station, line: tapLine, trainCode: prompt.trainCode as string };
    },
    mergeSyncByTs: true,
  });
  const tickLocks: { tick: number; code?: string; line?: string }[] = [];
  let kvRef: KVNamespace | undefined;
  await runCaptureReplay({
    fixture,
    seedTrips: [seedTrip],
    apns: 'capture',
    twoPass: true,
    beforeTick: async ({ tick, env, kv, pushes }) => {
      kvRef = kv;
      (env as unknown as { DB: D1Database }).DB = db;
      stub.setNow(tick);
      const before = await getTrip(kv, TOKEN);
      tickLocks.push({ tick, code: before?.boardingLock?.trainCode, line: before?.boardingLock?.line });
      await replayer.beforeTick({ tick, env: env as Env, pushes });
    },
  });
  const finalTrip = await getTrip(kvRef as KVNamespace, TOKEN);
  return { events, tickLocks, finalLock: finalTrip?.boardingLock };
}

const reattachEvents = (events: { kind: string; meta: Record<string, unknown> }[]) => events.filter((e) => e.kind === 'lock-reattach');

describe('#3158 트립 173 — 성수 번호 변경 시 lock이 시간표 후속으로 이동', () => {
  it('최종 lock == fixture에서 도출한 후속 열차, D1에 source=timetable-successor 1행', async () => {
    const successor = oracleSuccessor();
    const r = await replay173();
    const oldLock = r.tickLocks.find((t) => t.line === '2')?.code as string;
    expect(oldLock).toBeDefined();
    expect(r.finalLock?.trainCode).toBe(successor);
    const timetableRows = reattachEvents(r.events).filter((e) => e.meta.source === 'timetable-successor');
    expect(timetableRows).toHaveLength(1);
    expect(timetableRows[0].meta).toMatchObject({ source: 'timetable-successor', to: successor, timetableFrom: oldLock });
  });

  it('기존 vanish-swap 경로는 그대로 동작하고 같은 D1 kind에 source=vanish-swap으로 기록된다 (시간표가 후속을 확정하기 전까지)', async () => {
    const r = await replay173();
    const vanishRows = reattachEvents(r.events).filter((e) => e.meta.source === 'vanish-swap');
    expect(vanishRows.length).toBeGreaterThanOrEqual(1);
    const lastBeforeFinal = r.tickLocks.at(-1)?.code;
    expect(vanishRows.at(-1)?.meta.to).toBe(lastBeforeFinal);
  });

  it('거부: 후속이 라이브 피드에 없으면(마지막 캡처 제거) table 재부착 0, 최종 lock은 후속이 아니다', async () => {
    const successor = oracleSuccessor();
    const r = await replay173({ dropLastCaps: 1 });
    expect(reattachEvents(r.events).filter((e) => e.meta.source === 'timetable-successor')).toEqual([]);
    expect(r.finalLock?.trainCode).not.toBe(successor);
  });
});
