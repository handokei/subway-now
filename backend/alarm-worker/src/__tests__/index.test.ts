import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as sentryModule from '../sentry';
import {
  app,
  applyBoardingLockTrainCodeSwap,
  computeLockSyncAdvance,
  LOCK_TTL_REFRESH_MS,
  validateBoardingLockSync,
  validateLiveActivityRegister,
  validatePushAck,
  validateTrip,
  verifyBoardingLockPersisted,
} from '../index';
import { ARCH_FLAG_KV_KEY } from '../archFlag';
import { progressKey, type TripProgress } from '../progress';
import { pendingKey, putPending, stampReceived } from '../pendingPushes';
import { KV_MIN_CACHE_TTL_SEC } from '../kvConsistency';
import type { AnalyticsEngineWriter, Env } from '../types';
import { InMemoryKV } from './inMemoryKv';
import { makeEmptyFakeR2 } from './helpers/r2Fixtures';

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

  // #1324 — degenerate trip(출발역 == 목적지)은 client가 `{ type: 'direct', stops: 0 }` 경로를
  // 만든다 → 진행할 hop 없음 → 방향 null/빈 탑승목록/skip-cycle(사가정 trip 사고). backend 거부.
  it('rejects degenerate 0-stop direct route (#1324)', () => {
    expect(
      validateTrip({ ...base(), route: { type: 'direct', line: '2', stops: 0 } }),
    ).toBeNull();
  });

  it('accepts 1-stop direct route (#1324 — 인접역 trip은 정상)', () => {
    const trip = validateTrip({ ...base(), route: { type: 'direct', line: '2', stops: 1 } });
    expect(trip).not.toBeNull();
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

  // #2120 (#2114 근본 수리 Phase 2) — device trip 인스턴스 corrId 저장.
  it('preserves valid corrId', () => {
    expect(validateTrip({ ...base(), corrId: 'corr-abc' })?.corrId).toBe('corr-abc');
  });

  it('drops missing/non-string/empty corrId', () => {
    expect(validateTrip(base())?.corrId).toBeUndefined();
    expect(validateTrip({ ...base(), corrId: 42 })?.corrId).toBeUndefined();
    expect(validateTrip({ ...base(), corrId: '' })?.corrId).toBeUndefined();
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
  it('preserves boolean infoModeEnabled (#816)', () => {
    expect(validateTrip({ ...base(), infoModeEnabled: true })?.infoModeEnabled).toBe(true);
    expect(validateTrip({ ...base(), infoModeEnabled: false })?.infoModeEnabled).toBe(false);
  });

  it('drops non-boolean infoModeEnabled and absent field stays undefined', () => {
    expect(
      validateTrip({ ...base(), infoModeEnabled: 'yes' })?.infoModeEnabled,
    ).toBeUndefined();
    expect(validateTrip({ ...base(), infoModeEnabled: 1 })?.infoModeEnabled).toBeUndefined();
    expect(validateTrip(base())?.infoModeEnabled).toBeUndefined();
  });

  // #1669 backward-compat: 구 device가 locklessStationPassed 필드명으로 송신해도 infoModeEnabled로 파싱
  it('backward-compat: locklessStationPassed 필드를 infoModeEnabled로 파싱한다 (#1669)', () => {
    expect(validateTrip({ ...base(), locklessStationPassed: true })?.infoModeEnabled).toBe(true);
    expect(validateTrip({ ...base(), locklessStationPassed: false })?.infoModeEnabled).toBe(false);
    // infoModeEnabled 우선: 둘 다 있으면 infoModeEnabled 채택
    expect(
      validateTrip({ ...base(), infoModeEnabled: true, locklessStationPassed: false })?.infoModeEnabled,
    ).toBe(true);
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

  // #2032 (Issue D) — sleepModeEnabled 필드 (monitoring 전용, ADR-023 결정 gate 미사용)
  it('preserves boolean sleepModeEnabled (#2032)', () => {
    expect(validateTrip({ ...base(), sleepModeEnabled: true })?.sleepModeEnabled).toBe(true);
    expect(validateTrip({ ...base(), sleepModeEnabled: false })?.sleepModeEnabled).toBe(false);
  });

  it('drops non-boolean sleepModeEnabled and absent field stays undefined (#2032, legacy client graceful)', () => {
    expect(validateTrip({ ...base(), sleepModeEnabled: 'yes' })?.sleepModeEnabled).toBeUndefined();
    expect(validateTrip({ ...base(), sleepModeEnabled: 1 })?.sleepModeEnabled).toBeUndefined();
    // Legacy client (필드 미송신) — 기존 동작 완전 보존.
    expect(validateTrip(base())?.sleepModeEnabled).toBeUndefined();
  });

  // #1193 — 중복역 trip의 waypoint occurrenceIdx stamping.
  describe('occurrenceIdx stamping (#1193)', () => {
    it('단일 등장 waypoints는 모두 occurrenceIdx=0', () => {
      const trip = validateTrip({
        ...base(),
        waypoints: [
          { stationName: '신도림', line: '2', kind: 'transfer' },
          { stationName: '강남', line: '2', kind: 'destination' },
        ],
      });
      expect(trip?.waypoints.map((w) => w.occurrenceIdx)).toEqual([0, 0]);
    });

    it('같은 stationName 중복 시 0, 1, 2... 순차 stamp', () => {
      const trip = validateTrip({
        ...base(),
        waypoints: [
          { stationName: '회차역', line: '2', kind: 'transfer' },
          { stationName: '다른역', line: '2', kind: 'transfer' },
          { stationName: '회차역', line: '2', kind: 'transfer' },
          { stationName: '강남', line: '2', kind: 'destination' },
        ],
      });
      expect(trip?.waypoints.map((w) => w.occurrenceIdx)).toEqual([0, 0, 1, 0]);
    });

    it('클라이언트가 명시한 occurrenceIdx는 그대로 신뢰 (round-trip)', () => {
      const trip = validateTrip({
        ...base(),
        waypoints: [
          { stationName: '회차역', line: '2', kind: 'transfer', occurrenceIdx: 5 },
          { stationName: '강남', line: '2', kind: 'destination', occurrenceIdx: 0 },
        ],
      });
      expect(trip?.waypoints.map((w) => w.occurrenceIdx)).toEqual([5, 0]);
    });

    it.each([
      ['음수', -1],
      ['소수', 1.5],
      ['문자열', '1'],
    ] as const)('비정상 occurrenceIdx(%s)는 무시 후 자동 계산', (_label, badValue) => {
      const trip = validateTrip({
        ...base(),
        waypoints: [
          { stationName: '회차역', line: '2', kind: 'transfer', occurrenceIdx: badValue },
          { stationName: '회차역', line: '2', kind: 'transfer' },
          { stationName: '강남', line: '2', kind: 'destination' },
        ],
      });
      expect(trip?.waypoints.map((w) => w.occurrenceIdx)).toEqual([0, 1, 0]);
    });
  });

  // Epic #1204 그룹 2 D3 (#1273) — silent push payload hopIndex SSOT용 stamping.
  describe('hopIndex stamping (#1273)', () => {
    it('waypoint 시퀀스 0-based 위치로 stamp (단일 등장)', () => {
      const trip = validateTrip({
        ...base(),
        waypoints: [
          { stationName: '용마산', line: '7', kind: 'transfer' },
          { stationName: '중곡', line: '7', kind: 'intermediate' },
          { stationName: '군자', line: '7', kind: 'destination' },
        ],
      });
      expect(trip?.waypoints.map((w) => w.hopIndex)).toEqual([0, 1, 2]);
    });

    it('중복 station이 있어도 hopIndex는 절대 시퀀스 위치 유지', () => {
      const trip = validateTrip({
        ...base(),
        waypoints: [
          { stationName: '회차역', line: '2', kind: 'transfer' },
          { stationName: '다른역', line: '2', kind: 'transfer' },
          { stationName: '회차역', line: '2', kind: 'transfer' },
          { stationName: '강남', line: '2', kind: 'destination' },
        ],
      });
      expect(trip?.waypoints.map((w) => w.hopIndex)).toEqual([0, 1, 2, 3]);
      // occurrenceIdx와 별개로 카운트되는지 동시 검증.
      expect(trip?.waypoints.map((w) => w.occurrenceIdx)).toEqual([0, 0, 1, 0]);
    });

    it('클라이언트가 명시한 hopIndex는 그대로 신뢰 (round-trip)', () => {
      const trip = validateTrip({
        ...base(),
        waypoints: [
          { stationName: '용마산', line: '7', kind: 'transfer', hopIndex: 7 },
          { stationName: '강남', line: '2', kind: 'destination', hopIndex: 8 },
        ],
      });
      expect(trip?.waypoints.map((w) => w.hopIndex)).toEqual([7, 8]);
    });

    it.each([
      ['음수', -1],
      ['소수', 1.5],
      ['문자열', '1'],
    ] as const)('비정상 hopIndex(%s)는 무시 후 시퀀스 위치로 fallback', (_label, badValue) => {
      const trip = validateTrip({
        ...base(),
        waypoints: [
          { stationName: '용마산', line: '7', kind: 'transfer', hopIndex: badValue },
          { stationName: '강남', line: '2', kind: 'destination' },
        ],
      });
      expect(trip?.waypoints.map((w) => w.hopIndex)).toEqual([0, 1]);
    });
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
      // #1366: lock 검증을 통과하도록 lock.line(='7')과 일치하는 waypoint를 포함.
      waypoints: [
        { stationName: '군자', line: '7', kind: 'transfer' },
        { stationName: '강남', line: '2', kind: 'destination' },
      ],
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

// #1731 — validateTrip reject logger: console.warn + Sentry breadcrumb
describe('validateTrip — reject logger (#1731)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let breadcrumbSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    breadcrumbSpy = vi.spyOn(sentryModule, 'addValidateRejectBreadcrumb').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['non-object input → non-object', null, 'non-object'],
    ['missing token → missing-token', { ...base(), token: undefined }, 'missing-token'],
    ['missing destination → missing-destination', { ...base(), destination: undefined }, 'missing-destination'],
    ['missing route → missing-route', { ...base(), route: undefined }, 'missing-route'],
    ['empty waypoints → empty-waypoints', { ...base(), waypoints: [] }, 'empty-waypoints'],
    ['expired expiresAt → invalid-expiresAt', { ...base(), expiresAt: Date.now() - 1 }, 'invalid-expiresAt'],
    ['missing alarmAtEpochMs → missing-alarmAtEpochMs', (() => { const b = base(); delete b.alarmAtEpochMs; return b; })(), 'missing-alarmAtEpochMs'],
    ['0-stop direct route → zero-stop-direct-route', { ...base(), route: { type: 'direct', line: '2', stops: 0 } }, 'zero-stop-direct-route'],
    ['waypoint null → invalid-waypoint-non-object', { ...base(), waypoints: [null] }, 'invalid-waypoint-non-object'],
    ['waypoint stationName number → invalid-waypoint-stationName', { ...base(), waypoints: [{ stationName: 1, line: '2', kind: 'destination' }] }, 'invalid-waypoint-stationName'],
    ['waypoint line missing → invalid-waypoint-line', { ...base(), waypoints: [{ stationName: '강남', kind: 'destination' }] }, 'invalid-waypoint-line'],
    ['waypoint kind unknown → invalid-waypoint-kind', { ...base(), waypoints: [{ stationName: '강남', line: '2', kind: 'unknown' }] }, 'invalid-waypoint-kind'],
  ] as const)('%s', (_label, input, expectedReason) => {
    validateTrip(input as unknown);
    expect(warnSpy).toHaveBeenCalledOnce();
    const warnArg = warnSpy.mock.calls[0][0] as string;
    expect(warnArg).toContain(expectedReason);
    expect(breadcrumbSpy).toHaveBeenCalledOnce();
    expect(breadcrumbSpy).toHaveBeenCalledWith(expectedReason, expect.any(Object));
  });

  it('valid input → no console.warn, no breadcrumb', () => {
    validateTrip(base());
    expect(warnSpy).not.toHaveBeenCalled();
    expect(breadcrumbSpy).not.toHaveBeenCalled();
  });

  it('token 앞 8자만 tokenPrefix로 mask', () => {
    validateTrip({ ...base(), destination: undefined });
    const data = breadcrumbSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(data.tokenPrefix).toBe('tok');           // 'tok' is 3 chars, slice(0,8) = 'tok'
    expect(data.tokenPrefix).not.toBe(base().token + 'extra');
  });
});

// #916 follow-up A — server-set auto-lock(autoLockedAt 마커) 보존.
// client가 lock 필드 없이 same-session 재등록하면 사용자 명시 lock은 drop되고
// server-set auto-lock은 보존되어야 한다 (cron 추적 연속성).
describe('POST /trips — server-set auto-lock 보존 (#916 follow-up A)', () => {
  const CREATED = 1_700_000_000_000;
  const TOKEN = 'tok-916-fua';

  function tripBody(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      ...base(),
      token: TOKEN,
      createdAt: CREATED,
      // #1366: lock validation 통과 — lock.line='7'과 일치하는 waypoint 포함.
      waypoints: [
        { stationName: '군자', line: '7', kind: 'transfer' },
        { stationName: '강남', line: '2', kind: 'destination' },
      ],
      ...overrides,
    };
  }

  /** existing trip을 KV에 직접 주입 — backend가 자동 합성한 server-set lock 시뮬레이션. */
  async function seedExisting(
    env: ReturnType<typeof makeKvEnv>,
    lock: Record<string, unknown> | undefined,
  ): Promise<void> {
    const seeded: Record<string, unknown> = { ...tripBody() };
    if (lock !== undefined) seeded.boardingLock = lock;
    await env.TRIPS.put(`trip:${TOKEN}`, JSON.stringify(seeded));
  }

  function serverSetLock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      trainCode: 'AUTO1',
      line: '7',
      subwayId: '1007',
      selectedDepartureTime: CREATED,
      segmentStations: ['용마산', '중곡', '군자'],
      expiresAt: FUTURE,
      autoLockedAt: CREATED + 1_000,
      ...overrides,
    };
  }

  function userSetLock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    // autoLockedAt 부재 = 사용자 명시 lock
    return {
      trainCode: 'USER1',
      line: '7',
      subwayId: '1007',
      selectedDepartureTime: CREATED,
      segmentStations: ['용마산', '중곡', '군자'],
      expiresAt: FUTURE,
      ...overrides,
    };
  }

  it('server-set lock + incoming.boardingLock 부재 → 보존', async () => {
    const env = makeKvEnv();
    await seedExisting(env, serverSetLock());
    await post('/trips', tripBody(), env); // incoming.boardingLock 없음
    const stored = JSON.parse((await env.TRIPS.get(`trip:${TOKEN}`)) as string);
    expect(stored.boardingLock?.trainCode).toBe('AUTO1');
    expect(stored.boardingLock?.autoLockedAt).toBe(CREATED + 1_000);
  });

  it('user-set lock + incoming.boardingLock 부재 → drop (기존 정책 유지)', async () => {
    const env = makeKvEnv();
    await seedExisting(env, userSetLock());
    await post('/trips', tripBody(), env);
    const stored = JSON.parse((await env.TRIPS.get(`trip:${TOKEN}`)) as string);
    expect(stored.boardingLock).toBeUndefined();
  });

  it('server-set lock + incoming 새 trainCode → swap (새 lock 채택)', async () => {
    const env = makeKvEnv();
    await seedExisting(env, serverSetLock({ trainCode: 'AUTO1' }));
    await post(
      '/trips',
      tripBody({
        boardingLock: {
          trainCode: 'NEW1',
          line: '7',
          subwayId: '1007',
          selectedDepartureTime: CREATED,
          segmentStations: ['용마산', '중곡', '군자'],
          expiresAt: FUTURE,
        },
      }),
      env,
    );
    const stored = JSON.parse((await env.TRIPS.get(`trip:${TOKEN}`)) as string);
    expect(stored.boardingLock?.trainCode).toBe('NEW1');
    // 새 lock은 client가 보낸 그대로 — autoLockedAt 마커 없음
    expect(stored.boardingLock?.autoLockedAt).toBeUndefined();
  });

  it('server-set lock 보존 시 lastTrackedArrivalEpoch도 유지 (cron 추적 연속성)', async () => {
    const env = makeKvEnv();
    await seedExisting(env, serverSetLock());
    // backend cron이 baseline epoch을 stamp한 상태 시뮬레이션
    const advanced = JSON.parse((await env.TRIPS.get(`trip:${TOKEN}`)) as string);
    advanced.lastTrackedArrivalEpoch = 12_345;
    await env.TRIPS.put(`trip:${TOKEN}`, JSON.stringify(advanced));
    await post('/trips', tripBody(), env); // lock 필드 없이 재등록
    const stored = JSON.parse((await env.TRIPS.get(`trip:${TOKEN}`)) as string);
    expect(stored.lastTrackedArrivalEpoch).toBe(12_345);
  });
});

describe('POST /trips — lastAutoPromptedAt 보존 (#916 follow-up B)', () => {
  // 30분 window (AUTO_PROMPT_DEDUP_WINDOW_MS) 안/밖, same/new session 4사분면 검증.
  const CREATED = 1_700_000_000_000;
  const TOKEN = 'tok-916-fub';
  const WITHIN_WINDOW_MS = 5 * 60_000; // 5분 — 30분 window 안
  const BEYOND_WINDOW_MS = 31 * 60_000; // 31분 — 30분 window 밖

  function tripBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...base(), token: TOKEN, createdAt: CREATED, ...overrides };
  }

  async function seedExisting(
    env: ReturnType<typeof makeKvEnv>,
    fields: Record<string, unknown>,
  ): Promise<void> {
    await env.TRIPS.put(
      `trip:${TOKEN}`,
      JSON.stringify({ ...tripBody(), ...fields }),
    );
  }

  it('same session — existing.lastAutoPromptedAt 보존', async () => {
    const env = makeKvEnv();
    const stamp = CREATED - WITHIN_WINDOW_MS;
    await seedExisting(env, { lastAutoPromptedAt: stamp });
    await post('/trips', tripBody(), env);
    const stored = JSON.parse((await env.TRIPS.get(`trip:${TOKEN}`)) as string);
    expect(stored.lastAutoPromptedAt).toBe(stamp);
  });

  it('new session(createdAt drift > 5s) — window 안이어도 보존하지 않음(undefined) (#1886 RC-2 옵션 D)', async () => {
    const env = makeKvEnv();
    const stamp = CREATED - WITHIN_WINDOW_MS;
    await seedExisting(env, { lastAutoPromptedAt: stamp });
    // #1886 RC-2 옵션 D: 새 trip(isSameSession=false)은 lastAutoPromptedAt를 reset.
    // T1→T2 연속 trip에서 T1의 dedup이 T2로 carry-over하던 회귀 차단.
    await post('/trips', tripBody({ createdAt: CREATED + 10_000 }), env);
    const stored = JSON.parse((await env.TRIPS.get(`trip:${TOKEN}`)) as string);
    expect(stored.lastAutoPromptedAt).toBeUndefined();
  });

  it('new session + window 밖 — 보존하지 않음(undefined)', async () => {
    const env = makeKvEnv();
    // existing의 createdAt도 같이 옛 시각으로 시뮬레이션 (둘 다 옛 시각이라야 incoming 새 시각과 drift)
    const oldNow = CREATED - BEYOND_WINDOW_MS;
    await env.TRIPS.put(
      `trip:${TOKEN}`,
      JSON.stringify({ ...tripBody({ createdAt: oldNow }), lastAutoPromptedAt: oldNow }),
    );
    await post('/trips', tripBody({ createdAt: CREATED }), env);
    const stored = JSON.parse((await env.TRIPS.get(`trip:${TOKEN}`)) as string);
    expect(stored.lastAutoPromptedAt).toBeUndefined();
  });

  it('existing 마커 부재 — incoming도 마커 없이 저장(undefined)', async () => {
    const env = makeKvEnv();
    await seedExisting(env, {}); // lastAutoPromptedAt 없음
    await post('/trips', tripBody({ createdAt: CREATED + 10_000 }), env);
    const stored = JSON.parse((await env.TRIPS.get(`trip:${TOKEN}`)) as string);
    expect(stored.lastAutoPromptedAt).toBeUndefined();
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

  // #2120 (#2114 근본 수리 Phase 2) — corrId는 재등록마다 incoming 값으로 교체된다.
  it('replaces corrId with incoming value on re-register (same session)', async () => {
    const env = makeKvEnv();
    await post('/trips', tripBody({ corrId: 'corr-1' }), env);
    let stored = JSON.parse((await env.TRIPS.get('trip:tok-578')) as string);
    expect(stored.corrId).toBe('corr-1');
    // 같은 세션(createdAt 동일) 재등록 — corrId 변경 없음 시나리오는 사실상 발생하지 않지만
    // (같은 trip 동안 corrId 안정) 회귀 가드로 값이 유지되는지 확인.
    await post('/trips', tripBody({ corrId: 'corr-1' }), env);
    stored = JSON.parse((await env.TRIPS.get('trip:tok-578')) as string);
    expect(stored.corrId).toBe('corr-1');
  });

  it('replaces corrId with new value on new session register (different createdAt)', async () => {
    const env = makeKvEnv();
    await post('/trips', tripBody({ corrId: 'corr-old' }), env);
    await post(
      '/trips',
      tripBody({ createdAt: CREATED + 10_000, corrId: 'corr-new' }),
      env,
    );
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-578')) as string);
    expect(stored.corrId).toBe('corr-new');
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

  // #1701 — 새 세션 분기에서 SSoT mirror가 강제 reset되어야 cross-trip stale mirror가 누수되지 않는다.
  // evidence: device가 옛 trip stationName(7-018 어린이대공원)을 picker 입력으로 받아 잘못된 알림 발사.
  it('deletes stale SSoT row on new session (different createdAt) (#1701)', async () => {
    const { seedSsot, readSsot } = await import('../tripPositionSsot');
    const env = makeKvEnv();
    await post('/trips', tripBody(), env);
    // 옛 trip의 SSoT mirror 시뮬레이션 — 다른 line의 station name이 남은 상태.
    await seedSsot(env.TRIPS, 'tok-578', '어린이대공원(세종대)');
    expect(await readSsot(env.TRIPS, 'tok-578')).not.toBeNull();
    // 새 세션(다른 createdAt) 등록.
    await post('/trips', tripBody({ createdAt: CREATED + 10_000 }), env);
    // SSoT는 즉시 reset → 후속 lazy-seed가 새 waypoint.stationName으로 정착할 수 있다.
    expect(await readSsot(env.TRIPS, 'tok-578')).toBeNull();
  });

  it('preserves SSoT row on same-session re-register (no reset) (#1701)', async () => {
    // 회귀 가드 — 같은 세션 재등록에서는 SSoT가 유지돼야 한다 (advance 진행분 보존 정신과 정합).
    const { seedSsot, readSsot } = await import('../tripPositionSsot');
    const env = makeKvEnv();
    await post('/trips', tripBody(), env);
    await seedSsot(env.TRIPS, 'tok-578', '중곡');
    // 같은 createdAt으로 재POST (same session).
    await post('/trips', tripBody(), env);
    const ssot = await readSsot(env.TRIPS, 'tok-578');
    expect(ssot).not.toBeNull();
    expect(ssot?.currentStationId).toBe('중곡');
  });

  it('logs but does not throw when SSoT delete fails on new session (#1701)', async () => {
    // 회귀 가드 — SSoT delete 실패가 trip 등록을 차단하지 않는다 (graceful).
    const { seedSsot } = await import('../tripPositionSsot');
    const env = makeKvEnv();
    await post('/trips', tripBody(), env);
    await seedSsot(env.TRIPS, 'tok-578', '어린이대공원(세종대)');
    // KV.delete가 ssot:* 키에서 throw하도록 patch.
    const originalDelete = env.TRIPS.delete.bind(env.TRIPS);
    env.TRIPS.delete = vi.fn(async (key: string) => {
      if (key.startsWith('ssot:')) throw new Error('ssot kv down');
      return originalDelete(key);
    }) as unknown as typeof env.TRIPS.delete;
    const logSpy = vi.spyOn(console, 'log');
    const res = await post('/trips', tripBody({ createdAt: CREATED + 10_000 }), env);
    expect(res.status).toBe(200);
    const failureLog = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('ssot delete on new session failed'));
    expect(failureLog).toBeDefined();
    logSpy.mockRestore();
  });

  it('preserves existing apnsEnv when incoming omits it', async () => {
    const env = makeKvEnv();
    await post('/trips', tripBody({ apnsEnv: 'production' }), env);
    await post('/trips', tripBody(), env); // no apnsEnv
    const finalTrip = JSON.parse((await env.TRIPS.get('trip:tok-578')) as string);
    expect(finalTrip.apnsEnv).toBe('production');
  });

  // #1370 L1 — self-heal로 정정된 apnsEnv는 같은 token이면 새 session(환승 후 새 trainCode 등)에서도 보존.
  // 보존 안 하면 매 새 session 첫 push마다 mismatch retry가 반복돼 첫 push latency + 일부 drop 위험.
  it('preserves backend-corrected apnsEnv across new session re-register (#1370)', async () => {
    const env = makeKvEnv();
    await post('/trips', tripBody({ apnsEnv: 'production' }), env);
    // backend self-heal로 sandbox로 정정된 상태 시뮬레이션
    const existing = JSON.parse((await env.TRIPS.get('trip:tok-578')) as string);
    existing.apnsEnv = 'sandbox';
    await env.TRIPS.put('trip:tok-578', JSON.stringify(existing));
    // 환승 후 새 trainCode + createdAt drift → !isSameSession 분기. client는 다시 production 송신.
    await post('/trips', tripBody({ createdAt: CREATED + 10_000, apnsEnv: 'production' }), env);
    const finalTrip = JSON.parse((await env.TRIPS.get('trip:tok-578')) as string);
    expect(finalTrip.apnsEnv).toBe('sandbox');
  });

  // existing 부재(brand-new token) 또는 existing.apnsEnv 부재(legacy trip) → incoming 값으로 fallback.
  it('uses incoming apnsEnv on brand-new token (no existing trip)', async () => {
    const env = makeKvEnv();
    await post('/trips', tripBody({ apnsEnv: 'production' }), env);
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

  // #2032 (Issue D) — sleepModeEnabled 저장 및 재등록 시 incoming 값 반영.
  // ADR-023: monitoring 전용 필드 — merge는 `...incoming` spread로 자연 갱신 (별도 preserve 로직 불필요).
  it('persists sleepModeEnabled on register (monitoring 전용, ADR-023)', async () => {
    const env = makeKvEnv();
    await post('/trips', { ...tripBody(), sleepModeEnabled: true }, env);
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-578')) as string);
    expect(stored.sleepModeEnabled).toBe(true);
  });

  it('updates sleepModeEnabled on same-session re-register (user toggled sleep)', async () => {
    const env = makeKvEnv();
    // 1) initial register: sleep OFF
    await post('/trips', tripBody(), env);
    const initial = JSON.parse((await env.TRIPS.get('trip:tok-578')) as string);
    expect(initial.sleepModeEnabled).toBeUndefined();
    // 2) user turns sleep ON — same createdAt (same session)
    await post('/trips', { ...tripBody(), sleepModeEnabled: true }, env);
    const afterOn = JSON.parse((await env.TRIPS.get('trip:tok-578')) as string);
    expect(afterOn.sleepModeEnabled).toBe(true);
    // 3) user turns sleep OFF again — same session
    await post('/trips', { ...tripBody(), sleepModeEnabled: false }, env);
    const afterOff = JSON.parse((await env.TRIPS.get('trip:tok-578')) as string);
    expect(afterOff.sleepModeEnabled).toBe(false);
  });

  it('legacy client (no sleepModeEnabled) 는 undefined 저장 (backward-compat 완전 보존)', async () => {
    const env = makeKvEnv();
    await post('/trips', tripBody(), env); // legacy client — 필드 미송신
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-578')) as string);
    expect(stored.sleepModeEnabled).toBeUndefined();
  });

  // POST /trips 거부 케이스 — 동일한 400 + error-code shape를 테이블로 검증(중복 제거).
  // #1324 degenerate(0-stop direct) row는 KV에 trip이 쓰이지 않았는지까지 추가 확인한다.
  it.each<[string, unknown, string, boolean]>([
    ['invalid JSON', 'not-json{', 'invalid_json', false],
    ['invalid trip body', { token: '' }, 'invalid_trip', false],
    [
      'degenerate 0-stop direct route (#1324)',
      tripBody({ route: { type: 'direct', line: '2', stops: 0 } }),
      'invalid_trip',
      true,
    ],
  ])('returns 400 on %s', async (_name, body, expectedError, expectNoTrip) => {
    const env = makeKvEnv();
    const res = await post('/trips', body, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expectedError });
    if (expectNoTrip) expect(await env.TRIPS.get('trip:tok-578')).toBeNull();
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

// #1285 — lockless trip POST /trips 재등록 시 waypoint 진행 보존
describe('POST /trips — #1285 lockless progress KV 재등록 시 진행 보존', () => {
  const LOCKLESS_TOKEN = 'tok-1285';
  const LOCKLESS_WAYPOINTS = [
    { stationName: '중곡', line: '5', kind: 'intermediate' },
    { stationName: '군자', line: '5', kind: 'intermediate' },
    { stationName: '아차산', line: '5', kind: 'destination' },
  ];

  function locklessTripBody(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      ...base(),
      token: LOCKLESS_TOKEN,
      createdAt: SESSION_CREATED,
      infoModeEnabled: true,
      waypoints: LOCKLESS_WAYPOINTS,
      ...overrides,
    };
  }

  async function readLocklessTrip(env: Env): Promise<Record<string, unknown>> {
    return JSON.parse((await env.TRIPS.get(`trip:${LOCKLESS_TOKEN}`)) as string);
  }

  async function seedLocklessProgress(env: Env, shiftedCount: number): Promise<void> {
    await env.TRIPS.put(
      `progress:${LOCKLESS_TOKEN}`,
      JSON.stringify({ lockless: true, shiftedCount }),
    );
  }

  it('lockless trip 재등록 시 progress.shiftedCount=1 → 중곡 제거, 군자가 첫 waypoint', async () => {
    const env = makeKvEnv();
    // 첫 등록
    await post('/trips', locklessTripBody(), env);
    // 서버가 중곡 발사 후 progress.shiftedCount=1 기록
    await seedLocklessProgress(env, 1);
    // 디바이스 재등록 (GPS 동결로 중곡 포함 full route 재전송)
    await post('/trips', locklessTripBody({ createdAt: SESSION_CREATED + 50_000 }), env);
    const finalTrip = await readLocklessTrip(env);
    expect((finalTrip.waypoints as Array<{ stationName: string }>)).toHaveLength(2);
    expect((finalTrip.waypoints as Array<{ stationName: string }>)[0].stationName).toBe('군자');
  });

  it('lockless progress 보존 후 중곡 재발사 안 됨 — waypoint가 군자로 advance 유지', async () => {
    const env = makeKvEnv();
    await post('/trips', locklessTripBody(), env);
    await seedLocklessProgress(env, 1);
    // 재등록 후에도 진행분 보존 검증
    await post('/trips', locklessTripBody(), env);
    const finalTrip = await readLocklessTrip(env);
    expect((finalTrip.waypoints as Array<{ stationName: string }>)[0].stationName).toBe('군자');
  });

  it('lockless progress가 있어도 infoModeEnabled=false면 progress 폐기', async () => {
    const env = makeKvEnv();
    await post('/trips', locklessTripBody(), env);
    await seedLocklessProgress(env, 1);
    // infoModeEnabled가 false인 재등록 — progress 미적용
    await post('/trips', locklessTripBody({ infoModeEnabled: false }), env);
    expect(await env.TRIPS.get(`progress:${LOCKLESS_TOKEN}`)).toBeNull();
  });

  it('lock-mode progress(trainCode stamp)가 lockless 재등록 시 폐기됨', async () => {
    const env = makeKvEnv();
    await post('/trips', locklessTripBody(), env);
    // lock 경로가 남긴 progress (lockless 마커 없음)
    await env.TRIPS.put(
      `progress:${LOCKLESS_TOKEN}`,
      JSON.stringify({ trainCode: 'SOME_TRAIN', shiftedCount: 1 }),
    );
    await post('/trips', locklessTripBody(), env);
    // trainCode 기반 progress는 lockless 재등록 시 progressApplies=false → 삭제
    expect(await env.TRIPS.get(`progress:${LOCKLESS_TOKEN}`)).toBeNull();
  });
});

/**
 * 4 tests 공통 패턴 — TELEMETRY 적재형 POST endpoint(/telemetry/silent-push,
 * /metrics/boarding-prompt, /telemetry/recall)는 모두 (1) invalid JSON 400,
 * (2) invalid payload 400, (3) writer 있을 때 적재, (4) writer 없을 때 graceful
 * 200을 보장해야 한다. Sonar `new_duplicated_lines_density` 임계(3%)에 걸리지 않도록
 * helper로 통합 (#919 sonar fix).
 */
function runTelemetryEndpointSuite(path: string, validBody: Record<string, unknown>): void {
  it('returns 400 on invalid JSON', async () => {
    const env = makeEnv();
    const res = await post(path, 'not-json{', env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
  });

  it('returns 400 on invalid payload', async () => {
    const env = makeEnv();
    const res = await post(path, { token: '' }, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_payload' });
  });

  it('writes to TELEMETRY binding when present', async () => {
    const writer: AnalyticsEngineWriter = { writeDataPoint: vi.fn() };
    const env = makeEnv({ TELEMETRY: writer });
    const res = await post(path, validBody, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(writer.writeDataPoint).toHaveBeenCalled();
  });

  it('still returns ok when TELEMETRY binding absent (graceful)', async () => {
    const env = makeEnv();
    const res = await post(path, validBody, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
}

describe('POST /telemetry/silent-push', () => {
  runTelemetryEndpointSuite('/telemetry/silent-push', {
    token: 'aabbccdd11223344',
    since: 0,
    until: 1000,
    received: 3,
    fired: 2,
    skipped: 1,
    skipReasons: { 'gate-out-of-range': 1 },
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

  it('#1370 L5 — accepts received outcome', () => {
    expect(validatePushAck({ pushId: 'p1', token: 'tok', outcome: 'received' })).toEqual({
      pushId: 'p1',
      token: 'tok',
      outcome: 'received',
    });
  });

  describe('#1768 — permissionMode', () => {
    it.each([
      { mode: 'always' as const },
      { mode: 'whileInUse' as const },
      { mode: 'denied' as const },
    ])('permissionMode=$mode → payload에 포함', ({ mode }) => {
      const ack = validatePushAck({ pushId: 'p1', token: 'tok', outcome: 'received', permissionMode: mode });
      expect(ack).toEqual({ pushId: 'p1', token: 'tok', outcome: 'received', permissionMode: mode });
    });

    it('permissionMode 누락(legacy) → payload에 포함 안 됨', () => {
      const ack = validatePushAck({ pushId: 'p1', token: 'tok', outcome: 'received' });
      expect(ack).toEqual({ pushId: 'p1', token: 'tok', outcome: 'received' });
      expect(ack).not.toHaveProperty('permissionMode');
    });

    it('permissionMode 유효하지 않은 값 → payload에 포함 안 됨 (graceful 무시)', () => {
      const ack = validatePushAck({ pushId: 'p1', token: 'tok', outcome: 'received', permissionMode: 'unknown-value' });
      expect(ack).toEqual({ pushId: 'p1', token: 'tok', outcome: 'received' });
      expect(ack).not.toHaveProperty('permissionMode');
    });
  });

  describe('#1772 — latencyMs + batteryState', () => {
    it('양의 latencyMs → payload에 포함', () => {
      const ack = validatePushAck({ pushId: 'p1', token: 'tok', outcome: 'received', latencyMs: 350 });
      expect(ack).toMatchObject({ latencyMs: 350 });
    });

    it('0ms latencyMs → payload에 포함 (0은 유효)', () => {
      const ack = validatePushAck({ pushId: 'p1', token: 'tok', outcome: 'received', latencyMs: 0 });
      expect(ack).toMatchObject({ latencyMs: 0 });
    });

    it('음수 latencyMs → payload에 포함 안 됨 (graceful)', () => {
      const ack = validatePushAck({ pushId: 'p1', token: 'tok', outcome: 'received', latencyMs: -100 });
      expect(ack).not.toHaveProperty('latencyMs');
    });

    it('Infinity latencyMs → payload에 포함 안 됨', () => {
      const ack = validatePushAck({ pushId: 'p1', token: 'tok', outcome: 'received', latencyMs: Infinity });
      expect(ack).not.toHaveProperty('latencyMs');
    });

    it('latencyMs 누락 → payload에 포함 안 됨 (legacy backward compat)', () => {
      const ack = validatePushAck({ pushId: 'p1', token: 'tok', outcome: 'received' });
      expect(ack).not.toHaveProperty('latencyMs');
    });

    it.each([
      { state: 'normal' as const },
      { state: 'lowPowerMode' as const },
      { state: 'unknown' as const },
    ])('batteryState=$state → payload에 포함', ({ state }) => {
      const ack = validatePushAck({ pushId: 'p1', token: 'tok', outcome: 'received', batteryState: state });
      expect(ack).toMatchObject({ batteryState: state });
    });

    it('batteryState 유효하지 않은 값 → payload에 포함 안 됨', () => {
      const ack = validatePushAck({ pushId: 'p1', token: 'tok', outcome: 'received', batteryState: 'charging' });
      expect(ack).not.toHaveProperty('batteryState');
    });

    it('batteryState 누락 → payload에 포함 안 됨 (legacy)', () => {
      const ack = validatePushAck({ pushId: 'p1', token: 'tok', outcome: 'received' });
      expect(ack).not.toHaveProperty('batteryState');
    });
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

  describe('#1370 L5 — received outcome', () => {
    it('token 매칭 시 stamped=true, pending entry는 보존', async () => {
      await kv.put(
        pendingKey('p1'),
        JSON.stringify({
          pushId: 'p1',
          token: 'real-token',
          stationName: '어린이대공원',
          phase: 'early',
        }),
      );
      const env = makeEnv({ PENDING_PUSHES: kv as unknown as KVNamespace });
      const res = await post(
        '/push/ack',
        { pushId: 'p1', token: 'real-token', outcome: 'received' },
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, stamped: true });
      // pending entry는 보존 — fired/skipped 후속 ack가 P2c fallback 결정에 사용.
      expect(kv.store.has(pendingKey('p1'))).toBe(true);
      // received: stamp 적재.
      expect(kv.store.has('received:p1')).toBe(true);
    });

    it('token 불일치 시 stamped=false, reason=token-mismatch', async () => {
      await kv.put(
        pendingKey('p1'),
        JSON.stringify({ pushId: 'p1', token: 'real-token', stationName: '강남', phase: 'early' }),
      );
      const env = makeEnv({ PENDING_PUSHES: kv as unknown as KVNamespace });
      const res = await post(
        '/push/ack',
        { pushId: 'p1', token: 'attacker', outcome: 'received' },
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        stamped: false,
        reason: 'token-mismatch',
      });
      expect(kv.store.has('received:p1')).toBe(false);
    });

    it('PENDING_PUSHES 미바인딩 시 stamped=false, reason=not-found', async () => {
      const env = makeEnv();
      const res = await post(
        '/push/ack',
        { pushId: 'p1', token: 'tok', outcome: 'received' },
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, stamped: false, reason: 'not-found' });
    });

    describe('#1768 — received ack에 permissionMode 포함 시 stamp에 저장', () => {
      it('permissionMode=always → received stamp에 포함', async () => {
        await kv.put(
          pendingKey('p-pm'),
          JSON.stringify({ pushId: 'p-pm', token: 'tok', stationName: '강남', phase: 'early' }),
        );
        const env = makeEnv({ PENDING_PUSHES: kv as unknown as KVNamespace });
        await post('/push/ack', { pushId: 'p-pm', token: 'tok', outcome: 'received', permissionMode: 'always' }, env);
        const raw = kv.store.get('received:p-pm');
        expect(raw).toBeDefined();
        const parsed = JSON.parse(raw!.value) as Record<string, unknown>;
        expect(parsed.permissionMode).toBe('always');
      });

      it('permissionMode 누락(legacy) → stamp에 permissionMode 없음', async () => {
        await kv.put(
          pendingKey('p-noperm'),
          JSON.stringify({ pushId: 'p-noperm', token: 'tok', stationName: '강남', phase: 'early' }),
        );
        const env = makeEnv({ PENDING_PUSHES: kv as unknown as KVNamespace });
        await post('/push/ack', { pushId: 'p-noperm', token: 'tok', outcome: 'received' }, env);
        const raw = kv.store.get('received:p-noperm');
        expect(raw).toBeDefined();
        const parsed = JSON.parse(raw!.value) as Record<string, unknown>;
        expect(parsed.permissionMode).toBeUndefined();
      });
    });
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

  describe('#1363 — currentStationName 옵션 필드 (log 진단 이원화)', () => {
    const BASE_POS = { token: 'tok-csn', lat: 1, lng: 2, accuracy: 5, ts: 1234, motion: 'walking' as const };

    it('정상 문자열 → point.currentStationName에 set (waypoint와 구분된 log 라벨용)', async () => {
      const env = makeKvEnv();
      const res = await post('/position', { ...BASE_POS, currentStationName: '강남' }, env);
      expect(res.status).toBe(200);
      const stored = JSON.parse((await env.TRIPS.get('pos:tok-csn'))!) as Array<Record<string, unknown>>;
      expect(stored[0].currentStationName).toBe('강남');
    });

    it('빈 문자열 → undefined로 graceful skip (payload 거부 X)', async () => {
      const env = makeKvEnv();
      const res = await post('/position', { ...BASE_POS, currentStationName: '' }, env);
      expect(res.status).toBe(200);
      const stored = JSON.parse((await env.TRIPS.get('pos:tok-csn'))!) as Array<Record<string, unknown>>;
      expect(stored[0].currentStationName).toBeUndefined();
    });

    it('non-string → undefined로 graceful skip', async () => {
      const env = makeKvEnv();
      const res = await post('/position', { ...BASE_POS, currentStationName: 123 }, env);
      expect(res.status).toBe(200);
      const stored = JSON.parse((await env.TRIPS.get('pos:tok-csn'))!) as Array<Record<string, unknown>>;
      expect(stored[0].currentStationName).toBeUndefined();
    });

    it('필드 없음 → undefined (회귀 없음)', async () => {
      const env = makeKvEnv();
      await post('/position', BASE_POS, env);
      const stored = JSON.parse((await env.TRIPS.get('pos:tok-csn'))!) as Array<Record<string, unknown>>;
      expect(stored[0].currentStationName).toBeUndefined();
    });
  });

  describe('#1543 (S10) — cellularEnvironmentVote 옵션 필드', () => {
    const BASE_POS = {
      token: 'tok-cell',
      lat: 1,
      lng: 2,
      accuracy: 5,
      ts: 1234,
      motion: 'walking' as const,
    };

    it.each(['surface', 'underground', 'unknown'] as const)(
      'enum %s → point.cellularEnvironmentVote에 set',
      async (vote) => {
        const env = makeKvEnv();
        const res = await post(
          '/position',
          { ...BASE_POS, cellularEnvironmentVote: vote },
          env,
        );
        expect(res.status).toBe(200);
        const stored = JSON.parse(
          (await env.TRIPS.get('pos:tok-cell'))!,
        ) as Array<Record<string, unknown>>;
        expect(stored[0].cellularEnvironmentVote).toBe(vote);
      },
    );

    it('enum 외 값 → undefined로 graceful skip (payload 거부 X)', async () => {
      const env = makeKvEnv();
      const res = await post(
        '/position',
        { ...BASE_POS, cellularEnvironmentVote: 'mars' },
        env,
      );
      expect(res.status).toBe(200);
      const stored = JSON.parse(
        (await env.TRIPS.get('pos:tok-cell'))!,
      ) as Array<Record<string, unknown>>;
      expect(stored[0].cellularEnvironmentVote).toBeUndefined();
    });

    it('필드 없음 → undefined (회귀 없음)', async () => {
      const env = makeKvEnv();
      await post('/position', BASE_POS, env);
      const stored = JSON.parse(
        (await env.TRIPS.get('pos:tok-cell'))!,
      ) as Array<Record<string, unknown>>;
      expect(stored[0].cellularEnvironmentVote).toBeUndefined();
    });
  });

  describe('#1667 (ADR-015 strongDB) — wifiSsidStationName 옵션 필드', () => {
    const BASE_POS = {
      token: 'tok-wifi',
      lat: 1,
      lng: 2,
      accuracy: 5,
      ts: 1234,
      motion: 'walking' as const,
    };

    it('비어있지 않은 문자열 → point.wifiSsidStationName에 set', async () => {
      const env = makeKvEnv();
      const res = await post(
        '/position',
        { ...BASE_POS, wifiSsidStationName: '강남' },
        env,
      );
      expect(res.status).toBe(200);
      const stored = JSON.parse(
        (await env.TRIPS.get('pos:tok-wifi'))!,
      ) as Array<Record<string, unknown>>;
      expect(stored[0].wifiSsidStationName).toBe('강남');
    });

    it('빈 문자열 → undefined로 graceful skip (payload 거부 X)', async () => {
      const env = makeKvEnv();
      const res = await post(
        '/position',
        { ...BASE_POS, wifiSsidStationName: '' },
        env,
      );
      expect(res.status).toBe(200);
      const stored = JSON.parse(
        (await env.TRIPS.get('pos:tok-wifi'))!,
      ) as Array<Record<string, unknown>>;
      expect(stored[0].wifiSsidStationName).toBeUndefined();
    });

    it('필드 없음 → undefined (회귀 없음)', async () => {
      const env = makeKvEnv();
      await post('/position', BASE_POS, env);
      const stored = JSON.parse(
        (await env.TRIPS.get('pos:tok-wifi'))!,
      ) as Array<Record<string, unknown>>;
      expect(stored[0].wifiSsidStationName).toBeUndefined();
    });
  });

  describe('#1534 (S1, T9b, ADR-016) — response embed lockSuggestion + originStationId', () => {
    const BASE_POS = {
      token: 'tok-ls',
      lat: 1,
      lng: 2,
      accuracy: 5,
      ts: 1234,
      motion: 'walking' as const,
    };

    it('SSOT 미존재 (trip 미등록) → response { ok: true } only, lockSuggestion/originStationId 누락', async () => {
      const env = makeKvEnv();
      const res = await post('/position', BASE_POS, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.lockSuggestion).toBeUndefined();
      expect(body.originStationId).toBeUndefined();
    });

    it('SSOT 존재 + currentStationId set → originStationId만 forward', async () => {
      const env = makeKvEnv();
      // SSOT 직접 seed
      const { seedSsot } = await import('../tripPositionSsot');
      await seedSsot(env.TRIPS, BASE_POS.token, '용마산');
      const res = await post('/position', BASE_POS, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.originStationId).toBe('용마산');
      expect(body.lockSuggestion).toBeUndefined();
    });

    it('SSOT + lockSuggestion → 둘 다 response embed', async () => {
      const env = makeKvEnv();
      const { seedSsot, setLockSuggestion, writeSsot } = await import('../tripPositionSsot');
      const ssot = await seedSsot(env.TRIPS, BASE_POS.token, '용마산');
      setLockSuggestion(ssot, {
        stationId: '용마산',
        trainCode: '7246',
        lineId: '7',
        confidence: 'high',
        decidedAt: 1_700_000_000_000,
      });
      await writeSsot(env.TRIPS, ssot);
      const res = await post('/position', BASE_POS, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.originStationId).toBe('용마산');
      expect(body.lockSuggestion).toEqual({
        stationId: '용마산',
        trainCode: '7246',
        lineId: '7',
        confidence: 'high',
        decidedAt: 1_700_000_000_000,
      });
    });

    it('SSOT currentStationId 빈 문자열 (GAP A seed 직후) → originStationId 누락 (graceful)', async () => {
      const env = makeKvEnv();
      const { seedSsot, writeSsot } = await import('../tripPositionSsot');
      const ssot = await seedSsot(env.TRIPS, BASE_POS.token, 'X');
      ssot.currentStationId = '';
      await writeSsot(env.TRIPS, ssot);
      const res = await post('/position', BASE_POS, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.originStationId).toBeUndefined();
    });
  });

  // #2153 (리뷰 P1) — trip.promptGeoContext.originDistanceM/originAccuracyM은 device가
  // POST /trips 재등록할 때만 갱신되는 정적 스냅샷(useApnsTripRegistration.ts는 currentStation을
  // register effect deps에서 제외 — #703). "집에서 route 설정 → 재등록 트리거 없이 도보로 출발역
  // 근접" 시나리오에서 cron 경로(scheduled.ts)만으로는 anchor stamp 기회가 영영 안 올 수 있다.
  // POST /position(10초 주기, 재등록과 무관)에도 근접 신호를 흘려 매 cycle 신선한 GPS 기준으로
  // stamp 기회를 준다 — 이 describe가 그 경로를 검증한다.
  describe('#2153 — /position originDistanceM/originAccuracyM → originProximityAt stamp', () => {
    const CREATED = 1_700_000_000_000;
    function tripBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        token: 'tok-prox',
        route: { type: 'direct', line: '2', stops: 3 },
        destination: 'dst',
        waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
        expiresAt: CREATED + 60 * 60_000,
        alarmAtEpochMs: CREATED + 30 * 60_000,
        createdAt: CREATED,
        ...overrides,
      };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('red → green: 재등록 없이 /position만으로 근접(margin 이내) 관측 시 originProximityAt stamp', async () => {
      vi.useFakeTimers();
      // route 설정(createdAt) 20분 후 — 재등록 없이 이 시각에 처음 /position이 근접을 보고한다.
      const observedAt = CREATED + 20 * 60 * 1000;
      vi.setSystemTime(observedAt);
      const env = makeKvEnv();
      await post('/trips', tripBody(), env);

      const res = await post(
        '/position',
        {
          token: 'tok-prox',
          lat: 1,
          lng: 2,
          accuracy: 10,
          ts: observedAt,
          motion: 'walking',
          // margin(150m) 이내 근접 관측: distance - accuracy = 40m.
          originDistanceM: 50,
          originAccuracyM: 10,
        },
        env,
      );
      expect(res.status).toBe(200);
      const stored = JSON.parse((await env.TRIPS.get('trip:tok-prox')) as string);
      expect(stored.originProximityAt).toBe(observedAt);
    });

    it('margin 초과(멀리 있음) → originProximityAt stamp 안 함', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(CREATED);
      const env = makeKvEnv();
      await post('/trips', tripBody(), env);
      await post(
        '/position',
        {
          token: 'tok-prox',
          lat: 1,
          lng: 2,
          accuracy: 9,
          ts: CREATED,
          motion: 'walking',
          // distance - accuracy = 218m > 150m margin → 근접 아님.
          originDistanceM: 227,
          originAccuracyM: 9,
        },
        env,
      );
      const stored = JSON.parse((await env.TRIPS.get('trip:tok-prox')) as string);
      expect(stored.originProximityAt).toBeUndefined();
    });

    it('originDistanceM/originAccuracyM 부재 → stamp 안 함(기존 nearestStationDistanceM과 무관)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(CREATED);
      const env = makeKvEnv();
      await post('/trips', tripBody(), env);
      await post(
        '/position',
        { token: 'tok-prox', lat: 1, lng: 2, accuracy: 5, ts: CREATED, motion: 'walking' },
        env,
      );
      const stored = JSON.parse((await env.TRIPS.get('trip:tok-prox')) as string);
      expect(stored.originProximityAt).toBeUndefined();
    });

    it('trip 미존재 → no-op (KV에 trip:<token> 생성 안 됨, 200 응답)', async () => {
      const env = makeKvEnv();
      const res = await post(
        '/position',
        {
          token: 'no-such-trip',
          lat: 1,
          lng: 2,
          accuracy: 10,
          ts: CREATED,
          motion: 'walking',
          originDistanceM: 50,
          originAccuracyM: 10,
        },
        env,
      );
      expect(res.status).toBe(200);
      expect(await env.TRIPS.get('trip:no-such-trip')).toBeNull();
    });

    it('이미 stamp된 trip은 재관측해도 최초 시각을 보존(계속 갱신 금지)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(CREATED);
      const env = makeKvEnv();
      await post('/trips', tripBody(), env);
      const nearPayload = {
        token: 'tok-prox',
        lat: 1,
        lng: 2,
        accuracy: 10,
        ts: CREATED,
        motion: 'walking' as const,
        originDistanceM: 50,
        originAccuracyM: 10,
      };
      await post('/position', nearPayload, env);
      const firstStamp = JSON.parse((await env.TRIPS.get('trip:tok-prox')) as string).originProximityAt;
      expect(firstStamp).toBe(CREATED);

      // 5분 뒤 재관측(여전히 근접) — anchor가 최초 시각(CREATED)으로 그대로 유지돼야 한다.
      vi.setSystemTime(CREATED + 5 * 60 * 1000);
      await post('/position', { ...nearPayload, ts: CREATED + 5 * 60 * 1000 }, env);
      const secondStamp = JSON.parse((await env.TRIPS.get('trip:tok-prox')) as string).originProximityAt;
      expect(secondStamp).toBe(CREATED);
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
  runTelemetryEndpointSuite('/metrics/boarding-prompt', {
    token: 'aabbccdd11223344',
    outcome: 'dismissed',
  });
});

describe('POST /telemetry/recall (#919)', () => {
  runTelemetryEndpointSuite('/telemetry/recall', {
    token: 'aabbccdd11223344',
    tripStart: 1_000,
    tripEnd: 2_000,
    expectedStops: 5,
    firedStops: 4,
    recallPct: 80,
    gateSuppressionCounts: { 'gate-accuracy': 1 },
  });
});

describe('POST /telemetry/prescheduled (#918 A3)', () => {
  runTelemetryEndpointSuite('/telemetry/prescheduled', {
    token: 'aabbccdd11223344',
    tripStart: 1_000,
    tripEnd: 2_000,
    scheduledCount: 5,
    firedCount: 4,
    stationAccurateCount: 3,
    fireDeltaSamplesMs: [10, -5, 0, 100],
  });

  // #986 — missContext optional 첨부.
  it('accepts missContext and returns ok (Logpush로 보존)', async () => {
    const env = makeEnv();
    const res = await post(
      '/telemetry/prescheduled',
      {
        token: 'aabbccdd11223344',
        tripStart: 1_000,
        tripEnd: 2_000,
        scheduledCount: 5,
        firedCount: 4,
        stationAccurateCount: 3,
        fireDeltaSamplesMs: [10, -5, 0, 100],
        missContext: {
          lockedTrainCode: '5050',
          lockedAt: 999,
          missedIdentifiers: ['tba:early:강남'],
        },
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('rejects malformed missContext (400)', async () => {
    const env = makeEnv();
    const res = await post(
      '/telemetry/prescheduled',
      {
        token: 'aabbccdd11223344',
        tripStart: 1_000,
        tripEnd: 2_000,
        scheduledCount: 5,
        firedCount: 4,
        stationAccurateCount: 3,
        fireDeltaSamplesMs: [10, -5, 0, 100],
        missContext: { lockedAt: 'not-a-number' },
      },
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /telemetry/server-progress (#1173)', () => {
  runTelemetryEndpointSuite('/telemetry/server-progress', {
    token: 'aabbccdd11223344',
    windowStart: 1_000,
    windowEnd: 2_000,
    attempts: 10,
    received: 9,
  });
});

describe('POST /telemetry/delta-vs-estimator (#1174)', () => {
  runTelemetryEndpointSuite('/telemetry/delta-vs-estimator', {
    token: 'aabbccdd11223344',
    windowStart: 1_000,
    windowEnd: 2_000,
    deltaSamples: [0, 1, 2, 1, 0],
  });
});

describe('GET /metrics/recall/summary (#919 후속)', () => {
  async function get(env: Env): Promise<Response> {
    return app.fetch(
      new Request('http://example.com/metrics/recall/summary', { method: 'GET' }),
      env,
    );
  }

  it('returns dataset + queries + threshold (binding 부재 시 available=false)', async () => {
    const env = makeEnv();
    const res = await get(env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dataset: string;
      available: boolean;
      minRecallRatioThreshold: number;
      recallThresholdCritical: number;
      opsPageUrl: string;
      queries: { id: string; description: string; sql: string }[];
    };
    expect(body.dataset).toBe('silent_push_telemetry');
    expect(body.available).toBe(false);
    expect(body.minRecallRatioThreshold).toBeGreaterThan(0);
    expect(body.minRecallRatioThreshold).toBeLessThanOrEqual(1);
    // #1003 — critical 임계도 노출되고 invariant(critical < warning) 충족.
    expect(body.recallThresholdCritical).toBeGreaterThan(0);
    expect(body.recallThresholdCritical).toBeLessThan(body.minRecallRatioThreshold);
    expect(body.opsPageUrl).toMatch(/^https:\/\//);
    expect(body.queries.length).toBeGreaterThanOrEqual(3);
    for (const q of body.queries) {
      expect(typeof q.id).toBe('string');
      expect(q.id.length).toBeGreaterThan(0);
      expect(typeof q.description).toBe('string');
      expect(q.sql).toContain('silent_push_telemetry');
    }
  });

  it('reports available=true when TELEMETRY binding present', async () => {
    const writer: AnalyticsEngineWriter = { writeDataPoint: vi.fn() };
    const env = makeEnv({ TELEMETRY: writer });
    const res = await get(env);
    const body = (await res.json()) as { available: boolean };
    expect(body.available).toBe(true);
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

  // #2130 (Part B-be-1) — 근접 게이트 입력 필드 파싱.
  it('originDistanceM/originAccuracyM 유효 숫자 → 보존', () => {
    const trip = validateTrip(
      withPrompt({
        promptGeoContext: {
          origin: { lat: 1, lng: 2 },
          nextStation: { lat: 3, lng: 4 },
          direction: 'up',
          originDistanceM: 227,
          originAccuracyM: 9,
        },
      }),
    );
    expect(trip?.promptGeoContext?.originDistanceM).toBe(227);
    expect(trip?.promptGeoContext?.originAccuracyM).toBe(9);
  });

  it('originDistanceM/originAccuracyM 부재(지하/구 클라) → undefined로 graceful', () => {
    const trip = validateTrip(
      withPrompt({
        promptGeoContext: {
          origin: { lat: 1, lng: 2 },
          nextStation: { lat: 3, lng: 4 },
          direction: 'up',
        },
      }),
    );
    expect(trip?.promptGeoContext?.originDistanceM).toBeUndefined();
    expect(trip?.promptGeoContext?.originAccuracyM).toBeUndefined();
  });

  it.each([
    ['non-number', 'abc'],
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('originDistanceM 비정상 값(%s) → undefined로 graceful (나머지 필드는 보존)', (_label, bad) => {
    const trip = validateTrip(
      withPrompt({
        promptGeoContext: {
          origin: { lat: 1, lng: 2 },
          nextStation: { lat: 3, lng: 4 },
          direction: 'up',
          originDistanceM: bad,
          originAccuracyM: 9,
        },
      }),
    );
    expect(trip?.promptGeoContext?.originDistanceM).toBeUndefined();
    expect(trip?.promptGeoContext?.originAccuracyM).toBe(9);
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

  // D4 (#1210) — trainCode / boardingLine optional 검증. validBase에 trainCode/boardingLine만
  // 변형해 일괄 검증 (정상/빈문자열/비문자열).
  it.each<{
    label: string;
    extra: Record<string, unknown>;
    expectedTrainCode: string | undefined;
    expectedBoardingLine: string | undefined;
  }>([
    {
      label: '정상 string forward',
      extra: { trainCode: 'T-1', boardingLine: '2' },
      expectedTrainCode: 'T-1',
      expectedBoardingLine: '2',
    },
    {
      label: '빈 문자열은 누락 처리',
      extra: { trainCode: '', boardingLine: '' },
      expectedTrainCode: undefined,
      expectedBoardingLine: undefined,
    },
    {
      label: '비문자열 타입은 무시',
      extra: { trainCode: 123, boardingLine: { x: 1 } },
      expectedTrainCode: undefined,
      expectedBoardingLine: undefined,
    },
  ])('#1210 — trainCode/boardingLine: $label', ({ extra, expectedTrainCode, expectedBoardingLine }) => {
    const p = validateBoardingLockSync({
      token: 'tok',
      observedStationName: '강남',
      observedAtMs: 1,
      accuracy: 10,
      ...extra,
    });
    expect(p?.trainCode).toBe(expectedTrainCode);
    expect(p?.boardingLine).toBe(expectedBoardingLine);
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
    const body = (await res.json()) as {
      ok: boolean;
      advanced: boolean;
      currentWaypoint: string | null;
      nextStation: string | null;
      autoLockCandidate: { trainCode: string; line: string; subwayId: string; expiresAt: number };
    };
    expect(body.ok).toBe(true);
    expect(body.advanced).toBe(true);
    expect(body.currentWaypoint).toBe('역삼');
    expect(body.nextStation).toBe('역삼');
    // #916 — tripWithLock fixture에 boardingLock이 미리 설정돼 있으므로 candidate로 노출.
    // #1364 P1 — expiresAt도 함께 노출 (client local store 동기화용).
    expect(body.autoLockCandidate.trainCode).toBe('T-1');
    expect(body.autoLockCandidate.line).toBe('2');
    expect(body.autoLockCandidate.subwayId).toBe('1002');
    expect(typeof body.autoLockCandidate.expiresAt).toBe('number');
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
      autoLockCandidate: { trainCode: string; line: string; subwayId: string; expiresAt: number } | null;
    };
    // #1364 P1 — autoLockCandidate에 expiresAt 포함 (client TTL 동기화).
    expect(body.autoLockCandidate?.trainCode).toBe('T-1');
    expect(body.autoLockCandidate?.line).toBe('2');
    expect(body.autoLockCandidate?.subwayId).toBe('1002');
    expect(typeof body.autoLockCandidate?.expiresAt).toBe('number');
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

  // W1 (#1271, Epic #1204 그룹 2) — payload trainCode가 KV lock과 달라 swap 실제 적용된
  // cycle에서만 autoLockCandidate.from='transfer-swap' hint를 첨부한다. client는 hint를
  // 보고 motion gate(#1014 RC2 Gate 2)를 우회 — 환승 직후 이동 중 hydrate 차단 회귀 방지.
  describe('autoLockCandidate.from (W1 #1271 transfer-swap hint)', () => {
    it('payload trainCode가 KV와 달라 swap 발생 → from=transfer-swap 첨부', async () => {
      const env = makeKvEnv();
      await post('/trips', tripWithLock(), env);
      const res = await post(
        '/boarding-lock/sync',
        {
          token: 'tok-sync',
          observedStationName: '신촌',
          observedAtMs: 1,
          accuracy: 5,
          trainCode: 'T-NEW',
          boardingLine: '7',
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        autoLockCandidate: { trainCode: string; line: string; from?: string };
      };
      expect(body.autoLockCandidate.trainCode).toBe('T-NEW');
      expect(body.autoLockCandidate.from).toBe('transfer-swap');
    });

    it('payload trainCode가 KV와 같음 → from 미첨부 (no swap)', async () => {
      const env = makeKvEnv();
      await post('/trips', tripWithLock(), env);
      const res = await post(
        '/boarding-lock/sync',
        {
          token: 'tok-sync',
          observedStationName: '신촌',
          observedAtMs: 1,
          accuracy: 5,
          trainCode: 'T-1',
          boardingLine: '2',
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        autoLockCandidate: { trainCode: string; from?: string };
      };
      expect(body.autoLockCandidate.trainCode).toBe('T-1');
      expect(body.autoLockCandidate.from).toBeUndefined();
    });

    it('payload trainCode 미제공 → from 미첨부 (swap 비대상)', async () => {
      const env = makeKvEnv();
      await post('/trips', tripWithLock(), env);
      const res = await post(
        '/boarding-lock/sync',
        { token: 'tok-sync', observedStationName: '신촌', observedAtMs: 1, accuracy: 5 },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        autoLockCandidate: { from?: string };
      };
      expect(body.autoLockCandidate.from).toBeUndefined();
    });
  });

  // D4 (#1210) — payload trainCode가 KV lock과 다르면 KV lock 갱신 + consecutiveEtaMissing=0 reset.
  describe('trainCode swap (#1210)', () => {
    /**
     * 4 trip+payload 케이스 ($label) × 동일 assertion 셰이프(lock + counter)로 1 케이스 1 시나리오
     * 검증. payload 분기는 sync POST 직전에 spread로 추가.
     */
    it.each<{
      label: string;
      preCounter: number;
      payloadExtra: Record<string, unknown>;
      expectedTrainCode: string;
      expectedLine: string;
      expectedCounter: number;
    }>([
      {
        label: 'trainCode != KV → KV trainCode + line 갱신, counter reset',
        preCounter: 4,
        payloadExtra: { trainCode: 'T-7', boardingLine: '7' },
        expectedTrainCode: 'T-7',
        expectedLine: '7',
        expectedCounter: 0,
      },
      {
        label: 'trainCode == KV → no-op (lock + counter 보존)',
        preCounter: 2,
        payloadExtra: { trainCode: 'T-1', boardingLine: '2' },
        expectedTrainCode: 'T-1',
        expectedLine: '2',
        expectedCounter: 2,
      },
      {
        label: 'trainCode 누락 → KV lock + counter 그대로 (backward compat)',
        preCounter: 3,
        payloadExtra: {},
        expectedTrainCode: 'T-1',
        expectedLine: '2',
        expectedCounter: 3,
      },
      {
        label: 'boardingLine 누락 + trainCode만 변경 → 기존 line 유지',
        preCounter: 0,
        payloadExtra: { trainCode: 'T-NEW' },
        expectedTrainCode: 'T-NEW',
        expectedLine: '2',
        expectedCounter: 0,
      },
    ])(
      'lock 있는 trip — $label',
      async ({ preCounter, payloadExtra, expectedTrainCode, expectedLine, expectedCounter }) => {
        const env = makeKvEnv();
        const trip = validateTrip({ ...tripWithLock(), consecutiveEtaMissing: preCounter });
        await env.TRIPS.put('trip:tok-sync', JSON.stringify(trip));
        const res = await post(
          '/boarding-lock/sync',
          {
            token: 'tok-sync',
            observedStationName: '신촌',
            observedAtMs: 1,
            accuracy: 5,
            ...payloadExtra,
          },
          env,
        );
        expect(res.status).toBe(200);
        const stored = JSON.parse((await env.TRIPS.get('trip:tok-sync')) as string);
        expect(stored.boardingLock.trainCode).toBe(expectedTrainCode);
        expect(stored.boardingLock.line).toBe(expectedLine);
        expect(stored.consecutiveEtaMissing).toBe(expectedCounter);
      },
    );

    // lock 없는 trip은 setup 경로(POST /trips)가 다르고 expectation(boardingLock undefined)이
    // 별개라 it.each에 합치지 않고 단독 케이스로 둔다.
    it('lock 없는 trip + payload trainCode → no-op (lock 생성 안 함)', async () => {
      const env = makeKvEnv();
      const tripNoLock = tripWithLock();
      delete tripNoLock.boardingLock;
      await post('/trips', tripNoLock, env);
      await post(
        '/boarding-lock/sync',
        {
          token: 'tok-sync',
          observedStationName: '신촌',
          observedAtMs: 1,
          accuracy: 5,
          trainCode: 'T-1',
          boardingLine: '2',
        },
        env,
      );
      const stored = JSON.parse((await env.TRIPS.get('trip:tok-sync')) as string);
      expect(stored.boardingLock).toBeUndefined();
    });

    // #2021 (ADR-022) — archFlag='on' 시 handler 가 payload.boardingLine 을 무시하고 KV lock.line
    // 을 유지한다. trainCode / consecutiveEtaMissing 갱신은 유지 (환승 leg 자동 종료 차단 목적은 flag 무관).
    describe('#2021 archFlag boardingLine seal (ADR-022)', () => {
      it("archFlag='on' KV 세팅 상태 → payload.boardingLine='7' 무시, KV lock.line='2' 유지", async () => {
        const env = makeKvEnv();
        await env.TRIPS.put(ARCH_FLAG_KV_KEY, 'on');
        await post('/trips', tripWithLock(), env);
        const res = await post(
          '/boarding-lock/sync',
          {
            token: 'tok-sync',
            observedStationName: '신촌',
            observedAtMs: 1,
            accuracy: 5,
            trainCode: 'T-NEW',
            boardingLine: '7',
          },
          env,
        );
        expect(res.status).toBe(200);
        const stored = JSON.parse((await env.TRIPS.get('trip:tok-sync')) as string);
        expect(stored.boardingLock.trainCode).toBe('T-NEW');
        // 봉인 정책: 기존 line 유지.
        expect(stored.boardingLock.line).toBe('2');
      });

      it("archFlag='off' KV 세팅 상태 → 기존 동작 (payload.boardingLine='7' 반영)", async () => {
        const env = makeKvEnv();
        await env.TRIPS.put(ARCH_FLAG_KV_KEY, 'off');
        await post('/trips', tripWithLock(), env);
        const res = await post(
          '/boarding-lock/sync',
          {
            token: 'tok-sync',
            observedStationName: '신촌',
            observedAtMs: 1,
            accuracy: 5,
            trainCode: 'T-NEW',
            boardingLine: '7',
          },
          env,
        );
        expect(res.status).toBe(200);
        const stored = JSON.parse((await env.TRIPS.get('trip:tok-sync')) as string);
        expect(stored.boardingLock.line).toBe('7');
      });

      it('archFlag 미설정 → default(off) 로 fallback (기존 동작 유지)', async () => {
        const env = makeKvEnv();
        // KV 에 archFlag key 를 두지 않음 — getArchFlag 가 default 로 fallback.
        await post('/trips', tripWithLock(), env);
        const res = await post(
          '/boarding-lock/sync',
          {
            token: 'tok-sync',
            observedStationName: '신촌',
            observedAtMs: 1,
            accuracy: 5,
            trainCode: 'T-NEW',
            boardingLine: '7',
          },
          env,
        );
        expect(res.status).toBe(200);
        const stored = JSON.parse((await env.TRIPS.get('trip:tok-sync')) as string);
        expect(stored.boardingLock.line).toBe('7');
      });
    });
  });

  // #1364 — read-after-write verification + expiresAt response field.
  //
  // sync handler가 putTrip 후 cacheTtl=0으로 KV propagation을 확인한다. 정상 path는 1회로
  // 통과해야 하며, verification failure 경로는 verifyBoardingLockPersisted 단위 테스트로 커버.
  describe('read-after-write verification (#1364)', () => {
    it('정상 path → 200 + autoLockCandidate.expiresAt 노출', async () => {
      const env = makeKvEnv();
      await post('/trips', tripWithLock(), env);
      const res = await post(
        '/boarding-lock/sync',
        { token: 'tok-sync', observedStationName: '신촌', observedAtMs: 1, accuracy: 5 },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        autoLockCandidate: { expiresAt: number };
      };
      // refresh 후 expiresAt이 LOCK_TTL_REFRESH_MS 이상 미래 (P1 response sync).
      expect(body.autoLockCandidate.expiresAt).toBeGreaterThan(Date.now());
    });
  });
});

// #1364 — verifyBoardingLockPersisted 단위 테스트 (sync handler retry/5xx 게이트의 분기).
describe('verifyBoardingLockPersisted (#1364)', () => {
  function lockedTrip(expiresAt: number) {
    return {
      token: 'tok-v',
      route: { type: 'direct' as const, line: '2', stops: 3 },
      destination: 'dst',
      waypoints: [{ stationName: '강남', line: '2', kind: 'destination' as const }],
      expiresAt: Date.now() + 3600_000,
      createdAt: Date.now(),
      alarmAtEpochMs: Date.now() + 1800_000,
      boardingLock: {
        trainCode: 'T-1',
        line: '2',
        subwayId: '1002',
        selectedDepartureTime: 1,
        segmentStations: ['강남'],
        expiresAt,
      },
    };
  }

  it('KV에 동일 expiresAt 저장됨 → true', async () => {
    const kv = new InMemoryKV();
    const trip = lockedTrip(Date.now() + 60_000);
    await kv.put('trip:tok-v', JSON.stringify(trip));
    expect(await verifyBoardingLockPersisted(kv as unknown as KVNamespace, trip)).toBe(true);
  });

  it('KV의 expiresAt이 expected보다 작음(stale) → false', async () => {
    const kv = new InMemoryKV();
    const expected = lockedTrip(Date.now() + 120_000);
    const stale = lockedTrip(Date.now() + 30_000);
    await kv.put('trip:tok-v', JSON.stringify(stale));
    expect(await verifyBoardingLockPersisted(kv as unknown as KVNamespace, expected)).toBe(false);
  });

  it('KV에 trip 자체가 없음 → false', async () => {
    const kv = new InMemoryKV();
    const expected = lockedTrip(Date.now() + 60_000);
    expect(await verifyBoardingLockPersisted(kv as unknown as KVNamespace, expected)).toBe(false);
  });

  it('expected가 lock 없는 trip → KV에 trip만 있으면 true (lock 검증 생략)', async () => {
    const kv = new InMemoryKV();
    const expected = lockedTrip(Date.now() + 60_000);
    delete (expected as { boardingLock?: unknown }).boardingLock;
    await kv.put('trip:tok-v', JSON.stringify(expected));
    expect(await verifyBoardingLockPersisted(kv as unknown as KVNamespace, expected)).toBe(true);
  });

  it('expected는 lock 있는데 KV trip은 lock 없음 → false', async () => {
    const kv = new InMemoryKV();
    const expected = lockedTrip(Date.now() + 60_000);
    const noLock = { ...expected, boardingLock: undefined };
    await kv.put('trip:tok-v', JSON.stringify(noLock));
    expect(await verifyBoardingLockPersisted(kv as unknown as KVNamespace, expected)).toBe(false);
  });

  it('verify는 cacheTtl=KV_MIN_CACHE_TTL_SEC(30)으로 read (#1423: cacheTtl<30은 CF KV가 400 throw)', async () => {
    const kv = new InMemoryKV();
    const trip = lockedTrip(Date.now() + 60_000);
    await kv.put('trip:tok-v', JSON.stringify(trip));
    const spy = vi.spyOn(kv, 'get');
    await verifyBoardingLockPersisted(kv as unknown as KVNamespace, trip);
    // #1423 회귀 가드 — 0/<30 절대 금지. 30은 KV 런타임 floor.
    expect(spy).toHaveBeenCalledWith('trip:tok-v', { cacheTtl: KV_MIN_CACHE_TTL_SEC });
  });

  // #1423 — sync handler 통합 회귀 가드. 본 helper가 cacheTtl<30을 받으면 InMemoryKV가
  // production CF KV와 동일하게 `Invalid cache_ttl` throw → 본 PR 이전엔 mock이 silently
  // 통과해 회귀가 production으로 빠져나갔다.
  it('mock InMemoryKV가 cacheTtl<30 throw 시뮬레이션 (lesson_test_mock_must_validate_runtime)', async () => {
    const kv = new InMemoryKV();
    await kv.put('trip:t', '{}');
    await expect(kv.get('trip:t', { cacheTtl: 0 })).rejects.toThrow(/Invalid cache_ttl of 0/);
    await expect(kv.get('trip:t', { cacheTtl: 15 })).rejects.toThrow(/Cache TTL must be at least 30/);
    await expect(kv.get('trip:t', { cacheTtl: 29 })).rejects.toThrow(/Invalid cache_ttl of 29/);
    // boundary + safe
    await expect(kv.get('trip:t', { cacheTtl: 30 })).resolves.toBe('{}');
    await expect(kv.get('trip:t', { cacheTtl: 60 })).resolves.toBe('{}');
    await expect(kv.get('trip:t')).resolves.toBe('{}');
  });
});

// #1364 — sync verification failure → 503 + retry path.
// stale snapshot을 반환하는 fake KV로 verification 분기 검증.
describe('POST /boarding-lock/sync verification failure (#1364)', () => {
  it('putTrip이 전부 drop돼 stale snapshot 반환 → 1회 retry 후 503', async () => {
    const inner = new InMemoryKV();
    // 초기 trip을 직접 KV에 적재 (POST /trips 우회) — lock TTL refresh 전 값으로 두어
    // sync handler가 expiresAt을 갱신하려 putTrip 시도 → wrapper put이 drop → verification 실패.
    const initial = {
      token: 'tok-503',
      route: { type: 'direct' as const, line: '2', stops: 3 },
      destination: 'dst',
      waypoints: [
        { stationName: '강남', line: '2', kind: 'intermediate' as const },
        { stationName: '역삼', line: '2', kind: 'destination' as const },
      ],
      expiresAt: FUTURE,
      alarmAtEpochMs: FUTURE - 30 * 60 * 1000,
      boardingLock: {
        trainCode: 'T-1',
        line: '2',
        subwayId: '1002',
        selectedDepartureTime: 1,
        segmentStations: ['강남', '역삼'],
        // 짧은 expiresAt — sync가 LOCK_TTL_REFRESH_MS로 연장하려 한다.
        expiresAt: Date.now() + 60_000,
      },
    };
    await inner.put('trip:tok-503', JSON.stringify(initial));

    // Wrapper: get/list만 inner로 위임, put은 silently drop. retry까지 모두 실패하게 한다.
    const putCalls: number[] = [];
    const kv = {
      get: (key: string, opts?: { cacheTtl?: number }) => inner.get(key, opts),
      put: () => {
        putCalls.push(1);
        return Promise.resolve();
      },
      delete: (key: string) => inner.delete(key),
      list: (opts?: { prefix?: string; cursor?: string }) => inner.list(opts),
    };
    const env = makeEnv({ TRIPS: kv as unknown as Env['TRIPS'] });

    const res = await post(
      '/boarding-lock/sync',
      { token: 'tok-503', observedStationName: '강남', observedAtMs: 1, accuracy: 5 },
      env,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('sync-verification-failed');
    // retry로 putTrip이 두 번(원래 + retry) 호출됐어야 함.
    expect(putCalls.length).toBeGreaterThanOrEqual(2);
  });
});

// D4 (#1210) — applyBoardingLockTrainCodeSwap 순수 함수 단위 테스트.
//
// outer scope에 fixture builder 둠 — describe 내부 nested function 선언은 SonarCloud의
// CODE_SMELL (typescript:S6535/S2392 family) 으로 잡힌다. 모든 케이스가 같은 fixture를 쓰므로
// outer 헬퍼로 hoist.
function buildD4SwapBaseTrip() {
  const trip = validateTrip({
    token: 'tok',
    route: { type: 'direct', line: '2', stops: 3 },
    destination: 'dst',
    waypoints: [{ stationName: '강남', line: '2', kind: 'intermediate' }],
    expiresAt: FUTURE,
    alarmAtEpochMs: FUTURE - 60_000,
    boardingLock: {
      trainCode: 'T-OLD',
      line: '2',
      subwayId: '1002',
      selectedDepartureTime: 1,
      segmentStations: ['강남'],
      expiresAt: FUTURE,
    },
    consecutiveEtaMissing: 4,
  });
  if (!trip) throw new Error('buildD4SwapBaseTrip fixture failed validateTrip');
  return trip;
}

function buildD4SwapPayload(
  over: Partial<Parameters<typeof applyBoardingLockTrainCodeSwap>[1]> = {},
) {
  return {
    token: 'tok',
    observedStationName: '강남',
    observedAtMs: 1,
    accuracy: 5,
    ...over,
  };
}

describe('applyBoardingLockTrainCodeSwap (#1210)', () => {
  it('trainCode 미제공 → 동일 trip 그대로 반환', () => {
    const trip = buildD4SwapBaseTrip();
    const result = applyBoardingLockTrainCodeSwap(trip, buildD4SwapPayload());
    expect(result).toBe(trip);
  });

  it('lock 없는 trip → 동일 trip 그대로 반환', () => {
    const trip = { ...buildD4SwapBaseTrip(), boardingLock: undefined };
    const result = applyBoardingLockTrainCodeSwap(
      trip,
      buildD4SwapPayload({ trainCode: 'T-NEW' }),
    );
    expect(result).toBe(trip);
  });

  it('trainCode 동일 → 동일 trip 그대로 반환', () => {
    const trip = buildD4SwapBaseTrip();
    const result = applyBoardingLockTrainCodeSwap(
      trip,
      buildD4SwapPayload({ trainCode: 'T-OLD' }),
    );
    expect(result).toBe(trip);
  });

  it('trainCode 변경 → lock.trainCode + line 갱신 + counter reset', () => {
    const trip = buildD4SwapBaseTrip();
    const result = applyBoardingLockTrainCodeSwap(
      trip,
      buildD4SwapPayload({ trainCode: 'T-NEW', boardingLine: '7' }),
    );
    expect(result.boardingLock?.trainCode).toBe('T-NEW');
    expect(result.boardingLock?.line).toBe('7');
    expect(result.consecutiveEtaMissing).toBe(0);
    // 다른 필드는 보존.
    expect(result.boardingLock?.subwayId).toBe('1002');
    expect(result.boardingLock?.segmentStations).toEqual(['강남']);
  });

  it('trainCode 변경 + line 누락 → 기존 line 유지', () => {
    const trip = buildD4SwapBaseTrip();
    const result = applyBoardingLockTrainCodeSwap(
      trip,
      buildD4SwapPayload({ trainCode: 'T-NEW' }),
    );
    expect(result.boardingLock?.line).toBe('2');
  });

  // #2021 (ADR-022) — archFlag='on' 시 payload.boardingLine 무시, 기존 lock.line 유지.
  // trainCode swap 자체는 flag 무관 유지 (환승 leg 자동 종료 차단은 공통 정책).
  it("#2021 archFlag='on' → payload.boardingLine 무시, lock.line 유지 (trainCode/counter 는 갱신)", () => {
    const trip = buildD4SwapBaseTrip();
    const result = applyBoardingLockTrainCodeSwap(
      trip,
      buildD4SwapPayload({ trainCode: 'T-NEW', boardingLine: '7' }),
      'on',
    );
    // trainCode 및 counter reset 은 유지 — 환승 leg 자동 종료 차단 목적은 flag 무관.
    expect(result.boardingLock?.trainCode).toBe('T-NEW');
    expect(result.consecutiveEtaMissing).toBe(0);
    // line 은 device 가 sync 로 보낸 '7' 을 무시하고 기존 '2' 유지 — 봉인 정책.
    expect(result.boardingLock?.line).toBe('2');
  });

  it("#2021 archFlag='off' → 기존 D4 동작 (payload.boardingLine 반영)", () => {
    const trip = buildD4SwapBaseTrip();
    const result = applyBoardingLockTrainCodeSwap(
      trip,
      buildD4SwapPayload({ trainCode: 'T-NEW', boardingLine: '7' }),
      'off',
    );
    expect(result.boardingLock?.trainCode).toBe('T-NEW');
    expect(result.boardingLock?.line).toBe('7');
  });

  it("#2021 archFlag='on' + boardingLine 미제공 → 기존 lock.line 유지 (no-op 동등)", () => {
    const trip = buildD4SwapBaseTrip();
    const result = applyBoardingLockTrainCodeSwap(
      trip,
      buildD4SwapPayload({ trainCode: 'T-NEW' }),
      'on',
    );
    expect(result.boardingLock?.line).toBe('2');
  });
});

/**
 * #1241 — 사용자 trip 2026-06-12 회귀 가드
 *
 * Evidence SSOT: tasks/epic-lockless-recovery-2026-06-12.md §1~§2
 *   - 보고 #5 (08:43 trip BG 강제 종료, 환승 leg trainCode 추적 상실)
 *   - 보고 #10 (오후 trip에서 동일 재발)
 *   - 디바이스 로그: `boarding-lock auto-ended (consecutiveEtaMissing=5)`
 *
 * 기대 동작: 환승 leg에서 새 trainCode가 도착하면 `applyBoardingLockTrainCodeSwap`이
 *   1) boardingLock.trainCode를 신규로 갱신
 *   2) consecutiveEtaMissing을 0으로 리셋
 * → 5회 누적으로 인한 auto-end가 발생하지 않아야 한다.
 *
 * 본 describe는 D4 (#1210, PR #1218) 함수가 향후 회귀로 풀리지 않도록 박제한다.
 * 위 describe('applyBoardingLockTrainCodeSwap (#1210)') 매트릭스가 기능 검증을 담당하고
 * 본 describe는 사용자 보고와 1:1로 묶는다.
 */
describe('사용자 trip 2026-06-12 회귀 가드 (#1241)', () => {
  it('보고 #5/#10 — 신규 trainCode 도착 시 consecutiveEtaMissing이 0으로 리셋되어 auto-end 방지', () => {
    const trip = buildD4SwapBaseTrip();
    expect(trip.consecutiveEtaMissing).toBeGreaterThan(0);
    const result = applyBoardingLockTrainCodeSwap(
      trip,
      buildD4SwapPayload({ trainCode: 'T-NEW', boardingLine: '7' }),
    );
    expect(result.boardingLock?.trainCode).toBe('T-NEW');
    expect(result.consecutiveEtaMissing).toBe(0);
  });
});

describe('POST /telemetry/regression (#1261)', () => {
  const validBody = {
    token: 'aabbccdd11223344',
    since: 0,
    until: 1000,
    counts: { '8': 1, '10': 2 },
  };

  it('returns 400 on invalid JSON', async () => {
    const env = makeKvEnv();
    const res = await post('/telemetry/regression', 'not-json{', env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
  });

  it('returns 400 on invalid payload', async () => {
    const env = makeKvEnv();
    const res = await post('/telemetry/regression', { token: '' }, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_payload' });
  });

  it('writes counts to KV when payload valid', async () => {
    const env = makeKvEnv();
    const res = await post('/telemetry/regression', validBody, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const kv = env.TRIPS as unknown as InMemoryKV;
    const dayKeys = [...kv.store.keys()].filter((k) => k.startsWith('regression:day:'));
    expect(dayKeys.length).toBeGreaterThan(0);
  });

  it('also writes datapoints to TELEMETRY binding when present', async () => {
    const writer: AnalyticsEngineWriter = { writeDataPoint: vi.fn() };
    const env = makeEnv({
      TRIPS: new InMemoryKV() as unknown as Env['TRIPS'],
      TELEMETRY: writer,
    });
    const res = await post('/telemetry/regression', validBody, env);
    expect(res.status).toBe(200);
    expect(writer.writeDataPoint).toHaveBeenCalled();
  });
});

describe('GET /admin/telemetry/regressions (#1261)', () => {
  async function getRegressions(env: Env, authHeader?: string): Promise<Response> {
    return app.fetch(
      new Request('http://example.com/admin/telemetry/regressions', {
        headers: authHeader ? { authorization: authHeader } : undefined,
      }),
      env,
    );
  }

  function makeAuthEnv(): Env {
    return makeEnv({ TRIPS: new InMemoryKV() as unknown as Env['TRIPS'], ADMIN_TOKEN: 'secret' });
  }

  it('returns 503 when ADMIN_TOKEN not configured', async () => {
    const env = makeKvEnv();
    const res = await getRegressions(env, 'Bearer x');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'admin_unavailable' });
  });

  it('returns 401 without bearer header', async () => {
    const env = makeAuthEnv();
    const res = await getRegressions(env);
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong token', async () => {
    const env = makeAuthEnv();
    const res = await getRegressions(env, 'Bearer wrong');
    expect(res.status).toBe(401);
  });

  it('returns all known ids with zero windows when KV empty (authorized)', async () => {
    const env = makeAuthEnv();
    const res = await getRegressions(env, 'Bearer secret');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ids: string[];
      counts: Record<string, { last5m: number; lastHour: number; today: number; last7d: number }>;
    };
    expect(body.ids).toEqual(['8', '10', '11', '12']);
    for (const id of body.ids) {
      expect(body.counts[id]).toEqual({ last5m: 0, lastHour: 0, today: 0, last7d: 0 });
    }
  });

  it('reflects counters previously written via POST', async () => {
    const env = makeAuthEnv();
    await post(
      '/telemetry/regression',
      {
        token: 'aabbccdd11223344',
        since: 0,
        until: 1,
        counts: { '8': 3 },
      },
      env,
    );
    const res = await getRegressions(env, 'Bearer secret');
    const body = (await res.json()) as {
      counts: Record<string, { last5m: number; today: number }>;
    };
    expect(body.counts['8'].last5m).toBe(3);
    expect(body.counts['8'].today).toBe(3);
  });
});

describe('GET /trips/:tripToken/status (#1339 launch reconciliation)', () => {
  async function getStatus(env: Env, token: string): Promise<Response> {
    return app.fetch(
      new Request(`http://example.com/trips/${token}/status`, { method: 'GET' }),
      env,
    );
  }

  it('returns active when the trip exists in KV', async () => {
    const env = makeKvEnv();
    const res = await post('/trips', base(), env);
    expect(res.status).toBe(200);

    const got = await getStatus(env, 'tok');
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({
      tripToken: 'tok',
      status: 'active',
      endedAt: null,
      endReason: null,
    });
  });

  it('returns ended with endedAt + endReason when a recent status marker exists', async () => {
    const env = makeKvEnv();
    const kv = env.TRIPS as unknown as InMemoryKV;
    const endedAt = Date.now() - 5_000;
    kv.store.set('tripStatus:abc', {
      value: JSON.stringify({ endedAt, endReason: 'destination' }),
    });

    const res = await getStatus(env, 'abc');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tripToken: 'abc',
      status: 'ended',
      endedAt,
      endReason: 'destination',
    });
  });

  it('returns 404 when neither the trip nor a status marker exists', async () => {
    const env = makeKvEnv();
    const res = await getStatus(env, 'missing');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'trip_not_found' });
  });

  it('returns 410 expired-retention when the marker is older than the retention window', async () => {
    const env = makeKvEnv();
    const kv = env.TRIPS as unknown as InMemoryKV;
    const endedAt = Date.now() - 60 * 60 * 1000 - 1_000; // > 1h
    kv.store.set('tripStatus:old', {
      value: JSON.stringify({ endedAt, endReason: 'expired' }),
    });

    const res = await getStatus(env, 'old');
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({
      tripToken: 'old',
      status: 'expired-retention',
    });
  });

  it('emits only the documented response fields', async () => {
    const env = makeKvEnv();
    await post('/trips', base(), env);
    const got = await getStatus(env, 'tok');
    const body = (await got.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort((a, b) => a.localeCompare(b))).toEqual([
      'endedAt',
      'endReason',
      'status',
      'tripToken',
    ]);
  });
});

// #1366 Layer 3 — POST /trips boardingLock metadata cross-validation.
// Frontend가 환승 hop 진입 시 race로 trainCode/line(새 leg) + segmentStations(이전 leg)
// stale 결합으로 전송하면 cron "trainCode not found" → consecutiveEtaMissing → trip auto-end.
// waypoint와 (line, stationName) 일치를 검사해 불일치하면 boardingLock 필드만 drop, trip 본체는 살린다.
describe('POST /trips — #1366 boardingLock metadata cross-validation', () => {
  const CREATED = 1_700_000_000_000;

  function bodyWithLock(
    lock: Record<string, unknown>,
    waypoints: Array<Record<string, unknown>>,
  ): Record<string, unknown> {
    return {
      ...base(),
      token: 'tok-1366',
      createdAt: CREATED,
      waypoints,
      boardingLock: {
        trainCode: 'TC',
        line: '2',
        subwayId: '1002',
        selectedDepartureTime: CREATED,
        segmentStations: ['건대입구', '성수'],
        expiresAt: FUTURE,
        ...lock,
      },
    };
  }

  it('keeps boardingLock when first segment matches a waypoint (line + stationName)', async () => {
    const env = makeKvEnv();
    await post(
      '/trips',
      bodyWithLock(
        {},
        [
          { stationName: '건대입구', line: '2', kind: 'intermediate' },
          { stationName: '성수', line: '2', kind: 'destination' },
        ],
      ),
      env,
    );
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-1366')) as string);
    expect(stored.boardingLock?.trainCode).toBe('TC');
  });

  it('drops boardingLock when lock.line mismatches the waypoint at segmentStations[0]', async () => {
    const env = makeKvEnv();
    // lock.line='2' + segmentStations[0]='건대입구', waypoint 건대입구는 7호선 → 불일치
    await post(
      '/trips',
      bodyWithLock(
        { line: '2' },
        [
          { stationName: '건대입구', line: '7', kind: 'intermediate' },
          { stationName: '뚝섬유원지', line: '7', kind: 'destination' },
        ],
      ),
      env,
    );
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-1366')) as string);
    expect(stored.boardingLock).toBeUndefined();
    // trip 본체는 살아 있어야 한다 — backend는 anchor 폴링으로 fallback
    expect(stored.token).toBe('tok-1366');
    expect(stored.waypoints).toHaveLength(2);
  });

  it('drops boardingLock when lock.line is absent from every waypoint (stale leg)', async () => {
    const env = makeKvEnv();
    // lock.line='7' but all waypoints are line='2' — frontend race(7→2 환승) 시뮬레이션
    await post(
      '/trips',
      bodyWithLock(
        { line: '7', segmentStations: ['용마산', '중곡'] },
        [
          { stationName: '강남', line: '2', kind: 'intermediate' },
          { stationName: '잠실', line: '2', kind: 'destination' },
        ],
      ),
      env,
    );
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-1366')) as string);
    expect(stored.boardingLock).toBeUndefined();
    expect(stored.token).toBe('tok-1366');
  });

  it('isBoardingLockConsistentWithWaypoints — direct helper coverage', async () => {
    const { isBoardingLockConsistentWithWaypoints } = await import('../index');
    // line 일치하는 waypoint가 있으면 통과
    expect(
      isBoardingLockConsistentWithWaypoints(
        {
          trainCode: 'X',
          line: '2',
          subwayId: '1002',
          selectedDepartureTime: 0,
          segmentStations: ['건대입구', '성수'],
          expiresAt: FUTURE,
        },
        [
          { stationName: '건대입구', line: '2', kind: 'intermediate' },
          { stationName: '성수', line: '2', kind: 'destination' },
        ],
      ),
    ).toBe(true);
    // line이 어떤 waypoint와도 일치 X — stale 판정
    expect(
      isBoardingLockConsistentWithWaypoints(
        {
          trainCode: 'X',
          line: '2',
          subwayId: '1002',
          selectedDepartureTime: 0,
          segmentStations: ['건대입구'],
          expiresAt: FUTURE,
        },
        [{ stationName: '건대입구', line: '7', kind: 'destination' }],
      ),
    ).toBe(false);
    // 환승 경로 — fromLine waypoint(transfer)와 lock.line 일치하면 통과 (segmentStations[0]은
    // waypoint에 직접 등장하지 않아도 OK)
    expect(
      isBoardingLockConsistentWithWaypoints(
        {
          trainCode: 'X',
          line: '7',
          subwayId: '1007',
          selectedDepartureTime: 0,
          segmentStations: ['용마산', '중곡', '군자'],
          expiresAt: FUTURE,
        },
        [
          { stationName: '건대입구', line: '7', kind: 'transfer' },
          { stationName: '성수', line: '2', kind: 'destination' },
        ],
      ),
    ).toBe(true);
  });
});

// #1604 — POST /trips backend Dijkstra route infer.
// route 미설정 trip(legacy collapse: waypoints=[destination only])이 도착하면 backend가
// `promptDisplay`(originStation + line) + `destination`(station id)로 Dijkstra 자동 추론.
// device의 정상 `routeToWaypoints` 시퀀스와 동형으로 채워, 다음 cron 사이클부터 정상 매역 추적.
const COLLAPSE_PROMPT_GEO_1604 = {
  origin: { lat: 37.573647, lng: 127.092833 }, // 용마산
  nextStation: { lat: 37.561446, lng: 127.082888 }, // 중곡 근사
  direction: null as 'up' | 'down' | null,
};

function collapseBody1604(
  waypoints: Array<Record<string, unknown>>,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...base(),
    token: 'tok-1604',
    waypoints,
    ...extras,
  };
}

describe('POST /trips — #1604 backend Dijkstra route infer', () => {

  it('infers waypoints when waypoints=[destination only] + promptDisplay 제공 (직선 trip)', async () => {
    const env = makeKvEnv();
    await post(
      '/trips',
      collapseBody1604(
        // 용마산 → 어린이대공원(세종대), 동일 7호선 → Dijkstra가 직선 추론.
        [{ stationName: '어린이대공원(세종대)', line: '7', kind: 'destination' }],
        {
          destination: '7-018',
          route: { type: 'direct', line: '7', stops: 3 },
          promptDisplay: { originStation: '용마산', line: '7' },
          promptGeoContext: COLLAPSE_PROMPT_GEO_1604,
        },
      ),
      env,
    );
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-1604')) as string);
    // 1 waypoint → 3+ waypoints (intermediates + destination).
    expect(stored.waypoints.length).toBeGreaterThanOrEqual(2);
    const last = stored.waypoints[stored.waypoints.length - 1];
    expect(last.kind).toBe('destination');
    expect(last.stationName).toBe('어린이대공원(세종대)');
    expect(last.line).toBe('7');
    // 모든 intermediate은 7호선
    for (let i = 0; i < stored.waypoints.length - 1; i += 1) {
      expect(stored.waypoints[i].kind).toBe('intermediate');
      expect(stored.waypoints[i].line).toBe('7');
    }
    // hopIndex/occurrenceIdx stamp 검증
    expect(stored.waypoints[0].hopIndex).toBe(0);
    expect(stored.waypoints[stored.waypoints.length - 1].hopIndex).toBe(
      stored.waypoints.length - 1,
    );
  });

  it('infers waypoints for 환승 1회 trip (7호선 용마산 → 2호선 성수)', async () => {
    const env = makeKvEnv();
    await post(
      '/trips',
      collapseBody1604(
        [{ stationName: '성수', line: '2', kind: 'destination' }],
        {
          destination: '2-011',
          route: { type: 'direct', line: '2', stops: 1 },
          promptDisplay: { originStation: '용마산', line: '7' },
          promptGeoContext: COLLAPSE_PROMPT_GEO_1604,
        },
      ),
      env,
    );
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-1604')) as string);
    const transferCount = stored.waypoints.filter(
      (w: { kind: string }) => w.kind === 'transfer',
    ).length;
    const destinationCount = stored.waypoints.filter(
      (w: { kind: string }) => w.kind === 'destination',
    ).length;
    expect(transferCount).toBe(1);
    expect(destinationCount).toBe(1);
    const last = stored.waypoints[stored.waypoints.length - 1];
    expect(last.stationName).toBe('성수');
    expect(last.line).toBe('2');
  });

  it('infers waypoints for 환승 2회+ trip (1호선 신도림 → 7호선 어린이대공원)', async () => {
    const env = makeKvEnv();
    await post(
      '/trips',
      collapseBody1604(
        [{ stationName: '어린이대공원(세종대)', line: '7', kind: 'destination' }],
        {
          destination: '7-018',
          route: { type: 'direct', line: '7', stops: 1 },
          promptDisplay: { originStation: '신도림', line: '1' },
          promptGeoContext: COLLAPSE_PROMPT_GEO_1604,
        },
      ),
      env,
    );
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-1604')) as string);
    expect(
      stored.waypoints.filter((w: { kind: string }) => w.kind === 'transfer').length,
    ).toBeGreaterThanOrEqual(1);
    const last = stored.waypoints[stored.waypoints.length - 1];
    expect(last.stationName).toBe('어린이대공원(세종대)');
  });

  it('같은 노선 양방향 — direction 검증 (어린이대공원 → 용마산)', async () => {
    const env = makeKvEnv();
    await post(
      '/trips',
      collapseBody1604(
        [{ stationName: '용마산', line: '7', kind: 'destination' }],
        {
          destination: '7-015',
          route: { type: 'direct', line: '7', stops: 3 },
          promptDisplay: { originStation: '어린이대공원(세종대)', line: '7' },
          promptGeoContext: COLLAPSE_PROMPT_GEO_1604,
        },
      ),
      env,
    );
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-1604')) as string);
    expect(stored.waypoints.length).toBeGreaterThanOrEqual(2);
    const last = stored.waypoints[stored.waypoints.length - 1];
    expect(last.stationName).toBe('용마산');
    expect(last.line).toBe('7');
  });

  it('promptDisplay 부재 → infer skip, incoming 그대로 보존 (backward-compat)', async () => {
    const env = makeKvEnv();
    await post(
      '/trips',
      collapseBody1604([{ stationName: '강남', line: '2', kind: 'destination' }]),
      env,
    );
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-1604')) as string);
    // promptDisplay 없으면 infer 안 함 — incoming 그대로 1 waypoint.
    expect(stored.waypoints.length).toBe(1);
    expect(stored.waypoints[0].stationName).toBe('강남');
  });

  it('이미 채워진 waypoints는 infer 건너뛰기 (정상 trip은 변경 X)', async () => {
    const env = makeKvEnv();
    await post(
      '/trips',
      collapseBody1604(
        [
          { stationName: '강변', line: '2', kind: 'intermediate' },
          { stationName: '잠실', line: '2', kind: 'destination' },
        ],
        {
          destination: '2-216',
          promptDisplay: { originStation: '신도림', line: '2' },
          promptGeoContext: COLLAPSE_PROMPT_GEO_1604,
        },
      ),
      env,
    );
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-1604')) as string);
    expect(stored.waypoints.length).toBe(2);
    expect(stored.waypoints[0].stationName).toBe('강변');
    expect(stored.waypoints[1].stationName).toBe('잠실');
  });

  it('origin 미해소 (잘못된 역명) → infer skip, incoming 그대로 보존', async () => {
    const env = makeKvEnv();
    await post(
      '/trips',
      collapseBody1604(
        [{ stationName: '강남', line: '2', kind: 'destination' }],
        {
          destination: '2-022',
          promptDisplay: { originStation: '존재안함역', line: '2' },
          promptGeoContext: COLLAPSE_PROMPT_GEO_1604,
        },
      ),
      env,
    );
    const stored = JSON.parse((await env.TRIPS.get('trip:tok-1604')) as string);
    expect(stored.waypoints.length).toBe(1);
    expect(stored.waypoints[0].stationName).toBe('강남');
  });
});

// #1425 — POST /trips trip-ended retention 안 같은 token 재등록 차단.
// silent push `trip-ended:eta-missing` 후 device 자동 재시도/재하이드레이션이 backend에 도달하면
// 기존 코드는 `getTrip()`만 확인(=null, 이미 삭제됨)하고 무조건 새 trip을 만들어 → backend
// auto-revive → dedup state reset → false fire 회귀. retention(1h) 안에서는 race로 간주하고 reject.
describe('POST /trips — #1425 trip-recently-ended reject', () => {
  function seedTripEnded(
    env: Env,
    token: string,
    endedAt: number,
    endReason: 'expired' | 'eta-missing' | 'seoul-outage' | 'destination' | 'push-unrecoverable' = 'eta-missing',
  ): void {
    const kv = env.TRIPS as unknown as InMemoryKV;
    kv.store.set(`tripStatus:${token}`, {
      value: JSON.stringify({ endedAt, endReason }),
    });
  }

  it('rejects re-register with 400 + body when same token is recently ended (within retention)', async () => {
    const env = makeKvEnv();
    seedTripEnded(env, 'tok', Date.now() - 5_000, 'eta-missing');

    const res = await post('/trips', base(), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'trip-recently-ended',
      reason: 'eta-missing',
    });
  });

  it('does not create the trip KV entry when rejected', async () => {
    const env = makeKvEnv();
    seedTripEnded(env, 'tok', Date.now() - 5_000, 'eta-missing');

    await post('/trips', base(), env);
    // trip:<token> KV는 작성되지 않아야 한다 — auto-revive 차단.
    expect(await env.TRIPS.get('trip:tok')).toBeNull();
  });

  it('accepts re-register when retention window has elapsed (> 1h)', async () => {
    const env = makeKvEnv();
    // 1h 1s 전에 종료된 마커 — retention 윈도우 밖이므로 정상 등록.
    seedTripEnded(env, 'tok', Date.now() - (60 * 60 * 1000 + 1_000), 'eta-missing');

    const res = await post('/trips', base(), env);
    expect(res.status).toBe(200);
    // #1897 (RC-5) — 응답에 confirmedEnv echo. base()는 apnsEnv 미설정이라 sandbox fallback.
    expect(await res.json()).toEqual({ ok: true, token: 'tok', confirmedEnv: 'sandbox' });
    expect(await env.TRIPS.get('trip:tok')).not.toBeNull();
  });

  it('accepts re-register when no trip-ended marker exists (default behavior preserved)', async () => {
    const env = makeKvEnv();
    const res = await post('/trips', base(), env);
    expect(res.status).toBe(200);
    expect(await env.TRIPS.get('trip:tok')).not.toBeNull();
  });

  it('does not affect a different token when one token is recently ended', async () => {
    const env = makeKvEnv();
    seedTripEnded(env, 'ended-token', Date.now() - 5_000, 'destination');

    // 다른 token으로 등록 → 정상 처리되어야 함 (token 단위 격리).
    const res = await post('/trips', { ...base(), token: 'fresh-token' }, env);
    expect(res.status).toBe(200);
    expect(await env.TRIPS.get('trip:fresh-token')).not.toBeNull();
  });

  // #1663 — Seoul outage cooldown bypass
  it('bypasses cooldown and accepts re-register when endReason is seoul-outage (within retention)', async () => {
    const env = makeKvEnv();
    // trip ended 5s ago due to Seoul outage (still within 1h retention)
    seedTripEnded(env, 'tok', Date.now() - 5_000, 'seoul-outage');

    const res = await post('/trips', base(), env);
    expect(res.status).toBe(200);
    // #1897 (RC-5) — 응답에 confirmedEnv echo. base()는 apnsEnv 미설정이라 sandbox fallback.
    expect(await res.json()).toEqual({ ok: true, token: 'tok', confirmedEnv: 'sandbox' });
    expect(await env.TRIPS.get('trip:tok')).not.toBeNull();
  });

  it('still rejects eta-missing within retention (non-outage cooldown preserved)', async () => {
    const env = makeKvEnv();
    seedTripEnded(env, 'tok', Date.now() - 5_000, 'eta-missing');

    const res = await post('/trips', base(), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'trip-recently-ended' });
  });

  // #2144 — register 성공 후 같은 token의 stale tripStatus 종료 마커 정리.
  describe('#2144 — stale tripStatus cleanup on successful register', () => {
    it('clears tripStatus after seoul-outage cooldown bypass succeeds (retention 윈도우 밖 진입 없이도 즉시 정리)', async () => {
      const env = makeKvEnv();
      seedTripEnded(env, 'tok', Date.now() - 5_000, 'seoul-outage');

      const res = await post('/trips', base(), env);
      expect(res.status).toBe(200);
      expect(await env.TRIPS.get('tripStatus:tok')).toBeNull();
    });

    it('clears tripStatus when retention window has elapsed and re-register succeeds', async () => {
      const env = makeKvEnv();
      seedTripEnded(env, 'tok', Date.now() - (60 * 60 * 1000 + 1_000), 'eta-missing');

      const res = await post('/trips', base(), env);
      expect(res.status).toBe(200);
      expect(await env.TRIPS.get('tripStatus:tok')).toBeNull();
    });

    it('does not touch a different token tripStatus when unrelated token registers', async () => {
      const env = makeKvEnv();
      seedTripEnded(env, 'ended-token', Date.now() - 5_000, 'destination');

      const res = await post('/trips', { ...base(), token: 'fresh-token' }, env);
      expect(res.status).toBe(200);
      // 무관한 token의 종료 마커는 그대로 보존돼야 한다.
      expect(await env.TRIPS.get('tripStatus:ended-token')).not.toBeNull();
    });

    it('is a no-op (no crash) when no tripStatus marker exists for the token', async () => {
      const env = makeKvEnv();
      const res = await post('/trips', base(), env);
      expect(res.status).toBe(200);
      expect(await env.TRIPS.get('tripStatus:tok')).toBeNull();
    });

    it('still rejects (cooldown preserved) before any cleanup runs — no delete attempted on reject path', async () => {
      const env = makeKvEnv();
      seedTripEnded(env, 'tok', Date.now() - 5_000, 'eta-missing');

      const res = await post('/trips', base(), env);
      expect(res.status).toBe(400);
      // reject 경로에서는 cooldown 판정 유지가 우선 — 마커가 그대로 남아 재시도 시에도 reject된다.
      expect(await env.TRIPS.get('tripStatus:tok')).not.toBeNull();
    });
  });
});

// #1897 (RC-5) — POST /trips 응답 confirmedEnv echo.
// device 가 응답 confirmedEnv 를 stamp 해 다음 register POST 부터는 build env 대신 송신 →
// backend self-heal(envCorrected) 발동 0 수렴.
describe('POST /trips — #1897 confirmedEnv echo (RC-5)', () => {
  it.each(['sandbox', 'production'] as const)(
    'first register: incoming.apnsEnv=%s → 응답 confirmedEnv 동일 echo',
    async (env) => {
      const kvEnv = makeKvEnv();
      const res = await post('/trips', { ...base(), apnsEnv: env }, kvEnv);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, token: 'tok', confirmedEnv: env });
    },
  );

  it('first register: apnsEnv 누락 → 응답 confirmedEnv=sandbox fallback', async () => {
    const env = makeKvEnv();
    const res = await post('/trips', base(), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, token: 'tok', confirmedEnv: 'sandbox' });
  });

  it('existing.apnsEnv=sandbox + incoming.apnsEnv=production (build env drift) → existing 보존 echo', async () => {
    const env = makeKvEnv();
    // 첫 register: existing apnsEnv=sandbox (corrected 시뮬레이션)
    await post('/trips', { ...base(), apnsEnv: 'sandbox' }, env);
    // 둘째 register: device build env 가 production 으로 잘못 송신 → existing 우선 보존
    const res = await post('/trips', { ...base(), apnsEnv: 'production' }, env);
    expect(res.status).toBe(200);
    // backend `existing.apnsEnv ?? incoming.apnsEnv` 정책 → sandbox 유지
    expect(await res.json()).toEqual({ ok: true, token: 'tok', confirmedEnv: 'sandbox' });
  });
});

// ADR-022 B4 (#2019 wire) — POST /trips 에서 rotateTripTokenForNewRoute 실제 호출.
//
// #1986 이 helper 정의를 도입했지만 프로덕션 caller 0개 (테스트 파일에서만 호출) 였고 2026-07-03
// 사용자 실기기 trip(중곡→성수)에서 이전 trip 잔재 pending push 가 계속 발사돼 device 는
// `BoardingLock active=no + boardingPrompt(all)=0` 상태였음에도 `08:37:25 bg fired
// station-passed 성수` 관측. 원인: 새 route 등록 시 `trip:<oldToken>` KV entry 와
// `pending:*` 잔재가 rotation helper 호출 부재로 정리되지 않음.
//
// 본 describe 는 wire 완결(POST handler 가 helper 호출) 을 검증한다. Helper 자체의 rotation
// 로직 (route sig 계산 / KV delete / pending cleanup) 은 `trips.test.ts` 에서 커버.
describe('POST /trips — #2019 rotateTripTokenForNewRoute wire (ADR-022 B4)', () => {
  const TOKEN = 'tok-2019';
  const ARCH_FLAG_KV_KEY = 'arch:simple-arrival-v1';

  // Helper: incoming trip body 를 다른 destination/waypoints 로 변형.
  function tripBodyFor(destination: string, stationName: string): Record<string, unknown> {
    return {
      ...base(),
      token: TOKEN,
      destination,
      waypoints: [{ stationName, line: '2', kind: 'destination' }],
    };
  }

  async function seedExistingTrip(
    env: Env,
    destination: string,
    stationName: string,
  ): Promise<void> {
    const trip = {
      token: TOKEN,
      route: { type: 'direct', line: '2', stops: 3 },
      destination,
      waypoints: [{ stationName, line: '2', kind: 'destination' }],
      expiresAt: FUTURE,
      createdAt: Date.now(),
      alarmAtEpochMs: FUTURE - 30 * 60 * 1000,
    };
    await env.TRIPS.put(`trip:${TOKEN}`, JSON.stringify(trip));
  }

  async function seedPending(env: Env, pushId: string, token: string): Promise<void> {
    const entry = {
      pushId,
      token,
      alarmKey: `early:${pushId}`,
      sentAt: Date.now(),
      stationName: '용마산',
      kind: 'destination',
      phase: 'early',
      etaSeconds: 300,
      apnsEnv: 'sandbox',
    };
    await env.TRIPS.put(`pending:${pushId}`, JSON.stringify(entry));
  }

  describe('archFlag=off (default) — dormant', () => {
    it('existing + 다른 destination → 회전 없음 (`trip:<TOKEN>` 유지 + 응답 token 동일)', async () => {
      const env = makeKvEnv();
      await seedExistingTrip(env, '용마산-id', '용마산');
      // KV 에 archFlag 미설정 → getArchFlag 는 default 'off' 반환.
      const res = await post('/trips', tripBodyFor('성수-id', '성수'), env);
      expect(res.status).toBe(200);
      // 응답 token 은 그대로 (rotation 미발동).
      expect(await res.json()).toEqual({
        ok: true,
        token: TOKEN,
        confirmedEnv: 'sandbox',
      });
      // 기존 KV key 유지 — putTrip 이 같은 key 로 덮어씀.
      const stored = await env.TRIPS.get(`trip:${TOKEN}`);
      expect(stored).not.toBeNull();
      // 새 destination 으로 갱신됐지만 token 은 그대로.
      expect(JSON.parse(stored as string).destination).toBe('성수-id');
    });

    it('existing + pending push 잔재 + 다른 destination → pending 유지 (cleanup 미발동)', async () => {
      // Wire dormant 상태에서 pending cleanup 이 발동하지 않는지 회귀 가드.
      const env = makeKvEnv();
      await seedExistingTrip(env, '용마산-id', '용마산');
      await seedPending(env, 'p-legacy', TOKEN);
      await post('/trips', tripBodyFor('성수-id', '성수'), env);
      // flag=off → helper no-op → pending 잔재는 그대로 (기존 회귀 재현 시나리오).
      expect(await env.TRIPS.get('pending:p-legacy')).not.toBeNull();
    });
  });

  describe('archFlag=on — rotation active', () => {
    beforeEach(async () => {
      // 각 테스트는 자체 env 를 만들고 setup 에서 flag 를 KV 에 set 한다.
    });

    it('existing 없음 (신규 trip) → 회전 없음, incoming token 유지', async () => {
      const env = makeKvEnv();
      await env.TRIPS.put(ARCH_FLAG_KV_KEY, 'on');
      const res = await post('/trips', tripBodyFor('성수-id', '성수'), env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        token: TOKEN,
        confirmedEnv: 'sandbox',
      });
      expect(await env.TRIPS.get(`trip:${TOKEN}`)).not.toBeNull();
    });

    it('existing + 같은 route (destination/waypoints 동일) → 회전 없음', async () => {
      const env = makeKvEnv();
      await env.TRIPS.put(ARCH_FLAG_KV_KEY, 'on');
      await seedExistingTrip(env, '성수-id', '성수');
      const res = await post('/trips', tripBodyFor('성수-id', '성수'), env);
      expect(res.status).toBe(200);
      // 같은 route sig → rotation dormant → token 유지.
      expect(await res.json()).toEqual({
        ok: true,
        token: TOKEN,
        confirmedEnv: 'sandbox',
      });
      expect(await env.TRIPS.get(`trip:${TOKEN}`)).not.toBeNull();
    });

    it('#2174 P1-A — existing + 다른 destination: rotation 발동으로 응답에 새 UUID token + old trip:<TOKEN> 삭제', async () => {
      // #2173 P0 hotfix가 guard로 이 경로를 단락시켰던 이유(crypto.randomUUID() 가 APNs
      // deviceToken 자리에 저장돼 400 BadDeviceToken 즉사, Epic #2172)는 #2174의
      // `Trip.deviceToken` 필드 분리로 해소됐다 — 모든 push 발사 사이트가 `resolveTripDeviceToken`
      // 을 사용하므로 trip.token(신원) 로테이션이 더 이상 push 발사 주소에 영향을 주지 않는다.
      const env = makeKvEnv();
      await env.TRIPS.put(ARCH_FLAG_KV_KEY, 'on');
      await seedExistingTrip(env, '용마산-id', '용마산');
      const res = await post('/trips', tripBodyFor('성수-id', '성수'), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: true; token: string; confirmedEnv: string };
      expect(body.ok).toBe(true);
      // rotation 발동 — 응답 token은 새 UUID (incoming token과 다름).
      expect(body.token).not.toBe(TOKEN);
      expect(body.token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      // old trip:<TOKEN> 은 삭제되고 새 trip:<newToken> 이 생성된다.
      expect(await env.TRIPS.get(`trip:${TOKEN}`)).toBeNull();
      const stored = await env.TRIPS.get(`trip:${body.token}`);
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored as string).destination).toBe('성수-id');
    });

    it('#2174 P1-A — 이전 trip pending push 잔재 존재 상태에서 새 route 등록: old token 소유 cleanup 발동', async () => {
      const env = makeKvEnv();
      await env.TRIPS.put(ARCH_FLAG_KV_KEY, 'on');
      await seedExistingTrip(env, '용마산-id', '용마산');
      await seedPending(env, 'p-old-1', TOKEN);
      await seedPending(env, 'p-old-2', TOKEN);
      await seedPending(env, 'p-other-device', 'tok-different');

      const res = await post('/trips', tripBodyFor('성수-id', '성수'), env);
      expect(res.status).toBe(200);

      // rotation 발동 → old token 소유 pending은 cleanup, 다른 device 소유는 보존.
      expect(await env.TRIPS.get('pending:p-old-1')).toBeNull();
      expect(await env.TRIPS.get('pending:p-old-2')).toBeNull();
      expect(await env.TRIPS.get('pending:p-other-device')).not.toBeNull();
    });

    it('#2174 P1-A — archFlag off→on 전환 시 두 번째 등록만 rotation 발동', async () => {
      const env = makeKvEnv();
      await seedExistingTrip(env, '용마산-id', '용마산');
      // Round 1: flag 미설정 → default off → 회전 없음.
      const res1 = await post('/trips', tripBodyFor('성수-id', '성수'), env);
      const body1 = (await res1.json()) as { token: string };
      expect(body1.token).toBe(TOKEN);

      // Reset: 새 existing 을 다시 seed 하고 flag on.
      await seedExistingTrip(env, '용마산-id', '용마산');
      await env.TRIPS.put(ARCH_FLAG_KV_KEY, 'on');
      // Round 2: flag on → rotation 발동 → token 변경.
      const res2 = await post('/trips', tripBodyFor('성수-id', '성수'), env);
      const body2 = (await res2.json()) as { token: string };
      expect(body2.token).not.toBe(TOKEN);
    });

    // #2174 F2 → #2175로 완결 — rotation 발동 후 old(실) token으로 GET /trips/:token/status를
    // 조회하면 deviceToken 역인덱스가 새 UUID trip을 재발견해 'active'를 반환한다. 로테이션된
    // trip은 실제로 여전히 살아있으므로(사용자가 그냥 route를 바꿨을 뿐) 'ended'로 보고하는 게
    // 오히려 부정확했다 — #2175가 이 갭을 닫는다.
    it('#2175 — rotation 발동 후 실 deviceToken으로 GET /trips/:token/status 조회 시 역인덱스로 새 UUID trip을 찾아 active를 반환한다', async () => {
      const env = makeKvEnv();
      await env.TRIPS.put(ARCH_FLAG_KV_KEY, 'on');
      await seedExistingTrip(env, '용마산-id', '용마산');
      const res = await post('/trips', tripBodyFor('성수-id', '성수'), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string };

      // #2174 comment 1 — device는 로테이션 이후에도 실 deviceToken(=최초 등록 시 TOKEN)으로
      // GET /trips/:token/status를 조회한다.
      const statusRes = await app.fetch(
        new Request(`http://example.com/trips/${TOKEN}/status`, { method: 'GET' }),
        env,
      );
      expect(statusRes.status).toBe(200);
      const statusBody = (await statusRes.json()) as {
        tripToken: string;
        status: string;
        endReason: string | null;
      };
      // 응답의 tripToken은 device가 질의한 원래 값(TOKEN)을 echo — 내부적으로는 새 UUID(body.token)
      // trip을 참조해 active로 판정했다.
      expect(statusBody.tripToken).toBe(TOKEN);
      expect(statusBody.status).toBe('active');
      expect(statusBody.endReason).toBeNull();
      expect(body.token).not.toBe(TOKEN);
    });

    // #2175 — 로테이션된 trip이 실제로 종료(예: 만료)되면, 역인덱스가 여전히 그 UUID를 가리키는
    // 상태에서 실 deviceToken 조회가 그 UUID의 종료 사유('rotated')를 그대로 노출한다.
    it('#2175 — rotation 후 새 UUID trip마저 종료되면 실 deviceToken 조회가 그 종료 사유를 반환한다', async () => {
      const env = makeKvEnv();
      await env.TRIPS.put(ARCH_FLAG_KV_KEY, 'on');
      await seedExistingTrip(env, '용마산-id', '용마산');
      const res = await post('/trips', tripBodyFor('성수-id', '성수'), env);
      const body = (await res.json()) as { token: string };
      const newToken = body.token;
      expect(newToken).not.toBe(TOKEN);

      // 새 UUID trip을 직접 종료 상태로 전환 (cron 자동 종료를 시뮬레이션 — expired 사유).
      await env.TRIPS.delete(`trip:${newToken}`);
      await env.TRIPS.put(
        `tripStatus:${newToken}`,
        JSON.stringify({ endedAt: Date.now(), endReason: 'expired' }),
      );

      const statusRes = await app.fetch(
        new Request(`http://example.com/trips/${TOKEN}/status`, { method: 'GET' }),
        env,
      );
      expect(statusRes.status).toBe(200);
      const statusBody = (await statusRes.json()) as {
        tripToken: string;
        status: string;
        endReason: string | null;
      };
      expect(statusBody.tripToken).toBe(TOKEN);
      expect(statusBody.status).toBe('ended');
      expect(statusBody.endReason).toBe('expired');
    });

    // #2129 — 2026-08-04 실탑승 evidence: 같은 device token으로 거의 동시에 도착한
    // POST /trips 2건(waypoints 다름)이 getTrip → rotate → putTrip TOCTOU window에서
    // interleave해 유령 trip 2개(원본 token + rotated UUID)가 모두 KV에 생존했다.
    // withTripRegisterLock이 같은 token의 register 처리를 직렬화해 이 race를 차단한다.
    it('#2129 동시 register 2건(같은 token, 다른 waypoints) → KV 활성 trip 정확히 1개', async () => {
      const env = makeKvEnv();
      await env.TRIPS.put(ARCH_FLAG_KV_KEY, 'on');
      const bodyA = tripBodyFor('용마산-id', '용마산');
      const bodyB = tripBodyFor('성수-id', '성수');
      const [resA, resB] = await Promise.all([
        post('/trips', bodyA, env),
        post('/trips', bodyB, env),
      ]);
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      const allTripKeys = (await env.TRIPS.list({ prefix: 'trip:' })).keys;
      // 두 요청 모두 성공 응답을 받아도, 직렬화 덕분에 KV에는 활성 trip이 정확히 1개만 남는다
      // (원본 TOKEN 재사용이든 rotation으로 발급된 새 UUID든 — 유령 trip 2개 생존이 회귀).
      expect(allTripKeys.length).toBe(1);
    });
  });
});

// #2175 — deviceToken → trip.token 역인덱스로 POST /trips 비멱등 회수 (#2184 리뷰 P1).
//
// Root cause(backend RCA #2175 코멘트): 같은 실토큰 재-POST + route 변경 → 매번 새 UUID trip
// 생성, `getTrip`은 incoming.token(실토큰)으로만 조회(index.ts)라 직전 로테이션의 UUID trip을
// 못 찾아 orphan이 누적된다. rotated UUID를 device가 채택하지 않는 것도 원인(발산 지속).
//
// #2184 리뷰 P1 시퀀스: (1) 실토큰 등록 → route 변경 재-POST → 로테이션(`trip:<실토큰>` 삭제 +
// `trip:<UUID>` 생성) → (2) 클라가 또 실토큰으로 재-POST(route 동일, lock/ETA 변동 등) →
// `getTrip(실토큰)` miss → 역인덱스 fallback 없이는 신규 `trip:<실토큰>` 생성 → `trip:<UUID>`
// (route frozen 고아)와 `trip:<실토큰>`(현재) 둘 다 live.
describe('POST /trips — #2175 deviceToken 역인덱스 (orphan 회수, #2184 리뷰 P1)', () => {
  const TOKEN = 'tok-2175-real';

  function tripBodyFor(destination: string, stationName: string): Record<string, unknown> {
    return {
      ...base(),
      token: TOKEN,
      destination,
      waypoints: [{ stationName, line: '2', kind: 'destination' }],
    };
  }

  async function activeTripKeys(env: Env): Promise<string[]> {
    const list = await env.TRIPS.list({ prefix: 'trip:' });
    return list.keys.map((k) => k.name);
  }

  it('P1: 실토큰 재-POST(route 동일, 로테이션 이후) → 역인덱스로 기존 UUID trip에 merge, 신규 trip:<실토큰> 미생성', async () => {
    const env = makeKvEnv();
    await env.TRIPS.put(ARCH_FLAG_KV_KEY, 'on');

    // 1) 최초 등록.
    const res1 = await post('/trips', tripBodyFor('용마산-id', '용마산'), env);
    expect(res1.status).toBe(200);
    expect(await activeTripKeys(env)).toEqual([`trip:${TOKEN}`]);

    // 2) route 변경 재-POST → rotation 발동 (`trip:<TOKEN>` 삭제 + `trip:<UUID>` 생성).
    const res2 = await post('/trips', tripBodyFor('성수-id', '성수'), env);
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { token: string };
    const uuid1 = body2.token;
    expect(uuid1).not.toBe(TOKEN);
    expect(await activeTripKeys(env)).toEqual([`trip:${uuid1}`]);

    // 3) 클라는 rotated UUID를 채택하지 않고 계속 실토큰(TOKEN)으로 같은 route 재-POST.
    //    수정 전: getTrip(TOKEN) miss → 신규 trip:<TOKEN> 생성 → trip:<uuid1>(고아) 동시 생존(2개).
    //    수정 후: 역인덱스가 TOKEN → uuid1을 가리키므로 existing으로 재발견 → 같은 route → merge.
    const res3 = await post('/trips', tripBodyFor('성수-id', '성수'), env);
    expect(res3.status).toBe(200);
    const body3 = (await res3.json()) as { token: string };
    expect(body3.token).toBe(uuid1);
    const keysAfterMerge = await activeTripKeys(env);
    expect(keysAfterMerge).toEqual([`trip:${uuid1}`]);
    expect(keysAfterMerge).not.toContain(`trip:${TOKEN}`);
  });

  it('P1: 2회 연속 로테이션에도 orphan이 쌓이지 않는다 (역인덱스가 매번 최신 UUID로 갱신)', async () => {
    const env = makeKvEnv();
    await env.TRIPS.put(ARCH_FLAG_KV_KEY, 'on');

    await post('/trips', tripBodyFor('용마산-id', '용마산'), env);
    const res2 = await post('/trips', tripBodyFor('성수-id', '성수'), env);
    const uuid1 = ((await res2.json()) as { token: string }).token;

    // 다시 실토큰으로 두 번째 route 변경 재-POST → uuid1 → uuid2 로테이션.
    const res3 = await post('/trips', tripBodyFor('중곡-id', '중곡'), env);
    expect(res3.status).toBe(200);
    const uuid2 = ((await res3.json()) as { token: string }).token;
    expect(uuid2).not.toBe(uuid1);
    expect(uuid2).not.toBe(TOKEN);

    // 두 번의 로테이션이 지나도 KV에 활성 trip은 정확히 1개 — uuid1도 orphan으로 남지 않는다.
    expect(await activeTripKeys(env)).toEqual([`trip:${uuid2}`]);
  });

  it('#2184 리뷰 P1 안전망: 역인덱스가 가리키던 trip이 최종 확정 trip과 다르면 superseded-by-reregister로 정리하고 D1/sentinel을 남긴다', async () => {
    const env = makeKvEnv();
    await env.TRIPS.put(ARCH_FLAG_KV_KEY, 'on');
    await post('/trips', tripBodyFor('용마산-id', '용마산'), env);
    const res2 = await post('/trips', tripBodyFor('성수-id', '성수'), env);
    const uuid1 = ((await res2.json()) as { token: string }).token;

    const res3 = await post('/trips', tripBodyFor('성수-id', '성수'), env);
    expect(res3.status).toBe(200);
    // merge 케이스라 정리 대상이 없다 — uuid1 자체가 그대로 유지된 최종 trip이므로 sentinel 미기록.
    expect(await env.TRIPS.get(`tripStatus:${uuid1}`)).toBeNull();

    // 이어서 route 변경 재-POST → uuid1 → uuid2 로테이션. rotateTripTokenForNewRoute 자체가
    // 'rotated' sentinel을 남기므로(#2174 F2), superseded-by-reregister 중복 기록은 없어야 한다.
    const res4 = await post('/trips', tripBodyFor('중곡-id', '중곡'), env);
    const uuid2 = ((await res4.json()) as { token: string }).token;
    const uuid1Status = await env.TRIPS.get(`tripStatus:${uuid1}`);
    expect(uuid1Status).not.toBeNull();
    expect(JSON.parse(uuid1Status as string).endReason).toBe('rotated');
    expect(await activeTripKeys(env)).toEqual([`trip:${uuid2}`]);
  });

  it('deviceToken 역인덱스가 최종 trip.token으로 유지된다 (raw KV 값 검증)', async () => {
    const env = makeKvEnv();
    await env.TRIPS.put(ARCH_FLAG_KV_KEY, 'on');
    await post('/trips', tripBodyFor('용마산-id', '용마산'), env);
    expect(await env.TRIPS.get(`device-trips:${TOKEN}`)).toBe(TOKEN);

    const res2 = await post('/trips', tripBodyFor('성수-id', '성수'), env);
    const uuid1 = ((await res2.json()) as { token: string }).token;
    expect(await env.TRIPS.get(`device-trips:${TOKEN}`)).toBe(uuid1);
  });
});

function rawSignalsEnv(): Env {
  return makeEnv({ RAW_SIGNALS: new InMemoryKV() as unknown as KVNamespace });
}
function dumpBody(): Record<string, unknown> {
  return {
    corrId: '1700000000000-deadbeef',
    token: 'aabbccdd11223344',
    entries: [{ ts: 1, kind: 'cycle' }, { ts: 2, kind: 'enter' }],
  };
}

describe('POST /signals/dump (#1520)', () => {
  it('returns 503 when RAW_SIGNALS binding is missing (graceful)', async () => {
    const env = makeEnv();
    const res = await post('/signals/dump', dumpBody(), env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'raw_signals_unavailable' });
  });

  it('returns 400 on invalid JSON', async () => {
    const env = rawSignalsEnv();
    const res = await post('/signals/dump', 'not-json{', env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
  });

  it('returns 400 on invalid payload (bad corrId)', async () => {
    const env = rawSignalsEnv();
    const res = await post('/signals/dump', { ...dumpBody(), corrId: 'bad' }, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_payload' });
  });

  it('returns 400 when entries exceeds cap', async () => {
    const env = rawSignalsEnv();
    const tooMany = Array.from({ length: 501 }, (_, i) => ({ ts: i }));
    const res = await post('/signals/dump', { ...dumpBody(), entries: tooMany }, env);
    expect(res.status).toBe(400);
  });

  it('stores entries under dump:{corrId} with TTL', async () => {
    const env = rawSignalsEnv();
    const res = await post('/signals/dump', dumpBody(), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: 2 });

    const stored = await env.RAW_SIGNALS!.get('dump:1700000000000-deadbeef');
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored ?? '');
    expect(parsed.tokenPrefix).toBe('aabbccdd');
    expect(parsed.entries.length).toBe(2);
    expect(typeof parsed.uploadedAt).toBe('number');
  });
});

function makeAdminRawSignalsEnv(): Env {
  return makeEnv({
    RAW_SIGNALS: new InMemoryKV() as unknown as KVNamespace,
    ADMIN_TOKEN: 'secret',
  });
}

async function getAdminSignalsExport(
  env: Env,
  query: string,
  auth?: string,
): Promise<Response> {
  return app.fetch(
    new Request(`http://example.com/admin/signals/export${query}`, {
      method: 'GET',
      headers: auth ? { authorization: auth } : {},
    }),
    env,
  );
}

describe('GET /admin/signals/export (#1520)', () => {
  it('returns 503 when ADMIN_TOKEN not configured', async () => {
    const env = makeEnv({ RAW_SIGNALS: new InMemoryKV() as unknown as KVNamespace });
    const res = await getAdminSignalsExport(env, '?corrId=1700000000000-deadbeef', 'Bearer x');
    expect(res.status).toBe(503);
  });

  it('returns 401 when auth header missing', async () => {
    const env = makeAdminRawSignalsEnv();
    const res = await getAdminSignalsExport(env, '?corrId=1700000000000-deadbeef');
    expect(res.status).toBe(401);
  });

  it('returns 503 when RAW_SIGNALS binding missing', async () => {
    const env = makeEnv({ ADMIN_TOKEN: 'secret' });
    const res = await getAdminSignalsExport(env, '?corrId=1700000000000-deadbeef', 'Bearer secret');
    expect(res.status).toBe(503);
  });

  it('returns 400 when corrId param missing', async () => {
    const env = makeAdminRawSignalsEnv();
    const res = await getAdminSignalsExport(env, '', 'Bearer secret');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_corrId' });
  });

  it('returns 404 when corrId pattern invalid', async () => {
    const env = makeAdminRawSignalsEnv();
    const res = await getAdminSignalsExport(env, '?corrId=bad', 'Bearer secret');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('returns 404 when no stored dump for corrId', async () => {
    const env = makeAdminRawSignalsEnv();
    const res = await getAdminSignalsExport(env, '?corrId=1700000000000-deadbeef', 'Bearer secret');
    expect(res.status).toBe(404);
  });

  it('returns 200 with stored dump after upload', async () => {
    const env = makeAdminRawSignalsEnv();
    await post(
      '/signals/dump',
      {
        corrId: '1700000000000-deadbeef',
        token: 'aabbccdd11223344',
        entries: [{ ts: 1 }],
      },
      env,
    );
    const res = await getAdminSignalsExport(env, '?corrId=1700000000000-deadbeef', 'Bearer secret');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      corrId: string;
      tokenPrefix: string;
      entries: unknown[];
      uploadedAt: number;
    };
    expect(body.corrId).toBe('1700000000000-deadbeef');
    expect(body.tokenPrefix).toBe('aabbccdd');
    expect(body.entries.length).toBe(1);
  });
});

// ─── GET /admin/push-ack-stats (#1614 Phase D, S4 #1537) ──────────────────────

async function getAdminPushAckStats(
  env: Env,
  authHeader?: string,
): Promise<Response> {
  return app.fetch(
    new Request('http://example.com/admin/push-ack-stats', {
      method: 'GET',
      headers: authHeader ? { authorization: authHeader } : {},
    }),
    env,
  );
}

/**
 * #1700 — `/admin/push-ack-stats`는 `PENDING_PUSHES` namespace를 scan해야 하므로
 * KV 두 개(TRIPS, PENDING_PUSHES)를 모두 bind한 env를 생성. write 대상과 같은
 * namespace scan을 보장.
 */
function makePushAckEnv(): Env {
  return makeEnv({
    TRIPS: new InMemoryKV() as unknown as Env['TRIPS'],
    PENDING_PUSHES: new InMemoryKV() as unknown as Env['PENDING_PUSHES'],
  });
}

describe('GET /admin/push-ack-stats (#1614 Phase D)', () => {
  it('returns 503 when ADMIN_TOKEN is not configured', async () => {
    const env = makePushAckEnv();
    const res = await getAdminPushAckStats(env, 'Bearer some-token');
    expect(res.status).toBe(503);
  });

  it('returns 401 when no Authorization header', async () => {
    const env = makePushAckEnv();
    env.ADMIN_TOKEN = 'secret';
    const res = await getAdminPushAckStats(env);
    expect(res.status).toBe(401);
  });

  it('returns 401 when token does not match', async () => {
    const env = makePushAckEnv();
    env.ADMIN_TOKEN = 'secret';
    const res = await getAdminPushAckStats(env, 'Bearer wrong-token');
    expect(res.status).toBe(401);
  });

  it('returns 200 with stats shape (empty KV)', async () => {
    const env = makePushAckEnv();
    env.ADMIN_TOKEN = 'secret';
    const res = await getAdminPushAckStats(env, 'Bearer secret');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      windowStart: number;
      windowEnd: number;
      pending: number;
      received: number;
      receivedByPhase: Record<string, number>;
      receivedByStation: Record<string, number>;
    };
    expect(body.windowStart).toBeLessThan(body.windowEnd);
    expect(body.pending).toBe(0);
    expect(body.received).toBe(0);
    expect(body.receivedByPhase).toEqual({});
    expect(body.receivedByStation).toEqual({});
  });

  it('returns 503 when PENDING_PUSHES binding unavailable (#1700)', async () => {
    // TRIPS는 살아있어도 PENDING_PUSHES 미바인딩이면 503 — write 대상 KV와 일치 강제.
    const env = makeEnv({
      TRIPS: new InMemoryKV() as unknown as Env['TRIPS'],
      ADMIN_TOKEN: 'secret',
    });
    const res = await getAdminPushAckStats(env, 'Bearer secret');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('pending_pushes_unavailable');
  });

  // #1700 회귀 가드 — write(`stampReceived`) → read(`/admin/push-ack-stats`) 정합성.
  it('counts received stamps written to PENDING_PUSHES via stampReceived (#1700)', async () => {
    const env = makePushAckEnv();
    env.ADMIN_TOKEN = 'secret';
    const pendingKv = env.PENDING_PUSHES as unknown as KVNamespace;
    // 1) silent push 발사 시점에 pending entry 적재 (60s TTL).
    await putPending(pendingKv, {
      pushId: 'p1700',
      token: 'device-token-A',
      alarmKey: 'imminent:용마산',
      sentAt: Date.now(),
      stationName: '용마산',
      kind: 'destination',
      phase: 'imminent',
      etaSeconds: 60,
      apnsEnv: 'production',
    });
    // 2) device → POST /push/ack → stampReceived 호출 시뮬레이션.
    const result = await stampReceived(pendingKv, 'p1700', 'device-token-A', Date.now());
    expect(result.stamped).toBe(true);

    const res = await getAdminPushAckStats(env, 'Bearer secret');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      received: number;
      receivedByPhase: Record<string, number>;
      receivedByStation: Record<string, number>;
    };
    expect(body.received).toBe(1);
    expect(body.receivedByPhase.imminent).toBe(1);
    expect(body.receivedByStation['용마산']).toBe(1);
  });

  // #1700 — TRIPS namespace에 같은 prefix가 있어도 endpoint는 영향받지 않음을 보장.
  it('ignores received: prefix entries in TRIPS namespace (#1700)', async () => {
    const env = makePushAckEnv();
    env.ADMIN_TOKEN = 'secret';
    const tripsKv = env.TRIPS as unknown as InMemoryKV;
    // TRIPS namespace에 우연히 같은 prefix entry가 있어도 카운트되지 않아야 한다.
    tripsKv.store.set('received:noise', {
      value: JSON.stringify({
        pushId: 'noise',
        receivedAt: Date.now() - 10_000,
        stationName: '잘못된-namespace',
        phase: 'imminent',
      }),
    });
    const res = await getAdminPushAckStats(env, 'Bearer secret');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: number };
    expect(body.received).toBe(0);
  });

  // #1928 F-E4 — kv.list / kv.get / JSON parse throw 시 1101 HTML 대신 503 JSON 반환.
  it('returns 503 JSON when computePushAckStats throws (#1928 F-E4)', async () => {
    const env = makePushAckEnv();
    env.ADMIN_TOKEN = 'secret';
    const pendingKv = env.PENDING_PUSHES as unknown as InMemoryKV;
    // kv.list가 throw하도록 override → computePushAckStats 내부 cascade 실패.
    pendingKv.list = async () => {
      throw new Error('KV list 503 simulated');
    };

    const res = await getAdminPushAckStats(env, 'Bearer secret');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('push_ack_stats_failed');
  });
});

// ─── GET /admin/alarm-log-stats (#1621 Phase A) ───────────────────────────────

async function getAdminAlarmLogStats(env: Env, authHeader?: string): Promise<Response> {
  return app.fetch(
    new Request('http://example.com/admin/alarm-log-stats', {
      method: 'GET',
      headers: authHeader ? { authorization: authHeader } : {},
    }),
    env,
  );
}

// Sonar dup 차단 — R2 empty/fake mock은 helpers/r2Fixtures.ts에 단일 정의 (#1621).
const makeEmptyR2 = makeEmptyFakeR2;

describe('GET /admin/alarm-log-stats (#1621 Phase A)', () => {
  it.each([
    {
      label: '503 when ADMIN_TOKEN is not configured',
      configureEnv: (env: Env) => {
        env.TELEMETRY_R2 = makeEmptyR2();
      },
      authHeader: 'Bearer some-token',
      expectedStatus: 503,
    },
    {
      label: '401 when no Authorization header',
      configureEnv: (env: Env) => {
        env.ADMIN_TOKEN = 'secret';
        env.TELEMETRY_R2 = makeEmptyR2();
      },
      authHeader: undefined,
      expectedStatus: 401,
    },
    {
      label: '401 when token does not match',
      configureEnv: (env: Env) => {
        env.ADMIN_TOKEN = 'secret';
        env.TELEMETRY_R2 = makeEmptyR2();
      },
      authHeader: 'Bearer wrong-token',
      expectedStatus: 401,
    },
    {
      label: '503 when TELEMETRY_R2 binding unavailable',
      configureEnv: (env: Env) => {
        env.ADMIN_TOKEN = 'secret';
      },
      authHeader: 'Bearer secret',
      expectedStatus: 503,
    },
  ])('returns $expectedStatus — $label', async ({ configureEnv, authHeader, expectedStatus }) => {
    const env = makeKvEnv();
    configureEnv(env);
    const res = await getAdminAlarmLogStats(env, authHeader);
    expect(res.status).toBe(expectedStatus);
  });

  it('returns 200 with stats shape (empty R2)', async () => {
    const env = makeKvEnv();
    env.ADMIN_TOKEN = 'secret';
    env.TELEMETRY_R2 = makeEmptyR2();
    const res = await getAdminAlarmLogStats(env, 'Bearer secret');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      windowStart: number;
      windowEnd: number;
      totalEvents: number;
      fired: number;
      suppressed: number;
      received: number;
      reasons: Record<string, number>;
      sources: Record<string, number>;
      tripsScanned: number;
    };
    expect(body.windowStart).toBeLessThan(body.windowEnd);
    expect(body.totalEvents).toBe(0);
    expect(body.fired).toBe(0);
    expect(body.tripsScanned).toBe(0);
    expect(body.reasons).toEqual({});
    expect(body.sources).toEqual({});
  });
});

// ─── GET /admin/baseline-check (#1621 Phase C) ────────────────────────────────

async function getAdminBaselineCheck(
  env: Env,
  query: string,
  authHeader?: string,
): Promise<Response> {
  const url = `http://example.com/admin/baseline-check${query ? '?' + query : ''}`;
  return app.fetch(
    new Request(url, {
      method: 'GET',
      headers: authHeader ? { authorization: authHeader } : {},
    }),
    env,
  );
}

describe('GET /admin/baseline-check (#1621 Phase C)', () => {
  it.each([
    {
      label: '503 when ADMIN_TOKEN is not configured',
      configureEnv: (env: Env) => {
        env.TELEMETRY_R2 = makeEmptyR2();
      },
      query: 'tripToken=tok',
      authHeader: 'Bearer some-token',
      expectedStatus: 503,
    },
    {
      label: '401 when no Authorization header',
      configureEnv: (env: Env) => {
        env.ADMIN_TOKEN = 'secret';
        env.TELEMETRY_R2 = makeEmptyR2();
      },
      query: 'tripToken=tok',
      authHeader: undefined,
      expectedStatus: 401,
    },
    {
      label: '400 when tripToken missing',
      configureEnv: (env: Env) => {
        env.ADMIN_TOKEN = 'secret';
        env.TELEMETRY_R2 = makeEmptyR2();
      },
      query: '',
      authHeader: 'Bearer secret',
      expectedStatus: 400,
    },
    {
      label: '503 when TELEMETRY_R2 binding unavailable',
      configureEnv: (env: Env) => {
        env.ADMIN_TOKEN = 'secret';
      },
      query: 'tripToken=tok',
      authHeader: 'Bearer secret',
      expectedStatus: 503,
    },
  ])('returns $expectedStatus — $label', async ({ configureEnv, query, authHeader, expectedStatus }) => {
    const env = makeKvEnv();
    configureEnv(env);
    const res = await getAdminBaselineCheck(env, query, authHeader);
    expect(res.status).toBe(expectedStatus);
  });

  it('returns 200 with baseline=fail shape (empty KV + empty R2)', async () => {
    const env = makeKvEnv();
    env.ADMIN_TOKEN = 'secret';
    env.TELEMETRY_R2 = makeEmptyR2();
    const res = await getAdminBaselineCheck(env, 'tripToken=tok', 'Bearer secret');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      baseline: string;
      signals: {
        tripActive: boolean;
        silentPushFired: number;
        silentPushReceived: number;
        v1Mismatch: number;
      };
    };
    // No fired push, no mismatch — baseline 'fail' (silentPushFired === 0).
    expect(body.baseline).toBe('fail');
    expect(body.signals.tripActive).toBe(false);
    expect(body.signals.silentPushFired).toBe(0);
    expect(body.signals.v1Mismatch).toBe(0);
  });
});

// #1982 (ADR-022 Phase 0) — Arrival API SSOT Feature Flag admin endpoints.
describe('GET/POST /admin/arch-flag (#1982)', () => {
  async function getFlag(env: Env, authHeader?: string): Promise<Response> {
    return app.fetch(
      new Request('http://example.com/admin/arch-flag', {
        method: 'GET',
        headers: authHeader ? { authorization: authHeader } : {},
      }),
      env,
    );
  }

  async function postFlag(
    env: Env,
    body: unknown,
    authHeader?: string,
    { rawBody }: { rawBody?: string } = {},
  ): Promise<Response> {
    return app.fetch(
      new Request('http://example.com/admin/arch-flag', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authHeader ? { authorization: authHeader } : {}),
        },
        body: rawBody ?? JSON.stringify(body),
      }),
      env,
    );
  }

  function makeAuthEnv(): Env {
    return makeEnv({ TRIPS: new InMemoryKV() as unknown as Env['TRIPS'], ADMIN_TOKEN: 'secret' });
  }

  describe('GET', () => {
    it('returns 503 when ADMIN_TOKEN not configured', async () => {
      const env = makeKvEnv();
      const res = await getFlag(env, 'Bearer x');
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'admin_unavailable' });
    });

    it('returns 401 without bearer header', async () => {
      const env = makeAuthEnv();
      const res = await getFlag(env);
      expect(res.status).toBe(401);
    });

    it('returns 401 with wrong token', async () => {
      const env = makeAuthEnv();
      const res = await getFlag(env, 'Bearer wrong');
      expect(res.status).toBe(401);
    });

    it('returns 503 when TRIPS binding unavailable', async () => {
      // ADMIN_TOKEN 은 있지만 TRIPS 미바인딩 케이스. Env type 은 non-null 이지만
      // wrangler.toml 에 KV binding 이 없는 환경(개발/최초 배포)에서 undefined 가 넘어온다.
      const env = makeEnv({
        ADMIN_TOKEN: 'secret',
        TRIPS: undefined as unknown as Env['TRIPS'],
      });
      const res = await getFlag(env, 'Bearer secret');
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'trips_unavailable' });
    });

    it('returns default (off) when key never set', async () => {
      const env = makeAuthEnv();
      const res = await getFlag(env, 'Bearer secret');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ value: 'off' });
    });

    it('reflects value previously written via POST', async () => {
      const env = makeAuthEnv();
      await postFlag(env, { value: 'on' }, 'Bearer secret');
      const res = await getFlag(env, 'Bearer secret');
      expect(await res.json()).toEqual({ value: 'on' });
    });
  });

  describe('POST', () => {
    it('returns 503 when ADMIN_TOKEN not configured', async () => {
      const env = makeKvEnv();
      const res = await postFlag(env, { value: 'on' }, 'Bearer x');
      expect(res.status).toBe(503);
    });

    it('returns 401 without bearer header', async () => {
      const env = makeAuthEnv();
      const res = await postFlag(env, { value: 'on' });
      expect(res.status).toBe(401);
    });

    it('returns 401 with wrong token', async () => {
      const env = makeAuthEnv();
      const res = await postFlag(env, { value: 'on' }, 'Bearer wrong');
      expect(res.status).toBe(401);
    });

    it('returns 503 when TRIPS binding unavailable', async () => {
      const env = makeEnv({
        ADMIN_TOKEN: 'secret',
        TRIPS: undefined as unknown as Env['TRIPS'],
      });
      const res = await postFlag(env, { value: 'on' }, 'Bearer secret');
      expect(res.status).toBe(503);
    });

    it('returns 400 when body is not JSON', async () => {
      const env = makeAuthEnv();
      const res = await postFlag(env, null, 'Bearer secret', { rawBody: 'not-json' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_body' });
    });

    it('returns 400 when body has no value field', async () => {
      const env = makeAuthEnv();
      const res = await postFlag(env, {}, 'Bearer secret');
      expect(res.status).toBe(400);
    });

    it('returns 400 when value is invalid literal', async () => {
      const env = makeAuthEnv();
      const res = await postFlag(env, { value: 'true' }, 'Bearer secret');
      expect(res.status).toBe(400);
    });

    it('accepts value=on and persists to KV', async () => {
      const env = makeAuthEnv();
      const res = await postFlag(env, { value: 'on' }, 'Bearer secret');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ value: 'on' });
      const readBack = await getFlag(env, 'Bearer secret');
      expect(await readBack.json()).toEqual({ value: 'on' });
    });

    it('accepts value=off (rollback) and persists to KV', async () => {
      const env = makeAuthEnv();
      // 사전에 on 으로 설정된 상태를 off 로 되돌리는 rollback 시나리오.
      await postFlag(env, { value: 'on' }, 'Bearer secret');
      const res = await postFlag(env, { value: 'off' }, 'Bearer secret');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ value: 'off' });
    });
  });
});

// #1967 (Ff-1) — lockless intermediate 게이트 admin kill switch endpoints.
describe('GET/POST /admin/kill-switch (#1967 Ff-1)', () => {
  async function getSwitch(
    env: Env,
    key: string | undefined,
    authHeader?: string,
  ): Promise<Response> {
    const url = key
      ? `http://example.com/admin/kill-switch?key=${encodeURIComponent(key)}`
      : 'http://example.com/admin/kill-switch';
    return app.fetch(
      new Request(url, {
        method: 'GET',
        headers: authHeader ? { authorization: authHeader } : {},
      }),
      env,
    );
  }

  async function postSwitch(
    env: Env,
    key: string | undefined,
    body: unknown,
    authHeader?: string,
    { rawBody }: { rawBody?: string } = {},
  ): Promise<Response> {
    const url = key
      ? `http://example.com/admin/kill-switch?key=${encodeURIComponent(key)}`
      : 'http://example.com/admin/kill-switch';
    return app.fetch(
      new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authHeader ? { authorization: authHeader } : {}),
        },
        body: rawBody ?? JSON.stringify(body),
      }),
      env,
    );
  }

  function makeAuthEnv(): Env {
    return makeEnv({ TRIPS: new InMemoryKV() as unknown as Env['TRIPS'], ADMIN_TOKEN: 'secret' });
  }

  describe('GET', () => {
    it('returns 503 when ADMIN_TOKEN not configured', async () => {
      const env = makeKvEnv();
      const res = await getSwitch(env, 'lockless_intermediate', 'Bearer x');
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'admin_unavailable' });
    });

    it('returns 401 without bearer header', async () => {
      const env = makeAuthEnv();
      const res = await getSwitch(env, 'lockless_intermediate');
      expect(res.status).toBe(401);
    });

    it('returns 401 with wrong token', async () => {
      const env = makeAuthEnv();
      const res = await getSwitch(env, 'lockless_intermediate', 'Bearer wrong');
      expect(res.status).toBe(401);
    });

    it('returns 400 when key is missing', async () => {
      const env = makeAuthEnv();
      const res = await getSwitch(env, undefined, 'Bearer secret');
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_key' });
    });

    it('returns 400 when key is unsupported', async () => {
      const env = makeAuthEnv();
      const res = await getSwitch(env, 'unknown_gate', 'Bearer secret');
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_key' });
    });

    it('returns 503 when TRIPS binding unavailable', async () => {
      const env = makeEnv({
        ADMIN_TOKEN: 'secret',
        TRIPS: undefined as unknown as Env['TRIPS'],
      });
      const res = await getSwitch(env, 'lockless_intermediate', 'Bearer secret');
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'trips_unavailable' });
    });

    it('returns default (false) when key never set', async () => {
      const env = makeAuthEnv();
      const res = await getSwitch(env, 'lockless_intermediate', 'Bearer secret');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ key: 'lockless_intermediate', value: 'false' });
    });

    it('reflects value previously written via POST', async () => {
      const env = makeAuthEnv();
      await postSwitch(env, 'lockless_intermediate', { value: 'true' }, 'Bearer secret');
      const res = await getSwitch(env, 'lockless_intermediate', 'Bearer secret');
      expect(await res.json()).toEqual({ key: 'lockless_intermediate', value: 'true' });
    });
  });

  describe('POST', () => {
    it('returns 503 when ADMIN_TOKEN not configured', async () => {
      const env = makeKvEnv();
      const res = await postSwitch(env, 'lockless_intermediate', { value: 'true' }, 'Bearer x');
      expect(res.status).toBe(503);
    });

    it('returns 401 without bearer header', async () => {
      const env = makeAuthEnv();
      const res = await postSwitch(env, 'lockless_intermediate', { value: 'true' });
      expect(res.status).toBe(401);
    });

    it('returns 401 with wrong token', async () => {
      const env = makeAuthEnv();
      const res = await postSwitch(env, 'lockless_intermediate', { value: 'true' }, 'Bearer wrong');
      expect(res.status).toBe(401);
    });

    it('returns 400 when key is missing', async () => {
      const env = makeAuthEnv();
      const res = await postSwitch(env, undefined, { value: 'true' }, 'Bearer secret');
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_key' });
    });

    it('returns 400 when key is unsupported', async () => {
      const env = makeAuthEnv();
      const res = await postSwitch(env, 'unknown_gate', { value: 'true' }, 'Bearer secret');
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_key' });
    });

    it('returns 503 when TRIPS binding unavailable', async () => {
      const env = makeEnv({
        ADMIN_TOKEN: 'secret',
        TRIPS: undefined as unknown as Env['TRIPS'],
      });
      const res = await postSwitch(env, 'lockless_intermediate', { value: 'true' }, 'Bearer secret');
      expect(res.status).toBe(503);
    });

    it('returns 400 when body is not JSON', async () => {
      const env = makeAuthEnv();
      const res = await postSwitch(env, 'lockless_intermediate', null, 'Bearer secret', {
        rawBody: 'not-json',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_body' });
    });

    it('returns 400 when body has no value field', async () => {
      const env = makeAuthEnv();
      const res = await postSwitch(env, 'lockless_intermediate', {}, 'Bearer secret');
      expect(res.status).toBe(400);
    });

    it('returns 400 when value is invalid literal', async () => {
      const env = makeAuthEnv();
      const res = await postSwitch(env, 'lockless_intermediate', { value: 'on' }, 'Bearer secret');
      expect(res.status).toBe(400);
    });

    it('accepts value=true and persists to KV', async () => {
      const env = makeAuthEnv();
      const res = await postSwitch(env, 'lockless_intermediate', { value: 'true' }, 'Bearer secret');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ key: 'lockless_intermediate', value: 'true' });
      const readBack = await getSwitch(env, 'lockless_intermediate', 'Bearer secret');
      expect(await readBack.json()).toEqual({ key: 'lockless_intermediate', value: 'true' });
    });

    it('accepts value=false (rollback) and persists to KV', async () => {
      const env = makeAuthEnv();
      // 사전에 true 로 설정된 상태를 false 로 되돌리는 rollback 시나리오(회귀 대응 종료).
      await postSwitch(env, 'lockless_intermediate', { value: 'true' }, 'Bearer secret');
      const res = await postSwitch(env, 'lockless_intermediate', { value: 'false' }, 'Bearer secret');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ key: 'lockless_intermediate', value: 'false' });
    });
  });
});
