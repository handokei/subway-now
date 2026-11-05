/**
 * #3221 PR-3a — 탑승 질문 LA가 "이번 발사 열차"(trainCode·trainCodeIssuedAtMs)를 싣고, 발사 기록(prompt_fires)을
 * 송신 전 단일 writer로 남기며, heartbeat(lock 없음)는 prompt_fires 최신 행으로 복구한다.
 * 실제 APNs 요청 body의 content-state 필드를 assert한다(계획 v6 §3.1, R3n·R3w·R4·R4'·R4h·R4c·R19).
 */
import { exportPKCS8, generateKeyPair } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { buildLiveActivityContentState } from '../liveActivity';
import {
  createEmptyScheduledStats,
  maybeFireLegBoardingPrompt,
  maybeFireLiveActivityUpdate,
  maybeFireOriginBoardingPromptGpsFree,
  runScheduled,
  type ScheduledDeps,
} from '../scheduled';
import { SeoulArrivalClient } from '../seoul';
import type { Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';

const NOW = 1_800_000_000_000;
const LATER = NOW + 20 * 60_000;
const HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' };
const START_TOKEN = 'pts-token-xyz';
const SPLIT = { split: true, boardingStart: 'push-to-start' } as const;

let apnsConfig: ApnsConfig;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsConfig = { keyId: 'K', teamId: 'T', bundleId: 'com.example.app', privateKeyPem: await exportPKCS8(privateKey) };
});
beforeEach(() => resetApnsJwtCache());

interface FireRow {
  tokenHash: string;
  station: string;
  line: string;
  trainCode: string | null;
  issuedAt: number;
  decision: string;
}

/** prompt_fires INSERT/SELECT/DELETE를 흉내내는 in-memory D1. `events`에 송신 순서를 함께 남긴다. */
function makeDb(events: string[], opts: { failRead?: boolean; failWrite?: boolean } = {}) {
  const rows: FireRow[] = [];
  const sqls: string[] = [];
  const db = {
    prepare(sql: string) {
      sqls.push(sql);
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (sql.includes('INSERT INTO prompt_fires')) {
                if (opts.failWrite) throw new Error('write boom');
                const [tokenHash, station, line, trainCode, issuedAt, decision] = args as [string, string, string, string | null, number, string];
                rows.push({ tokenHash, station, line, trainCode, issuedAt, decision });
                events.push('db:prompt_fires');
              }
              return { success: true, meta: { changes: 0 } };
            },
            async first() {
              if (!sql.includes('FROM prompt_fires')) return null;
              if (opts.failRead) throw new Error('read boom');
              const [tokenHash, station, line] = args as [string, string, string];
              const latest = rows
                .filter((r) => r.tokenHash === tokenHash && r.station === station && r.line === line)
                .sort((a, b) => b.issuedAt - a.issuedAt)[0];
              return latest ? { train_code: latest.trainCode, issued_at: latest.issuedAt } : null;
            },
          };
        },
      };
    },
  } as unknown as Env['DB'];
  return { db, rows, sqls };
}

function makeEnv(kv: InMemoryKV, db: Env['DB']): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
    DB: db,
    APNS_HOST: HOSTS.production,
    APNS_HOST_SANDBOX: HOSTS.sandbox,
    SEOUL_API_HOST: 'seoul.api',
    SEOUL_API_KEY: 'KEY',
    APNS_KEY_ID: 'K',
    APNS_TEAM_ID: 'T',
    APNS_PRIVATE_KEY: apnsConfig.privateKeyPem,
    APNS_BUNDLE_ID: 'com.example.app',
  };
}

type Arrival = { btrainNo: string; arvlCd: number };

interface Sent {
  type: string;
  url: string;
  raw: string;
  aps: Record<string, unknown>;
}

function makeFetch(events: string[], arrivalsRef: { rows: Arrival[] }) {
  const sent: Sent[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const type = ((init?.headers ?? {}) as Record<string, string>)['apns-push-type'];
    if (type === undefined) {
      return new Response(
        JSON.stringify({
          realtimeArrivalList: arrivalsRef.rows.map((r) => ({
            barvlDt: '120',
            recptnDt: '',
            updnLine: '상행',
            trainLineNm: '군자',
            btrainNo: r.btrainNo,
            subwayNm: '지하철7호선',
            arvlCd: r.arvlCd,
          })),
        }),
        { status: 200 },
      );
    }
    const raw = String(init?.body);
    const body = JSON.parse(raw) as { aps?: Record<string, unknown> };
    const aps = body.aps ?? {};
    const tag = type === 'liveactivity' ? (aps.event === 'start' ? 'la-start' : 'la-update') : 'notif';
    events.push(tag);
    sent.push({ type: tag, url: String(url), raw, aps });
    return new Response('', { status: 200 });
  });
  return { sent, impl: impl as unknown as typeof fetch };
}

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'firetok-prompt-fires',
    createdAt: NOW - 5 * 60_000,
    waypoints: [{ stationName: '용마산', line: '7', kind: 'intermediate' }],
    apnsEnv: 'production',
    registeredAt: NOW,
    infoModeEnabled: true,
    promptOptIn: true,
    promptDisplay: { originStation: '군자', line: '7' },
    activityPushToken: 'la-activity-token',
    activityState: 'live',
    lastLaPushAt: NOW - 30_000,
    ...overrides,
  } as unknown as Trip;
}

function makeDeps(fetchImpl: typeof fetch): ScheduledDeps {
  return {
    seoul: new SeoulArrivalClient({ host: 'seoul.api', apiKey: 'KEY', fetchImpl }),
    apnsConfig,
    apnsHosts: HOSTS,
    fetchImpl,
    archFlag: 'off',
  };
}

async function fireOnce(trip: Trip, now: number, db: Env['DB'], fetchImpl: typeof fetch, kv = new InMemoryKV()) {
  await maybeFireOriginBoardingPromptGpsFree(trip, makeEnv(kv, db), makeDeps(fetchImpl), createEmptyScheduledStats(now), now, () => {}, () => 'pid');
}

const contentOf = (s: Sent) => s.aps['content-state'] as Record<string, unknown>;
const laOf = (sent: Sent[]) => sent.filter((s) => s.type === 'la-update' || s.type === 'la-start');

describe('발사 열차가 LA content에 실린다 (여정 LA, non-split)', () => {
  it('여정 LA update content: trainCode=발사 열차, trainCodeIssuedAtMs=now(알림 sentAt과 동일) / prompt_fires 1행', async () => {
    const events: string[] = [];
    const { db, rows } = makeDb(events);
    const f = makeFetch(events, { rows: [{ btrainNo: '7246', arvlCd: 1 }] });
    await fireOnce(makeTrip(), NOW, db, f.impl);
    const [la] = laOf(f.sent);
    expect(contentOf(la)).toMatchObject({ boardingPhase: 'pre-boarding', trainCode: '7246', trainCodeIssuedAtMs: NOW });
    const notif = f.sent.find((s) => s.type === 'notif');
    expect(notif?.raw).toContain(`"sentAt":${NOW}`);
    expect(rows).toEqual([
      expect.objectContaining({ station: '군자', line: '7', trainCode: '7246', issuedAt: NOW }),
    ]);
  });

  it('R3w: prompt_fires 기록은 LA·알림 송신보다 먼저다', async () => {
    const events: string[] = [];
    const { db } = makeDb(events);
    const f = makeFetch(events, { rows: [{ btrainNo: '7246', arvlCd: 1 }] });
    await fireOnce(makeTrip(), NOW, db, f.impl);
    expect(events.indexOf('db:prompt_fires')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('db:prompt_fires')).toBeLessThan(events.indexOf('la-update'));
    expect(events.indexOf('db:prompt_fires')).toBeLessThan(events.indexOf('notif'));
  });

  it('R3n: ambiguity 발사(같은 tier 2대)는 LA content에 trainCode·trainCodeIssuedAtMs 없음(이전 lock/stamp 폴백 금지) + prompt_fires.train_code NULL', async () => {
    const events: string[] = [];
    const { db, rows } = makeDb(events);
    const f = makeFetch(events, {
      rows: [
        { btrainNo: '7246', arvlCd: 1 },
        { btrainNo: '7247', arvlCd: 1 },
      ],
    });
    await fireOnce(makeTrip(), NOW, db, f.impl);
    const [la] = laOf(f.sent);
    expect(la).toBeDefined();
    expect(contentOf(la)).not.toHaveProperty('trainCode');
    expect(contentOf(la)).not.toHaveProperty('trainCodeIssuedAtMs');
    expect(rows).toEqual([expect.objectContaining({ trainCode: null, issuedAt: NOW })]);
  });

  it('R3w: 기록은 쓰되 DB 쓰기가 실패해도 발사는 계속된다(삼킴)', async () => {
    const events: string[] = [];
    const { db } = makeDb(events, { failWrite: true });
    const f = makeFetch(events, { rows: [{ btrainNo: '7246', arvlCd: 1 }] });
    await fireOnce(makeTrip(), NOW, db, f.impl);
    expect(contentOf(laOf(f.sent)[0])).toMatchObject({ trainCode: '7246', trainCodeIssuedAtMs: NOW });
  });

  it('DB 미바인딩이어도 발사·content는 정상(기록만 생략)', async () => {
    const events: string[] = [];
    const f = makeFetch(events, { rows: [{ btrainNo: '7246', arvlCd: 1 }] });
    await fireOnce(makeTrip(), NOW, undefined, f.impl);
    expect(contentOf(laOf(f.sent)[0])).toMatchObject({ trainCode: '7246', trainCodeIssuedAtMs: NOW });
  });
});

const STALE_STAMP = {
  boardingStation: '건대입구',
  line: '7',
  trainCode: '9999',
  destination: '용마산',
  waypointKeys: [],
  firedAt: NOW - 60_000,
};

function leg2Trip(o: Partial<Trip> = {}): Trip {
  return makeTrip({
    token: 'firetok-leg2',
    promptDisplay: undefined,
    waypoints: [{ stationName: '용마산', line: '7', kind: 'destination' }],
    currentLegAnchor: { boardingStation: '건대입구', line: '7' },
    legBoardingEligibleAt: NOW,
    ...o,
  } as unknown as Partial<Trip>);
}

async function fireLeg2(trip: Trip, now: number, db: Env['DB'], fetchImpl: typeof fetch) {
  await maybeFireLegBoardingPrompt(trip, makeEnv(new InMemoryKV(), db), makeDeps(fetchImpl), createEmptyScheduledStats(now), now, () => {}, () => 'pid');
}

describe('leg-2 발사도 같은 계약', () => {
  it('R3n(현행 red): leg-2 ambiguity 발사는 낡은 legBoardingFireStamp 열차를 content에 싣지 않는다 + NULL 행', async () => {
    const events: string[] = [];
    const { db, rows } = makeDb(events);
    const f = makeFetch(events, {
      rows: [
        { btrainNo: '7246', arvlCd: 1 },
        { btrainNo: '7247', arvlCd: 1 },
      ],
    });
    await fireLeg2(leg2Trip({ legBoardingFireStamp: STALE_STAMP }), NOW, db, f.impl);
    const [la] = laOf(f.sent);
    expect(la).toBeDefined();
    expect(contentOf(la)).not.toHaveProperty('trainCode');
    expect(rows).toEqual([expect.objectContaining({ station: '건대입구', line: '7', trainCode: null })]);
  });
  it('leg-2 정상 발사: 발사 열차/now + 송신 전 기록', async () => {
    const events: string[] = [];
    const { db, rows } = makeDb(events);
    const f = makeFetch(events, { rows: [{ btrainNo: '7246', arvlCd: 1 }] });
    await fireLeg2(leg2Trip({ legBoardingFireStamp: STALE_STAMP }), NOW, db, f.impl);
    expect(contentOf(laOf(f.sent)[0])).toMatchObject({ trainCode: '7246', trainCodeIssuedAtMs: NOW });
    expect(events.indexOf('db:prompt_fires')).toBeLessThan(events.indexOf('la-update'));
    expect(rows).toHaveLength(1);
  });
});

describe('발사 열차가 LA content에 실린다 (탑승 LA start, split)', () => {
  const splitTrip = (o: Partial<Trip> = {}) =>
    makeTrip({ laClient: SPLIT, boardingPushToStartToken: START_TOKEN, ...o });

  it('탑승 LA start content: trainCode=발사 열차, trainCodeIssuedAtMs=now', async () => {
    const events: string[] = [];
    const { db, rows } = makeDb(events);
    const f = makeFetch(events, { rows: [{ btrainNo: '7246', arvlCd: 1 }] });
    await fireOnce(splitTrip(), NOW, db, f.impl);
    const [start] = f.sent.filter((s) => s.type === 'la-start');
    expect(contentOf(start)).toMatchObject({ phase: 'pre-boarding', trainCode: '7246', trainCodeIssuedAtMs: NOW });
    expect(events.indexOf('db:prompt_fires')).toBeLessThan(events.indexOf('la-start'));
    expect(rows).toHaveLength(1);
  });

  it('R3n: ambiguity 발사는 탑승 LA start에도 trainCode·trainCodeIssuedAtMs 없음', async () => {
    const events: string[] = [];
    const { db } = makeDb(events);
    const f = makeFetch(events, {
      rows: [
        { btrainNo: '7246', arvlCd: 1 },
        { btrainNo: '7247', arvlCd: 1 },
      ],
    });
    await fireOnce(splitTrip(), NOW, db, f.impl);
    const [start] = f.sent.filter((s) => s.type === 'la-start');
    expect(contentOf(start)).not.toHaveProperty('trainCode');
    expect(contentOf(start)).not.toHaveProperty('trainCodeIssuedAtMs');
  });
});

describe('R4: A 발사 -> heartbeat -> B 발사', () => {
  it('발사A=A/t1, heartbeat(lock 없음)=A/t1(prompt_fires 복구), 발사B=B/t2 + 행 2개', async () => {
    const events: string[] = [];
    const { db, rows } = makeDb(events);
    const arrivals = { rows: [{ btrainNo: '7246', arvlCd: 1 }] };
    const f = makeFetch(events, arrivals);

    await fireOnce(makeTrip(), NOW, db, f.impl);
    expect(contentOf(laOf(f.sent)[0])).toMatchObject({ trainCode: '7246', trainCodeIssuedAtMs: NOW });

    // heartbeat: 같은 trip 객체가 아니라 stamp 없는 재등록 직후 상태(R4') — prompt_fires만 믿어야 한다.
    const hbTrip = makeTrip({ lastLaPushEpoch: undefined, lastLaPushAt: NOW });
    const hbStats = createEmptyScheduledStats(NOW + 100_000);
    const fired = await maybeFireLiveActivityUpdate(
      hbTrip, hbTrip.waypoints[0], NOW + 600_000, makeDeps(f.impl), hbStats, NOW + 100_000, () => {}, null, true, db,
    );
    expect(fired).toBe(true);
    const hb = laOf(f.sent)[1];
    expect(contentOf(hb)).toMatchObject({ trainCode: '7246', trainCodeIssuedAtMs: NOW });

    arrivals.rows = [{ btrainNo: '7300', arvlCd: 1 }];
    await fireOnce(makeTrip(), LATER, db, f.impl);
    const lastLa = laOf(f.sent).pop() as Sent;
    expect(contentOf(lastLa)).toMatchObject({ trainCode: '7300', trainCodeIssuedAtMs: LATER });
    expect(rows.map((r) => [r.trainCode, r.issuedAt])).toEqual([
      ['7246', NOW],
      ['7300', LATER],
    ]);
  });

  it('R4\': 레코드에 낡은 legBoardingFireStamp(다른 열차)가 있어도 heartbeat는 prompt_fires 최신 발사를 쓴다', async () => {
    const events: string[] = [];
    const { db } = makeDb(events);
    const f = makeFetch(events, { rows: [{ btrainNo: '7246', arvlCd: 1 }] });
    await fireLeg2(leg2Trip(), NOW, db, f.impl);
    const hbTrip = leg2Trip({ lastLaPushEpoch: undefined, legBoardingFireStamp: STALE_STAMP });
    await maybeFireLiveActivityUpdate(hbTrip, hbTrip.waypoints[0], NOW + 600_000, makeDeps(f.impl), createEmptyScheduledStats(NOW), NOW, () => {}, null, true, db);
    expect(contentOf(laOf(f.sent).pop() as Sent)).toMatchObject({ trainCode: '7246', trainCodeIssuedAtMs: NOW });
  });

  it('R4h: prefetch 읽기 실패 -> trainCode 미기재(fail-closed), 다른 content 필드는 정상', async () => {
    const events: string[] = [];
    const { db } = makeDb(events, { failRead: true });
    const f = makeFetch(events, { rows: [] });
    const hbTrip = makeTrip({ lastLaPushEpoch: undefined });
    const fired = await maybeFireLiveActivityUpdate(hbTrip, hbTrip.waypoints[0], NOW + 600_000, makeDeps(f.impl), createEmptyScheduledStats(NOW), NOW, () => {}, null, true, db);
    expect(fired).toBe(true);
    const content = contentOf(laOf(f.sent)[0]);
    expect(content).not.toHaveProperty('trainCode');
    expect(content).not.toHaveProperty('trainCodeIssuedAtMs');
    expect(content).toMatchObject({ boardingPhase: 'pre-boarding', stopsRemaining: 1 });
  });

  it('prompt_fires 행이 train_code NULL(ambiguity)이면 heartbeat도 미기재', async () => {
    const events: string[] = [];
    const { db, rows } = makeDb(events);
    const f = makeFetch(events, { rows: [] });
    const hbTrip = makeTrip({ lastLaPushEpoch: undefined });
    rows.push({ tokenHash: (await import('../sentry')).hashTripToken(hbTrip.token), station: '군자', line: '7', trainCode: null, issuedAt: NOW, decision: 'imminent' });
    await maybeFireLiveActivityUpdate(hbTrip, hbTrip.waypoints[0], NOW + 600_000, makeDeps(f.impl), createEmptyScheduledStats(NOW), NOW, () => {}, null, true, db);
    expect(contentOf(laOf(f.sent)[0])).not.toHaveProperty('trainCode');
  });

  it('lock이 있으면 prefetch 하지 않고 기존 lock 열차 순서 그대로', async () => {
    const events: string[] = [];
    const { db, sqls } = makeDb(events);
    const f = makeFetch(events, { rows: [] });
    const hbTrip = makeTrip({
      lastLaPushEpoch: undefined,
      boardingLock: { trainCode: '5555', lockedAt: NOW - 1000, line: '7' },
    } as unknown as Partial<Trip>);
    await maybeFireLiveActivityUpdate(hbTrip, hbTrip.waypoints[0], NOW + 600_000, makeDeps(f.impl), createEmptyScheduledStats(NOW), NOW, () => {}, null, true, db);
    expect(contentOf(laOf(f.sent)[0])).toMatchObject({ trainCode: '5555' });
    expect(sqls.some((s) => s.includes('prompt_fires'))).toBe(false);
  });
});

describe('R19 / 4번째 호출자: lock 분기는 질문·발사 열차를 싣지 않는다', () => {
  it('lock 부착 trip의 content에는 boardingPhase 없음 / promptFire를 넘겨도 lock 열차 우선', () => {
    const trip = makeTrip({ boardingLock: { trainCode: '5555', lockedAt: NOW, line: '7' } } as unknown as Partial<Trip>);
    const content = buildLiveActivityContentState(trip.waypoints[0], 120, 1, trip, '군자', undefined, {
      promptFire: { trainCode: '7246', issuedAt: NOW },
    });
    expect(content).not.toHaveProperty('boardingPhase');
    expect(content).toMatchObject({ trainCode: '5555' });
    expect(content).not.toHaveProperty('trainCodeIssuedAtMs');
  });
});

describe('R4c: prompt_fires 정리는 시 단위 게이트(매시 0분)에서만', () => {
  async function tick(now: number) {
    const sqls: string[] = [];
    const db = {
      prepare(sql: string) {
        sqls.push(sql);
        return { bind: () => ({ run: async () => ({ success: true, meta: { changes: 0 } }), first: async () => null }) };
      },
    } as unknown as Env['DB'];
    const f = makeFetch([], { rows: [] });
    await runScheduled(makeEnv(new InMemoryKV(), db), { ...makeDeps(f.impl), now: () => now });
    return sqls;
  }
  it('0분: DELETE FROM prompt_fires 실행', async () => {
    const hourStart = Math.floor(NOW / 3_600_000) * 3_600_000;
    expect((await tick(hourStart)).some((s) => s.includes('DELETE FROM prompt_fires'))).toBe(true);
  });
  it('0분이 아니면 실행 안 함', async () => {
    const hourStart = Math.floor(NOW / 3_600_000) * 3_600_000;
    expect((await tick(hourStart + 5 * 60_000)).some((s) => s.includes('DELETE FROM prompt_fires'))).toBe(false);
  });
});
