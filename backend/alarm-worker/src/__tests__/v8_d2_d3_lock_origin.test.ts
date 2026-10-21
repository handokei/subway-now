/**
 * #3144 (v8 D2·D3, ADR-043) — lock은 boarding-prompt 응답으로만 부착된다.
 *   - D2: /boarding-lock/sync 승격은 backend가 프롬프트로 제시한 열차(recentPromptCandidates /
 *         legBoardingFireStamp)일 때만. 증거 없음·streak-only는 거부.
 *   - D3: register-time resolver는 현재 leg 응답 마커(boardingResponse ∨ boardingCommitted)가 있을 때만.
 *   - 모든 attach 지점이 D1 `lock-attached`(path, hasResponseMarker)를 남긴다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, isPromotionCorroborated } from '../index';
import { currentBoardingLegKey, hasBoardingResponseForCurrentLeg } from '../trips';
import type { Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';

function makeKvEnv(): Env {
  return {
    TRIPS: new InMemoryKV() as unknown as Env['TRIPS'],
    APNS_HOST: 'api.push.apple.com',
    APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
    SEOUL_API_HOST: 'h',
    SEOUL_API_KEY: 'k',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: 'p',
    APNS_BUNDLE_ID: 'b',
  };
}

async function post(path: string, body: unknown, env: Env, ctx?: ExecutionContext): Promise<Response> {
  return app.fetch(
    new Request(`http://example.com${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

/** register 응답 후 waitUntil 큐(resolver)를 완료시킨다. */
async function postAndSettle(path: string, body: unknown, env: Env): Promise<Response> {
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void waits.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  const res = await post(path, body, env, ctx);
  await Promise.all(waits);
  return res;
}

function captureEventInserts(): { db: Env['DB']; inserts: unknown[][] } {
  const inserts: unknown[][] = [];
  const run = vi.fn().mockResolvedValue({ success: true });
  const prepare = vi.fn().mockImplementation((sql: string) => ({
    bind: (...args: unknown[]) => {
      if (sql.includes('trip_events')) inserts.push(args);
      return { run };
    },
  }));
  return { db: { prepare } as unknown as Env['DB'], inserts };
}

function metaOf(args: unknown[]): Record<string, unknown> {
  return JSON.parse(args[5] as string) as Record<string, unknown>;
}

describe('v8 D2 — isPromotionCorroborated 엄격화', () => {
  const NOW = 1_800_000_000_000;

  function baseTrip(overrides: Partial<Trip> = {}): Trip {
    return {
      token: 'v8d2-unit',
      route: { type: 'direct', line: '7', stops: 3 } as unknown as Trip['route'],
      destination: '군자',
      waypoints: [{ stationName: '군자', line: '7', kind: 'destination' }],
      expiresAt: NOW + 60 * 60_000,
      createdAt: NOW - 10 * 60_000,
      alarmAtEpochMs: NOW,
      ...overrides,
    };
  }

  const stamp = (overrides: Record<string, unknown> = {}): Trip['legBoardingFireStamp'] =>
    ({
      boardingStation: '건대입구',
      line: '7',
      trainCode: '7039',
      destination: '군자',
      waypointKeys: [],
      firedAt: NOW - 60_000,
      ...overrides,
    }) as Trip['legBoardingFireStamp'];

  it('양쪽 신호 부재(한 번도 프롬프트 제시 없음) -> false (backward-safe true 폐기)', () => {
    expect(isPromotionCorroborated('7039', baseTrip(), NOW)).toBe(false);
  });

  it('legResolveStreak만 일치(프롬프트가 제시한 적 없는 열차) -> false', () => {
    const trip = baseTrip({ legResolveStreak: { trainCode: '7039', count: 3 } });
    expect(isPromotionCorroborated('7039', trip, NOW)).toBe(false);
  });

  it('legBoardingFireStamp.trainCode 일치 + TTL 내 -> true (발사 이력 증거)', () => {
    expect(isPromotionCorroborated('7039', baseTrip({ legBoardingFireStamp: stamp() }), NOW)).toBe(true);
  });

  it('legBoardingFireStamp가 다른 열차 -> false', () => {
    const trip = baseTrip({ legBoardingFireStamp: stamp({ trainCode: '9999' }) });
    expect(isPromotionCorroborated('7039', trip, NOW)).toBe(false);
  });

  it('legBoardingFireStamp가 TTL(15분) 초과 -> false', () => {
    const trip = baseTrip({ legBoardingFireStamp: stamp({ firedAt: NOW - 15 * 60_000 - 1 }) });
    expect(isPromotionCorroborated('7039', trip, NOW)).toBe(false);
  });

  it('stamp.trainCode 없음(ambiguity 발사) -> false', () => {
    const trip = baseTrip({ legBoardingFireStamp: stamp({ trainCode: undefined }) });
    expect(isPromotionCorroborated('7039', trip, NOW)).toBe(false);
  });

  it('recentPromptCandidates 소속 + TTL 내 -> true (유지)', () => {
    const trip = baseTrip({ recentPromptCandidates: { trainCodes: ['7039'], firedAt: NOW - 60_000 } });
    expect(isPromotionCorroborated('7039', trip, NOW)).toBe(true);
  });
});

describe('v8 D2 — /boarding-lock/sync 승격은 프롬프트 제시 열차만', () => {
  function lockless(overrides: Partial<Trip> = {}): Trip {
    const now = Date.now();
    return {
      token: 'v8d2-tok',
      route: { type: 'direct', line: '7', stops: 3 } as unknown as Trip['route'],
      destination: '군자',
      waypoints: [
        { stationName: '중곡', line: '7', kind: 'intermediate' },
        { stationName: '군자', line: '7', kind: 'destination' },
      ],
      expiresAt: now + 60 * 60_000,
      createdAt: now - 10 * 60_000,
      alarmAtEpochMs: now,
      infoModeEnabled: true,
      ...overrides,
    };
  }

  const sync = (env: Env, trainCode: string) =>
    post(
      '/boarding-lock/sync',
      {
        token: 'v8d2-tok',
        observedStationName: '용마산',
        observedAtMs: Date.now(),
        accuracy: 20,
        trainCode,
        boardingLine: '7',
      },
      env,
    );

  it('프롬프트 제시 이력 0(목록 탭 lock 3013형) -> 승격 거부 + promotion-rejected-uncorroborated 1건', async () => {
    const { db, inserts } = captureEventInserts();
    const env = makeKvEnv();
    env.DB = db;
    await env.TRIPS.put('trip:v8d2-tok', JSON.stringify(lockless()));
    const res = await sync(env, '7039');
    expect(res.status).toBe(200);
    const stored = JSON.parse((await env.TRIPS.get('trip:v8d2-tok')) as string);
    expect(stored.boardingLock).toBeUndefined();
    const rejected = inserts.filter((a) => a[2] === 'promotion-rejected-uncorroborated');
    expect(rejected).toHaveLength(1);
    expect(metaOf(rejected[0])).toEqual({ trainCode: '7039', line: '7' });
    expect(inserts.filter((a) => a[2] === 'lock-attached')).toEqual([]);
  });

  it('streak만 있고 프롬프트 제시 이력 없음 -> 승격 거부', async () => {
    const env = makeKvEnv();
    await env.TRIPS.put(
      'trip:v8d2-tok',
      JSON.stringify(lockless({ legResolveStreak: { trainCode: '7039', count: 2 } })),
    );
    await sync(env, '7039');
    const stored = JSON.parse((await env.TRIPS.get('trip:v8d2-tok')) as string);
    expect(stored.boardingLock).toBeUndefined();
  });

  it('recentPromptCandidates 소속 -> 승격 + lock-attached(path=sync, hasResponseMarker=false) 기록', async () => {
    const { db, inserts } = captureEventInserts();
    const env = makeKvEnv();
    env.DB = db;
    await env.TRIPS.put(
      'trip:v8d2-tok',
      JSON.stringify(lockless({ recentPromptCandidates: { trainCodes: ['7039'], firedAt: Date.now() } })),
    );
    const res = await sync(env, '7039');
    expect(res.status).toBe(200);
    const stored = JSON.parse((await env.TRIPS.get('trip:v8d2-tok')) as string);
    expect(stored.boardingLock?.trainCode).toBe('7039');
    const attached = inserts.filter((a) => a[2] === 'lock-attached');
    expect(attached).toHaveLength(1);
    expect(metaOf(attached[0])).toMatchObject({ path: 'sync', trainCode: '7039', hasResponseMarker: false });
  });
});

describe('v8 D3 — 응답 마커 헬퍼', () => {
  const NOW = 1_800_000_000_000;
  const trip = (overrides: Partial<Trip> = {}): Trip =>
    ({
      token: 'v8d3-unit',
      route: { type: 'direct', line: '7', stops: 3 },
      destination: '군자',
      waypoints: [{ stationName: '군자', line: '7', kind: 'destination' }],
      expiresAt: NOW + 3_600_000,
      createdAt: NOW,
      alarmAtEpochMs: NOW,
      ...overrides,
    }) as Trip;

  it('마커 없음 -> false', () => {
    expect(hasBoardingResponseForCurrentLeg(trip())).toBe(false);
  });

  it('현재 leg 키의 마커 -> true', () => {
    const t = trip();
    const marked: Trip = { ...t, boardingResponse: { legKey: currentBoardingLegKey(t), at: NOW } };
    expect(hasBoardingResponseForCurrentLeg(marked)).toBe(true);
  });

  it('leg 전환(currentLegAnchor 생김) 후에는 이전 leg 마커가 무효', () => {
    const t = trip();
    const marked: Trip = { ...t, boardingResponse: { legKey: currentBoardingLegKey(t), at: NOW } };
    const leg2: Trip = { ...marked, currentLegAnchor: { boardingStation: '건대입구', line: '2' } };
    expect(currentBoardingLegKey(leg2)).not.toBe(currentBoardingLegKey(marked));
    expect(hasBoardingResponseForCurrentLeg(leg2)).toBe(false);
  });

  it('boardingCommitted(PENDING 응답 유래)도 응답으로 인정', () => {
    expect(hasBoardingResponseForCurrentLeg(trip({ boardingCommitted: true }))).toBe(true);
  });
});

describe('v8 D3 — register-time resolver 응답 마커 게이트 + carry + 마커 기록', () => {
  const CREATED = 1_710_000_000_000;

  function recptnDtFor(ms: number): string {
    return new Date(ms + 9 * 60 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
  }

  function tripBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      token: 'tok-v8d3',
      route: { type: 'direct', line: '7', stops: 1 },
      destination: '어린이대공원',
      waypoints: [{ stationName: '어린이대공원', line: '7', kind: 'destination' }],
      expiresAt: CREATED + 60 * 60_000,
      alarmAtEpochMs: CREATED + 30 * 60_000,
      createdAt: CREATED,
      infoModeEnabled: true,
      promptDisplay: { originStation: '중곡', line: '7' },
      ...overrides,
    };
  }

  const positions = (): Response =>
    new Response(
      JSON.stringify({
        realtimePositionList: [
          {
            trainNo: '7246',
            statnNm: '중곡',
            trainSttus: 1,
            updnLine: '1',
            recptnDt: recptnDtFor(CREATED),
            lastRecptnDt: recptnDtFor(CREATED).slice(0, 10).replace(/-/g, ''),
          },
        ],
      }),
      { status: 200 },
    );
  const noPositions = (): Response =>
    new Response(JSON.stringify({ realtimePositionList: [] }), { status: 200 });

  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(CREATED);
    fetchSpy = vi.fn().mockImplementation(async () => positions());
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('infoMode=true + 응답 마커 없음 -> resolver가 Seoul 조회도 lock 부착도 하지 않는다', async () => {
    const env = makeKvEnv();
    const res = await postAndSettle('/trips', tripBody(), env);
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-v8d3')) as string);
    expect(stored.boardingLock).toBeUndefined();
  });

  it('boarded 응답(마커 기록) 후 same-session 재등록 -> 마커 carry + resolver 부착 + lock-attached(path=register, hasResponseMarker=true)', async () => {
    const { db, inserts } = captureEventInserts();
    const env = makeKvEnv();
    env.DB = db;
    await postAndSettle('/trips', tripBody(), env);

    // 응답 시점에는 열차가 아직 포착되지 않아 lock 미부착 — 마커만 남는다.
    fetchSpy.mockImplementation(async () => noPositions());
    const confirm = await post('/trips/tok-v8d3/boarding-confirm', { action: 'boarded', station: '중곡', line: '7' }, env);
    expect(confirm.status).toBe(200);
    const afterConfirm = JSON.parse((await env.TRIPS.get('trip:tok-v8d3')) as string);
    expect(afterConfirm.boardingLock).toBeUndefined();
    expect(afterConfirm.boardingResponse).toEqual({ legKey: currentBoardingLegKey(afterConfirm), at: CREATED });

    fetchSpy.mockImplementation(async () => positions());
    await postAndSettle('/trips', tripBody(), env);
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-v8d3')) as string);
    expect(stored.boardingResponse).toEqual(afterConfirm.boardingResponse);
    expect(stored.boardingLock?.trainCode).toBe('7246');
    const attached = inserts.filter((a) => a[2] === 'lock-attached');
    expect(attached).toHaveLength(1);
    expect(metaOf(attached[0])).toMatchObject({ path: 'register', trainCode: '7246', hasResponseMarker: true });
  });

  it('not-boarded 응답은 마커를 남기지 않는다', async () => {
    const env = makeKvEnv();
    await postAndSettle('/trips', tripBody(), env);
    await post('/trips/tok-v8d3/boarding-confirm', { action: 'not-boarded', station: '중곡', line: '7' }, env);
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-v8d3')) as string);
    expect(stored.boardingResponse).toBeUndefined();
  });

  it('same-session 재등록이 recentPromptCandidates를 보존한다 (D2가 의존하는 carry)', async () => {
    const env = makeKvEnv();
    await postAndSettle('/trips', tripBody({ infoModeEnabled: false }), env);
    const seeded = JSON.parse((await env.TRIPS.get('trip:tok-v8d3')) as string);
    const candidates = { trainCodes: ['7246'], firedAt: CREATED };
    await env.TRIPS.put('trip:tok-v8d3', JSON.stringify({ ...seeded, recentPromptCandidates: candidates }));
    await postAndSettle('/trips', tripBody({ infoModeEnabled: false }), env);
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-v8d3')) as string);
    expect(stored.recentPromptCandidates).toEqual(candidates);
  });

  it('boarding-confirm이 body trainCode로 lock을 붙이면 lock-attached(path=confirm, hasResponseMarker=true)', async () => {
    const { db, inserts } = captureEventInserts();
    const env = makeKvEnv();
    env.DB = db;
    await postAndSettle('/trips', tripBody({ infoModeEnabled: false }), env);
    const seeded = JSON.parse((await env.TRIPS.get('trip:tok-v8d3')) as string);
    await env.TRIPS.put(
      'trip:tok-v8d3',
      JSON.stringify({ ...seeded, recentPromptCandidates: { trainCodes: ['7246'], firedAt: CREATED - 1000 } }),
    );
    fetchSpy.mockImplementation(async () => noPositions());
    await post(
      '/trips/tok-v8d3/boarding-confirm',
      { action: 'boarded', station: '중곡', line: '7', trainCode: '7246' },
      env,
    );
    const attached = inserts.filter((a) => a[2] === 'lock-attached');
    expect(attached).toHaveLength(1);
    expect(metaOf(attached[0])).toMatchObject({ path: 'confirm', trainCode: '7246', hasResponseMarker: true });
  });
});
