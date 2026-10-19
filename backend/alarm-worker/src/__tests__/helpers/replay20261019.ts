/**
 * 2026-10-19 실측 트립 2건(오후 정상 완주 / 저녁 취침 실패) replay 공용 helper (#3089).
 *
 * 입력은 전부 불변 실측이다 — `fixtures/replay_20261019_*` 아래 R2 seoul-capture cycle(`caps/`)과
 * D1 `trip_events`/`trip_metrics` 추출본. 이 helper는 그 파일을 읽어 `ReplayFixture`로 합치고,
 * 재생 중 backend가 D1에 쓰는 `trip_events`를 fake D1로 가로채 **실측 D1 라벨(gateDecision /
 * outcome / reason)과 같은 어휘로** assert할 수 있게 한다. 프로덕션 코드는 건드리지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import app from '../../index';
import { makeCaptureFetch, type CapturedPush } from './replayHarness';
import { buildReplayFixture, parseSeoulCaptureCycle, type ReplayFixture } from '../../replayFixture';
import type { Env, Trip, Waypoint } from '../../types';

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

/** `fixtures/<dir>/caps/*.json`(R2 seoul-capture cycle 원본)을 시간순으로 합쳐 ReplayFixture로. */
export function loadCapsFixture(fixtureDirName: string): ReplayFixture {
  const capsDir = path.join(FIXTURES_DIR, fixtureDirName, 'caps');
  const cycles = fs
    .readdirSync(capsDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => parseSeoulCaptureCycle(JSON.parse(fs.readFileSync(path.join(capsDir, name), 'utf-8'))));
  return buildReplayFixture(cycles);
}

/** D1 `trip_events` 1행 — wrangler d1 execute --json 결과 그대로(`meta`는 JSON 문자열). */
export interface D1TripEventRow {
  id: number;
  token_hash: string;
  ts: number;
  kind: string;
  station: string | null;
  line: string | null;
  meta: string | null;
}

/** `fixtures/<dir>/<file>`(wrangler d1 execute --json 원본)의 results 행. */
export function loadD1Events(fixtureDirName: string, fileName: string): D1TripEventRow[] {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, fixtureDirName, fileName), 'utf-8'));
  return raw[0].results as D1TripEventRow[];
}

/** 재생 중 backend가 append한 `trip_events` 1건(ts는 벽시계라 쓰지 않는다 — 순서만 신뢰). */
export interface RecordedTripEvent {
  kind: string;
  station: string | null;
  line: string | null;
  meta: Record<string, unknown>;
}

/**
 * `recordTripEvent`(`INSERT INTO trip_events (token_hash, ts, kind, station, line, meta)`)를
 * 가로채는 fake D1. 다른 쿼리는 no-op으로 통과시킨다.
 */
export function makeTripEventSink(): { db: D1Database; events: RecordedTripEvent[] } {
  const events: RecordedTripEvent[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        if (sql.startsWith('INSERT INTO trip_events')) {
          const [, , kind, station, line, meta] = args as [string, number, string, string | null, string | null, string | null];
          events.push({ kind, station, line, meta: meta ? (JSON.parse(meta) as Record<string, unknown>) : {} });
        }
        return {
          run: async () => ({ success: true }),
          first: async () => null,
          all: async () => ({ results: [] }),
        };
      },
    }),
  } as unknown as D1Database;
  return { db, events };
}

/**
 * 재생 시각(tick)으로 `Date.now`를 고정한 채 boarding-confirm을 POST한다(#2981 패턴 —
 * HTTP 핸들러는 `Date.now()`를 직접 쓴다).
 */
export async function postBoardingConfirmAt(
  at: number,
  env: Env,
  token: string,
  body: { station: string; line: string; trainCode?: string },
): Promise<Response> {
  const spy = vi.spyOn(Date, 'now').mockReturnValue(at);
  try {
    return await app.fetch(
      new Request(`http://example.com/trips/${token}/boarding-confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'boarded', ...body }),
      }),
      env,
    );
  } finally {
    spy.mockRestore();
  }
}

/**
 * HTTP 핸들러(`/boarding-lock/sync`, `/trips/:token/boarding-confirm`)는 cron deps와 달리 전역 `fetch`로
 * Seoul/APNs를 직접 호출한다 — 스텁하지 않으면 재생 중 실 네트워크("fetch failed")가 나고 그 예외가
 * advance 루프를 끊어 재생이 실 trip과 달라진다(10/19 저녁 재생에서 확인). Seoul 호출은 캡처 스트림으로
 * (재생 시각 기준 신선 entry), 그 외(APNs)는 200으로 응답한다. 반환 `setNow`로 현재 재생 시각을 갱신한다.
 * 호출한 테스트는 `afterEach(() => vi.unstubAllGlobals())`로 복원해야 한다.
 */
export function stubReplayFetch(fixture: ReplayFixture): {
  setNow: (ms: number) => void;
  /** HTTP 핸들러가 직접 보낸 APNs push 본문(cron 경로 push는 harness `CapturedPush`가 따로 잡는다). */
  httpPushes: Record<string, unknown>[];
} {
  let now = fixture.window.fromMs;
  const httpPushes: Record<string, unknown>[] = [];
  const seoulFetch = makeCaptureFetch(fixture, () => now);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('seoul.api')) return seoulFetch(input, init);
    try {
      httpPushes.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    } catch {
      // 본문 없는/비JSON 요청은 기록하지 않는다.
    }
    return new Response('', { status: 200 });
  });
  return {
    setNow: (ms: number) => {
      now = ms;
    },
    httpPushes,
  };
}

/**
 * D1 `route-signature-mismatch.meta`의 sig 문자열 → waypoints.
 * 형식: `<목적지코드>::<역>|<노선>|<kind>|<hop>/<역>|...` (index.ts routeSignature).
 * 역명/노선을 코드에 박지 않고 **D1 실측 sig에서 그대로** seed trip을 만든다.
 */
export function parseRouteSig(sig: string): Waypoint[] {
  const [, body] = sig.split('::');
  return body.split('/').map((segment) => {
    const [stationName, line, kind] = segment.split('|');
    return { stationName, line, kind: kind as Waypoint['kind'] };
  });
}

/** D1 `route-signature-mismatch` 행의 sig 필드(`incomingSig`=device가 가진 route, `existingSig`=backend 진행분). */
export function routeSigOf(row: D1TripEventRow, field: 'incomingSig' | 'existingSig'): string {
  return (JSON.parse(row.meta ?? '{}') as Record<string, string>)[field];
}

/**
 * 환승 1회 route를 가진 replay seed trip. waypoints는 호출자가 D1 sig에서 파생해 넘긴다 —
 * route 요약 필드(`route`/`destination`)도 waypoints에서 계산한다(환승 횟수/역명 비하드코딩).
 */
export function buildTransferSeedTrip(opts: {
  token: string;
  waypoints: Waypoint[];
  originStationName: string;
  now: number;
  overrides?: Partial<Trip>;
}): Trip {
  const { token, waypoints, originStationName, now, overrides } = opts;
  const transferIndex = waypoints.findIndex((w) => w.kind === 'transfer');
  const transfer = waypoints[transferIndex];
  const next = waypoints[transferIndex + 1];
  const destination = waypoints[waypoints.length - 1];
  return {
    token,
    route: {
      type: 'transfer',
      transferName: transfer.stationName,
      fromLine: transfer.line,
      toLine: next.line,
      stopsToTransfer: transferIndex + 1,
      stopsFromTransfer: waypoints.length - transferIndex - 1,
    },
    destination: destination.stationName,
    waypoints,
    expiresAt: now + 60 * 60_000,
    createdAt: now,
    alarmAtEpochMs: now,
    originStationName,
    ...overrides,
  };
}

/** 재생 중 주입한 device → backend 요청 1건의 결과(탭만 `body` 보존). */
export interface InjectedTap {
  /** D1 실측 `boarding-confirm-result` ts — 이 시각의 시계로 호출했다. */
  at: number;
  status: number;
  response: { ok?: boolean; lockState?: string; resolvedTrainCode?: string };
  /** 실제로 보낸 body(`trainCode` 미동봉 = LA 버튼 모양). */
  sent: { station: string; line: string; trainCode?: string };
}

/**
 * D1 `trip_events`의 device 기원 행을 **원래 시각 순서대로** 재생에 주입한다 — `sync-received`는
 * `POST /boarding-lock/sync`(device가 fix로 현재역을 확정해 보낸 것)로, `boarding-confirm-result`는
 * `POST /trips/:token/boarding-confirm`(사용자 탭)으로. `harness.beforeTick`에 그대로 꽂는다.
 *
 * - 시각: 각 요청은 D1 행의 ts로 `Date.now`를 고정해 호출(HTTP 핸들러가 `Date.now`를 직접 씀).
 *   cron tick 사이에 있던 요청은 그 다음 tick 직전에 주입된다(순서 보존, 시각 근사 ≤ 1 cron 주기).
 * - sync body의 `accuracy`는 D1에 없다 — #901 게이트(≤50m) 통과 값(20)으로 둔다(추정 입력).
 * - 탭 body는 D1에 없다 → `tapBody`가 정한다(호출자가 근거를 주석으로 남긴다).
 */
export function createDeviceReplayer(opts: {
  rows: D1TripEventRow[];
  token: string;
  stub: { setNow: (ms: number) => void };
  tapBody: (tapIndex: number, pushes: readonly CapturedPush[]) => { station: string; line: string; trainCode?: string };
}): {
  beforeTick: (ctx: { tick: number; env: Env; pushes: readonly CapturedPush[] }) => Promise<void>;
  taps: InjectedTap[];
} {
  const queue = opts.rows.filter((r) => r.kind === 'sync-received' || r.kind === 'boarding-confirm-result');
  let cursor = 0;
  let tapIndex = 0;
  const taps: InjectedTap[] = [];
  return {
    taps,
    beforeTick: async ({ tick, env, pushes }) => {
      while (cursor < queue.length && queue[cursor].ts <= tick) {
        const row = queue[cursor];
        cursor += 1;
        opts.stub.setNow(row.ts);
        if (row.kind === 'sync-received') {
          const spy = vi.spyOn(Date, 'now').mockReturnValue(row.ts);
          try {
            await app.fetch(
              new Request('http://example.com/boarding-lock/sync', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  token: opts.token,
                  observedStationName: row.station,
                  observedAtMs: row.ts,
                  accuracy: 20,
                }),
              }),
              env,
            );
          } finally {
            spy.mockRestore();
          }
        } else {
          const sent = opts.tapBody(tapIndex, pushes);
          tapIndex += 1;
          const res = await postBoardingConfirmAt(row.ts, env, opts.token, sent);
          taps.push({ at: row.ts, status: res.status, response: await res.json(), sent });
        }
      }
    },
  };
}

/** `trip_metrics_166_168.json`(wrangler d1 execute --json 원본)에서 trip 1행. */
export function loadTripMetricsRow(fixtureDirName: string, id: number): Record<string, unknown> {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, fixtureDirName, 'trip_metrics_166_168.json'), 'utf-8'));
  const row = (raw[0].results as Record<string, unknown>[]).find((r) => r.id === id);
  if (!row) throw new Error(`trip_metrics id=${id} 행이 fixture에 없다`);
  return row;
}
