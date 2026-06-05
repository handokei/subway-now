import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  app,
  computeLockSyncAdvance,
  LOCK_TTL_REFRESH_MS,
  validateBoardingLockSync,
  validateLiveActivityRegister,
  validatePushAck,
  validateTrip,
} from '../index';
import { progressKey, type TripProgress } from '../progress';
import { pendingKey } from '../pendingPushes';
import type { AnalyticsEngineWriter, Env } from '../types';
import { InMemoryKV } from './inMemoryKv';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    TRIPS: {} as Env['TRIPS'],
    APNS_HOST: 'api.push.apple.com',
    APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
    SEOUL_API_HOST: 'h',
    SEOUL_API_KEY: 'k',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: 'p',
    APNS_BUNDLE_ID: 'b',
    ...overrides,
  };
}

async function post(path: string, body: unknown, env: Env): Promise<Response> {
  return app.fetch(
    new Request(`http://example.com${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
  );
}

async function del(path: string, env: Env): Promise<Response> {
  return app.fetch(new Request(`http://example.com${path}`, { method: 'DELETE' }), env);
}

function makeKvEnv(): Env {
  return makeEnv({ TRIPS: new InMemoryKV() as unknown as Env['TRIPS'] });
}

const FUTURE = Date.now() + 60 * 60 * 1000;

function base(): Record<string, unknown> {
  return {
    token: 'tok',
    route: { type: 'direct', line: '2', stops: 3 },
    destination: 'dst',
    waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
    expiresAt: FUTURE,
    alarmAtEpochMs: FUTURE - 30 * 60 * 1000,
  };
}

describe('validateTrip', () => {
  it('accepts valid input', () => {
    const trip = validateTrip(base());
    expect(trip?.token).toBe('tok');
  });

  it('rejects non-object', () => {
    expect(validateTrip(null)).toBeNull();
    expect(validateTrip('string')).toBeNull();
  });

  it('rejects missing token', () => {
    const b = base();
    delete b.token;
    expect(validateTrip(b)).toBeNull();
  });

  it('rejects expired trip', () => {
    expect(validateTrip({ ...base(), expiresAt: Date.now() - 1 })).toBeNull();
  });

  it('rejects empty waypoints', () => {
    expect(validateTrip({ ...base(), waypoints: [] })).toBeNull();
  });

  it('rejects invalid waypoint kind', () => {
    expect(
      validateTrip({
        ...base(),
        waypoints: [{ stationName: '강남', line: '2', kind: 'unknown' }],
      }),
    ).toBeNull();
  });

  it('accepts intermediate waypoint kind (#416)', () => {
    const trip = validateTrip({
      ...base(),
      waypoints: [
        { stationName: '중곡', line: '7', kind: 'intermediate' },
        { stationName: '강남', line: '2', kind: 'destination' },
      ],
    });
    expect(trip).not.toBeNull();
    expect(trip?.waypoints[0].kind).toBe('intermediate');
  });

  it('rejects malformed waypoint', () => {
    expect(validateTrip({ ...base(), waypoints: [null] })).toBeNull();
    expect(
      validateTrip({ ...base(), waypoints: [{ stationName: 1, line: '2', kind: 'destination' }] }),
    ).toBeNull();
  });

  it('preserves optional lastFiredPhase', () => {
    const trip = validateTrip({ ...base(), lastFiredPhase: 'early', lastEtaSeconds: 120 });
    expect(trip?.lastFiredPhase).toBe('early');
    expect(trip?.lastEtaSeconds).toBe(120);
  });

  it('drops invalid lastFiredPhase', () => {
    const trip = validateTrip({ ...base(), lastFiredPhase: 'bogus' });
    expect(trip?.lastFiredPhase).toBeUndefined();
  });

  it('preserves valid apnsEnv', () => {
    expect(validateTrip({ ...base(), apnsEnv: 'sandbox' })?.apnsEnv).toBe('sandbox');
    expect(validateTrip({ ...base(), apnsEnv: 'production' })?.apnsEnv).toBe('production');
  });

  it('drops invalid apnsEnv', () => {
    expect(validateTrip({ ...base(), apnsEnv: 'bogus' })?.apnsEnv).toBeUndefined();
    expect(validateTrip(base())?.apnsEnv).toBeUndefined();
  });

  it('rejects missing alarmAtEpochMs', () => {
    const b = base();
    delete b.alarmAtEpochMs;
    expect(validateTrip(b)).toBeNull();
  });

  it('rejects missing route', () => {
    const b = base();
    delete b.route;
    expect(validateTrip(b)).toBeNull();
  });

  // #706
  it('preserves numeric consecutiveEtaMissing', () => {
    expect(validateTrip({ ...base(), consecutiveEtaMissing: 3 })?.consecutiveEtaMissing).toBe(3);
  });

  it('drops non-number consecutiveEtaMissing (defaults to undefined → 0 at runtime)', () => {
    expect(validateTrip({ ...base(), consecutiveEtaMissing: 'lots' })?.consecutiveEtaMissing).toBeUndefined();
    // 필드 자체가 부재인 경우(구버전 trip): undefined로 보존, scheduled.ts가 ?? 0으로 fallback.
    expect(validateTrip(base())?.consecutiveEtaMissing).toBeUndefined();
  });

  // #816 C — lockless station-passed opt-in 필드
  it('preserves boolean locklessStationPassed (#816)', () => {
    expect(validateTrip({ ...base(), locklessStationPassed: true })?.locklessStationPassed).toBe(true);
    expect(validateTrip({ ...base(), locklessStationPassed: false })?.locklessStationPassed).toBe(false);
  });

  it('drops non-boolean locklessStationPassed and absent field stays undefined', () => {
    expect(
      validateTrip({ ...base(), locklessStationPassed: 'yes' })?.locklessStationPassed,
    ).toBeUndefined();
    expect(validateTrip({ ...base(), locklessStationPassed: 1 })?.locklessStationPassed).toBeUndefined();
    expect(validateTrip(base())?.locklessStationPassed).toBeUndefined();
  });

  // #903 (Seam G) — subsurface 필드
  it('preserves boolean subsurface (#903)', () => {
    expect(validateTrip({ ...base(), subsurface: true })?.subsurface).toBe(true);
    expect(validateTrip({ ...base(), subsurface: false })?.subsurface).toBe(false);
  });

  it('drops non-boolean subsurface and absent field stays undefined (#903)', () => {
    expect(validateTrip({ ...base(), subsurface: 'yes' })?.subsurface).toBeUndefined();
    expect(validateTrip({ ...base(), subsurface: 1 })?.subsurface).toBeUndefined();
    expect(validateTrip(base())?.subsurface).toBeUndefined();
  });
});

describe('validateTrip — boardingLock (#585)', () => {
  function validLock(): Record<string, unknown> {
    return {
      trainCode: '7246',
      line: '7',
      subwayId: '1007',
      selectedDepartureTime: 1_700_000_000_000,
      segmentStations: ['용마산', '중곡', '군자'],
      expiresAt: FUTURE,
    };
  }

  it('accepts valid boardingLock', () => {
    const trip = validateTrip({ ...base(), boardingLock: validLock() });
    expect(trip?.boardingLock?.trainCode).toBe('7246');
    expect(trip?.boardingLock?.segmentStations).toEqual(['용마산', '중곡', '군자']);
  });

  it('omits boardingLock when absent', () => {
    expect(validateTrip(base())?.boardingLock).toBeUndefined();
  });

  it('drops boardingLock when non-object (trip survives)', () => {
    const trip = validateTrip({ ...base(), boardingLock: 'bogus' });
    expect(trip).not.toBeNull();
    expect(trip?.boardingLock).toBeUndefined();
  });

  it.each([
    ['trainCode missing', { trainCode: undefined }],
    ['trainCode empty', { trainCode: '' }],
    ['line missing', { line: undefined }],
    ['line empty', { line: '' }],
    ['subwayId missing', { subwayId: undefined }],
    ['subwayId empty', { subwayId: '' }],
    ['selectedDepartureTime not number', { selectedDepartureTime: 'now' }],
    ['segmentStations not array', { segmentStations: 'A,B' }],
    ['segmentStations empty', { segmentStations: [] }],
    ['segmentStations contains non-string', { segmentStations: ['A', 1] }],
    ['segmentStations contains empty string', { segmentStations: ['A', ''] }],
    ['expiresAt not number', { expiresAt: 'soon' }],
  ])('drops boardingLock when %s', (_label, override) => {
    const trip = validateTrip({ ...base(), boardingLock: { ...validLock(), ...override } });
    expect(trip).not.toBeNull();
    expect(trip?.boardingLock).toBeUndefined();
  });
});

describe('POST /trips — boardingLock merge (#585)', () => {
  const CREATED = 1_700_000_000_000;
  function lockBody(lockOverride?: Record<string, unknown> | null): Record<string, unknown> {
    const body: Record<string, unknown> = {
      ...base(),
      token: 'tok-585',
      createdAt: CREATED,
    };
    if (lockOverride !== null) {
      body.boardingLock = {
        trainCode: '7246',
        line: '7',
        subwayId: '1007',
        selectedDepartureTime: CREATED,
        segmentStations: ['용마산', '중곡', '군자'],
        expiresAt: FUTURE,
        ...lockOverride,
      };
    }
    return body;
  }

  it('persists boardingLock on first register', async () => {
    const env = makeKvEnv();
    await post('/trips', lockBody(), env);
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-585')) as string);
    expect(stored.boardingLock?.trainCode).toBe('7246');
  });

  it('incoming boardingLock wins on same-session re-register (transfer updates trainCode)', async () => {
    const env = makeKvEnv();
    await post('/trips', lockBody({ trainCode: '7246' }), env);
    await post('/trips', lockBody({ trainCode: '2317' }), env);
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-585')) as string);
    expect(stored.boardingLock?.trainCode).toBe('2317');
  });

  it('omitted boardingLock clears existing lock (lock released)', async () => {
    const env = makeKvEnv();
    await post('/trips', lockBody(), env);
    await post('/trips', lockBody(null), env);
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-585')) as string);
    expect(stored.boardingLock).toBeUndefined();
  });

  it('clears stale lastTrackedArrivalEpoch when both sides have no boardingLock (P3-3 회귀 방지)', async () => {
    const env = makeKvEnv();
    // 외부에서 lastTrackedArrivalEpoch가 남은 trip 직접 주입 (예: 잔여 backend 상태)
    const seeded = { ...lockBody(null), lastTrackedArrivalEpoch: 1_234 };
    await env.TRIPS.put('trip:tok-585', JSON.stringify(seeded));
    await post('/trips', lockBody(null), env);
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-585')) as string);
    expect(stored.lastTrackedArrivalEpoch).toBeUndefined();
  });

  it('preserves lastTrackedArrivalEpoch when same trainCode re-registered', async () => {
    const env = makeKvEnv();
    await post('/trips', lockBody(), env);
    // backend 측에서 epoch을 갱신했다고 가정
    const advanced = JSON.parse((await env.TRIPS.get('trip:tok-585')) as string);
    advanced.lastTrackedArrivalEpoch = 9_999;
    await env.TRIPS.put('trip:tok-585', JSON.stringify(advanced));
    // 같은 trainCode로 재등록
    await post('/trips', lockBody(), env);
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-585')) as string);
    expect(stored.lastTrackedArrivalEpoch).toBe(9_999);
  });

  it('resets lastTrackedArrivalEpoch when trainCode changed (transfer)', async () => {
    const env = makeKvEnv();
    await post('/trips', lockBody({ trainCode: '7246' }), env);
    const advanced = JSON.parse((await env.TRIPS.get('trip:tok-585')) as string);
    advanced.lastTrackedArrivalEpoch = 9_999;
    await env.TRIPS.put('trip:tok-585', JSON.stringify(advanced));
    await post('/trips', lockBody({ trainCode: '2317' }), env);
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-585')) as string);
    expect(stored.lastTrackedArrivalEpoch).toBeUndefined();
  });
});

describe('POST /trips (#578 — preserve advance progress on re-register)', () => {
  const CREATED = 1_700_000_000_000;

  function tripBody(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      ...base(),
      token: 'tok-578',
      createdAt: CREATED,
      waypoints: [
        { stationName: '중곡', line: '7', kind: 'intermediate' },
        { stationName: '군자', line: '7', kind: 'intermediate' },
        { stationName: '강남', line: '2', kind: 'destination' },
      ],
      ...overrides,
    };
  }

  it('persists incoming trip on first register', async () => {
    const env = makeKvEnv();
    const res = await post('/trips', tripBody(), env);
    expect(res.status).toBe(200);
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-578')) as string);
    expect(stored.waypoints).toHaveLength(3);
  });

  it('preserves advanced waypoints when same session re-registers (same createdAt)', async () => {
    const env = makeKvEnv();
    // 1) initial register
    await post('/trips', tripBody(), env);
    // 2) backend advance: shift first waypoint + set lastFiredPhase=undefined (mimics scheduled.ts)
    const advanced = JSON.parse((await env.TRIPS.get('trip:tok-578')) as string);
    advanced.waypoints.shift();
    advanced.lastFiredPhase = undefined;
    advanced.lastEtaSeconds = 42;
    await env.TRIPS.put('trip:tok-578', JSON.stringify(advanced));
    // 3) device re-POSTs original payload (same createdAt)
    const res = await post('/trips', tripBody(), env);
    expect(res.status).toBe(200);
    const finalTrip = JSON.parse((await env.TRIPS.get('trip:tok-578')) as string);
    // advance progress preserved
    expect(finalTrip.waypoints).toHaveLength(2);
    expect(finalTrip.waypoints[0].stationName).toBe('군자');
    expect(finalTrip.lastEtaSeconds).toBe(42);
  });

  it('replaces trip entirely when createdAt differs (new session)', async () => {
    const env = makeKvEnv();
    await post('/trips', tripBody(), env);
    const advanced = JSON.parse((await env.TRIPS.get('trip:tok-578')) as string);
    advanced.waypoints.shift();
    await env.TRIPS.put('trip:tok-578', JSON.stringify(advanced));
    // new trip session with different createdAt
    await post('/trips', tripBody({ createdAt: CREATED + 10_000 }), env);
    const finalTrip = JSON.parse((await env.TRIPS.get('trip:tok-578')) as string);
    expect(finalTrip.waypoints).toHaveLength(3);
    expect(finalTrip.waypoints[0].stationName).toBe('중곡');
  });

  it('preserves existing apnsEnv when incoming omits it', async () => {
    const env = makeKvEnv();
    await post('/trips', tripBody({ apnsEnv: 'production' }), env);
    await post('/trips', tripBody(), env); // no apnsEnv
    const finalTrip = JSON.parse((await env.TRIPS.get('trip:tok-578')) as string);
    expect(finalTrip.apnsEnv).toBe('production');
  });

  // #706 — re-register가 누적된 consecutiveEtaMissing을 0으로 지우면 자동 종료가 영원히 못 발동.
  it('preserves backend-accumulated consecutiveEtaMissing on same-session re-register', async () => {
    const env = makeKvEnv();
    await post('/trips', tripBody(), env);
    const advanced = JSON.parse((await env.TRIPS.get('trip:tok-578')) as string);
    advanced.consecutiveEtaMissing = 4;
    await env.TRIPS.put('trip:tok-578', JSON.stringify(advanced));
    await post('/trips', tripBody(), env); // device sends payload w/o counter
    const finalTrip = JSON.parse((await env.TRIPS.get('trip:tok-578')) as string);
    expect(finalTrip.consecutiveEtaMissing).toBe(4);
  });

  // #903 (Seam G) — subsurface 전환에 따른 누적 카운터 정책.
  // helper: existing trip을 (subsurface, count) 상태로 셋업.
  async function seedExistingTrip(
    env: ReturnType<typeof makeKvEnv>,
    initialSubsurface: boolean | undefined,
    missCount: number,
  ): Promise<void> {
    const body = initialSubsurface === undefined ? tripBody() : { ...tripBody(), subsurface: initialSubsurface };
    await post('/trips', body, env);
    const existing = JSON.parse((await env.TRIPS.get('trip:tok-578')) as string);
    existing.consecutiveEtaMissing = missCount;
    await env.TRIPS.put('trip:tok-578', JSON.stringify(existing));
  }

  it.each([
    {
      label: 'true→false 전환(지상 복귀) → counter 리셋',
      initial: true,
      seed: 7,
      next: false,
      expectedCount: 0,
      expectedSubsurface: false,
    },
    {
      label: 'undefined→true 전환(지하 진입) → counter 보존',
      initial: undefined,
      seed: 3,
      next: true,
      expectedCount: 3,
      expectedSubsurface: true,
    },
  ])('subsurface $label', async ({ initial, seed, next, expectedCount, expectedSubsurface }) => {
    const env = makeKvEnv();
    await seedExistingTrip(env, initial, seed);
    await post('/trips', { ...tripBody(), subsurface: next }, env);
    const finalTrip = JSON.parse((await env.TRIPS.get('trip:tok-578')) as string);
    expect(finalTrip.consecutiveEtaMissing).toBe(expectedCount);
    expect(finalTrip.subsurface).toBe(expectedSubsurface);
  });

  it('returns 400 on invalid JSON', async () => {
    const env = makeKvEnv();
    const res = await post('/trips', 'not-json{', env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
  });

  it('returns 400 on invalid trip body', async () => {
    const env = makeKvEnv();
    const res = await post('/trips', { token: '' }, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_trip' });
  });
});

// #704 / #705 — isSameSession trainCode 기반 강화 + waypoint progress KV 분리.
//
// session 시나리오는 createdAt strict 비교를 폐기하고 trainCode가 일치하면 cold restart 후
// createdAt이 변해도 advance를 유지해야 한다. trainCode가 어긋나면 새 세션으로 reset.
// progress KV는 POST race (createdAt 동일성과 무관)에서도 shiftedCount/baseline을 보존한다.

const SESSION_CREATED = 1_700_000_000_000;
const SESSION_WAYPOINTS = [
  { stationName: '중곡', line: '7', kind: 'intermediate' as const },
  { stationName: '군자', line: '7', kind: 'intermediate' as const },
  { stationName: '강남', line: '2', kind: 'destination' as const },
];

function makeSessionLock(trainCode: string): Record<string, unknown> {
  return {
    trainCode,
    line: '7',
    subwayId: '1007',
    selectedDepartureTime: SESSION_CREATED,
    segmentStations: ['중곡', '군자', '강남'],
    expiresAt: SESSION_CREATED + 60 * 60 * 1000,
  };
}

/**
 * #704/#705 시나리오 공용 trip body 팩토리.
 * token + 기본 trainCode만 다른 두 describe 블록의 LOCK + tripBody 중복을 제거한다.
 */
function makeSessionTripFactory(token: string, trainCode: string) {
  const lock = makeSessionLock(trainCode);
  function tripBody(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      ...base(),
      token,
      createdAt: SESSION_CREATED,
      boardingLock: lock,
      waypoints: SESSION_WAYPOINTS,
      ...overrides,
    };
  }
  async function readTrip(env: Env): Promise<Record<string, unknown>> {
    return JSON.parse((await env.TRIPS.get(`trip:${token}`)) as string);
  }
  async function writeTrip(env: Env, trip: Record<string, unknown>): Promise<void> {
    await env.TRIPS.put(`trip:${token}`, JSON.stringify(trip));
  }
  return { lock, tripBody, readTrip, writeTrip };
}

describe('POST /trips — #704 isSameSession (trainCode 기반 + drift window)', () => {
  const { lock: LOCK, tripBody, readTrip, writeTrip } = makeSessionTripFactory('tok-704', 'T1');

  async function seedAndShift(env: Env, body = tripBody()): Promise<void> {
    await post('/trips', body, env);
    const stored = await readTrip(env);
    (stored.waypoints as unknown[]).shift();
    await writeTrip(env, stored);
  }

  // boardingLock 미지정 시나리오 공통 seed: stored trip에 lastEtaSeconds=99를 심어
  // 후속 POST의 same-session 판정 결과(99 유지 / undefined 리셋)를 관찰한다.
  async function seedNoLockWithEta(env: Env): Promise<void> {
    await post('/trips', tripBody({ boardingLock: undefined }), env);
    const stored = await readTrip(env);
    stored.lastEtaSeconds = 99;
    await writeTrip(env, stored);
  }

  it('preserves advance when same trainCode + same createdAt', async () => {
    const env = makeKvEnv();
    await seedAndShift(env);
    await post('/trips', tripBody(), env);
    const finalTrip = await readTrip(env);
    expect(finalTrip.waypoints).toHaveLength(2);
    expect((finalTrip.waypoints as Array<{ stationName: string }>)[0].stationName).toBe('군자');
  });

  it('preserves advance when same trainCode + createdAt drift 3s (still in window)', async () => {
    const env = makeKvEnv();
    await seedAndShift(env);
    await post('/trips', tripBody({ createdAt: SESSION_CREATED + 3_000 }), env);
    const finalTrip = await readTrip(env);
    expect(finalTrip.waypoints).toHaveLength(2);
    expect((finalTrip.waypoints as Array<{ stationName: string }>)[0].stationName).toBe('군자');
  });

  it('preserves advance when same trainCode + createdAt drift 100s (out of window)', async () => {
    // trainCode 일치만으로도 same session — drift 무관.
    const env = makeKvEnv();
    await seedAndShift(env);
    await post('/trips', tripBody({ createdAt: SESSION_CREATED + 100_000 }), env);
    const finalTrip = await readTrip(env);
    expect(finalTrip.waypoints).toHaveLength(2);
  });

  it('resets when trainCode differs (new train → new session)', async () => {
    const env = makeKvEnv();
    await seedAndShift(env);
    await post('/trips', tripBody({ boardingLock: { ...LOCK, trainCode: 'T2' } }), env);
    const finalTrip = await readTrip(env);
    expect(finalTrip.waypoints).toHaveLength(3);
    expect((finalTrip.waypoints as Array<{ stationName: string }>)[0].stationName).toBe('중곡');
  });

  it('drift window allows same session when boardingLock not yet set on either side', async () => {
    const env = makeKvEnv();
    await seedNoLockWithEta(env);
    await post(
      '/trips',
      tripBody({ boardingLock: undefined, createdAt: SESSION_CREATED + 2_000 }),
      env,
    );
    const finalTrip = await readTrip(env);
    expect(finalTrip.lastEtaSeconds).toBe(99);
  });

  it('drift window rejects when boardingLock missing on both sides and drift exceeds window', async () => {
    const env = makeKvEnv();
    await seedNoLockWithEta(env);
    await post(
      '/trips',
      tripBody({ boardingLock: undefined, createdAt: SESSION_CREATED + 60_000 }),
      env,
    );
    const finalTrip = await readTrip(env);
    expect(finalTrip.lastEtaSeconds).toBeUndefined();
  });
});

describe('POST /trips — #705 progress KV preserves advance across POST race', () => {
  const { lock: LOCK, tripBody, readTrip } = makeSessionTripFactory('tok-705', 'TP');

  async function seedProgress(env: Env, shiftedCount: number, trainCode = 'TP'): Promise<void> {
    await env.TRIPS.put(
      'progress:tok-705',
      JSON.stringify({
        trainCode,
        shiftedCount,
        lastTrackedArrivalEpoch: 12345,
        lastLaPushEpoch: 67890,
        consecutiveEtaMissing: 2,
      }),
    );
  }

  it('restores advance from progress KV even when trip object is freshly POSTed (race)', async () => {
    const env = makeKvEnv();
    await post('/trips', tripBody(), env);
    // 시뮬레이션: scheduled.ts가 advance → progress 기록 (외부 race가 trip object를 reset해도 progress는 남아 있음)
    await seedProgress(env, 1);
    // race: 디바이스가 동일 trip을 cold restart로 다시 POST. trip.waypoints는 origin 3건.
    await post('/trips', tripBody({ createdAt: SESSION_CREATED + 50_000 }), env);
    const finalTrip = await readTrip(env);
    // progress.shiftedCount=1 → 중곡(첫 waypoint)이 잘려나가야 함
    expect(finalTrip.waypoints).toHaveLength(2);
    expect((finalTrip.waypoints as Array<{ stationName: string }>)[0].stationName).toBe('군자');
    expect(finalTrip.lastTrackedArrivalEpoch).toBe(12345);
    expect(finalTrip.consecutiveEtaMissing).toBe(2);
  });

  it('drops progress when incoming trainCode differs (new train → reset)', async () => {
    const env = makeKvEnv();
    await post('/trips', tripBody(), env);
    await seedProgress(env, 2);
    // 다른 trainCode로 POST → progress 폐기 + 전체 waypoints 복원
    await post('/trips', tripBody({ boardingLock: { ...LOCK, trainCode: 'OTHER' } }), env);
    const finalTrip = await readTrip(env);
    expect(finalTrip.waypoints).toHaveLength(3);
    expect(await env.TRIPS.get('progress:tok-705')).toBeNull();
  });

  it('drops progress when incoming has no boardingLock', async () => {
    const env = makeKvEnv();
    await post('/trips', tripBody(), env);
    await seedProgress(env, 1);
    await post('/trips', tripBody({ boardingLock: undefined }), env);
    expect(await env.TRIPS.get('progress:tok-705')).toBeNull();
  });

  it('ignores corrupted progress entry (graceful)', async () => {
    const env = makeKvEnv();
    await post('/trips', tripBody(), env);
    await env.TRIPS.put('progress:tok-705', 'not-json{');
    await post('/trips', tripBody(), env);
    const finalTrip = await readTrip(env);
    // progress null → progressApplies false → 일반 same-session 경로로 trip 복원
    expect(finalTrip.waypoints).toHaveLength(3);
  });

  it('falls back to base waypoints when shiftedCount exceeds incoming.waypoints length', async () => {
    // 보호: progress가 incoming보다 더 많이 잘릴 경우 빈 배열 회귀 방지 — base.waypoints 유지.
    const env = makeKvEnv();
    await post('/trips', tripBody(), env);
    await seedProgress(env, 10);
    await post('/trips', tripBody(), env);
    const finalTrip = await readTrip(env);
    expect((finalTrip.waypoints as unknown[]).length).toBeGreaterThan(0);
  });
});

describe('POST /telemetry/silent-push', () => {
  const validBody = {
    token: 'aabbccdd11223344',
    since: 0,
    until: 1000,
    received: 3,
    fired: 2,
    skipped: 1,
    skipReasons: { 'gate-out-of-range': 1 },
  };

  it('returns 400 on invalid JSON', async () => {
    const env = makeEnv();
    const res = await post('/telemetry/silent-push', 'not-json{', env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
  });

  it('returns 400 on invalid payload', async () => {
    const env = makeEnv();
    const res = await post('/telemetry/silent-push', { token: '' }, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_payload' });
  });

  it('writes to TELEMETRY binding when present', async () => {
    const writer: AnalyticsEngineWriter = { writeDataPoint: vi.fn() };
    const env = makeEnv({ TELEMETRY: writer });
    const res = await post('/telemetry/silent-push', validBody, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(writer.writeDataPoint).toHaveBeenCalled();
  });

  it('still returns ok when TELEMETRY binding absent (graceful)', async () => {
    const env = makeEnv();
    const res = await post('/telemetry/silent-push', validBody, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('validatePushAck (#566 P2a)', () => {
  it('accepts valid fired ack', () => {
    expect(validatePushAck({ pushId: 'p1', token: 'tok', outcome: 'fired' })).toEqual({
      pushId: 'p1',
      token: 'tok',
      outcome: 'fired',
    });
  });

  it('accepts valid skipped ack with reason', () => {
    expect(
      validatePushAck({
        pushId: 'p1',
        token: 'tok',
        outcome: 'skipped',
        reason: 'gate-out-of-range',
      }),
    ).toEqual({
      pushId: 'p1',
      token: 'tok',
      outcome: 'skipped',
      reason: 'gate-out-of-range',
    });
  });

  it('rejects non-object', () => {
    expect(validatePushAck(null)).toBeNull();
    expect(validatePushAck('string')).toBeNull();
  });

  it('rejects missing pushId', () => {
    expect(validatePushAck({ token: 'tok', outcome: 'fired' })).toBeNull();
  });

  it('rejects empty pushId', () => {
    expect(validatePushAck({ pushId: '', token: 'tok', outcome: 'fired' })).toBeNull();
  });

  it('rejects missing token', () => {
    expect(validatePushAck({ pushId: 'p1', outcome: 'fired' })).toBeNull();
  });

  it('rejects empty token', () => {
    expect(validatePushAck({ pushId: 'p1', token: '', outcome: 'fired' })).toBeNull();
  });

  it('rejects invalid outcome', () => {
    expect(validatePushAck({ pushId: 'p1', token: 'tok', outcome: 'bogus' })).toBeNull();
  });

  it('ignores non-string reason', () => {
    const ack = validatePushAck({ pushId: 'p1', token: 'tok', outcome: 'skipped', reason: 123 });
    expect(ack).toEqual({ pushId: 'p1', token: 'tok', outcome: 'skipped' });
  });
});

describe('POST /push/ack (#566 P2a)', () => {
  let kv: InMemoryKV;
  beforeEach(() => {
    kv = new InMemoryKV();
  });

  it('returns 400 on invalid JSON', async () => {
    const env = makeEnv({ PENDING_PUSHES: kv as unknown as KVNamespace });
    const res = await post('/push/ack', 'not-json{', env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
  });

  it('returns 400 on invalid payload (missing token)', async () => {
    const env = makeEnv({ PENDING_PUSHES: kv as unknown as KVNamespace });
    const res = await post('/push/ack', { pushId: 'p1', outcome: 'fired' }, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_payload' });
  });

  it('token 매칭 시 deleted=true로 entry 삭제', async () => {
    await kv.put(pendingKey('p1'), JSON.stringify({ pushId: 'p1', token: 'real-token' }));
    const env = makeEnv({ PENDING_PUSHES: kv as unknown as KVNamespace });
    const res = await post(
      '/push/ack',
      { pushId: 'p1', token: 'real-token', outcome: 'fired' },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: true });
    expect(kv.store.has(pendingKey('p1'))).toBe(false);
  });

  it('token 불일치 시 reason=token-mismatch로 삭제 안 함 (인증 차단)', async () => {
    await kv.put(pendingKey('p1'), JSON.stringify({ pushId: 'p1', token: 'real-token' }));
    const env = makeEnv({ PENDING_PUSHES: kv as unknown as KVNamespace });
    const res = await post(
      '/push/ack',
      { pushId: 'p1', token: 'attacker', outcome: 'fired' },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: false, reason: 'token-mismatch' });
    expect(kv.store.has(pendingKey('p1'))).toBe(true);
  });

  it('entry 만료/미존재 시 reason=not-found (idempotent)', async () => {
    const env = makeEnv({ PENDING_PUSHES: kv as unknown as KVNamespace });
    const res = await post(
      '/push/ack',
      { pushId: 'missing', token: 'tok', outcome: 'skipped' },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: false, reason: 'not-found' });
  });

  it('PENDING_PUSHES 미바인딩 시 reason=not-found (graceful)', async () => {
    const env = makeEnv();
    const res = await post('/push/ack', { pushId: 'p1', token: 'tok', outcome: 'fired' }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: false, reason: 'not-found' });
  });
});

describe('validateLiveActivityRegister (#586 C)', () => {
  it('accepts valid payload', () => {
    expect(
      validateLiveActivityRegister({ tripToken: 'tt', activityPushToken: 'at' }),
    ).toEqual({ tripToken: 'tt', activityPushToken: 'at' });
  });

  it('rejects non-object', () => {
    expect(validateLiveActivityRegister(null)).toBeNull();
    expect(validateLiveActivityRegister('x')).toBeNull();
  });

  it('rejects missing/empty tripToken', () => {
    expect(validateLiveActivityRegister({ activityPushToken: 'at' })).toBeNull();
    expect(
      validateLiveActivityRegister({ tripToken: '', activityPushToken: 'at' }),
    ).toBeNull();
  });

  it('rejects missing/empty activityPushToken', () => {
    expect(validateLiveActivityRegister({ tripToken: 'tt' })).toBeNull();
    expect(
      validateLiveActivityRegister({ tripToken: 'tt', activityPushToken: '' }),
    ).toBeNull();
  });
});

describe('DELETE /trips/:token — LA dismissal (#586 D)', () => {
  const CREATED = 1_700_000_000_000;

  it('returns 200 deleted=false when trip missing (no LA fire)', async () => {
    const env = makeKvEnv();
    const res = await del('/trips/nope', env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: false });
  });

  it('deletes the trip from KV when no LA token attached', async () => {
    const env = makeKvEnv();
    await post('/trips', { ...base(), token: 'tok-d', createdAt: CREATED }, env);
    const res = await del('/trips/tok-d', env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: true });
    expect(await env.TRIPS.get('trip:tok-d')).toBeNull();
  });
});

describe('Live Activity endpoints (#586 C)', () => {
  const CREATED = 1_700_000_000_000;
  function tripBody(): Record<string, unknown> {
    return { ...base(), token: 'tok-611', createdAt: CREATED };
  }

  describe('POST /live-activity/register', () => {
    it('returns 400 on invalid JSON', async () => {
      const env = makeKvEnv();
      const res = await post('/live-activity/register', 'not-json{', env);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_json' });
    });

    it('returns 400 on invalid payload', async () => {
      const env = makeKvEnv();
      const res = await post('/live-activity/register', { tripToken: '' }, env);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_payload' });
    });

    it('returns 404 when trip does not exist', async () => {
      const env = makeKvEnv();
      const res = await post(
        '/live-activity/register',
        { tripToken: 'nope', activityPushToken: 'at' },
        env,
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'trip_not_found' });
    });

    it('persists activityPushToken and sets activityState=live', async () => {
      const env = makeKvEnv();
      await post('/trips', tripBody(), env);
      const res = await post(
        '/live-activity/register',
        { tripToken: 'tok-611', activityPushToken: 'la-token' },
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      const stored = JSON.parse((await env.TRIPS.get('trip:tok-611')) as string);
      expect(stored.activityPushToken).toBe('la-token');
      expect(stored.activityState).toBe('live');
    });
  });

  describe('DELETE /live-activity/:tripToken', () => {
    it('returns 200 deleted=false when trip does not exist (idempotent)', async () => {
      const env = makeKvEnv();
      const res = await del('/live-activity/nope', env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, deleted: false });
    });

    it('clears activityPushToken and sets activityState=ended', async () => {
      const env = makeKvEnv();
      await post('/trips', tripBody(), env);
      await post(
        '/live-activity/register',
        { tripToken: 'tok-611', activityPushToken: 'la-token' },
        env,
      );
      const res = await del('/live-activity/tok-611', env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, deleted: true });
      const stored = JSON.parse((await env.TRIPS.get('trip:tok-611')) as string);
      expect(stored.activityPushToken).toBeUndefined();
      expect(stored.activityState).toBe('ended');
    });
  });

  describe('POST /trips merge preserves LA fields (same session)', () => {
    it('preserves activityPushToken and activityState across re-register', async () => {
      const env = makeKvEnv();
      await post('/trips', tripBody(), env);
      await post(
        '/live-activity/register',
        { tripToken: 'tok-611', activityPushToken: 'la-token' },
        env,
      );
      // device re-POSTs trip (without LA fields) — must not erase them
      await post('/trips', tripBody(), env);
      const stored = JSON.parse((await env.TRIPS.get('trip:tok-611')) as string);
      expect(stored.activityPushToken).toBe('la-token');
      expect(stored.activityState).toBe('live');
    });

    it('does not carry LA fields across new session (different createdAt)', async () => {
      const env = makeKvEnv();
      await post('/trips', tripBody(), env);
      await post(
        '/live-activity/register',
        { tripToken: 'tok-611', activityPushToken: 'la-token' },
        env,
      );
      await post('/trips', { ...tripBody(), createdAt: CREATED + 10_000 }, env);
      const stored = JSON.parse((await env.TRIPS.get('trip:tok-611')) as string);
      expect(stored.activityPushToken).toBeUndefined();
      expect(stored.activityState).toBeUndefined();
    });
  });
});

describe('POST /position (#819)', () => {
  it('valid payload → KV에 series append + 200', async () => {
    const env = makeKvEnv();
    const res = await post(
      '/position',
      { token: 'tok-pos', lat: 1, lng: 2, accuracy: 5, ts: 1234, motion: 'walking' },
      env,
    );
    expect(res.status).toBe(200);
    const stored = (await env.TRIPS.get('pos:tok-pos'))!;
    expect(JSON.parse(stored)).toEqual([
      { lat: 1, lng: 2, accuracy: 5, ts: 1234, motion: 'walking' },
    ]);
  });

  it('invalid JSON → 400', async () => {
    const env = makeKvEnv();
    const res = await post('/position', '{', env);
    expect(res.status).toBe(400);
  });

  it.each([
    ['missing token', { lat: 1, lng: 2, accuracy: 5, ts: 0, motion: 'walking' }],
    ['empty token', { token: '', lat: 1, lng: 2, accuracy: 5, ts: 0, motion: 'walking' }],
    ['lat not number', { token: 't', lat: 'x', lng: 2, accuracy: 5, ts: 0, motion: 'walking' }],
    ['lng infinity', { token: 't', lat: 1, lng: Infinity, accuracy: 5, ts: 0, motion: 'walking' }],
    ['accuracy negative', { token: 't', lat: 1, lng: 2, accuracy: -1, ts: 0, motion: 'walking' }],
    ['ts not number', { token: 't', lat: 1, lng: 2, accuracy: 5, ts: 'x', motion: 'walking' }],
    ['motion invalid', { token: 't', lat: 1, lng: 2, accuracy: 5, ts: 0, motion: 'flying' }],
    ['empty body', null],
  ])('invalid_payload — %s', async (_label, body) => {
    const env = makeKvEnv();
    const res = await post('/position', body, env);
    expect(res.status).toBe(400);
  });

  describe('#823 — accelSummary 옵션 필드', () => {
    const accel = {
      startTs: 1000,
      endTs: 2000,
      count: 100,
      ax: 0.1,
      ay: 0.2,
      az: 0.3,
      magnitudeMean: 0.5,
      magnitudeStd: 0.1,
      magnitudePeak: 1.2,
    };

    it('valid accelSummary 포함 → position + accel series 둘 다 저장', async () => {
      const env = makeKvEnv();
      const res = await post(
        '/position',
        {
          token: 'tok-acc',
          lat: 1,
          lng: 2,
          accuracy: 5,
          ts: 1500,
          motion: 'automotive',
          accelSummary: accel,
        },
        env,
      );
      expect(res.status).toBe(200);
      const accelStored = (await env.TRIPS.get('accel:tok-acc'))!;
      expect(JSON.parse(accelStored)).toEqual([accel]);
      const posStored = (await env.TRIPS.get('pos:tok-acc'))!;
      expect(JSON.parse(posStored)).toHaveLength(1);
    });

    it('accelSummary 부재 → position만 저장, accel series 빈 상태', async () => {
      const env = makeKvEnv();
      const res = await post(
        '/position',
        { token: 'tok-no-acc', lat: 1, lng: 2, accuracy: 5, ts: 1500, motion: 'walking' },
        env,
      );
      expect(res.status).toBe(200);
      const accelStored = await env.TRIPS.get('accel:tok-no-acc');
      expect(accelStored).toBeNull();
      const posStored = (await env.TRIPS.get('pos:tok-no-acc'))!;
      expect(JSON.parse(posStored)).toHaveLength(1);
    });

    it('invalid accelSummary 형식 → graceful skip (position만 저장, 200)', async () => {
      const env = makeKvEnv();
      const res = await post(
        '/position',
        {
          token: 'tok-bad-acc',
          lat: 1,
          lng: 2,
          accuracy: 5,
          ts: 1500,
          motion: 'walking',
          accelSummary: { startTs: 'bad' }, // 형식 불일치 → skip
        },
        env,
      );
      expect(res.status).toBe(200);
      const accelStored = await env.TRIPS.get('accel:tok-bad-acc');
      expect(accelStored).toBeNull();
    });
  });

  it('#828: mapMatchedLine + mapMatchedArcM 둘 다 있으면 series에 적재', async () => {
    const env = makeKvEnv();
    const res = await post(
      '/position',
      {
        token: 'tok-mm',
        lat: 1,
        lng: 2,
        accuracy: 5,
        ts: 1234,
        motion: 'walking',
        mapMatchedLine: '2',
        mapMatchedArcM: 678.9,
      },
      env,
    );
    expect(res.status).toBe(200);
    const stored = (await env.TRIPS.get('pos:tok-mm'))!;
    expect(JSON.parse(stored)).toEqual([
      {
        lat: 1,
        lng: 2,
        accuracy: 5,
        ts: 1234,
        motion: 'walking',
        mapMatchedLine: '2',
        mapMatchedArcM: 678.9,
      },
    ]);
  });

  it.each([
    [
      'mapMatchedLine only — 둘 다 omit 처리',
      {
        token: 'tok-mm-half',
        lat: 1,
        lng: 2,
        accuracy: 5,
        ts: 0,
        motion: 'walking',
        mapMatchedLine: '2',
      },
    ],
    [
      'mapMatchedArcM only — 둘 다 omit 처리',
      {
        token: 'tok-mm-half',
        lat: 1,
        lng: 2,
        accuracy: 5,
        ts: 0,
        motion: 'walking',
        mapMatchedArcM: 100,
      },
    ],
    [
      'mapMatchedLine 빈 문자열 — 둘 다 omit 처리',
      {
        token: 'tok-mm-half',
        lat: 1,
        lng: 2,
        accuracy: 5,
        ts: 0,
        motion: 'walking',
        mapMatchedLine: '',
        mapMatchedArcM: 100,
      },
    ],
    [
      'mapMatchedArcM NaN/inf — 둘 다 omit 처리',
      {
        token: 'tok-mm-half',
        lat: 1,
        lng: 2,
        accuracy: 5,
        ts: 0,
        motion: 'walking',
        mapMatchedLine: '2',
        mapMatchedArcM: Infinity,
      },
    ],
  ])('#828: %s', async (_label, body) => {
    const env = makeKvEnv();
    const res = await post('/position', body, env);
    expect(res.status).toBe(200);
    const stored = (await env.TRIPS.get(`pos:${body.token}`))!;
    const parsed = JSON.parse(stored) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].mapMatchedLine).toBeUndefined();
    expect(parsed[0].mapMatchedArcM).toBeUndefined();
  });

  describe('#825 — nearestStationDistanceM 옵션 필드', () => {
    const BASE_POS = { token: 'tok-nsd', lat: 1, lng: 2, accuracy: 5, ts: 1234, motion: 'walking' as const };

    it('정상값(number ≥ 0) → point.nearestStationDistanceM에 set', async () => {
      const env = makeKvEnv();
      const res = await post('/position', { ...BASE_POS, nearestStationDistanceM: 150 }, env);
      expect(res.status).toBe(200);
      const stored = JSON.parse((await env.TRIPS.get('pos:tok-nsd'))!) as Array<Record<string, unknown>>;
      expect(stored[0].nearestStationDistanceM).toBe(150);
    });

    it('nearestStationDistanceM=0 → set (경계값 0 허용)', async () => {
      const env = makeKvEnv();
      await post('/position', { ...BASE_POS, nearestStationDistanceM: 0 }, env);
      const stored = JSON.parse((await env.TRIPS.get('pos:tok-nsd'))!) as Array<Record<string, unknown>>;
      expect(stored[0].nearestStationDistanceM).toBe(0);
    });

    it('음수 → undefined로 graceful skip (payload 거부 X, 200)', async () => {
      const env = makeKvEnv();
      const res = await post('/position', { ...BASE_POS, nearestStationDistanceM: -1 }, env);
      expect(res.status).toBe(200);
      const stored = JSON.parse((await env.TRIPS.get('pos:tok-nsd'))!) as Array<Record<string, unknown>>;
      expect(stored[0].nearestStationDistanceM).toBeUndefined();
    });

    it('NaN → undefined로 graceful skip', async () => {
      const env = makeKvEnv();
      const res = await post('/position', { ...BASE_POS, nearestStationDistanceM: NaN }, env);
      expect(res.status).toBe(200);
      const stored = JSON.parse((await env.TRIPS.get('pos:tok-nsd'))!) as Array<Record<string, unknown>>;
      expect(stored[0].nearestStationDistanceM).toBeUndefined();
    });

    it('문자열 → undefined로 graceful skip', async () => {
      const env = makeKvEnv();
      const res = await post('/position', { ...BASE_POS, nearestStationDistanceM: '100' }, env);
      expect(res.status).toBe(200);
      const stored = JSON.parse((await env.TRIPS.get('pos:tok-nsd'))!) as Array<Record<string, unknown>>;
      expect(stored[0].nearestStationDistanceM).toBeUndefined();
    });

    it('필드 없음 → undefined (옵션 필드 부재 정상 처리)', async () => {
      const env = makeKvEnv();
      await post('/position', BASE_POS, env);
      const stored = JSON.parse((await env.TRIPS.get('pos:tok-nsd'))!) as Array<Record<string, unknown>>;
      expect(stored[0].nearestStationDistanceM).toBeUndefined();
    });
  });
});

describe('POST /boarding-prompt/dismiss (#819)', () => {
  const CREATED = 1_710_000_000_000;
  function tripBody(): Record<string, unknown> {
    return {
      token: 'tok-dis',
      route: { type: 'direct', line: '2', stops: 3 },
      destination: 'dst',
      waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
      expiresAt: CREATED + 60 * 60_000,
      alarmAtEpochMs: CREATED + 30 * 60_000,
      createdAt: CREATED,
    };
  }

  it('trip 없으면 idempotent 200 applied:false', async () => {
    const env = makeKvEnv();
    const res = await post('/boarding-prompt/dismiss', { token: 'no-trip' }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, applied: false });
  });

  it('trip 있으면 silencedUntil 설정 (현재 시각 + 5분 이후)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(CREATED);
    const env = makeKvEnv();
    await post('/trips', tripBody(), env);
    const res = await post('/boarding-prompt/dismiss', { token: 'tok-dis' }, env);
    expect(res.status).toBe(200);
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-dis')) as string);
    expect(stored.boardingPromptState.silencedUntil).toBe(CREATED + 5 * 60 * 1000);
    vi.useRealTimers();
  });

  it('invalid_json → 400', async () => {
    const env = makeKvEnv();
    const res = await post('/boarding-prompt/dismiss', '{', env);
    expect(res.status).toBe(400);
  });

  it.each([
    ['missing token', {}],
    ['empty token', { token: '' }],
    ['token not string', { token: 123 }],
    ['null body', null],
  ])('invalid_payload — %s', async (_label, body) => {
    const env = makeKvEnv();
    const res = await post('/boarding-prompt/dismiss', body, env);
    expect(res.status).toBe(400);
  });
});

describe('POST /metrics/boarding-prompt (#827)', () => {
  const validBody = { token: 'aabbccdd11223344', outcome: 'dismissed' as const };

  it('returns 400 on invalid JSON', async () => {
    const env = makeEnv();
    const res = await post('/metrics/boarding-prompt', 'not-json{', env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
  });

  it('returns 400 on invalid payload', async () => {
    const env = makeEnv();
    const res = await post('/metrics/boarding-prompt', { token: '' }, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_payload' });
  });

  it('writes to TELEMETRY binding when present', async () => {
    const writer: AnalyticsEngineWriter = { writeDataPoint: vi.fn() };
    const env = makeEnv({ TELEMETRY: writer });
    const res = await post('/metrics/boarding-prompt', validBody, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(writer.writeDataPoint).toHaveBeenCalled();
  });

  it('still returns ok when TELEMETRY binding absent', async () => {
    const env = makeEnv();
    const res = await post('/metrics/boarding-prompt', validBody, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('validateTrip — #819 promptGeoContext / promptDisplay', () => {
  function withPrompt(overrides: Record<string, unknown>): Record<string, unknown> {
    return { ...base(), ...overrides };
  }

  it('valid geoContext + display 보존', () => {
    const trip = validateTrip(
      withPrompt({
        promptGeoContext: {
          origin: { lat: 1, lng: 2 },
          nextStation: { lat: 3, lng: 4 },
          direction: 'up',
        },
        promptDisplay: { originStation: '강남', line: '2' },
      }),
    );
    expect(trip?.promptGeoContext).toEqual({
      origin: { lat: 1, lng: 2 },
      nextStation: { lat: 3, lng: 4 },
      direction: 'up',
    });
    expect(trip?.promptDisplay).toEqual({ originStation: '강남', line: '2' });
  });

  it('direction 부재 → null로 강등 (양방향 허용)', () => {
    const trip = validateTrip(
      withPrompt({
        promptGeoContext: {
          origin: { lat: 1, lng: 2 },
          nextStation: { lat: 3, lng: 4 },
        },
      }),
    );
    expect(trip?.promptGeoContext?.direction).toBeNull();
  });

  it.each([
    ['origin coord 누락', { promptGeoContext: { nextStation: { lat: 1, lng: 2 } } }],
    ['nextStation 누락', { promptGeoContext: { origin: { lat: 1, lng: 2 } } }],
    ['lat NaN', { promptGeoContext: { origin: { lat: NaN, lng: 2 }, nextStation: { lat: 3, lng: 4 } } }],
    ['lng infinity', { promptGeoContext: { origin: { lat: 1, lng: Infinity }, nextStation: { lat: 3, lng: 4 } } }],
    ['nextStation lat string', { promptGeoContext: { origin: { lat: 1, lng: 2 }, nextStation: { lat: 'x', lng: 4 } } }],
    ['nextStation lng string', { promptGeoContext: { origin: { lat: 1, lng: 2 }, nextStation: { lat: 3, lng: 'y' } } }],
    ['non-object', { promptGeoContext: 'oops' }],
  ])('promptGeoContext invalid — %s', (_label, override) => {
    const trip = validateTrip(withPrompt(override));
    expect(trip?.promptGeoContext).toBeUndefined();
  });

  it.each([
    ['originStation 누락', { promptDisplay: { line: '2' } }],
    ['line 누락', { promptDisplay: { originStation: '강남' } }],
    ['originStation 빈 문자열', { promptDisplay: { originStation: '', line: '2' } }],
    ['line 빈 문자열', { promptDisplay: { originStation: '강남', line: '' } }],
    ['non-object', { promptDisplay: 'oops' }],
  ])('promptDisplay invalid — %s', (_label, override) => {
    const trip = validateTrip(withPrompt(override));
    expect(trip?.promptDisplay).toBeUndefined();
  });
});

describe('POST /trips — #819 boardingPromptState carries over same session', () => {
  const CREATED = 1_700_000_000_000;
  function tripBody(): Record<string, unknown> {
    return {
      token: 'tok-bp',
      route: { type: 'direct', line: '2', stops: 3 },
      destination: 'dst',
      waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
      expiresAt: CREATED + 60 * 60_000,
      alarmAtEpochMs: CREATED + 30 * 60_000,
      createdAt: CREATED,
      promptGeoContext: {
        origin: { lat: 0, lng: 0 },
        nextStation: { lat: 0, lng: 0.01 },
        direction: 'up',
      },
      promptDisplay: { originStation: '강남', line: '2' },
    };
  }

  it('same session re-register → 이전 fired state 보존', async () => {
    const env = makeKvEnv();
    // 첫 등록 후 backend가 state.fired=true 적재했다고 가정
    await env.TRIPS.put(
      'trip:tok-bp',
      JSON.stringify({
        ...validateTrip(tripBody()),
        boardingPromptState: { fired: true, lastFiredAt: CREATED - 10_000 },
      }),
    );
    // re-register
    await post('/trips', tripBody(), env);
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-bp')) as string);
    expect(stored.boardingPromptState).toEqual({ fired: true, lastFiredAt: CREATED - 10_000 });
  });

  it('new session (createdAt drift > 5s) → state 초기화', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(CREATED);
    const env = makeKvEnv();
    // 기존 trip을 명시 trainCode 없이 저장 (#704 trainCode 미사용 시 createdAt drift만 본다)
    await env.TRIPS.put(
      'trip:tok-bp',
      JSON.stringify({
        ...validateTrip(tripBody()),
        boardingPromptState: { fired: true, lastFiredAt: CREATED - 10_000 },
      }),
    );
    await post('/trips', { ...tripBody(), createdAt: CREATED + 10_000 }, env);
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-bp')) as string);
    expect(stored.boardingPromptState).toBeUndefined();
    vi.useRealTimers();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Seam E (#901) — POST /boarding-lock/sync
// ──────────────────────────────────────────────────────────────────────────

describe('validateBoardingLockSync (#901)', () => {
  it('정상 payload 통과', () => {
    expect(
      validateBoardingLockSync({
        token: 'tok',
        observedStationName: '강남',
        observedAtMs: 1,
        accuracy: 10,
      }),
    ).toEqual({ token: 'tok', observedStationName: '강남', observedAtMs: 1, accuracy: 10 });
  });

  it('subsurface 옵션 필드 유지', () => {
    const p = validateBoardingLockSync({
      token: 'tok',
      observedStationName: '강남',
      observedAtMs: 1,
      accuracy: 10,
      subsurface: false,
    });
    expect(p?.subsurface).toBe(false);
  });

  it('subsurface 잘못된 타입은 무시', () => {
    const p = validateBoardingLockSync({
      token: 'tok',
      observedStationName: '강남',
      observedAtMs: 1,
      accuracy: 10,
      subsurface: 'yes',
    });
    expect(p?.subsurface).toBeUndefined();
  });

  it('non-object reject', () => {
    expect(validateBoardingLockSync(null)).toBeNull();
    expect(validateBoardingLockSync('s')).toBeNull();
  });

  // 정상 baseline에서 한 필드만 변형해 reject 게이트를 일괄 검증.
  const validBase = {
    token: 'tok',
    observedStationName: '강남',
    observedAtMs: 1,
    accuracy: 10,
  } as Record<string, unknown>;

  it.each<{ label: string; mutate: (p: Record<string, unknown>) => void }>([
    { label: '빈 token', mutate: (p) => (p.token = '') },
    { label: 'observedStationName 누락', mutate: (p) => delete p.observedStationName },
    { label: '빈 observedStationName', mutate: (p) => (p.observedStationName = '') },
    { label: 'NaN observedAtMs', mutate: (p) => (p.observedAtMs = Number.NaN) },
    { label: '비숫자 observedAtMs', mutate: (p) => (p.observedAtMs = '1') },
    { label: '음수 accuracy', mutate: (p) => (p.accuracy = -1) },
    { label: 'NaN accuracy', mutate: (p) => (p.accuracy = Number.NaN) },
    { label: '비숫자 accuracy', mutate: (p) => (p.accuracy = 'a') },
  ])('$label reject', ({ mutate }) => {
    const payload = { ...validBase };
    mutate(payload);
    expect(validateBoardingLockSync(payload)).toBeNull();
  });
});

describe('computeLockSyncAdvance (#901)', () => {
  const w = (name: string) => ({ stationName: name, line: '2', kind: 'intermediate' as const });

  it('waypoints[0] 일치 → 1 hop shift', () => {
    expect(computeLockSyncAdvance([w('A'), w('B'), w('C')], 'A')).toEqual({ shiftedCount: 1 });
  });

  it('waypoints[1] 일치 → 2 hop catch-up', () => {
    expect(computeLockSyncAdvance([w('A'), w('B'), w('C')], 'B')).toEqual({ shiftedCount: 2 });
  });

  it('waypoints[2] 일치 → 3 hop catch-up', () => {
    expect(computeLockSyncAdvance([w('A'), w('B'), w('C')], 'C')).toEqual({ shiftedCount: 3 });
  });

  it('미일치 → 0 (no-op)', () => {
    expect(computeLockSyncAdvance([w('A'), w('B')], 'X')).toEqual({ shiftedCount: 0 });
  });

  it('빈 waypoints → 0', () => {
    expect(computeLockSyncAdvance([], 'A')).toEqual({ shiftedCount: 0 });
  });
});

describe('POST /boarding-lock/sync (#901)', () => {
  const FUTURE_LOCK = Date.now() + 30 * 60 * 1000;

  function tripWithLock(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      token: 'tok-sync',
      route: { type: 'direct', line: '2', stops: 3 },
      destination: 'dst',
      waypoints: [
        { stationName: '강남', line: '2', kind: 'intermediate' },
        { stationName: '역삼', line: '2', kind: 'intermediate' },
        { stationName: '선릉', line: '2', kind: 'destination' },
      ],
      expiresAt: FUTURE,
      alarmAtEpochMs: FUTURE - 30 * 60 * 1000,
      boardingLock: {
        trainCode: 'T-1',
        line: '2',
        subwayId: '1002',
        selectedDepartureTime: 1,
        segmentStations: ['강남', '역삼', '선릉'],
        expiresAt: FUTURE_LOCK,
      },
      ...overrides,
    };
  }

  it('잘못된 JSON → 400', async () => {
    const env = makeKvEnv();
    const res = await post('/boarding-lock/sync', '{', env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
  });

  it('잘못된 payload → 400', async () => {
    const env = makeKvEnv();
    const res = await post('/boarding-lock/sync', { token: 'x' }, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_payload' });
  });

  it('trip 부재 → 404 trip_not_found', async () => {
    const env = makeKvEnv();
    const res = await post(
      '/boarding-lock/sync',
      { token: 'unknown', observedStationName: '강남', observedAtMs: 1, accuracy: 5 },
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'trip_not_found' });
  });

  it('현재 waypoints[0] 일치 → 1 hop advance + currentWaypoint=역삼', async () => {
    const env = makeKvEnv();
    await post('/trips', tripWithLock(), env);
    const res = await post(
      '/boarding-lock/sync',
      { token: 'tok-sync', observedStationName: '강남', observedAtMs: 1, accuracy: 5 },
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      advanced: true,
      currentWaypoint: '역삼',
      nextStation: '역삼',
      // #916 — tripWithLock fixture에 boardingLock이 미리 설정돼 있으므로 candidate로 노출.
      autoLockCandidate: { trainCode: 'T-1', line: '2', subwayId: '1002' },
    });
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-sync')) as string);
    expect(stored.waypoints.map((w: { stationName: string }) => w.stationName)).toEqual([
      '역삼',
      '선릉',
    ]);
  });

  it('waypoints[1] 일치 → 2 hop catch-up advance', async () => {
    const env = makeKvEnv();
    await post('/trips', tripWithLock(), env);
    const res = await post(
      '/boarding-lock/sync',
      { token: 'tok-sync', observedStationName: '역삼', observedAtMs: 1, accuracy: 5 },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { advanced: boolean; currentWaypoint: string | null };
    expect(body.advanced).toBe(true);
    expect(body.currentWaypoint).toBe('선릉');
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-sync')) as string);
    expect(stored.waypoints).toHaveLength(1);
  });

  it('미일치 → no-op (advanced=false), waypoints 그대로', async () => {
    const env = makeKvEnv();
    await post('/trips', tripWithLock(), env);
    const res = await post(
      '/boarding-lock/sync',
      { token: 'tok-sync', observedStationName: '신촌', observedAtMs: 1, accuracy: 5 },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { advanced: boolean; currentWaypoint: string | null };
    expect(body.advanced).toBe(false);
    expect(body.currentWaypoint).toBe('강남');
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-sync')) as string);
    expect(stored.waypoints).toHaveLength(3);
  });

  it('마지막 waypoint(destination) 일치 → 전체 소진 + currentWaypoint=null', async () => {
    const env = makeKvEnv();
    await post('/trips', tripWithLock(), env);
    const res = await post(
      '/boarding-lock/sync',
      { token: 'tok-sync', observedStationName: '선릉', observedAtMs: 1, accuracy: 5 },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      advanced: boolean;
      currentWaypoint: string | null;
      nextStation: string | null;
    };
    expect(body.advanced).toBe(true);
    expect(body.currentWaypoint).toBeNull();
    expect(body.nextStation).toBeNull();
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-sync')) as string);
    expect(stored.waypoints).toEqual([]);
  });

  it('boardingLock TTL refresh — expiresAt이 now+30min 이상으로 연장', async () => {
    vi.useFakeTimers();
    const NOW = Date.now();
    vi.setSystemTime(NOW);
    const env = makeKvEnv();
    // 짧은 TTL의 lock을 직접 KV에 적재 — POST /trips 검증을 우회하기 위해.
    const trip = validateTrip(
      tripWithLock({ boardingLock: { ...(tripWithLock().boardingLock as object), expiresAt: NOW + 60_000 } }),
    );
    await env.TRIPS.put('trip:tok-sync', JSON.stringify(trip));
    await post(
      '/boarding-lock/sync',
      { token: 'tok-sync', observedStationName: '강남', observedAtMs: 1, accuracy: 5 },
      env,
    );
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-sync')) as string);
    expect(stored.boardingLock.expiresAt).toBeGreaterThanOrEqual(NOW + LOCK_TTL_REFRESH_MS);
    vi.useRealTimers();
  });

  it('boardingLock 없는 trip — advance만 일어나고 lock 필드 추가 안 됨', async () => {
    const env = makeKvEnv();
    const tripNoLock = tripWithLock();
    delete tripNoLock.boardingLock;
    await post('/trips', tripNoLock, env);
    const res = await post(
      '/boarding-lock/sync',
      { token: 'tok-sync', observedStationName: '강남', observedAtMs: 1, accuracy: 5 },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { advanced: boolean };
    expect(body.advanced).toBe(true);
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-sync')) as string);
    expect(stored.boardingLock).toBeUndefined();
  });

  it('advance 시 progress KV에 shiftedCount mirror', async () => {
    const env = makeKvEnv();
    await post('/trips', tripWithLock(), env);
    await post(
      '/boarding-lock/sync',
      { token: 'tok-sync', observedStationName: '역삼', observedAtMs: 1, accuracy: 5 },
      env,
    );
    const progressRaw = await env.TRIPS.get(progressKey('tok-sync'));
    expect(progressRaw).not.toBeNull();
    const progress = JSON.parse(progressRaw as string) as TripProgress;
    expect(progress.trainCode).toBe('T-1');
    expect(progress.shiftedCount).toBe(2);
  });

  it('advance 누적 — 두 번째 sync도 progress.shiftedCount 누적', async () => {
    const env = makeKvEnv();
    await post('/trips', tripWithLock(), env);
    // 1차 sync — 강남(0) → 1 hop
    await post(
      '/boarding-lock/sync',
      { token: 'tok-sync', observedStationName: '강남', observedAtMs: 1, accuracy: 5 },
      env,
    );
    // 2차 sync — 역삼(이제 waypoints[0]) → 1 hop 추가
    await post(
      '/boarding-lock/sync',
      { token: 'tok-sync', observedStationName: '역삼', observedAtMs: 2, accuracy: 5 },
      env,
    );
    const progress = JSON.parse((await env.TRIPS.get(progressKey('tok-sync'))) as string);
    expect(progress.shiftedCount).toBe(2);
  });

  it('boardingLock 없는 trip → progress mirror 안 함 (trainCode 없음)', async () => {
    const env = makeKvEnv();
    const tripNoLock = tripWithLock();
    delete tripNoLock.boardingLock;
    await post('/trips', tripNoLock, env);
    await post(
      '/boarding-lock/sync',
      { token: 'tok-sync', observedStationName: '강남', observedAtMs: 1, accuracy: 5 },
      env,
    );
    expect(await env.TRIPS.get(progressKey('tok-sync'))).toBeNull();
  });

  it('subsurface 필드 허용 — 200', async () => {
    const env = makeKvEnv();
    await post('/trips', tripWithLock(), env);
    const res = await post(
      '/boarding-lock/sync',
      {
        token: 'tok-sync',
        observedStationName: '강남',
        observedAtMs: 1,
        accuracy: 5,
        subsurface: false,
      },
      env,
    );
    expect(res.status).toBe(200);
  });

  // #916 A1 — boardingLock이 있으면 autoLockCandidate로 노출, 없으면 null.
  // client는 이 필드를 보고 자동 lock이 부착됐는지 알 수 있다.
  it('boardingLock 있는 trip → autoLockCandidate에 trainCode/line/subwayId 노출', async () => {
    const env = makeKvEnv();
    await post('/trips', tripWithLock(), env);
    const res = await post(
      '/boarding-lock/sync',
      { token: 'tok-sync', observedStationName: '신촌', observedAtMs: 1, accuracy: 5 },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      autoLockCandidate: { trainCode: string; line: string; subwayId: string } | null;
    };
    expect(body.autoLockCandidate).toEqual({ trainCode: 'T-1', line: '2', subwayId: '1002' });
  });

  it('boardingLock 없는 trip → autoLockCandidate=null', async () => {
    const env = makeKvEnv();
    const tripNoLock = tripWithLock();
    delete tripNoLock.boardingLock;
    await post('/trips', tripNoLock, env);
    const res = await post(
      '/boarding-lock/sync',
      { token: 'tok-sync', observedStationName: '신촌', observedAtMs: 1, accuracy: 5 },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      autoLockCandidate: unknown;
    };
    expect(body.autoLockCandidate).toBeNull();
  });
});
