/**
 * #3221 PR-2 (backend dormant) — Live Activity 2개 분리: Trip capability 수용 + 여정 content 질문 필드 생략 +
 * `sendLiveActivityStart` payload. 동작 변경 0: `laClient` 없는 구 trip은 현행과 byte 동일해야 한다.
 *
 * TDD: 이 파일은 구현 전 스펙(plan §4-2, §8 PR-2)만 보고 작성했다.
 * 실측 acceptance는 10/28 trip 179(`fixtures/capture_20261028_trip179`, 불변) 시나리오를 쓴다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exportPKCS8, generateKeyPair } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, sendLiveActivityStart, type ApnsConfig } from '../apns';
import { app, validateTrip } from '../index';
import { buildLiveActivityContentState } from '../liveActivity';
import { SeoulArrivalClient } from '../seoul';
import { createEmptyScheduledStats, maybeFireLiveActivityUpdate, type ScheduledDeps } from '../scheduled';
import { getTrip } from '../trips';
import type { Env, Trip, Waypoint } from '../types';
import { InMemoryKV } from './inMemoryKv';

let apnsConfig: ApnsConfig;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: await exportPKCS8(privateKey), bundleId: 'com.example.app' };
});
beforeEach(() => resetApnsJwtCache());

const NOW = 1_700_000_000_000;
const WAYPOINT: Waypoint = { stationName: '강남', line: '2', kind: 'destination' };
const SPLIT = { split: true, boardingStart: 'push-to-start' } as const;

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'devtoken',
    route: { type: 'direct', line: '2', stops: 3 },
    destination: '강남',
    waypoints: [WAYPOINT],
    expiresAt: NOW + 3_600_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW + 60_000,
    activityPushToken: 'la-token',
    activityState: 'live',
    apnsEnv: 'sandbox',
    promptDisplay: { originStation: '용마산', line: '7' },
    ...overrides,
  };
}

const QUESTION_KEY = /^boarding/;
function questionKeys(cs: Record<string, unknown>): string[] {
  return Object.keys(cs).filter((k) => QUESTION_KEY.test(k));
}
function withoutQuestion(cs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(cs).filter(([k]) => !QUESTION_KEY.test(k)));
}

describe('buildLiveActivityContentState — split이면 탑승 질문 필드 생략', () => {
  it('[기준] 구 trip(laClient 없음)은 pre-boarding 질문 필드를 싣는다 (현행)', () => {
    const cs = buildLiveActivityContentState(WAYPOINT, 90, 3, makeTrip());
    expect(cs.boardingPhase).toBe('pre-boarding');
    expect(questionKeys(cs).sort()).toEqual(
      ['boardingPhase', 'boardingPromptLine', 'boardingPromptOriginStation', 'boardingPromptTripToken'].sort(),
    );
  });

  it('split trip: pre-boarding 질문 필드 0건 (사유: boardingPhase 미생성)', () => {
    const cs = buildLiveActivityContentState(WAYPOINT, 90, 3, makeTrip({ laClient: SPLIT }));
    expect(questionKeys(cs)).toEqual([]);
  });

  it('split trip: end-prompt due여도 boardingPhase/boardingAlert* 0건', () => {
    const cs = buildLiveActivityContentState(WAYPOINT, 90, 3, makeTrip({ laClient: SPLIT }), undefined, undefined, {
      endPromptDue: true,
    });
    expect(questionKeys(cs)).toEqual([]);
  });

  it('[기준] 구 trip end-prompt due는 현행대로 boardingPhase=end-prompt + alert를 싣는다', () => {
    const cs = buildLiveActivityContentState(WAYPOINT, 90, 3, makeTrip(), undefined, undefined, { endPromptDue: true });
    expect(cs.boardingPhase).toBe('end-prompt');
    expect(cs.boardingAlertTitle).toBeDefined();
  });

  it('split trip도 여정 필드(stationName/lineName/stopsRemaining/etaMinutes)는 그대로 싣는다', () => {
    const base = buildLiveActivityContentState(WAYPOINT, 90, 3, makeTrip());
    const split = buildLiveActivityContentState(WAYPOINT, 90, 3, makeTrip({ laClient: SPLIT }));
    expect(split).toEqual(withoutQuestion(base));
  });

  it.each([
    ['fg-only', { split: true, boardingStart: 'fg-only' }],
    ['none', { split: true, boardingStart: 'none' }],
  ] as const)('boardingStart=%s split도 질문 필드 0건', (_n, laClient) => {
    const cs = buildLiveActivityContentState(WAYPOINT, 90, 3, makeTrip({ laClient }));
    expect(questionKeys(cs)).toEqual([]);
  });

  it('split trip도 trainCode 필드는 여정 content에 유지된다', () => {
    const cs = buildLiveActivityContentState(WAYPOINT, 90, 3, makeTrip({ laClient: SPLIT }), undefined, 'T123');
    expect(cs.trainCode).toBe('T123');
  });
});

function baseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: 'tok-3221',
    route: { type: 'direct', line: '7', stops: 2 },
    destination: '용마산',
    waypoints: [
      { stationName: '중곡', line: '7', kind: 'intermediate' },
      { stationName: '용마산', line: '7', kind: 'destination' },
    ],
    expiresAt: Date.now() + 3_600_000,
    alarmAtEpochMs: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

describe('validateTrip — laClient / boardingPushToStartToken 수용', () => {
  it.each(['push-to-start', 'fg-only', 'none'] as const)('laClient boardingStart=%s 수용', (boardingStart) => {
    const trip = validateTrip(baseBody({ laClient: { split: true, boardingStart } }));
    expect(trip?.laClient).toEqual({ split: true, boardingStart });
  });

  it('push-to-start token 문자열 수용', () => {
    const trip = validateTrip(baseBody({ boardingPushToStartToken: 'abcdef0123' }));
    expect(trip?.boardingPushToStartToken).toBe('abcdef0123');
  });

  it('미송신 구 payload는 두 필드 모두 undefined (등록 거부 아님)', () => {
    const trip = validateTrip(baseBody());
    expect(trip).not.toBeNull();
    expect(trip?.laClient).toBeUndefined();
    expect(trip?.boardingPushToStartToken).toBeUndefined();
  });

  it.each([
    ['split:false', { split: false, boardingStart: 'push-to-start' }],
    ['split 문자열', { split: 'true', boardingStart: 'push-to-start' }],
    ['알 수 없는 boardingStart', { split: true, boardingStart: 'push' }],
    ['boardingStart 누락', { split: true }],
    ['배열', []],
    ['문자열', 'split'],
    ['null', null],
  ])('잘못된 laClient(%s)는 제거하되 등록은 거부하지 않는다', (_n, laClient) => {
    const trip = validateTrip(baseBody({ laClient }));
    expect(trip).not.toBeNull();
    expect(trip?.laClient).toBeUndefined();
  });

  it.each([
    ['빈 문자열', ''],
    ['숫자', 5],
    ['객체', {}],
    ['null', null],
  ])('잘못된 boardingPushToStartToken(%s)은 제거하되 등록은 거부하지 않는다', (_n, boardingPushToStartToken) => {
    const trip = validateTrip(baseBody({ boardingPushToStartToken }));
    expect(trip).not.toBeNull();
    expect(trip?.boardingPushToStartToken).toBeUndefined();
  });
});

function makeEnv(kv: InMemoryKV): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
    APNS_HOST: 'api.push.apple.com',
    APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
    SEOUL_API_HOST: 'seoul.api',
    SEOUL_API_KEY: 'KEY',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: 'p',
    APNS_BUNDLE_ID: 'b',
  };
}

async function postTrips(body: unknown, env: Env): Promise<Response> {
  return app.fetch(
    new Request('http://example.com/trips', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );
}

describe('POST /trips — same-session 재등록 merge 보존', () => {
  it('1차(laClient+token) -> 2차(미송신, 같은 세션) 후에도 저장본에 보존된다', async () => {
    const env = makeEnv(new InMemoryKV());
    expect((await postTrips(baseBody({ laClient: SPLIT, boardingPushToStartToken: 'p2s-1' }), env)).status).toBe(200);
    expect((await postTrips(baseBody(), env)).status).toBe(200);
    const stored = await getTrip(env.TRIPS, 'tok-3221');
    // 사유: merge가 `...incoming`만 받으면 두 필드가 undefined로 소실된다.
    expect(stored?.laClient).toEqual(SPLIT);
    expect(stored?.boardingPushToStartToken).toBe('p2s-1');
  });

  it('재등록당 trip KV put 횟수는 필드 유무와 무관하게 동일하다 (KV 쓰기 +0)', async () => {
    const countTripPuts = async (extra: Record<string, unknown>): Promise<number> => {
      const kv = new InMemoryKV();
      const env = makeEnv(kv);
      await postTrips(baseBody(extra), env);
      const spy = vi.spyOn(kv, 'put');
      await postTrips(baseBody(extra), env);
      return spy.mock.calls.length;
    };
    const without = await countTripPuts({});
    const withFields = await countTripPuts({ laClient: SPLIT, boardingPushToStartToken: 'p2s-1' });
    expect(withFields).toBe(without);
  });

  it('2차가 새 token을 보내면 incoming이 이긴다 (push-to-start token rotation)', async () => {
    const env = makeEnv(new InMemoryKV());
    await postTrips(baseBody({ laClient: SPLIT, boardingPushToStartToken: 'p2s-1' }), env);
    await postTrips(
      baseBody({ laClient: { split: true, boardingStart: 'fg-only' }, boardingPushToStartToken: 'p2s-2' }),
      env,
    );
    const stored = await getTrip(env.TRIPS, 'tok-3221');
    expect(stored?.laClient).toEqual({ split: true, boardingStart: 'fg-only' });
    expect(stored?.boardingPushToStartToken).toBe('p2s-2');
  });
});

describe('sendLiveActivityStart — push-to-start payload (정의만, 호출 배선은 PR-3)', () => {
  it('event=start + attributes-type + attributes + content-state + alert, LA topic/push-type 재사용', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const result = await sendLiveActivityStart({
      pushToStartToken: 'p2s-token-hex',
      attributesType: 'BoardingActivityAttributes',
      attributes: { promptId: 'p-1', tripToken: 'tok' },
      contentState: { phase: 'pre-boarding', originStation: '중곡' },
      alert: { title: '탑승하셨나요?', body: '7호선 중곡', sound: 'default' },
      timestamp: 1_700_000_000,
      config: apnsConfig,
      host: 'api.push.apple.com',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.push.apple.com/3/device/p2s-token-hex');
    const headers = init.headers as Record<string, string>;
    expect(headers['apns-topic']).toBe('com.example.app.push-type.liveactivity');
    expect(headers['apns-push-type']).toBe('liveactivity');
    expect(headers['apns-priority']).toBe('10');
    expect(JSON.parse(init.body as string)).toEqual({
      aps: {
        timestamp: 1_700_000_000,
        event: 'start',
        'attributes-type': 'BoardingActivityAttributes',
        attributes: { promptId: 'p-1', tripToken: 'tok' },
        'content-state': { phase: 'pre-boarding', originStation: '중곡' },
        alert: { title: '탑승하셨나요?', body: '7호선 중곡', sound: 'default' },
      },
    });
  });

  it('sound 미지정이면 alert에 sound 키를 싣지 않고, staleDate는 stale-date, priority는 헤더로 실린다', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await sendLiveActivityStart({
      pushToStartToken: 't',
      attributesType: 'BoardingActivityAttributes',
      attributes: {},
      contentState: {},
      alert: { title: 'a', body: 'b' },
      staleDate: 1_700_000_300,
      priority: 5,
      config: apnsConfig,
      host: 'api.push.apple.com',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const { aps } = JSON.parse(init.body as string);
    expect(aps.alert).toEqual({ title: 'a', body: 'b' });
    expect(aps['stale-date']).toBe(1_700_000_300);
    expect((init.headers as Record<string, string>)['apns-priority']).toBe('5');
  });

  it('APNs 거절은 ok:false + status로 반환한다', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
    );
    const result = await sendLiveActivityStart({
      pushToStartToken: 't',
      attributesType: 'BoardingActivityAttributes',
      attributes: {},
      contentState: {},
      alert: { title: 'a', body: 'b' },
      config: apnsConfig,
      host: 'api.push.apple.com',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });
});

// --- 10/28 trip 179 acceptance (fixture 원문 불변) -------------------------------------------------------
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'capture_20261028_trip179');
const KST_OFFSET_MS = 9 * 60 * 60_000;
const PUSH_AT = Date.UTC(2026, 9, 28, 6, 29, 46) - KST_OFFSET_MS;

function tripAtGunja(extra: Partial<Trip> = {}): Trip {
  const contract = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'device_waypoints.contract.json'), 'utf8')) as {
    route: unknown;
    waypoints: Record<string, unknown>[];
  };
  const trip = validateTrip({
    token: 'trip179',
    destination: '뚝섬',
    route: contract.route,
    waypoints: contract.waypoints,
    expiresAt: Date.now() + 3_600_000,
    alarmAtEpochMs: PUSH_AT + 60_000,
  });
  if (!trip) throw new Error('validateTrip rejected the device payload');
  return {
    ...trip,
    activityPushToken: 'la-token',
    activityState: 'live',
    apnsEnv: 'sandbox',
    originStationName: '중곡',
    ...extra,
  };
}

async function laPushBody(trip: Trip): Promise<string> {
  const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
  const deps = {
    apnsConfig,
    apnsHosts: { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' },
    fetchImpl: fetchImpl as unknown as typeof fetch,
    seoul: new SeoulArrivalClient({ host: 'h', apiKey: 'K', fetchImpl: fetchImpl as unknown as typeof fetch }),
  } as ScheduledDeps;
  const stats = createEmptyScheduledStats(PUSH_AT);
  const fired = await maybeFireLiveActivityUpdate(
    trip,
    trip.waypoints[0],
    PUSH_AT + 120_000,
    deps,
    stats,
    PUSH_AT,
    () => {},
    null,
  );
  expect(fired).toBe(true);
  const calls = (fetchImpl.mock.calls as unknown as [string, RequestInit][]).filter(([, init]) =>
    String(init?.body).includes('content-state'),
  );
  expect(calls).toHaveLength(1);
  return calls[0][1].body as string;
}

function contentOf(body: string): Record<string, unknown> {
  return (JSON.parse(body) as { aps: { 'content-state': Record<string, unknown> } }).aps['content-state'];
}

describe('acceptance — 10/28 trip 179 (06:29:46) 여정 LA push', () => {
  it('구 trip(laClient 없음): 질문 필드를 싣는 현행 body와 byte 동일 (laClient:undefined 명시와도 동일)', async () => {
    const legacy = await laPushBody(tripAtGunja());
    const explicitUndefined = await laPushBody(
      tripAtGunja({ laClient: undefined, boardingPushToStartToken: undefined }),
    );
    expect(explicitUndefined).toBe(legacy);
    const cs = contentOf(legacy);
    expect(cs.boardingPhase).toBe('pre-boarding');
    expect(cs.boardingPromptOriginStation).toBe('중곡');
  });

  it('split trip: 질문 필드 0건, 나머지 여정 필드는 구 trip과 동일', async () => {
    const legacyCs = contentOf(await laPushBody(tripAtGunja()));
    const splitCs = contentOf(await laPushBody(tripAtGunja({ laClient: SPLIT, boardingPushToStartToken: 'p2s' })));
    expect(questionKeys(splitCs)).toEqual([]);
    expect(splitCs).toEqual(withoutQuestion(legacyCs));
  });
});
