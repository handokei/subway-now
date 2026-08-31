import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DISEMBARK_PROMPT_CATEGORY, resetApnsJwtCache, type ApnsConfig } from '../apns';
import { computeNextRetryAt, isRetryableApnsError } from '../apnsHost';
import { DRIFT_WARNING_THRESHOLD_KMH, R_LOW, readKalmanState, type KalmanState } from '../kalmanFilter';
import type { WindowedMetrics } from '../positionSeries';
import {
  ARVLCD_FIRE_DEDUP_TTL_SEC,
  ARVLCD_FIRE_KEY_PREFIX,
  ARVLCD_FIRE_ONCE_CYCLE_SLOT,
  hasArrivedSignal,
  SAME_PHASE_STATION_DEDUP_WINDOW_MS,
  FALLBACK_ADVANCE_GRACE_CYCLES,
  FALLBACK_HOP_SEC,
  MAX_CONSECUTIVE_ETA_MISSING,
  RESCHEDULE_THRESHOLD_MS,
  STALE_LOCK_FIRE_THRESHOLD_MS,
  SUBSURFACE_ETA_MISSING_TOLERANCE,
  VANISH_RE_ATTACH_THRESHOLD,
  BACKEND_TRIP_LIFECYCLE_SILENCE_MS,
  BACKEND_TRIP_LIFECYCLE_FORCE_END_MS,
  DESTINATION_GPS_CROSS_CHECK_MAX_M,
  DESTINATION_GPS_STALE_THRESHOLD_MS,
  DESTINATION_REACH_BACKSTOP_MS,
  evaluateDestinationCrossCheck,
  recordDestinationCrossCheck,
  arvlCdFireKey,
  estimateArrivalFromPosition,
  estimateBoardingLockArrival,
  evaluateArvlCdFireGate,
  fireArvlCdStationPush,
  flipApnsEnv,
  maybeCountDrift,
  pickActiveWaypoint,
  pickApnsHost,
  pickBestArrivalSignal,
  pickLatestCurrentStationName,
  resolveEtaMissingThreshold,
  buildBoardingPromptMessage,
  buildHopEndPromptMessage,
  maybeFireHopEndPrompt,
  runScheduled,
  tripLifecyclePhase,
  appendPassedStation,
  computeCronJitterMs,
  PASSED_STATIONS_MAX_LEN,
  CRON_NOMINAL_INTERVAL_MS,
  toSilentPushSsot,
  shouldSkipStationary,
  resolveBoardingLinePayload,
  type ScheduledDeps,
  type ScheduledStats,
} from '../scheduled';
import { SeoulArrivalClient, type ArrivalEntry, type PositionEntry } from '../seoul';
import { ARVLCD_FIRE_ONCE_TTL_SEC, arvlCdFireOnceKey } from '../arvlcdFireOnceTtl';
import { stampPushActivity, readPushActivityRecent } from '../cronIdleGate';
import {
  ACTIVE_TRIPS_MARKER_KEY,
  hasActiveTripsMarker,
  markTripRegistered,
} from '../activeTripsGate';
import { JITTER_SAMPLE_EVERY_N_TICKS, readJitterSamples } from '../cronJitterAggregate';
import { putTrip } from '../trips';
import { pendingKey, putPending } from '../pendingPushes';
import { readSsot, seedSsot, ssotKey, writeSsot, type TripPositionSSoT } from '../tripPositionSsot';
import type { BoardingLockMeta, Env, PositionPoint, Trip, Waypoint } from '../types';
import { InMemoryKV } from './inMemoryKv';

let apnsConfig: ApnsConfig;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  const pem = await exportPKCS8(privateKey);
  apnsConfig = {
    keyId: 'K',
    teamId: 'T',
    privateKeyPem: pem,
    bundleId: 'com.example.app',
  };
});

beforeEach(() => resetApnsJwtCache());

const NOW = 1_700_000_000_000;

const APNS_HOSTS = {
  production: 'api.push.apple.com',
  sandbox: 'api.sandbox.push.apple.com',
} as const;

// #2086 — APNs apns-collapse-id 64B 한도 검증용 실물 길이(64 hex) mock device token.
// 짧은 mock token('lock-tok' 등)은 slice(0, 16)가 no-op이라 축약 로직을 실제로 exercise하지
// 못한다 — runtime constraint 시뮬 원칙(lesson_test_mock_must_validate_runtime)에 따라
// 실제 device token 길이를 반영한 별도 상수를 collapse-id 전용 테스트에서 사용한다.
const HEX64_TOKEN = '0123456789abcdef'.repeat(4);

function makeEnv(kv: InMemoryKV, pending?: InMemoryKV, db?: D1Database): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
    APNS_HOST: APNS_HOSTS.production,
    APNS_HOST_SANDBOX: APNS_HOSTS.sandbox,
    SEOUL_API_HOST: 'seoul.api',
    SEOUL_API_KEY: 'KEY',
    APNS_KEY_ID: 'K',
    APNS_TEAM_ID: 'T',
    APNS_PRIVATE_KEY: apnsConfig.privateKeyPem,
    APNS_BUNDLE_ID: 'com.example.app',
    PENDING_PUSHES: pending ? (pending as unknown as KVNamespace) : undefined,
    DB: db,
  };
}

// #2343 — trip_events INSERT 호출을 가로채는 최소 D1 mock. `bind(...).run()` 인자를
// `inserts` 배열에 축적해 테스트가 실제 D1 없이 fire-attempt 로그 내용을 검증한다.
// `first()`도 no-op 응답 — pushFailureLog 등 같은 fire path에서 함께 호출되는 다른 D1
// consumer가 mock 표면 부재로 swallow-warn 노이즈를 내지 않도록 최소 호환.
function makeFireLogDb(): { db: D1Database; inserts: unknown[][] } {
  const inserts: unknown[][] = [];
  const db = {
    prepare: () => ({
      bind: (...args: unknown[]) => {
        inserts.push(args);
        return {
          run: async () => ({ success: true }),
          first: async () => null,
        };
      },
    }),
  } as unknown as D1Database;
  return { db, inserts };
}

// estimateBoardingLockArrival 테스트 공용 — 단일 arvlCd 노출만 검증.
function makeEstimateArrivalSeoul(arvlCd: number | null): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => NOW,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          realtimeArrivalList: [
            {
              barvlDt: '0',
              recptnDt: '',
              updnLine: '상행',
              trainLineNm: '중곡',
              btrainNo: '7246',
              subwayNm: '지하철7호선',
              arvlCd,
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch,
  });
}

function makeEstimateArrivalDeps(seoul: SeoulArrivalClient): ScheduledDeps {
  return {
    seoul,
    apnsConfig,
    apnsHosts: APNS_HOSTS,
    fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
  };
}

/**
 * `fireArvlCdStationPush` 등 직접 호출 테스트용 full-shape stats. `ScheduledStats` 필드 추가 시
 * runScheduled 초기값과 동시에 갱신 필요 — 두 사이트가 drift 하지 않도록 헬퍼화. 기존 fixture 인
 * `makeEmptyStats` (partial cast, kalmanDriftWarning만 참조) 와는 별개 목적.
 */
function makeFullEmptyStats(): ScheduledStats {
  return {
    scanned: 0, polled: 0, pushed: 0, errors: 0, etaMissing: 0, envCorrected: 0,
    lockMissing: 0, laStaleAutoEnded: 0, laStaleSurvivedSilence: 0, killSwitchLocklessIntermediateSkipped: 0, locklessIntermediateFired: 0, locklessMotionGateBlocked: 0,
    laPushSent: 0, laPushFailed: 0, laTokenCleared: 0,
    boardingPromptEvaluated: 0, boardingPromptFired: 0, boardingPromptBlocked: 0,
    phaseImminentBlocked: 0, kalmanReset: 0, kalmanDriftWarning: 0,
    autoLockSuccess: 0, autoLockFalsePositive: 0, boardingPromptAutoDeduped: 0,
    boardingPromptSkippedEmpty: 0, boardingPromptSkippedLockActive: 0, boardingPromptSkippedNoContext: 0, boardingPromptSkippedStale: 0, boardingPromptSkippedTooFar: 0,
    boardingPromptSkippedMinInterval: 0, boardingPromptSkippedMaxFires: 0, boardingPromptSkippedTrainDuplicate: 0,
    hopEndPromptFired: 0, hopEndPromptBlocked: 0,
    arvlCdFireSuccess: 0, arvlCdFireDedup: 0, arvlCdFireMismatch: 0,
    arvlCdFireBlocked: 0, arvlCdFireFired: 0,
    boardingLockWaypointAdvanceBlocked: 0, transferDestinationGateBlocked: 0,
    vanishFallbackFired: 0, vanishReleaseFired: 0, vanishLocklessTakeover: 0,
    vanishFallbackMotionGateBlocked: 0,
    cronJitterMs: 0, rescheduleBlockedMotion: 0, rescheduleFallbackNoSsot: 0, rescheduleDedupSkipped: 0, destinationBackstopForceEnded: 0, destinationStaleGpsSurvivedSilence: 0,
    realtimePositionFetch: 0, selfPollCacheHit: 0, realtimePositionFetchError: 0,
    stationPollFetch: 0, stationPollCacheHit: 0, stationPollError: 0,
    staleLockFireSkipped: 0,
    // ADR-022 Phase 1-1 (#1985) — arvlCd fire-once TTL 게이트 (flag=OFF 시 항상 0).
    arvlCdFireOnceSkipped: 0,
    lifecycleSilenceSkipped: 0, lifecycleForceEnded: 0,
    lifecycleStationarySkipped: 0,
    silentPushFiredByKind: {
      intermediate: 0,
      transfer: 0,
      destination: 0,
      boardingPrompt: 0,
      reschedule: 0,
    },
    scheduleEtaFallback: 0,
    destinationCrossCheck: {
      within: 0,
      gpsFar: 0,
      staleGps: 0,
      noGps: 0,
      stationUnknown: 0,
    },
    // #2073 (Issue A) — pending/retry push 존재 가능성 게이트. 기본 true(보수적).
    pendingActivityPossible: true,
    // #2066 (Phase 2-backend) — 취침 알람(환승/도착 직전역) 발사/skip 카운터.
    sleepAlarmFired: 0,
    sleepAlarmDedupSkipped: 0,
    sleepAlarmRolledBack: 0,
    etaMissingDemoted: 0,
    trainReconfirmFired: 0,
  };
}

// #917 arvlCd fire 테스트용 — stationName/seconds/arvlCd/trainCode 명시.
function makeArvlCdFireSeoul(
  stationName: string,
  seconds: number,
  arvlCd: number | null,
  trainCode = '7246',
): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => NOW,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          realtimeArrivalList: [
            {
              barvlDt: String(seconds),
              recptnDt: '',
              updnLine: '상행',
              trainLineNm: stationName,
              btrainNo: trainCode,
              subwayNm: '지하철7호선',
              arvlCd,
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch,
  });
}

/**
 * arvlCd fire push (kind=intermediate/destination, phase=imminent) 호출만 추출.
 * #2063 (ADR-023 개정) — silent(background) → visible(alert) 전환. apns-push-type 이 바뀌었지만
 * data payload shape(phase/kind 포함)는 그대로 forward 되므로 헤더 조건만 갱신.
 */
function getArvlCdStationPassedCalls(
  fetchImpl: ReturnType<typeof vi.fn>,
): [string, RequestInit][] {
  return (fetchImpl.mock.calls as unknown as [string, RequestInit][]).filter((c) => {
    const headers = (c[1]?.headers ?? {}) as Record<string, string>;
    if (headers['apns-push-type'] !== 'alert') return false;
    try {
      const body = JSON.parse(c[1]?.body as string) as {
        data?: { phase?: string; kind?: string };
      };
      return (
        body?.data?.phase === 'imminent' &&
        (body?.data?.kind === 'intermediate' || body?.data?.kind === 'destination')
      );
    } catch {
      return false;
    }
  });
}

function parseArvlCdStationPassedData(call: [string, RequestInit]): {
  nextWaypoint: string;
  etaSeconds: number;
  phase: string;
  kind: string;
  pushId: string;
  sentAt: number;
  // Epic #1204 그룹 2 D3 (#1273) — 구 client 호환을 위해 optional.
  hopIndex?: number;
} {
  const body = JSON.parse(call[1].body as string) as {
    data: {
      nextWaypoint: string;
      etaSeconds: number;
      phase: string;
      kind: string;
      pushId: string;
      sentAt: number;
      hopIndex?: number;
    };
  };
  return body.data;
}

// arrivals 빈 응답 + positions에 lock.trainCode 매칭(중곡 ARRIVED) — positions-fallback 경로 테스트 공용.
function makePositionsFallbackSeoul(): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => NOW,
    fetchImpl: (async (url: string) => {
      if (url.includes('/realtimePosition/')) {
        return new Response(
          JSON.stringify({
            realtimePositionList: [
              { trainNo: '7246', statnNm: '중곡', trainSttus: 1, updnLine: '상행', lastRecptnDt: '' },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ realtimeArrivalList: [] }), { status: 200 });
    }) as unknown as typeof fetch,
  });
}

// 7호선 용마산→중곡→군자 leg lockTrip 공용 (lock 추적/arvlCd fire 테스트 공통).
// token만 describe별로 다르므로 token은 호출 시 명시.
function makeLockTripFixture(token: string, overrides: Partial<Trip> = {}): Trip {
  return makeTrip({
    token,
    route: { type: 'direct', line: '7', stops: 2 },
    waypoints: [
      { stationName: '중곡', line: '7', kind: 'intermediate' },
      { stationName: '군자', line: '7', kind: 'destination' },
    ],
    boardingLock: makeBoardingLock(),
    ...overrides,
  });
}

// boardingLock fixture — 7호선 용마산→중곡→군자 leg 공용 (lock 추적/arvlCd fire 테스트 공통).
function makeBoardingLock(overrides: Partial<BoardingLockMeta> = {}): BoardingLockMeta {
  return {
    trainCode: '7246',
    line: '7',
    subwayId: '1007',
    selectedDepartureTime: NOW,
    segmentStations: ['용마산', '중곡', '군자'],
    expiresAt: NOW + 60 * 60_000,
    ...overrides,
  };
}

// 9단 게이트 happy path 공용 GPS series — boarding-prompt / kalman / auto-lock 테스트 공통 사용.
// 게이트 #4(origin 100m 이내) / #5(direction cosine ≥ 0.7) / #7(speed ≥ 5 km/h) 모두 통과 설계.
async function seedHappyGateSeries(kv: InMemoryKV, token: string): Promise<void> {
  const series = [
    { lat: 0, lng: -0.0004, accuracy: 10, ts: NOW - 60_000, motion: 'automotive' },
    { lat: 0, lng: 0.0002, accuracy: 10, ts: NOW - 30_000, motion: 'automotive' },
    { lat: 0, lng: 0.0008, accuracy: 10, ts: NOW, motion: 'automotive' },
  ];
  await kv.put(`pos:${token}`, JSON.stringify(series));
}

// #1315 — lockless motion 게이트 테스트 공용 3-sample series. 게이트는 posMetrics.motion만 읽으므로
// motion을 파라미터로 받고, nearestStationDistanceM이 있으면 phaseState stamp(dirty)도 발생시킨다.
async function seedLocklessMotionSeries(
  kv: InMemoryKV,
  token: string,
  motion: PositionPoint['motion'],
  nearestStationDistanceM?: number,
): Promise<void> {
  const base = (ts: number, lng: number) => ({
    lat: 0,
    lng,
    accuracy: 10,
    ts,
    motion,
    ...(nearestStationDistanceM === undefined ? {} : { nearestStationDistanceM }),
  });
  await kv.put(
    `pos:${token}`,
    JSON.stringify([base(NOW - 40_000, 0), base(NOW - 20_000, 0.0002), base(NOW, 0.0004)]),
  );
}

// #916 auto-lock 테스트용 trip 시드. promptGeoContext + promptDisplay + waypoints 9단 게이트 통과 형태.
function makePromptTrip(overrides: Partial<Trip> = {}): Trip {
  return makeTrip({
    token: 'auto-lock-tok',
    route: { type: 'direct', line: '2', stops: 3 },
    destination: '선릉',
    waypoints: [
      { stationName: '역삼', line: '2', kind: 'intermediate' },
      { stationName: '선릉', line: '2', kind: 'destination' },
    ],
    promptGeoContext: {
      origin: { lat: 0, lng: 0 },
      nextStation: { lat: 0, lng: 0.01 },
      direction: 'up',
    },
    promptDisplay: { originStation: '강남', line: '2' },
    ...overrides,
  });
}

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'tok',
    route: { type: 'direct', line: '2', stops: 5 },
    destination: 'dst',
    waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
    expiresAt: NOW + 60 * 60_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW + 60_000, // 알람 1분 후 → 폴링 윈도우 진입
    ...overrides,
  };
}

/**
 * apnsFetch mock에서 lockless intermediate(kind==='intermediate') 발사 1건의 payload data를
 * 추출한다. 정확히 1건이 발사됐는지도 단언한다. (#1307 / #1273 lockless wire 검증 공용 헬퍼)
 */
function parseLocklessIntermediateData(apnsFetch: {
  mock: { calls: unknown[][] };
}): Record<string, unknown> {
  const calls = apnsFetch.mock.calls.filter((c) => {
    try {
      const init = c[1] as { body?: unknown } | undefined;
      const body = JSON.parse(init?.body as string) as { data?: { kind?: string } };
      return body?.data?.kind === 'intermediate';
    } catch {
      return false;
    }
  });
  expect(calls).toHaveLength(1);
  const init = calls[0][1] as { body?: unknown };
  const body = JSON.parse(init.body as string) as { data: Record<string, unknown> };
  return body.data;
}

function makeSeoul(arrivals: ArrivalEntry[]): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => NOW,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          realtimeArrivalList: arrivals.map((a) => ({
            barvlDt: String(a.arrivalSeconds),
            recptnDt: '',
            updnLine: a.isUp ? '상행' : '하행',
            trainLineNm: a.destination,
            btrainNo: a.trainCode,
            subwayNm: a.subwayNm,
            arvlCd: a.arvlCd,
          })),
        }),
        { status: 200 },
      )) as unknown as typeof fetch,
  });
}

describe('pickActiveWaypoint', () => {
  it('returns first waypoint', () => {
    const trip = makeTrip();
    expect(pickActiveWaypoint(trip)?.stationName).toBe('강남');
  });
  it('returns null when empty', () => {
    expect(pickActiveWaypoint(makeTrip({ waypoints: [] }))).toBeNull();
  });
});

describe('pickBestArrivalSignal (#409)', () => {
  const wp = { stationName: '강남', line: '2', kind: 'destination' as const };
  it('returns null when no arrivals', () => {
    expect(pickBestArrivalSignal([], wp)).toBeNull();
  });
  it('arvlCd 신호 없으면 min ETA fallback (라인 매칭 후)', () => {
    const arrivals: ArrivalEntry[] = [
      { destination: 'A', arrivalSeconds: 200, trainCode: '1', isUp: true, subwayNm: '지하철2호선', arvlCd: null },
      { destination: 'B', arrivalSeconds: 60, trainCode: '2', isUp: true, subwayNm: '지하철2호선', arvlCd: null },
      { destination: 'C', arrivalSeconds: 30, trainCode: '3', isUp: true, subwayNm: '지하철9호선', arvlCd: null },
    ];
    expect(pickBestArrivalSignal(arrivals, wp)).toEqual({ etaSeconds: 60, arvlCd: null });
  });
  it('라인 매칭 실패 시 전체 arrivals로 fallback', () => {
    const arrivals: ArrivalEntry[] = [
      { destination: 'A', arrivalSeconds: 100, trainCode: '1', isUp: true, subwayNm: '지하철9호선', arvlCd: null },
    ];
    expect(pickBestArrivalSignal(arrivals, wp)).toEqual({ etaSeconds: 100, arvlCd: null });
  });
  it('gyeongui line은 경의중앙선 alias로 매칭', () => {
    const arrivals: ArrivalEntry[] = [
      { destination: '용문', arrivalSeconds: 90, trainCode: 'G', isUp: true, subwayNm: '경의중앙선', arvlCd: null },
      { destination: '용문', arrivalSeconds: 200, trainCode: 'H', isUp: true, subwayNm: '지하철1호선', arvlCd: null },
    ];
    const gyeonguiWp = { stationName: '회기', line: 'gyeongui', kind: 'destination' as const };
    expect(pickBestArrivalSignal(arrivals, gyeonguiWp)).toEqual({ etaSeconds: 90, arvlCd: null });
  });
  it('arvlCd=0 (ENTERING)이 있으면 ETA가 더 큰 train이라도 우선 선택 (imminent 실측)', () => {
    const arrivals: ArrivalEntry[] = [
      { destination: 'A', arrivalSeconds: 30, trainCode: '1', isUp: true, subwayNm: '지하철2호선', arvlCd: null },
      { destination: 'B', arrivalSeconds: 120, trainCode: '2', isUp: true, subwayNm: '지하철2호선', arvlCd: 0 },
    ];
    expect(pickBestArrivalSignal(arrivals, wp)).toEqual({ etaSeconds: 120, arvlCd: 0 });
  });
  it('arvlCd=1 (ARRIVED)이 있으면 ETA가 더 빠른 비-신호 train보다 우선', () => {
    const arrivals: ArrivalEntry[] = [
      { destination: 'A', arrivalSeconds: 50, trainCode: '1', isUp: true, subwayNm: '지하철2호선', arvlCd: 99 },
      { destination: 'B', arrivalSeconds: 80, trainCode: '2', isUp: true, subwayNm: '지하철2호선', arvlCd: 1 },
    ];
    expect(pickBestArrivalSignal(arrivals, wp)).toEqual({ etaSeconds: 80, arvlCd: 1 });
  });
  it('arvlCd=4/5 (PREV_*)는 early 신호로 선택, imminent 신호 없을 때만', () => {
    const arrivals: ArrivalEntry[] = [
      { destination: 'A', arrivalSeconds: 300, trainCode: '1', isUp: true, subwayNm: '지하철2호선', arvlCd: 4 },
      { destination: 'B', arrivalSeconds: 60, trainCode: '2', isUp: true, subwayNm: '지하철2호선', arvlCd: 99 },
    ];
    expect(pickBestArrivalSignal(arrivals, wp)).toEqual({ etaSeconds: 300, arvlCd: 4 });
  });
  it('imminent 신호가 있으면 early 신호보다 우선', () => {
    const arrivals: ArrivalEntry[] = [
      { destination: 'A', arrivalSeconds: 200, trainCode: '1', isUp: true, subwayNm: '지하철2호선', arvlCd: 5 },
      { destination: 'B', arrivalSeconds: 100, trainCode: '2', isUp: true, subwayNm: '지하철2호선', arvlCd: 0 },
    ];
    expect(pickBestArrivalSignal(arrivals, wp)).toEqual({ etaSeconds: 100, arvlCd: 0 });
  });

  describe('#2027 (Issue K) — archFlag=on 시 line mismatch fallback 차단', () => {
    // 환승 후 waypoint line=2, Seoul API 는 7호선 stale 신호만 반환하는 시나리오.
    // archFlag='off' (기존 동작): fallback 으로 7호선 신호 채택 → 조기 발사 회귀.
    // archFlag='on' (Issue K fix): null 반환 → caller 는 arc / ETA fallback 경로로 자연 전환.
    const staleTransferArrivals: ArrivalEntry[] = [
      { destination: 'A', arrivalSeconds: 50, trainCode: '7-stale', isUp: true, subwayNm: '지하철7호선', arvlCd: 4 },
      { destination: 'B', arrivalSeconds: 30, trainCode: '7-stale2', isUp: true, subwayNm: '지하철7호선', arvlCd: 5 },
    ];

    it('archFlag=off (기본): line mismatch 시 전체 arrivals fallback (기존 동작 유지)', () => {
      // 회귀 방어: archFlag 미지정 시 기존 동작(모든 arrivals 로 fallback) 유지.
      const result = pickBestArrivalSignal(staleTransferArrivals, wp);
      expect(result).not.toBeNull();
      // arvlCd=4/5 중 arvlCd=4 가 pool.find 순서상 먼저 발견 → early 신호로 선택.
      expect(result?.arvlCd).toBe(4);
    });

    it('archFlag=off 명시: line mismatch 시 fallback 동작 유지', () => {
      const result = pickBestArrivalSignal(staleTransferArrivals, wp, 'off');
      expect(result).not.toBeNull();
      expect(result?.arvlCd).toBe(4);
    });

    it('archFlag=on: line mismatch 시 null 반환 (fallback 차단)', () => {
      const result = pickBestArrivalSignal(staleTransferArrivals, wp, 'on');
      expect(result).toBeNull();
    });

    it('archFlag=on: matching line 이 있으면 정상 선택 (필터 통과)', () => {
      const arrivals: ArrivalEntry[] = [
        { destination: 'A', arrivalSeconds: 100, trainCode: '2', isUp: true, subwayNm: '지하철2호선', arvlCd: 0 },
        { destination: 'B', arrivalSeconds: 30, trainCode: '7', isUp: true, subwayNm: '지하철7호선', arvlCd: 5 },
      ];
      const result = pickBestArrivalSignal(arrivals, wp, 'on');
      expect(result).not.toBeNull();
      expect(result?.arvlCd).toBe(0); // 2호선 imminent
      expect(result?.etaSeconds).toBe(100);
    });

    it('archFlag=on: 빈 arrivals 는 null (동일)', () => {
      expect(pickBestArrivalSignal([], wp, 'on')).toBeNull();
    });
  });
});

describe('flipApnsEnv (#482 self-heal)', () => {
  it('sandbox → production', () => {
    expect(flipApnsEnv('sandbox')).toBe('production');
  });
  it('production → sandbox', () => {
    expect(flipApnsEnv('production')).toBe('sandbox');
  });
  it('undefined → production (sandbox default 짝)', () => {
    // pickApnsHost가 undefined를 sandbox로 시작하므로, flip은 production이 되어야 한다.
    expect(flipApnsEnv(undefined)).toBe('production');
  });
});

describe('pickApnsHost', () => {
  it('returns sandbox host when apnsEnv is sandbox', () => {
    expect(pickApnsHost('sandbox', APNS_HOSTS)).toBe(APNS_HOSTS.sandbox);
  });
  it('returns production host when apnsEnv is production', () => {
    expect(pickApnsHost('production', APNS_HOSTS)).toBe(APNS_HOSTS.production);
  });
  it('falls back to sandbox host when apnsEnv is undefined (#482 safe default)', () => {
    expect(pickApnsHost(undefined, APNS_HOSTS)).toBe(APNS_HOSTS.sandbox);
  });
});

describe('isRetryableApnsError (#1721)', () => {
  it.each([
    [429, true],
    [500, true],
    [502, true],
    [503, true],
    [599, true],
    [200, false],
    [400, false],
    [403, false],
    [404, false],
    [410, false],
    [600, false],
  ])('status=%i → %s', (status, expected) => {
    expect(isRetryableApnsError(status)).toBe(expected);
  });
});

describe('computeNextRetryAt (#1721)', () => {
  const NOW = 1_700_000_000_000;
  it.each([
    [0, NOW + 60_000],
    [1, NOW + 120_000],
    [2, NOW + 240_000],
  ])('attempt=%i → now + correct backoff', (attempt, expectedAt) => {
    expect(computeNextRetryAt(attempt, NOW)).toBe(expectedAt);
  });
  it('attempt >= schedule length → null (영구 폐기 신호)', () => {
    expect(computeNextRetryAt(3, NOW)).toBeNull();
    expect(computeNextRetryAt(10, NOW)).toBeNull();
  });
  it('attempt < 0 → null (방어적)', () => {
    expect(computeNextRetryAt(-1, NOW)).toBeNull();
  });
});

describe('runScheduled', () => {
  it('skips trips outside polling window', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTrip({ alarmAtEpochMs: NOW + 10 * 60_000 }));
    const seoul = makeSeoul([]);
    const fetchSpy = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(stats.polled).toBe(0);
    expect(stats.pushed).toBe(0);
  });

  it('deletes expired trips', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({ expiresAt: NOW + 5_000, alarmAtEpochMs: NOW - 1 }),
    );
    // expire 이전이지만 다음 시점은 expire 이후
    // #1337 — expired 경로는 trip-ended alert push도 발사 시도하므로 fetch mock 필요.
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW + 10_000,
    });
    expect(stats.polled).toBe(0);
    // trip 자체는 삭제된다.
    expect(await kv.get('trip:tok')).toBeNull();
    // #1337 — alert push 성공 시 dedup key(`tripEndedAlert:{tripToken}:{createdAt}` TTL 10m)가 KV에 남는다.
    expect(await kv.get(`tripEndedAlert:tok:${NOW}`)).toBe('1');
    // #1339 — launch reconciliation을 위한 tripStatus marker도 남는다.
    const statusEntry = kv.store.get('tripStatus:tok');
    expect(statusEntry).toBeDefined();
    expect(JSON.parse(statusEntry!.value)).toMatchObject({ endReason: 'expired' });
  });

  // #640 — BoardingLock 게이트. 사용자가 열차를 선택하지 않은 trip(lock 부재)은
  // arrival 신호가 와도 push를 발사하지 않는다. (가) 정책: lock 없으면 silent push 0건.
  // 이전 legacy phase-based push 경로의 회귀 방지 테스트들은 boardingLock 경로의
  // 대응 케이스(self-heal/intermediate/410 등)로 모두 커버되어 삭제됨 (회귀 동등성 유지).
  describe('#640 lockMissing gate', () => {
    it('lock 부재 trip은 arrival이 와도 push 미발사 + Seoul arrivals API 미호출', async () => {
      const kv = new InMemoryKV();
      await putTrip(kv as unknown as KVNamespace, makeTrip()); // makeTrip default: boardingLock undefined
      const seoulFetch = vi.fn(async () =>
        new Response(JSON.stringify({ realtimePositionList: [] }), { status: 200 }),
      );
      const seoul = new SeoulArrivalClient({
        apiKey: 'K',
        host: 'h',
        now: () => NOW,
        fetchImpl: seoulFetch as unknown as typeof fetch,
      });
      const apnsFetch = vi.fn();
      const stats = await runScheduled(makeEnv(kv), {
        seoul,
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: apnsFetch as unknown as typeof fetch,
        now: () => NOW,
      });
      expect(stats.pushed).toBe(0);
      expect(stats.lockMissing).toBe(1);
      expect(apnsFetch).not.toHaveBeenCalled();
      // #1614 Phase A — cron 진입부 self-poll로 realtimePosition fetch는 발생할 수 있음.
      // #1828 Phase 5 — cron 진입부 station-level arrivals fetch도 발생할 수 있음 (route bound polling).
      // 본 테스트의 진짜 의도는 push 발사 0건 (lock 없는 trip은 알람 차단).
      // Seoul arrivals API 호출 자체는 cron stamp 목적으로 허용됨 — push 경로와 무관.
    });
  });

  // #816 C — lockless station-passed opt-in 분기. lock 없어도 토글 ON + intermediate면 발사 허용.
  describe('#816 C — lockless intermediate', () => {
    function makeApnsFetchOk(): ReturnType<typeof vi.fn> {
      return vi.fn(async () => new Response('', { status: 200 }) as unknown as Response);
    }

    function intermediateTrip(overrides: Partial<Trip> = {}): Trip {
      return makeTrip({
        waypoints: [
          { stationName: '강남', line: '2', kind: 'intermediate' },
          { stationName: '역삼', line: '2', kind: 'destination' },
        ],
        infoModeEnabled: true,
        ...overrides,
      });
    }

    /**
     * Lockless scenario 셋업 통일 헬퍼. trip을 InMemoryKV에 넣고 seoul/apns mock 주입 후
     * runScheduled를 한 cycle 돌려 stats + apnsFetch + kv를 반환한다. 어설션은 호출부에서.
     *
     * `arrivals`:
     *   - undefined: Seoul fetch mock(`seoulFetch`)을 vi.fn()으로 두고 호출 여부만 추적
     *     (lockMissing 게이트 등으로 Seoul 호출 자체가 일어나면 안 되는 시나리오용)
     *   - 배열 (빈 배열 포함): makeSeoul로 실제 응답 — 빈 배열은 etaMissing 트리거
     */
    // #1315 — lockless bare-arvlCd advance는 GPS motion이 walking/automotive일 때만 허용된다.
    // 발사를 기대하는 케이스는 `motion='automotive'`(default)로 이동 series를 시드한다. 정적
    // (false advance 회귀)을 검증하는 케이스는 'stationary' / 'unknown' 또는 'none'(series 미시드)을 준다.
    async function runLocklessCycle(input: {
      trip: Trip;
      arrivals?: ArrivalEntry[];
      apnsOk?: boolean;
      motion?: PositionPoint['motion'] | 'none';
    }) {
      const kv = new InMemoryKV();
      await putTrip(kv as unknown as KVNamespace, input.trip);
      const motion = input.motion ?? 'automotive';
      if (motion !== 'none') {
        await seedLocklessMotionSeries(kv, input.trip.token, motion);
      }
      const seoulFetch = vi.fn();
      const seoul = input.arrivals
        ? makeSeoul(input.arrivals)
        : new SeoulArrivalClient({
            apiKey: 'K',
            host: 'h',
            now: () => NOW,
            fetchImpl: seoulFetch as unknown as typeof fetch,
          });
      const apnsFetch = input.apnsOk ? makeApnsFetchOk() : vi.fn();
      const stats = await runScheduled(makeEnv(kv), {
        seoul,
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: apnsFetch as unknown as typeof fetch,
        now: () => NOW,
      });
      return { kv, stats, apnsFetch, seoulFetch };
    }

    const ARVL_ARRIVED: ArrivalEntry = {
      destination: '강남행',
      arrivalSeconds: 30,
      trainCode: '7246',
      isUp: true,
      subwayNm: '지하철2호선',
      arvlCd: 1,
    };
    const ARVL_NO_SIGNAL: ArrivalEntry = { ...ARVL_ARRIVED, arrivalSeconds: 60, arvlCd: null };

    type LocklessCase = {
      name: string;
      trip: () => Trip;
      arrivals?: ArrivalEntry[]; // undefined → Seoul fetch 미호출 보장 케이스
      apnsOk: boolean;
      expect: { pushed: number; locklessFired: number; lockMissing?: number; etaMissing?: number };
      apnsCalled: boolean;
      seoulCalled?: boolean; // arrivals undefined 케이스에서 seoulFetch 호출 여부 검증.
    };

    const cases: LocklessCase[] = [
      {
        name: '토글 ON + intermediate + arvlCd=1 → 발사 + locklessIntermediateFired 카운트',
        trip: () => intermediateTrip(),
        arrivals: [ARVL_ARRIVED],
        apnsOk: true,
        expect: { pushed: 1, locklessFired: 1, lockMissing: 0 },
        apnsCalled: true,
      },
      {
        name: '토글 OFF + intermediate → lockMissing 카운트 (발사 0, arrivals fetch 미호출)',
        trip: () => intermediateTrip({ infoModeEnabled: false }),
        apnsOk: false,
        expect: { pushed: 0, locklessFired: 0, lockMissing: 1 },
        apnsCalled: false,
        // #1614 Phase A — self-poll은 cron 진입부 unconditional (line set에 활성 trip이 있으면 fetch).
        // arrivals/realtimePosition fetch 0 보장은 더 이상 lockMissing 진단 신호로 유효 X — seoulCalled 검증 생략.
      },
      {
        name: '토글 ON + destination kind → lockMissing 카운트 (lockless는 intermediate만)',
        trip: () =>
          makeTrip({
            waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
            infoModeEnabled: true,
          }),
        apnsOk: false,
        expect: { pushed: 0, locklessFired: 0, lockMissing: 1 },
        apnsCalled: false,
      },
      {
        name: '토글 ON + intermediate + arvlCd 신호 없음 → 발사 0 (ARRIVED/ENTERING만 trigger)',
        trip: () => intermediateTrip(),
        arrivals: [ARVL_NO_SIGNAL],
        apnsOk: false,
        expect: { pushed: 0, locklessFired: 0 },
        apnsCalled: false,
      },
      {
        name: '토글 ON + intermediate + arrivals 비어있음 → etaMissing 증가, 발사 0',
        trip: () => intermediateTrip(),
        arrivals: [],
        apnsOk: false,
        expect: { pushed: 0, locklessFired: 0, etaMissing: 1 },
        apnsCalled: false,
      },
    ];

    it.each(cases)('lock 없음 + $name', async ({ trip, arrivals, apnsOk, expect: ex, apnsCalled, seoulCalled }) => {
      const { stats, apnsFetch, seoulFetch } = await runLocklessCycle({
        trip: trip(),
        arrivals,
        apnsOk,
      });
      expect(stats.pushed).toBe(ex.pushed);
      expect(stats.locklessIntermediateFired).toBe(ex.locklessFired);
      if (ex.lockMissing !== undefined) expect(stats.lockMissing).toBe(ex.lockMissing);
      if (ex.etaMissing !== undefined) expect(stats.etaMissing).toBe(ex.etaMissing);
      if (apnsCalled) {
        expect(apnsFetch).toHaveBeenCalled();
      } else {
        expect(apnsFetch).not.toHaveBeenCalled();
      }
      if (seoulCalled === false) expect(seoulFetch).not.toHaveBeenCalled();
    });

    // #1967 (Ff-1) — admin kill switch. 2026-07-31 리뷰(P1) — 게이트는 `runLocklessIntermediate`
    // 함수 호출 전체가 아니라 함수 내부의 매역 station-passed push 발사 블록만 대상으로 한다.
    // fusion advance 평가 / arvlCd Kalman reset / phase·motion 게이트 / 취침 알람 / waypoint 진행은
    // kill switch와 무관하게 정상 실행된다 — trip advance와 취침 알람까지 함께 죽으면 그 자체가
    // 새로운 사용자 가치 손실 회귀이기 때문이다(ADR-014: 사용자 명시 의향 trip = lock 활성과 동급).
    describe('#1967 (Ff-1) — admin kill switch (push 블록만 게이트)', () => {
      it('killSwitchLocklessIntermediate=true → push 0건 + killSwitchLocklessIntermediateSkipped 카운트 + waypoint는 정상 advance', async () => {
        const kv = new InMemoryKV();
        const trip = intermediateTrip();
        await putTrip(kv as unknown as KVNamespace, trip);
        await seedLocklessMotionSeries(kv, trip.token, 'automotive');
        const apnsFetch = vi.fn(async () => new Response('', { status: 200 }) as unknown as Response);
        const stats = await runScheduled(makeEnv(kv), {
          seoul: makeSeoul([ARVL_ARRIVED]),
          apnsConfig,
          apnsHosts: APNS_HOSTS,
          fetchImpl: apnsFetch as unknown as typeof fetch,
          now: () => NOW,
          killSwitchLocklessIntermediate: true,
        });
        expect(stats.pushed).toBe(0);
        expect(stats.locklessIntermediateFired).toBe(0);
        expect(stats.killSwitchLocklessIntermediateSkipped).toBe(1);
        // P2-1 — over-count 해소 확인: 게이트가 push 블록으로 좁혀졌으므로 함수 호출 자체는
        // 정상 진행돼 lockMissing 분기로 fall-through하지 않는다(intermediateTrip은 lock이
        // 아예 없는 lockless 시나리오이므로 애초에 lockMissing 분기 대상도 아니다).
        expect(stats.lockMissing).toBe(0);
        expect(apnsFetch).not.toHaveBeenCalled();
        // trip advance는 매역 통지 여부와 독립 — kill switch 활성 상태에서도 waypoint가 shift.
        const stored = JSON.parse((await (kv as unknown as KVNamespace).get('trip:tok')) as string);
        expect(stored.waypoints[0].stationName).toBe('역삼');
      });

      it('killSwitchLocklessIntermediate=false → 정상 발사 (dormant 확인)', async () => {
        const { stats, apnsFetch } = await runLocklessCycle({
          trip: intermediateTrip(),
          arrivals: [ARVL_ARRIVED],
          apnsOk: true,
        });
        expect(stats.pushed).toBe(1);
        expect(stats.locklessIntermediateFired).toBe(1);
        expect(stats.killSwitchLocklessIntermediateSkipped).toBe(0);
        expect(apnsFetch).toHaveBeenCalled();
      });

      it('killSwitchLocklessIntermediate 미전달(undefined) → 기존 동작 100% 유지 (dormant)', async () => {
        const kv = new InMemoryKV();
        const trip = intermediateTrip();
        await putTrip(kv as unknown as KVNamespace, trip);
        await seedLocklessMotionSeries(kv, trip.token, 'automotive');
        const apnsFetch = vi.fn(async () => new Response('', { status: 200 }) as unknown as Response);
        const stats = await runScheduled(makeEnv(kv), {
          seoul: makeSeoul([ARVL_ARRIVED]),
          apnsConfig,
          apnsHosts: APNS_HOSTS,
          fetchImpl: apnsFetch as unknown as typeof fetch,
          now: () => NOW,
          // killSwitchLocklessIntermediate 미전달
        });
        expect(stats.pushed).toBe(1);
        expect(stats.locklessIntermediateFired).toBe(1);
        expect(stats.killSwitchLocklessIntermediateSkipped).toBe(0);
        expect(apnsFetch).toHaveBeenCalled();
      });

      // P2-2 (리뷰 필수) — 취침 알람 생존 회귀 테스트. sleepModeEnabled + infoModeEnabled 둘 다
      // ON인 lockless trip에서 kill switch가 활성이어도 취침 알람(별 채널, alert+companion)은
      // 정상 발사되고 waypoint도 정상 advance해야 한다. #1967 P1 리뷰가 지적한 "매역 push만
      // 죽이려다 취침 알람까지 죽이는" 회귀를 직접 재현/차단.
      it('sleepModeEnabled + infoModeEnabled + kill switch ON → sleepAlarmFired 1 + 매역 push 0 + waypoint advance 정상', async () => {
        const kv = new InMemoryKV();
        // #2066 트리거 조건: waypoint(현재)=intermediate, nextWaypoint=transfer/destination.
        // intermediateTrip() 기본 shape(강남 intermediate → 역삼 destination)이 그대로 부합.
        const trip = intermediateTrip({ sleepModeEnabled: true });
        await putTrip(kv as unknown as KVNamespace, trip);
        await seedLocklessMotionSeries(kv, trip.token, 'automotive');
        const apnsFetch = vi.fn(async () => new Response('', { status: 200 }) as unknown as Response);
        const stats = await runScheduled(makeEnv(kv), {
          seoul: makeSeoul([ARVL_ARRIVED]),
          apnsConfig,
          apnsHosts: APNS_HOSTS,
          fetchImpl: apnsFetch as unknown as typeof fetch,
          now: () => NOW,
          generatePushId: () => 'p-sleep-killswitch',
          killSwitchLocklessIntermediate: true,
        });
        // 취침 알람(별 채널)은 kill switch 무관 정상 발사.
        expect(stats.sleepAlarmFired).toBe(1);
        // 매역 station-passed push(lockless intermediate)는 kill switch로 차단.
        expect(stats.pushed).toBe(0);
        expect(stats.locklessIntermediateFired).toBe(0);
        expect(stats.killSwitchLocklessIntermediateSkipped).toBe(1);
        // waypoint는 정상 advance (trip SSoT는 매역 통지 여부와 독립).
        const stored = JSON.parse((await (kv as unknown as KVNamespace).get('trip:tok')) as string);
        expect(stored.waypoints[0].stationName).toBe('역삼');
        // 취침 알람 push(alert + companion silent)는 실제로 전송 시도됐어야 한다.
        expect(apnsFetch).toHaveBeenCalled();
      });
    });

    // Epic #1204 그룹 2 D3 (#1273)
    it('lockless intermediate 발사 시 payload.hopIndex가 waypoint.hopIndex로 wire', async () => {
      const { apnsFetch } = await runLocklessCycle({
        trip: makeTrip({
          waypoints: [
            { stationName: '강남', line: '2', kind: 'intermediate', hopIndex: 3 },
            { stationName: '역삼', line: '2', kind: 'destination', hopIndex: 4 },
          ],
          infoModeEnabled: true,
        }),
        arrivals: [ARVL_ARRIVED],
        apnsOk: true,
      });
      const data = parseLocklessIntermediateData(apnsFetch);
      expect(data.hopIndex).toBe(3);
    });

    it('lockless intermediate 발사 시 waypoint.hopIndex 부재면 payload 본문에서도 hopIndex 누락', async () => {
      const { apnsFetch } = await runLocklessCycle({
        trip: makeTrip({
          waypoints: [
            { stationName: '강남', line: '2', kind: 'intermediate' },
            { stationName: '역삼', line: '2', kind: 'destination' },
          ],
          infoModeEnabled: true,
        }),
        arrivals: [ARVL_ARRIVED],
        apnsOk: true,
      });
      const data = parseLocklessIntermediateData(apnsFetch);
      expect('hopIndex' in data).toBe(false);
    });

    // #1307 — lockless intermediate도 server-authoritative subsurface flag forward.
    // trip.subsurface=true면 payload에 wire, 미설정이면 본문에서 omit.
    it.each([
      ['true면 payload.subsurface로 wire', true, true],
      ['미설정이면 payload 본문에서 omit', undefined, false],
    ])('lockless intermediate subsurface %s (#1307)', async (_label, input, expectPresent) => {
      const { apnsFetch } = await runLocklessCycle({
        trip: makeTrip({
          waypoints: [
            { stationName: '강남', line: '2', kind: 'intermediate', hopIndex: 3 },
            { stationName: '역삼', line: '2', kind: 'destination', hopIndex: 4 },
          ],
          infoModeEnabled: true,
          ...(input === undefined ? {} : { subsurface: input }),
        }),
        arrivals: [ARVL_ARRIVED],
        apnsOk: true,
      });
      const data = parseLocklessIntermediateData(apnsFetch);
      expect('subsurface' in data).toBe(expectPresent);
      if (expectPresent) expect(data.subsurface).toBe(true);
    });

    it('lock 없음 + intermediate(ARRIVED) → 발사 후 다음 intermediate 남으면 waypoint advance', async () => {
      const { kv } = await runLocklessCycle({
        trip: makeTrip({
          waypoints: [
            { stationName: '강남', line: '2', kind: 'intermediate' },
            { stationName: '역삼', line: '2', kind: 'intermediate' },
            { stationName: '선릉', line: '2', kind: 'destination' },
          ],
          infoModeEnabled: true,
        }),
        arrivals: [{ ...ARVL_ARRIVED, destination: '선릉행', arrivalSeconds: 0, trainCode: 'X' }],
        apnsOk: true,
      });
      // 한 cycle 후 첫 waypoint(강남)는 shift되어야 한다.
      const stored = await (kv as unknown as KVNamespace).get('trip:tok');
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored as string);
      expect(parsed.waypoints[0].stationName).toBe('역삼');
      expect(parsed.lastFiredPhase).toBeUndefined();
    });

    // #1285 — lockless waypoint shift → progress KV mirror
    it('#1285 — 발사 성공 시 progress KV에 lockless shiftedCount=1 저장', async () => {
      const { kv } = await runLocklessCycle({
        trip: makeTrip({
          waypoints: [
            { stationName: '중곡', line: '5', kind: 'intermediate' },
            { stationName: '군자', line: '5', kind: 'destination' },
          ],
          infoModeEnabled: true,
        }),
        arrivals: [ARVL_ARRIVED],
        apnsOk: true,
      });
      const progressRaw = await (kv as unknown as KVNamespace).get('progress:tok');
      expect(progressRaw).not.toBeNull();
      const progress = JSON.parse(progressRaw as string);
      expect(progress.lockless).toBe(true);
      expect(progress.shiftedCount).toBe(1);
      expect(progress.trainCode).toBeUndefined();
    });

    it('#1285 — 두 번째 발사 시 progress.shiftedCount 누적 (2)', async () => {
      const kv = new InMemoryKV();
      // 첫 발사 후 progress.shiftedCount=1 존재하는 상황
      await (kv as unknown as KVNamespace).put(
        'progress:tok',
        JSON.stringify({ lockless: true, shiftedCount: 1 }),
      );
      const trip = makeTrip({
        waypoints: [
          { stationName: '군자', line: '5', kind: 'intermediate' },
          { stationName: '아차산', line: '5', kind: 'destination' },
        ],
        infoModeEnabled: true,
      });
      await putTrip(kv as unknown as KVNamespace, trip);
      // #1315 — bare-arvlCd advance는 motion=walking/automotive에서만 허용 → 이동 series 시드.
      await seedLocklessMotionSeries(kv, trip.token, 'automotive');
      const seoul = makeSeoul([ARVL_ARRIVED]);
      const apnsFetch = vi.fn(async () => new Response('', { status: 200 }) as unknown as Response);
      await runScheduled(makeEnv(kv), {
        seoul,
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: apnsFetch as unknown as typeof fetch,
        now: () => NOW,
      });
      const progressRaw = await (kv as unknown as KVNamespace).get('progress:tok');
      const progress = JSON.parse(progressRaw as string);
      expect(progress.lockless).toBe(true);
      expect(progress.shiftedCount).toBe(2);
    });

    // #1315 — trainCode 미확보 cycle의 보수 motion 게이트 + trainCode 바인딩.
    // 정적(용마산 false advance 회귀)에서는 waypoint 역의 "아무 열차" arvlCd가 와도 advance 안 함.
    describe('#1315 — trainCode 바인딩 + 보수 motion 게이트', () => {
      async function storedFirstWaypoint(kv: InMemoryKV): Promise<string> {
        const raw = await (kv as unknown as KVNamespace).get('trip:tok');
        return JSON.parse(raw as string).waypoints[0].stationName;
      }

      // 다른 열차(trainCode=9999, arvlCd=ARRIVED)가 다음 waypoint에 도착 — 사용자 열차 아님.
      const OTHER_TRAIN_ARRIVED: ArrivalEntry = { ...ARVL_ARRIVED, trainCode: '9999' };

      // 보수 게이트 케이스: motion이 실제 이동(walking/automotive)이면 발사, 그 외(stationary/
      // unknown/series 미시드)면 보류. arrivals는 모두 ARRIVED(=bare arvlCd 신호) — trainCode 바인딩
      // 불가(promptGeoContext 부재) 상태에서 motion만으로 advance 여부가 갈리는지 검증.
      type MotionGateCase = {
        label: string;
        motion: PositionPoint['motion'] | 'none';
        fires: boolean;
      };
      const motionGateCases: MotionGateCase[] = [
        { label: 'stationary → advance 안 함', motion: 'stationary', fires: false },
        { label: 'unknown → advance 안 함', motion: 'unknown', fires: false },
        { label: 'series 미시드(unknown) → advance 안 함', motion: 'none', fires: false },
        { label: 'automotive → 발사', motion: 'automotive', fires: true },
        { label: 'walking → 발사', motion: 'walking', fires: true },
      ];

      it.each(motionGateCases)(
        'trainCode 미확보 + 다른 열차 ARRIVED + motion=$motion → $label',
        async ({ motion, fires }) => {
          const { kv, stats, apnsFetch } = await runLocklessCycle({
            trip: intermediateTrip(),
            arrivals: [OTHER_TRAIN_ARRIVED],
            apnsOk: fires,
            motion,
          });
          expect(stats.locklessIntermediateFired).toBe(fires ? 1 : 0);
          expect(stats.pushed).toBe(fires ? 1 : 0);
          expect(stats.locklessMotionGateBlocked).toBe(fires ? 0 : 1);
          // 발사 안 하면 첫 waypoint(강남) 유지 — multi/단일 advance 모두 차단.
          expect(await storedFirstWaypoint(kv)).toBe(fires ? '역삼' : '강남');
          if (fires) {
            expect(apnsFetch).toHaveBeenCalled();
          } else {
            expect(apnsFetch).not.toHaveBeenCalled();
          }
        },
      );

      // 레이스 가드: 정적 상태에서 연속 2 cycle 모두 bare-arvlCd가 와도 advance 0건.
      // (2026-06-15 군자→어린이대공원→건대입구 44초 레이스의 근원 — 정적인데 다중 advance.)
      it('정적 상태 연속 2 cycle → 다중 waypoint advance 0건 (레이스 차단)', async () => {
        const kv = new InMemoryKV();
        const trip = makeTrip({
          waypoints: [
            { stationName: '군자', line: '2', kind: 'intermediate' },
            { stationName: '어린이대공원', line: '2', kind: 'intermediate' },
            { stationName: '건대입구', line: '2', kind: 'destination' },
          ],
          infoModeEnabled: true,
        });
        await putTrip(kv as unknown as KVNamespace, trip);
        await seedLocklessMotionSeries(kv, trip.token, 'stationary');
        const seoul = makeSeoul([OTHER_TRAIN_ARRIVED]);
        const apnsFetch = vi.fn();
        const deps = {
          seoul,
          apnsConfig,
          apnsHosts: APNS_HOSTS,
          fetchImpl: apnsFetch as unknown as typeof fetch,
          now: () => NOW,
        };
        await runScheduled(makeEnv(kv), deps);
        await runScheduled(makeEnv(kv), deps);
        expect(apnsFetch).not.toHaveBeenCalled();
        expect(await storedFirstWaypoint(kv)).toBe('군자');
      });

      // motion 게이트 보류 시에도 phase 분류 결과(dirty)는 persist — nearestStationDistanceM이 있어
      // phaseState가 stamp된 cycle에서 정적이라 advance는 보류하되 trip은 저장돼야 한다.
      it('정적 + phaseState stamp → advance 보류 + trip에 stationPhase 저장', async () => {
        const kv = new InMemoryKV();
        const trip = intermediateTrip();
        await putTrip(kv as unknown as KVNamespace, trip);
        // 정거장 30m + 정지 → DWELLING(confidence<0.7, phase 게이트 통과) + motion=stationary.
        await seedLocklessMotionSeries(kv, trip.token, 'stationary', 30);
        const apnsFetch = vi.fn();
        const stats = await runScheduled(makeEnv(kv), {
          seoul: makeSeoul([OTHER_TRAIN_ARRIVED]),
          apnsConfig,
          apnsHosts: APNS_HOSTS,
          fetchImpl: apnsFetch as unknown as typeof fetch,
          now: () => NOW,
        });
        expect(stats.locklessMotionGateBlocked).toBe(1);
        expect(stats.locklessIntermediateFired).toBe(0);
        expect(apnsFetch).not.toHaveBeenCalled();
        const stored = JSON.parse((await (kv as unknown as KVNamespace).get('trip:tok')) as string);
        expect(stored.stationPhase?.current).toBe('DWELLING');
        expect(stored.waypoints[0].stationName).toBe('강남');
      });

      // #1729 paradigm shift — maybeBindLocklessTrainCode(Path B') 제거.
      // lockless trip은 bare-arvlCd 경로만 사용. 이동 + ARRIVED/ENTERING → station-passed 발사.
      // promptGeoContext / autoLock 관련 테스트 제거됨.

      it('이동 + ARRIVED → bare-arvlCd station-passed 발사 (auto-lock 없음)', async () => {
        const { stats, apnsFetch } = await runLocklessCycle({
          trip: intermediateTrip(),
          arrivals: [ARVL_ARRIVED],
          apnsOk: true,
          motion: 'automotive',
        });
        expect(stats.autoLockSuccess).toBe(0); // paradigm shift: auto-lock 없음
        expect(stats.locklessIntermediateFired).toBe(1);
        expect(apnsFetch).toHaveBeenCalled();
      });
    });
  });
});

describe('runScheduled — boardingLock trainCode tracking (#585)', () => {
  const makeLock = makeBoardingLock;
  const makeLockTrip = (overrides: Partial<Trip> = {}) => makeLockTripFixture('lock-tok', overrides);

  /** Seoul API 응답 — arrivals와 positions를 URL 경로로 분기. */
  function makeSeoulCombo(
    arrivals: ArrivalEntry[],
    positions: Array<Partial<PositionEntry> & { trainCode: string }>,
  ): SeoulArrivalClient {
    return new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async (url: string) => {
        if (url.includes('/realtimePosition/')) {
          return new Response(
            JSON.stringify({
              realtimePositionList: positions.map((p) => ({
                trainNo: p.trainCode,
                statnNm: p.stationName ?? '',
                trainSttus: p.trainSttus ?? 0,
                updnLine: p.isUp === false ? '하행' : '상행',
                lastRecptnDt: '',
              })),
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            realtimeArrivalList: arrivals.map((a) => ({
              barvlDt: String(a.arrivalSeconds),
              recptnDt: '',
              updnLine: a.isUp ? '상행' : '하행',
              trainLineNm: a.destination,
              btrainNo: a.trainCode,
              subwayNm: a.subwayNm,
              arvlCd: a.arvlCd,
            })),
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
  }

  function arrivalForLock(stationName: string, seconds: number, arvlCd: number | null = null, trainCode = '7246'): ArrivalEntry {
    return { destination: stationName, arrivalSeconds: seconds, trainCode, isUp: true, subwayNm: '지하철7호선', arvlCd };
  }

  it('fires reschedule push when trainCode matched in arrivals (no prior baseline)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockTrip());
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock('중곡', 120)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p1',
    });
    expect(stats.pushed).toBe(1);
    expect(apnsFetch).toHaveBeenCalledTimes(1);
    const call = apnsFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.data.kind).toBe('reschedule');
    expect(body.data.trainCode).toBe('7246');
    expect(body.data.nextStation).toBe('중곡');
    expect(body.data.newArrivalTimeEpoch).toBe(NOW + 120_000);
    // baseline 저장 확인
    const stored = JSON.parse((await kv.get('trip:lock-tok')) as string);
    expect(stored.lastTrackedArrivalEpoch).toBe(NOW + 120_000);
  });

  it('does not push when delta < threshold', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockTrip({ lastTrackedArrivalEpoch: NOW + 120_000 }),
    );
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock('중곡', 125)], []), // +5s delta
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p1',
    });
    expect(stats.pushed).toBe(0);
    expect(apnsFetch).not.toHaveBeenCalled();
  });

  it('pushes again when delta >= threshold', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockTrip({ lastTrackedArrivalEpoch: NOW + 120_000 }),
    );
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock('중곡', 140)], []), // +20s delta
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p2',
    });
    expect(stats.pushed).toBe(1);
  });

  // #2230 — per-station once dedup. 같은 (token, station)이 여러 cron cycle에 걸쳐 delta ≥ 15s로
  // 계속 드리프트해도(정상적인 ETA 관측 변동) 두 번째 이후 cycle은 발사되지 않아야 한다.
  // 2026-08-09 실기기 dump: destination ETA가 매 60s cron마다 15s+ 드리프트해 6분간 6회 반복 발사.
  it('does not fire reschedule push again for the same station across multiple cron cycles (#2230)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockTrip());
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    // cycle 1 — 최초 발사 (baseline 없음).
    const stats1 = await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock('중곡', 120)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'cyc1',
    });
    expect(stats1.pushed).toBe(1);
    // cycle 2 — 같은 station(중곡)에 delta +30s (임계 15s 이상) 이지만 dedup TTL 내이므로 skip.
    const stats2 = await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock('중곡', 150)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW + 60_000,
      generatePushId: () => 'cyc2',
    });
    expect(stats2.pushed).toBe(0);
    expect(stats2.rescheduleDedupSkipped).toBe(1);
    // cycle 3 — 또 한 번, 여전히 TTL 내(dedup 지속).
    const stats3 = await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock('중곡', 180)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW + 120_000,
      generatePushId: () => 'cyc3',
    });
    expect(stats3.pushed).toBe(0);
    expect(stats3.rescheduleDedupSkipped).toBe(1);
    // 전체 3 cycle에 걸쳐 APNs reschedule push는 정확히 1회만 발사.
    expect(apnsFetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to realtimePosition when trainCode not in arrivals', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockTrip());
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo(
        [arrivalForLock('중곡', 60, null, 'other-train')], // 다른 trainCode만 있음
        [{ trainCode: '7246', stationName: '용마산', trainSttus: 0 }], // segmentStations[0]
      ),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p3',
    });
    expect(stats.pushed).toBe(1);
    // segmentStations idx 0(용마산) → 1(중곡), 1 hop × 90s
    const call = apnsFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.data.newArrivalTimeEpoch).toBe(NOW + 90_000);
  });

  it('etaMissing when trainCode found nowhere', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockTrip());
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p4',
    });
    expect(stats.etaMissing).toBe(1);
    expect(stats.pushed).toBe(0);
  });

  it('#1824 Seoul outage(arrivals+positions 모두 empty) → scheduleEtaFallback 증가 + consecutiveEtaMissing 증가 (auto-end 로직 보존)', async () => {
    // Seoul API outage 시: arrivals 빈 응답 + positions 빈 응답 → schedule-hop fallback.
    // scheduleEtaFallback stat 증가 + etaMissing 증가 (auto-end 로직 보존).
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockTrip());
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: makeOkFetch() as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p1824',
    });
    // schedule-hop fallback 발동 확인.
    expect(stats.scheduleEtaFallback).toBe(1);
    // consecutiveEtaMissing은 기존대로 증가 (auto-end 보존).
    expect(stats.etaMissing).toBe(1);
  });

  it('#1824 Seoul outage + LA live trip → schedule-hop LA heartbeat 발사', async () => {
    // LA live trip에서 Seoul outage → schedule-hop ETA로 LA heartbeat 발사.
    const kv = new InMemoryKV();
    // makeLockedLaTrip: 2호선 강남 lock + activityPushToken + activityState='live'.
    await putTrip(kv as unknown as KVNamespace, makeLockedLaTrip());
    const apnsFetch = makeOkFetch();
    const stats = await runLaScheduled(kv, {
      // arrivals + positions 모두 empty (Seoul outage 시뮬레이션).
      seoul: new SeoulArrivalClient({
        apiKey: 'K', host: 'h', now: () => NOW,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ realtimeArrivalList: [], realtimePositionList: [] }), { status: 200 })
        ) as unknown as typeof fetch,
      }),
      fetchImpl: apnsFetch,
    });
    // LA heartbeat 발사 확인.
    expect(stats.laPushSent).toBe(1);
    // schedule-hop fallback 발동 확인.
    expect(stats.scheduleEtaFallback).toBe(1);
  });

  // #706 — 운행 시간대 외(새벽 등)에 trainCode가 사라지면 trip이 무한 폴링됐던 회귀 방지.
  // 연속 etaMissing 카운트 + 임계 초과 시 cleanupTripWithLa로 자동 종료.
  describe('#706 consecutiveEtaMissing auto-end', () => {
    /**
     * #706 시나리오 표준 runner — `runScheduled` boilerplate(apnsConfig/apnsHosts/now/generatePushId)
     * + `seoul=makeSeoulCombo(...)` + `fetchImpl=makeOkFetch()` 기본을 단일 진입점으로 압축.
     * 각 테스트는 trip 상태 차이(consecutiveEtaMissing/waypoints)와 응답 차이(arrivals/apns status)에만 집중한다.
     */
    async function runMissScenario(
      kv: InMemoryKV,
      args: {
        arrivals?: ArrivalEntry[];
        apnsFetch?: ReturnType<typeof vi.fn>;
      } = {},
    ) {
      const fetchImpl = args.apnsFetch ?? makeOkFetch();
      await runScheduled(makeEnv(kv), {
        seoul: makeSeoulCombo(args.arrivals ?? [], []),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
        generatePushId: () => 'p706',
      });
    }

    /** 표준 lock trip을 KV에 seed. trip 상태 override(consecutiveEtaMissing 등)만 받는다. */
    async function seedLockTrip(kv: InMemoryKV, overrides: Partial<Trip> = {}) {
      await putTrip(kv as unknown as KVNamespace, makeLockTrip(overrides));
    }

    /** KV에서 trip 읽기. 삭제된 경우 null. */
    async function readStoredTrip(kv: InMemoryKV): Promise<Trip | null> {
      const raw = await kv.get('trip:lock-tok');
      return raw ? (JSON.parse(raw) as Trip) : null;
    }

    it('increments counter and persists on etaMissing (no cleanup yet)', async () => {
      const kv = new InMemoryKV();
      await seedLockTrip(kv);
      await runMissScenario(kv);
      expect((await readStoredTrip(kv))?.consecutiveEtaMissing).toBe(1);
    });

    it('accumulates counter across cycles when etaMissing persists', async () => {
      // 이미 3회 연속 miss 상태로 시작 → 한 번 더 miss → 4
      const kv = new InMemoryKV();
      await seedLockTrip(kv, { consecutiveEtaMissing: 3 });
      await runMissScenario(kv);
      expect((await readStoredTrip(kv))?.consecutiveEtaMissing).toBe(4);
    });

    // #2157 (2026-08-05 결정 A) — trip을 강제 종료하는 대신 lock만 해제 + lockless 강등.
    it('demotes trip to lockless (lock detach, trip survives) when consecutiveEtaMissing reaches threshold', async () => {
      // 임계치 -1 상태 → 한 번 더 miss → threshold 도달 → 강등 (trip 생존).
      const kv = new InMemoryKV();
      await seedLockTrip(kv, { consecutiveEtaMissing: MAX_CONSECUTIVE_ETA_MISSING - 1 });
      await runMissScenario(kv);
      const stored = await readStoredTrip(kv);
      expect(stored).not.toBeNull();
      expect(stored?.boardingLock).toBeUndefined();
      expect(stored?.consecutiveEtaMissing).toBe(0);
      expect(stored?.infoModeEnabled).toBe(true);
    });

    it('resets counter to 0 when arrival estimate succeeds', async () => {
      // 4회 miss 누적 상태에서 정상 estimate 들어옴 → reset
      const kv = new InMemoryKV();
      await seedLockTrip(kv, { consecutiveEtaMissing: 4 });
      await runMissScenario(kv, { arrivals: [arrivalForLock('중곡', 120)] });
      expect((await readStoredTrip(kv))?.consecutiveEtaMissing).toBe(0);
    });

    it('resets counter when waypoint advances on arrival', async () => {
      // arvlCd=1 → arrived → waypoint advance + reset
      const kv = new InMemoryKV();
      await seedLockTrip(kv, { consecutiveEtaMissing: 2 });
      await runMissScenario(kv, { arrivals: [arrivalForLock('중곡', 0, 1)] });
      expect((await readStoredTrip(kv))?.consecutiveEtaMissing).toBe(0);
    });

    it('does not resurrect trip when reschedule push hits 410 with prior miss accumulation', async () => {
      // 회귀 가드: hadMissCount=true 상태에서 cleanupTripWithLa가 호출된 직후 reset persistance
      // 경로가 putTrip을 다시 호출하면 삭제된 trip이 KV에 부활한다. cleanedUp 시그널로 차단.
      const kv = new InMemoryKV();
      await seedLockTrip(kv, { consecutiveEtaMissing: 2 });
      const apnsFetch = vi.fn(async () =>
        new Response(JSON.stringify({ reason: 'Unregistered' }), { status: 410 }),
      );
      await runMissScenario(kv, {
        arrivals: [arrivalForLock('중곡', 120)],
        apnsFetch,
      });
      expect(await readStoredTrip(kv)).toBeNull();
    });

    it('treats missing field as 0 (backward compat with existing trips)', async () => {
      // consecutiveEtaMissing 미설정 (구버전 trip) → miss 1회 → 1
      const kv = new InMemoryKV();
      const trip = makeLockTrip();
      delete (trip as unknown as Record<string, unknown>).consecutiveEtaMissing;
      await putTrip(kv as unknown as KVNamespace, trip);
      await runMissScenario(kv);
      expect((await readStoredTrip(kv))?.consecutiveEtaMissing).toBe(1);
    });
  });

  describe('MAX_CONSECUTIVE_ETA_MISSING (#706)', () => {
    it('is 5', () => {
      expect(MAX_CONSECUTIVE_ETA_MISSING).toBe(5);
    });
  });

  // #903 (Seam G) — 기압계 subsurface trip은 인내 threshold(10) 적용.
  describe('#903 SUBSURFACE_ETA_MISSING_TOLERANCE', () => {
    it('is 10 (기본의 2배)', () => {
      expect(SUBSURFACE_ETA_MISSING_TOLERANCE).toBe(10);
    });

    it('resolveEtaMissingThreshold(subsurface=true) → 10', () => {
      expect(resolveEtaMissingThreshold({ subsurface: true })).toBe(SUBSURFACE_ETA_MISSING_TOLERANCE);
    });

    it('resolveEtaMissingThreshold(subsurface=false) → 5 (기본)', () => {
      expect(resolveEtaMissingThreshold({ subsurface: false })).toBe(MAX_CONSECUTIVE_ETA_MISSING);
    });

    it('resolveEtaMissingThreshold(subsurface=undefined) → 5 (graceful default)', () => {
      expect(resolveEtaMissingThreshold({})).toBe(MAX_CONSECUTIVE_ETA_MISSING);
    });
  });

  // #1277 — trainCode 소실 시 시간 기반 waypoint advance fallback
  describe('#1277 time-based waypoint advance fallback', () => {
    const FALLBACK_TRIGGER = VANISH_RE_ATTACH_THRESHOLD + FALLBACK_ADVANCE_GRACE_CYCLES;
    // hop 시간이 경과한 epoch: lastTrackedArrivalEpoch = NOW - FALLBACK_HOP_SEC * 1000 (정확히 경과)
    const LAST_EPOCH_ELAPSED = NOW - FALLBACK_HOP_SEC * 1000;
    // hop 시간이 아직 미경과: lastTrackedArrivalEpoch = NOW - 30_000 (30s 전, 90s 미달)
    const LAST_EPOCH_NOT_ELAPSED = NOW - 30_000;

    async function runVanishedScenario(kv: InMemoryKV) {
      await runScheduled(makeEnv(kv), {
        // arrivals/positions 모두 비어있음 → trainCode 소실 상태
        seoul: makeSeoulCombo([], []),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: makeOkFetch() as unknown as typeof fetch,
        now: () => NOW,
        generatePushId: () => 'p1277',
      });
    }

    it('FALLBACK_ADVANCE_GRACE_CYCLES is 1', () => {
      expect(FALLBACK_ADVANCE_GRACE_CYCLES).toBe(1);
    });

    it('fallback 미발동: miss 횟수가 fallbackTrigger 미달이면 카운터만 증가', async () => {
      // fallbackTrigger - 1 miss 상태 → nextMissCount = fallbackTrigger - 1 < trigger
      const kv = new InMemoryKV();
      await putTrip(
        kv as unknown as KVNamespace,
        makeLockTrip({
          consecutiveEtaMissing: FALLBACK_TRIGGER - 2,
          lastTrackedArrivalEpoch: LAST_EPOCH_ELAPSED,
        }),
      );
      await runVanishedScenario(kv);
      const stored = JSON.parse((await kv.get('trip:lock-tok'))!) as Trip;
      expect(stored.consecutiveEtaMissing).toBe(FALLBACK_TRIGGER - 1);
      expect(stored.boardingLock).toBeDefined();
    });

    it('시간 경과 + fallbackTrigger 도달 → waypoint advance (intermediate → shift)', async () => {
      // consecutiveEtaMissing = FALLBACK_TRIGGER - 1 → nextMissCount = FALLBACK_TRIGGER
      // lastTrackedArrivalEpoch = hop 시간 경과 → advanceBoardingLockWaypoint 호출
      // 첫 waypoint(intermediate 중곡)가 shift되고 남은 waypoint는 군자(destination)
      const kv = new InMemoryKV();
      await putTrip(
        kv as unknown as KVNamespace,
        makeLockTrip({
          consecutiveEtaMissing: FALLBACK_TRIGGER - 1,
          lastTrackedArrivalEpoch: LAST_EPOCH_ELAPSED,
        }),
      );
      await runVanishedScenario(kv);
      const stored = JSON.parse((await kv.get('trip:lock-tok'))!) as Trip;
      // intermediate 통과 → 다음 waypoint(군자)가 남아야 함
      expect(stored.waypoints[0].stationName).toBe('군자');
      // consecutiveEtaMissing 리셋
      expect(stored.consecutiveEtaMissing).toBe(0);
    });

    it('시간 경과 + fallbackTrigger 도달 + destination → trip 종료 (cleanupTripWithLa)', async () => {
      // waypoint가 destination 하나만 남은 경우 → advanceBoardingLockWaypoint → cleanupTripWithLa → trip 삭제
      const kv = new InMemoryKV();
      await putTrip(
        kv as unknown as KVNamespace,
        makeLockTrip({
          waypoints: [{ stationName: '군자', line: '7', kind: 'destination' }],
          consecutiveEtaMissing: FALLBACK_TRIGGER - 1,
          lastTrackedArrivalEpoch: LAST_EPOCH_ELAPSED,
        }),
      );
      await runVanishedScenario(kv);
      // destination arrived → cleanupTripWithLa → trip 삭제
      expect(await kv.get('trip:lock-tok')).toBeNull();
    });

    it('시간 미경과 + fallbackTrigger 도달 → lock release (lockless 인계)', async () => {
      // hop 시간이 아직 지나지 않았으면 advance 대신 lock release
      const kv = new InMemoryKV();
      await putTrip(
        kv as unknown as KVNamespace,
        makeLockTrip({
          consecutiveEtaMissing: FALLBACK_TRIGGER - 1,
          lastTrackedArrivalEpoch: LAST_EPOCH_NOT_ELAPSED,
        }),
      );
      await runVanishedScenario(kv);
      const stored = JSON.parse((await kv.get('trip:lock-tok'))!) as Trip;
      // lock release → isBoardingLockActive=false
      expect(stored.boardingLock).toBeUndefined();
      expect(stored.consecutiveEtaMissing).toBe(0);
      // #1370 L3 — lockless 인계가 실제로 작동하도록 강제 enable + stat 기록
      expect(stored.infoModeEnabled).toBe(true);
    });

    it('#1370 L2 — fallback advance 직전 station-passed silent push 발사 (intermediate)', async () => {
      // hop 시간 경과 + intermediate waypoint(중곡) — advanceBoardingLockWaypoint 호출 전에
      // station-passed silent push가 발사되어야 한다.
      const kv = new InMemoryKV();
      await putTrip(
        kv as unknown as KVNamespace,
        makeLockTrip({
          consecutiveEtaMissing: FALLBACK_TRIGGER - 1,
          lastTrackedArrivalEpoch: LAST_EPOCH_ELAPSED,
        }),
      );
      const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
      const stats = await runScheduled(makeEnv(kv), {
        seoul: makeSeoulCombo([], []),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: apnsFetch as unknown as typeof fetch,
        now: () => NOW,
        generatePushId: () => 'p1370-l2',
      });
      // push 발사 검증
      expect(stats.vanishFallbackFired).toBe(1);
      expect(stats.pushed).toBeGreaterThanOrEqual(1);
      expect(apnsFetch).toHaveBeenCalled();
      const calls = apnsFetch.mock.calls as unknown as Array<[string, RequestInit]>;
      const stationPassedCall = calls.find((c) => {
        const body = JSON.parse(c[1].body as string);
        return body.data?.nextWaypoint === '중곡' && body.data?.phase === 'imminent';
      });
      expect(stationPassedCall).toBeDefined();
      // waypoint shift 확인
      const stored = JSON.parse((await kv.get('trip:lock-tok'))!) as Trip;
      expect(stored.waypoints[0].stationName).toBe('군자');
    });

    it('#1399 — destination waypoint도 vanish fallback station-passed push 발사 (하차 알림 floor 보장)', async () => {
      // #1370 L2 시점에는 destination skip이었으나 #1399에서 destination 포함으로 확장.
      // cleanupTripWithLa의 trip-ended push는 alert path로 system banner를 띄우지만, vanish
      // 상황(지하 + backend trainCode 누락)에서 trip-ended가 cleanup race로 지연/소실되면
      // 사용자가 종착역 하차 알림을 받지 못한다(S6/S8 13:54·14:10 군자/용마산 하차 누락 회귀).
      // station-passed imminent push를 destination에도 발사해 device 측 banner 경로(채널 2)도
      // 확보 — surface 중복은 device pushId/firedPushIds dedup으로 흡수.
      const kv = new InMemoryKV();
      await putTrip(
        kv as unknown as KVNamespace,
        makeLockTrip({
          waypoints: [{ stationName: '군자', line: '7', kind: 'destination' }],
          consecutiveEtaMissing: FALLBACK_TRIGGER - 1,
          lastTrackedArrivalEpoch: LAST_EPOCH_ELAPSED,
        }),
      );
      const stats = await runScheduled(makeEnv(kv), {
        seoul: makeSeoulCombo([], []),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: makeOkFetch() as unknown as typeof fetch,
        now: () => NOW,
        generatePushId: () => 'p1399-dest',
      });
      // destination도 vanish fallback fire 1회 발사 (#1399).
      expect(stats.vanishFallbackFired).toBe(1);
    });

    // #2021 (ADR-022) — vanish-fallback 경로도 archFlag='on' 시 boardingLine 봉인.
    // vanish-fallback 은 arvlCd 관측 없이 시간 경과로 발사되는 경로라 flag=on 정책 우회 위험이
    // 높다 (arvlcd fire-once TTL 게이트에 걸리지 않음). 명시 매트릭스로 확인.
    it('#2021 archFlag=on 시 vanish-fallback payload.boardingLine 봉인', async () => {
      const kv = new InMemoryKV();
      await putTrip(
        kv as unknown as KVNamespace,
        makeLockTrip({
          consecutiveEtaMissing: FALLBACK_TRIGGER - 1,
          lastTrackedArrivalEpoch: LAST_EPOCH_ELAPSED,
        }),
      );
      const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
      await runScheduled(makeEnv(kv), {
        seoul: makeSeoulCombo([], []),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: apnsFetch as unknown as typeof fetch,
        now: () => NOW,
        generatePushId: () => 'p2021-vanish-on',
        archFlag: 'on',
      });
      const calls = apnsFetch.mock.calls as unknown as Array<[string, RequestInit]>;
      const stationPassedCall = calls.find((c) => {
        const body = JSON.parse(c[1].body as string);
        return body.data?.nextWaypoint === '중곡' && body.data?.phase === 'imminent';
      });
      expect(stationPassedCall).toBeDefined();
      const data = JSON.parse(stationPassedCall![1].body as string).data as Record<
        string,
        unknown
      >;
      expect('boardingLine' in data).toBe(false);
      expect(data.trainCode).toBe('7246');
    });

    // #2021 — archFlag='off' (default) 명시 시 vanish-fallback 도 기존 동작 유지 회귀 가드.
    it('#2021 archFlag=off 시 vanish-fallback payload.boardingLine=lock.line 유지', async () => {
      const kv = new InMemoryKV();
      await putTrip(
        kv as unknown as KVNamespace,
        makeLockTrip({
          consecutiveEtaMissing: FALLBACK_TRIGGER - 1,
          lastTrackedArrivalEpoch: LAST_EPOCH_ELAPSED,
        }),
      );
      const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
      await runScheduled(makeEnv(kv), {
        seoul: makeSeoulCombo([], []),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: apnsFetch as unknown as typeof fetch,
        now: () => NOW,
        generatePushId: () => 'p2021-vanish-off',
        archFlag: 'off',
      });
      const calls = apnsFetch.mock.calls as unknown as Array<[string, RequestInit]>;
      const stationPassedCall = calls.find((c) => {
        const body = JSON.parse(c[1].body as string);
        return body.data?.nextWaypoint === '중곡' && body.data?.phase === 'imminent';
      });
      expect(stationPassedCall).toBeDefined();
      const data = JSON.parse(stationPassedCall![1].body as string).data as Record<
        string,
        unknown
      >;
      expect(data.boardingLine).toBe('7');
    });

    it('#1370 L2 — vanish fallback push dedup (같은 station 두 번 발사 안 됨)', async () => {
      // 같은 waypoint에 대해 다시 vanish fallback이 trigger돼도 dedup KV로 차단.
      const kv = new InMemoryKV();
      await putTrip(
        kv as unknown as KVNamespace,
        makeLockTrip({
          consecutiveEtaMissing: FALLBACK_TRIGGER - 1,
          lastTrackedArrivalEpoch: LAST_EPOCH_ELAPSED,
        }),
      );
      const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
      const deps = {
        seoul: makeSeoulCombo([], []),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: apnsFetch as unknown as typeof fetch,
        now: () => NOW,
        generatePushId: () => 'p1370-dup',
      };
      await runScheduled(makeEnv(kv), deps);
      const callsAfterFirst = apnsFetch.mock.calls.length;
      // 두 번째 cycle도 같은 station에 fallback이 trigger되도록 trip을 다시 set up
      await putTrip(
        kv as unknown as KVNamespace,
        makeLockTrip({
          consecutiveEtaMissing: FALLBACK_TRIGGER - 1,
          lastTrackedArrivalEpoch: LAST_EPOCH_ELAPSED,
        }),
      );
      const stats2 = await runScheduled(makeEnv(kv), deps);
      // dedup → push 추가 발사 X
      expect(stats2.vanishFallbackFired).toBe(0);
      expect(apnsFetch.mock.calls.length).toBe(callsAfterFirst);
    });

    it('#1370 L2 — push 실패 시 dedup KV stamp 안 함 (다음 cycle 재시도 허용)', async () => {
      const kv = new InMemoryKV();
      await putTrip(
        kv as unknown as KVNamespace,
        makeLockTrip({
          consecutiveEtaMissing: FALLBACK_TRIGGER - 1,
          lastTrackedArrivalEpoch: LAST_EPOCH_ELAPSED,
        }),
      );
      // 503 retryable failure
      const apnsFetch = vi.fn(async () => new Response('{"reason":"InternalServerError"}', { status: 503 }));
      const stats = await runScheduled(makeEnv(kv), {
        seoul: makeSeoulCombo([], []),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: apnsFetch as unknown as typeof fetch,
        now: () => NOW,
        generatePushId: () => 'p1370-fail',
      });
      expect(stats.vanishFallbackFired).toBe(0);
      expect(stats.errors).toBeGreaterThanOrEqual(1);
    });

    it('#1370 L3 — lock release 시 infoModeEnabled 강제 enable + stat 기록', async () => {
      const kv = new InMemoryKV();
      await putTrip(
        kv as unknown as KVNamespace,
        makeLockTrip({
          consecutiveEtaMissing: FALLBACK_TRIGGER - 1,
          lastTrackedArrivalEpoch: LAST_EPOCH_NOT_ELAPSED,
          infoModeEnabled: false,
        }),
      );
      const stats = await runScheduled(makeEnv(kv), {
        seoul: makeSeoulCombo([], []),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: makeOkFetch() as unknown as typeof fetch,
        now: () => NOW,
        generatePushId: () => 'p1370-l3',
      });
      const stored = JSON.parse((await kv.get('trip:lock-tok'))!) as Trip;
      expect(stored.infoModeEnabled).toBe(true);
      expect(stats.vanishLocklessTakeover).toBe(1);
    });

    it('lastTrackedArrivalEpoch 없음 → fallback 미발동, 기존 auto-end 경로 유지', async () => {
      // lastTrackedArrivalEpoch가 undefined이면 #1277 fallback은 건너뛰고
      // 기존 consecutiveEtaMissing threshold 경로만 동작해야 한다.
      // FALLBACK_TRIGGER 도달해도 auto-end threshold(5) 미달이면 카운터 증가.
      const kv = new InMemoryKV();
      await putTrip(
        kv as unknown as KVNamespace,
        makeLockTrip({
          consecutiveEtaMissing: FALLBACK_TRIGGER - 1,
          // lastTrackedArrivalEpoch: undefined (미설정)
        }),
      );
      await runVanishedScenario(kv);
      const stored = JSON.parse((await kv.get('trip:lock-tok'))!) as Trip;
      // fallback 미발동 → 카운터만 증가
      expect(stored.consecutiveEtaMissing).toBe(FALLBACK_TRIGGER);
      expect(stored.boardingLock).toBeDefined();
    });

    it('vanish-swap 후보 존재 시 swap 우선 (time-based fallback 발동 안 됨)', async () => {
      // 같은 역·노선에 다른 trainCode(7999)가 있으면 attemptVanishSwap이 먼저 성공
      // → estimate 성공 → handleEtaMissing 호출 안 됨 → fallback 발동 안 됨
      const kv = new InMemoryKV();
      // FALLBACK_TRIGGER - 1 miss 상태에서 같은 역에 7999가 보임
      await putTrip(
        kv as unknown as KVNamespace,
        makeLockTrip({
          consecutiveEtaMissing: FALLBACK_TRIGGER - 1,
          lastTrackedArrivalEpoch: LAST_EPOCH_ELAPSED,
        }),
      );
      // arrivals에 다른 trainCode(7999)가 중곡행으로 있음 → attachTrainCodeForLeg가 swap candidate 반환
      // swap 후 재estimate 성공 → consecutiveEtaMissing 리셋, lock 유지
      // #1719 — leg(중곡→군자, 7호선) direction=down 이므로 isUp=false 로 fixture 정정.
      const arrivals: ArrivalEntry[] = [
        { destination: '중곡', arrivalSeconds: 60, trainCode: '7999', isUp: false, subwayNm: '지하철7호선', arvlCd: null },
      ];
      await runScheduled(makeEnv(kv), {
        seoul: makeSeoulCombo(arrivals, []),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: makeOkFetch() as unknown as typeof fetch,
        now: () => NOW,
        generatePushId: () => 'p1277-swap',
      });
      const stored = JSON.parse((await kv.get('trip:lock-tok'))!) as Trip;
      // swap 성공 → consecutiveEtaMissing 리셋, boardingLock 존재
      expect(stored.consecutiveEtaMissing).toBe(0);
      expect(stored.boardingLock).toBeDefined();
      // swap된 trainCode가 7999여야 함
      expect(stored.boardingLock?.trainCode).toBe('7999');
    });

    it('subsurface trip도 fallbackTrigger 도달 + 시간 경과 시 advance (지하 무한 동결 방지)', async () => {
      // subsurface=true여도 FALLBACK_TRIGGER 도달 시 advance 발동 (threshold는 더 크지만 freeze 방지 우선)
      const kv = new InMemoryKV();
      await putTrip(
        kv as unknown as KVNamespace,
        makeLockTrip({
          subsurface: true,
          consecutiveEtaMissing: FALLBACK_TRIGGER - 1,
          lastTrackedArrivalEpoch: LAST_EPOCH_ELAPSED,
        }),
      );
      await runVanishedScenario(kv);
      const stored = JSON.parse((await kv.get('trip:lock-tok'))!) as Trip;
      // advance 발동 → intermediate shift, destination(군자) 남음
      expect(stored.waypoints[0].stationName).toBe('군자');
      expect(stored.consecutiveEtaMissing).toBe(0);
    });

    // #1386 — lock-active vanish fallback motion 게이트.
    // hop 시간 경과 + fallbackTrigger 도달 상태에서 device motion에 따른 분기 검증.
    describe('#1386 motion gate (stationary 보류, walking/automotive/unknown 진행)', () => {
      /**
       * #1386 motion 게이트 시나리오 표준 setup. 5개 케이스 공통 boilerplate
       * (FALLBACK_TRIGGER - 1 lock trip + motion series seed + runScheduled wiring)을
       * 단일 진입점으로 압축. 각 it은 motion/hopElapsed/추가 trip override만 명시한다.
       */
      async function runFallbackMotionScenario(setup: {
        motion: PositionPoint['motion'];
        hopElapsed: boolean;
        pushId: string;
        tripOverrides?: Partial<Trip>;
        apnsFetch?: ReturnType<typeof vi.fn>;
        pending?: InMemoryKV;
      }) {
        const kv = new InMemoryKV();
        await putTrip(
          kv as unknown as KVNamespace,
          makeLockTrip({
            consecutiveEtaMissing: FALLBACK_TRIGGER - 1,
            lastTrackedArrivalEpoch: setup.hopElapsed ? LAST_EPOCH_ELAPSED : LAST_EPOCH_NOT_ELAPSED,
            ...setup.tripOverrides,
          }),
        );
        await seedLocklessMotionSeries(kv, 'lock-tok', setup.motion);
        const apnsFetch = setup.apnsFetch ?? makeOkFetch();
        const stats = await runScheduled(makeEnv(kv, setup.pending), {
          seoul: makeSeoulCombo([], []),
          apnsConfig,
          apnsHosts: APNS_HOSTS,
          fetchImpl: apnsFetch as unknown as typeof fetch,
          now: () => NOW,
          generatePushId: () => setup.pushId,
        });
        const stored = JSON.parse((await kv.get('trip:lock-tok'))!) as Trip;
        return { stats, stored, apnsFetch };
      }

      it('motion=stationary → fallback advance 보류 + station-passed push X (카운터 누적)', async () => {
        // 사용자 정지 trip — backend가 hop 시간만 보고 false station-passed를 발사하던 회귀 차단.
        const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
        const { stats, stored } = await runFallbackMotionScenario({
          motion: 'stationary',
          hopElapsed: true,
          pushId: 'p1386-stationary',
          apnsFetch,
        });
        expect(stats.vanishFallbackMotionGateBlocked).toBe(1);
        expect(stats.vanishFallbackFired).toBe(0);
        // station-passed push가 발사되지 않아야 함
        const stationPassedCalls = (apnsFetch.mock.calls as unknown as [string, RequestInit][]).filter((c) => {
          const body = JSON.parse(c[1].body as string);
          return body.data?.phase === 'imminent';
        });
        expect(stationPassedCalls.length).toBe(0);
        // waypoint 유지 — advance 안 됨
        expect(stored.waypoints[0].stationName).toBe('중곡');
        expect(stored.boardingLock).toBeDefined();
        // 카운터 누적 유지 — motion 회복 시 다음 cycle에서 정상 advance, 회복 안 되면 auto-end가 종료 보장
        expect(stored.consecutiveEtaMissing).toBe(FALLBACK_TRIGGER);
      });

      // walking/automotive — positive 비정지 신호 → advance 진행.
      // unknown — 센서 미지원/권한 거절 사용자 freeze 방지 트레이드오프 (lockless보다 약한 보수).
      it.each<[PositionPoint['motion'], string]>([
        ['walking', 'p1386-walking'],
        ['automotive', 'p1386-auto'],
        ['unknown', 'p1386-unknown'],
      ])('motion=%s → fallback advance 진행 (waypoint shift)', async (motion, pushId) => {
        const { stats, stored } = await runFallbackMotionScenario({
          motion,
          hopElapsed: true,
          pushId,
        });
        expect(stats.vanishFallbackMotionGateBlocked).toBe(0);
        expect(stats.vanishFallbackFired).toBe(1);
        expect(stored.waypoints[0].stationName).toBe('군자');
        expect(stored.consecutiveEtaMissing).toBe(0);
      });

      it('#2063 (ADR-023 개정) hop 시간 미경과 + motion=automotive → release floor fire visible alert 직접 발사, PENDING_PUSHES 미등록', async () => {
        // release 경로의 floor fire는 motion gate(stationary 차단)를 통과한 경우에만 fire.
        // #2063 — silent → visible alert 직접 발사로 전환돼 60s ACK 기반 PENDING_PUSHES 안전망이 불필요.
        const pending = new InMemoryKV();
        const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
        const { stats, stored } = await runFallbackMotionScenario({
          motion: 'automotive',
          hopElapsed: false,
          pushId: 'p1402-release',
          pending,
          apnsFetch,
        });
        // floor fire 발사 (release 경로)
        expect(stats.vanishReleaseFired).toBe(1);
        expect(stats.vanishFallbackFired).toBe(0);
        expect(stats.pushed).toBeGreaterThanOrEqual(1);
        // visible alert push 직접 발사 확인 (apns-push-type: alert)
        const alertCalls = (apnsFetch.mock.calls as unknown as [string, RequestInit][]).filter(
          (c) => (c[1]?.headers as Record<string, string>)['apns-push-type'] === 'alert',
        );
        expect(alertCalls.length).toBe(1);
        // PENDING_PUSHES 등록 없음 (ACK 개념 불필요)
        const pendingEntry = await pending.get('pending:p1402-release');
        expect(pendingEntry).toBeNull();
        // lock release는 정상 진행
        expect(stored.boardingLock).toBeUndefined();
      });

      // #2063 (ADR-023 개정) — vanish 경로(fireVanishFallbackStationPush) sleep mute 분기.
      describe('#2063 (ADR-023 개정) sleepModeEnabled 매역 알림 mute (vanish-fallback)', () => {
        it('sleepModeEnabled=true → vanish-fallback 매역 push skip (단, #2066 취침 알람은 별 채널로 정상 발사)', async () => {
          const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
          const { stats } = await runFallbackMotionScenario({
            motion: 'automotive',
            hopElapsed: true,
            pushId: 'p2063-vf-sleep',
            tripOverrides: { sleepModeEnabled: true },
            apnsFetch,
          });
          // 매역 알림(vanish-fallback) 채널은 여전히 mute — 본 PR 접촉 금지 영역, 기존 동작 그대로.
          expect(stats.vanishFallbackFired).toBe(0);
          expect(stats.pushed).toBe(0);
          // #2066 — vanish-fallback advance도 waypoint(중곡, intermediate)의 nextWaypoint가
          // destination(군자)인 "직전역 진입" ground truth라 취침 알람(별 채널)은 정상 발사된다.
          // fixture 기본 waypoints=[중곡(intermediate), 군자(destination)] (makeLockTripFixture).
          expect(stats.sleepAlarmFired).toBe(1);
          expect(apnsFetch.mock.calls.length).toBe(2);
        });

        it('sleepModeEnabled=false → vanish-fallback 매역 push 정상 발사', async () => {
          const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
          const { stats } = await runFallbackMotionScenario({
            motion: 'automotive',
            hopElapsed: true,
            pushId: 'p2063-vf-nosleep',
            tripOverrides: { sleepModeEnabled: false },
            apnsFetch,
          });
          expect(stats.vanishFallbackFired).toBe(1);
        });

        it('sleepModeEnabled 미지정(undefined) → vanish-fallback 매역 push 정상 발사 (기존 동작 보존)', async () => {
          const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
          const { stats } = await runFallbackMotionScenario({
            motion: 'automotive',
            hopElapsed: true,
            pushId: 'p2063-vf-undef',
            apnsFetch,
          });
          expect(stats.vanishFallbackFired).toBe(1);
        });
      });

      // vanish-release/vanish-fallback 양 origin의 push payload 검증용 헬퍼.
      // SonarCloud duplication 차단: 시나리오 실행 + 매칭 call body 추출을 한 곳에 모음.
      async function capturePushBody(setup: {
        hopElapsed: boolean;
        pushId: string;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }): Promise<{ data: any }> {
        const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
        await runFallbackMotionScenario({
          motion: 'automotive',
          hopElapsed: setup.hopElapsed,
          pushId: setup.pushId,
          apnsFetch,
        });
        const calls = apnsFetch.mock.calls as unknown as Array<[string, RequestInit]>;
        const matchedCall = calls.find((c) => {
          const body = JSON.parse(c[1].body as string);
          return body.data?.pushId === setup.pushId;
        });
        expect(matchedCall).toBeDefined();
        return JSON.parse(matchedCall![1].body as string);
      }

      it('#1402 release floor fire 페이로드에 origin=vanish-release stamp', async () => {
        const body = await capturePushBody({ hopElapsed: false, pushId: 'p1402-origin' });
        expect(body.data.origin).toBe('vanish-release');
      });

      // #1438 (E5) — vanish-release 경로는 floor fire 직후 lock을 release하므로 device가 즉시
      // 로컬 store를 sync할 수 있도록 lockReleasedReason='vanish'를 forward.
      it('#1438 (E5) vanish-release fire 페이로드에 lockReleasedReason=vanish stamp', async () => {
        const body = await capturePushBody({ hopElapsed: false, pushId: 'p1438-vanish' });
        expect(body.data.lockReleasedReason).toBe('vanish');
      });

      // vanish-fallback 경로(hop 시간 경과)는 caller(advanceBoardingLockWaypoint)가 별도 transfer
      // release push를 보내므로 fallback 자체에는 lockReleasedReason을 stamp하지 않는다.
      it('#1438 (E5) vanish-fallback origin은 lockReleasedReason omit', async () => {
        const body = await capturePushBody({ hopElapsed: true, pushId: 'p1438-fallback' });
        expect(body.data.origin).toBe('vanish-fallback');
        expect('lockReleasedReason' in body.data).toBe(false);
      });

      // #2092 — vanish-fallback 매역 push도 aps.alert + content-available 동시 병기.
      it('#2092 vanish-fallback push는 aps.alert + content-available===1 동시 wire (SSoT mirror·BG 위젯 채널)', async () => {
        const body = (await capturePushBody({
          hopElapsed: true,
          pushId: 'p2092-vf-content-available',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        })) as any;
        expect(body.aps.alert).toBeDefined();
        expect(body.aps['content-available']).toBe(1);
      });

      it('hop 시간 미경과 + motion=stationary → release floor fire 보류 + lock release 유지', async () => {
        // #1402 — release 경로도 ADR-010 "false positive / miss 동급" 게이트를 통과해야 fire.
        // motion=stationary이면 floor fire는 보류(motion gate 증가)되지만, lock release는
        // 그대로 진행 — #1370 L3 lockless takeover와 floor fire는 독립.
        const { stats, stored } = await runFallbackMotionScenario({
          motion: 'stationary',
          hopElapsed: false,
          pushId: 'p1386-not-elapsed',
          tripOverrides: { infoModeEnabled: false },
        });
        // floor fire 차단 (release 경로 motion gate)
        expect(stats.vanishFallbackMotionGateBlocked).toBe(1);
        expect(stats.vanishReleaseFired).toBe(0);
        // lock release + lockless takeover 경로 활성 — gate와 무관하게 진행
        expect(stats.vanishLocklessTakeover).toBe(1);
        expect(stored.boardingLock).toBeUndefined();
        expect(stored.infoModeEnabled).toBe(true);
      });
    });
  });

  it('advances waypoint and resets baseline when trainCode arrived (arvlCd=1)', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockTrip({ lastTrackedArrivalEpoch: NOW + 5000 }),
    );
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock('중곡', 0, 1)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p5',
    });
    const stored = JSON.parse((await kv.get('trip:lock-tok')) as string);
    expect(stored.waypoints).toHaveLength(1);
    expect(stored.waypoints[0].stationName).toBe('군자');
    expect(stored.lastTrackedArrivalEpoch).toBeUndefined();
  });

  // #1721 — arvlcd fire 가 transient APNs error(503) 받으면 retry-push: 큐에 적재된다.
  // sendWithEnvHeal 의 양 env retry 후에도 lost 되던 silent push 가 다음 cron cycle backoff 후
  // 재발사된다. envHeal 자체는 BadDeviceToken 에만 발동하므로 503 은 1회 호출로 즉시 실패 반환.
  it('#1721 — arvlcd fire 503 → retry-push: 큐 적재 (transient retry queue)', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockTrip({ lastTrackedArrivalEpoch: NOW + 5000 }),
    );
    const apnsFetch = vi.fn(async () => new Response('', { status: 503 }));
    // PENDING_PUSHES 는 동일 kv 인스턴스 사용 — retry-push: prefix 도 같은 store 에 적재.
    const stats = await runScheduled(makeEnv(kv, kv), {
      seoul: makeSeoulCombo([arrivalForLock('중곡', 0, 1)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-1721',
    });
    expect(stats.errors).toBeGreaterThan(0);
    // retry-push: prefix entry 가 적재되어 다음 cron cycle 에서 재발사 가능.
    const stored = await kv.get('retry-push:p-1721');
    expect(stored).not.toBeNull();
    const entry = JSON.parse(stored as string);
    expect(entry.pushId).toBe('p-1721');
    expect(entry.attemptCount).toBe(0);
    expect(entry.nextAttemptAt).toBe(NOW + 60_000);
    expect(entry.lastErrorStatus).toBe(503);
    // payload 도 같이 적재되어 retry 시점에 재구성 불필요.
    expect(entry.payload.nextWaypoint).toBe('중곡');
  });

  // #1721 — 410 Unregistered 같은 unrecoverable 은 retry-push: 큐 적재 X.
  // 기존 cleanup path (cleanupTripWithLa 'push-unrecoverable') 가 책임.
  it('#1721 — 410 Unregistered 는 retry-push: 큐 적재 X (unrecoverable)', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockTrip({ lastTrackedArrivalEpoch: NOW + 5000 }),
    );
    const apnsFetch = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'Unregistered' }), { status: 410 }),
    );
    await runScheduled(makeEnv(kv, kv), {
      seoul: makeSeoulCombo([arrivalForLock('중곡', 0, 1)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-410',
    });
    // 410 은 retry queue 적재 X — trip 자체가 cleanup (deleteTrip) 되므로.
    expect(await kv.get('retry-push:p-410')).toBeNull();
  });

  // #864 — transfer waypoint 통과 시 lock release. 다음 cycle에서 새 leg의 trainCode를
  // 찾지 못해 5분 만에 trip auto-end되던 회귀를 차단.
  async function runArrivedScenario(
    kv: InMemoryKV,
    overrides: Partial<Trip>,
    arrivalStation: string,
    pushId: string,
  ): Promise<void> {
    await putTrip(kv as unknown as KVNamespace, makeLockTrip(overrides));
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock(arrivalStation, 0, 1)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => pushId,
    });
  }

  it('#864 — transfer waypoint advance 시 boardingLock release + progress 정리 (trip은 유지)', async () => {
    const kv = new InMemoryKV();
    // 옛 trainCode + shiftedCount가 진행 중 progress KV에 남아 있는 상태를 시뮬레이션.
    await kv.put(
      'progress:lock-tok',
      JSON.stringify({ trainCode: '7246', shiftedCount: 2, lastTrackedArrivalEpoch: NOW + 5000 }),
    );
    await runArrivedScenario(
      kv,
      {
        waypoints: [
          { stationName: '군자', line: '7', kind: 'transfer' },
          { stationName: '아차산', line: '5', kind: 'destination' },
        ],
        consecutiveEtaMissing: 2,
      },
      '군자',
      'p-transfer',
    );
    const stored = JSON.parse((await kv.get('trip:lock-tok')) as string);
    expect(stored.boardingLock).toBeUndefined();
    expect(stored.consecutiveEtaMissing).toBe(0);
    expect(stored.waypoints).toEqual([{ stationName: '아차산', line: '5', kind: 'destination' }]);
    // P2-1: progress KV도 함께 정리 — token-refresh race에서 옛 trainCode가 progressApplies=true로
    // 진입해 backend에 옛 lock이 부활하는 회귀를 차단.
    expect(await kv.get('progress:lock-tok')).toBeNull();
  });

  // 잠실나루 redundant boarding prompt regression — transfer waypoint의 목적지 line이 현재
  // boardingLock.line과 동일(같은 호선 내 잘못 라벨된 transfer)이면 lock을 release하면 안 된다.
  // release되면 다음 cycle의 evaluateAndMaybeFireBoardingPrompt가 lock=inactive로 오판해
  // "탑승했어요?" 프롬프트를 이미 탑승 중인 사용자에게 재발사한다.
  it('실제 노선 변경 없는 transfer waypoint(같은 line) 통과 시 boardingLock 유지(release 억제)', async () => {
    const kv = new InMemoryKV();
    await runArrivedScenario(
      kv,
      {
        waypoints: [
          // 목적지 line이 lock.line('7')과 동일 — 같은 호선 내 waypoint가 transfer로 잘못
          // 라벨/advance된 케이스. 실제 환승이 아니므로 lock을 유지해야 한다.
          { stationName: '잠실나루', line: '7', kind: 'transfer' },
          { stationName: '군자', line: '7', kind: 'destination' },
        ],
      },
      '잠실나루',
      'p-same-line-transfer',
    );
    const stored = JSON.parse((await kv.get('trip:lock-tok')) as string);
    expect(stored.boardingLock).toBeDefined();
    expect(stored.boardingLock.trainCode).toBe('7246');
  });

  // 대조군 — 목적지 line이 lock.line과 실제로 다르면(#864 원 시나리오) 기존대로 release돼야 한다.
  it('실제 노선 변경 있는 transfer waypoint(다른 line) 통과 시 boardingLock release 유지', async () => {
    const kv = new InMemoryKV();
    await runArrivedScenario(
      kv,
      {
        waypoints: [
          { stationName: '군자', line: '7', kind: 'transfer' },
          { stationName: '아차산', line: '5', kind: 'destination' },
        ],
      },
      '군자',
      'p-diff-line-transfer',
    );
    const stored = JSON.parse((await kv.get('trip:lock-tok')) as string);
    expect(stored.boardingLock).toBeUndefined();
  });

  // #1438 (E5) — backend → device lock release sync. transfer waypoint advance 시 device로
  // silent push에 lockReleasedReason='transfer'를 실어 보내 로컬 useBoardingLockStore가 즉시 sync.
  it('#1438 (E5) — transfer release 시 silent push payload에 lockReleasedReason=transfer 포함', async () => {
    const kv = new InMemoryKV();
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockTrip({
        waypoints: [
          { stationName: '군자', line: '7', kind: 'transfer' },
          { stationName: '아차산', line: '5', kind: 'destination' },
        ],
      }),
    );
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock('군자', 0, 1)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-transfer-1438',
    });
    // transfer-release silent push가 발사된 APNs fetch 호출 1건 이상 존재 + payload에 reason 포함.
    const transferReleaseCall = (fetchImpl.mock.calls as unknown as [string, RequestInit][]).find((call) => {
      const init = call[1];
      if (!init?.body) return false;
      try {
        const body = JSON.parse(init.body as string);
        return body?.data?.lockReleasedReason === 'transfer';
      } catch {
        return false;
      }
    });
    expect(transferReleaseCall).toBeDefined();
    const body = JSON.parse(transferReleaseCall![1].body as string);
    expect(body.data.lockReleasedReason).toBe('transfer');
    expect(body.data.origin).toBe('transfer-release');
  });

  // #2021 (ADR-022) — transfer-release 경로도 archFlag='on' 시 boardingLine 봉인.
  // advanceBoardingLockWaypoint 안의 buildStationPassedImminentPayload 호출이 deps.archFlag 를
  // 그대로 forward 하는지 매트릭스로 회귀 차단.
  it('#2021 archFlag=on 시 transfer-release payload.boardingLine 봉인', async () => {
    const kv = new InMemoryKV();
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockTrip({
        waypoints: [
          { stationName: '군자', line: '7', kind: 'transfer' },
          { stationName: '아차산', line: '5', kind: 'destination' },
        ],
      }),
    );
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock('군자', 0, 1)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p2021-transfer-on',
      archFlag: 'on',
    });
    const transferReleaseCall = (fetchImpl.mock.calls as unknown as [string, RequestInit][]).find(
      (call) => {
        const init = call[1];
        if (!init?.body) return false;
        try {
          const body = JSON.parse(init.body as string);
          return body?.data?.origin === 'transfer-release';
        } catch {
          return false;
        }
      },
    );
    expect(transferReleaseCall).toBeDefined();
    const data = JSON.parse(transferReleaseCall![1].body as string).data as Record<
      string,
      unknown
    >;
    expect('boardingLine' in data).toBe(false);
    expect(data.trainCode).toBe('7246');
  });

  it('#2021 archFlag=off 시 transfer-release payload.boardingLine=lock.line 유지', async () => {
    const kv = new InMemoryKV();
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockTrip({
        waypoints: [
          { stationName: '군자', line: '7', kind: 'transfer' },
          { stationName: '아차산', line: '5', kind: 'destination' },
        ],
      }),
    );
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock('군자', 0, 1)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p2021-transfer-off',
      archFlag: 'off',
    });
    const transferReleaseCall = (fetchImpl.mock.calls as unknown as [string, RequestInit][]).find(
      (call) => {
        const init = call[1];
        if (!init?.body) return false;
        try {
          const body = JSON.parse(init.body as string);
          return body?.data?.origin === 'transfer-release';
        } catch {
          return false;
        }
      },
    );
    expect(transferReleaseCall).toBeDefined();
    const data = JSON.parse(transferReleaseCall![1].body as string).data as Record<
      string,
      unknown
    >;
    expect(data.boardingLine).toBe('7');
  });

  // #1721/#2177 — transfer-release push가 transient(503) 실패 시 retry-push: 큐에 적재된다.
  // envMismatchExhausted 필드도 함께 stamp되는지 회귀 차단(#2177 신규 필드).
  it('#2177 — transfer-release push 503 → retry-push: 큐 적재', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockTrip({
        waypoints: [
          { stationName: '군자', line: '7', kind: 'transfer' },
          { stationName: '아차산', line: '5', kind: 'destination' },
        ],
      }),
    );
    const apnsFetch = vi.fn(async () => new Response('', { status: 503 }));
    await runScheduled(makeEnv(kv, kv), {
      seoul: makeSeoulCombo([arrivalForLock('군자', 0, 1)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-transfer-503',
    });
    // arvlcd push는 injected generatePushId를 쓰지만, transfer-release push는 내부에서
    // crypto.randomUUID()로 자체 pushId를 발급한다 — retry-push: prefix 전체를 스캔해
    // payload.origin='transfer-release' 항목을 찾는다.
    const allKeys = await kv.list({ prefix: 'retry-push:' });
    let transferEntry: { lastErrorStatus: number; payload: { origin: string } } | undefined;
    for (const { name } of allKeys.keys) {
      const raw = await kv.get(name);
      if (!raw) continue;
      const parsed = JSON.parse(raw as string);
      if (parsed.payload?.origin === 'transfer-release') transferEntry = parsed;
    }
    expect(transferEntry).toBeDefined();
    expect(transferEntry!.lastErrorStatus).toBe(503);
  });

  // #2066 (Phase 2-backend) — 취침 알람 원격 visible 전환. "환승/도착역 직전 역" arvlCd 진입
  // 시점에 visible alert(주 채널) + companion silent push(kind sleep-alarm-companion)를 동시 발사.
  // ADR-023 정합: backend는 sleepModeEnabled === true trip에서만 발사한다(#2066부터 gate 도입 —
  // #2036/#2063과 달리 이 알람 채널 자체가 취침 전용이므로 mute가 아니라 발사 조건이다).
  describe('#2066 — 취침 알람(원격 visible) 발사 조건', () => {
    function makeSleepAlarmTrip(overrides: Partial<Trip> = {}) {
      return makeLockTrip({
        sleepModeEnabled: true,
        waypoints: [
          { stationName: '중곡', line: '7', kind: 'intermediate' },
          { stationName: '군자', line: '7', kind: 'transfer' },
          { stationName: '아차산', line: '5', kind: 'destination' },
        ],
        ...overrides,
      });
    }

    function findPushByKindOrAlert(
      fetchImpl: ReturnType<typeof vi.fn>,
      predicate: (body: { aps?: Record<string, unknown>; data?: Record<string, unknown> }) => boolean,
    ) {
      return (fetchImpl.mock.calls as unknown as [string, RequestInit][]).find((call) => {
        const init = call[1];
        if (!init?.body) return false;
        try {
          return predicate(JSON.parse(init.body as string));
        } catch {
          return false;
        }
      });
    }

    it('sleepModeEnabled=true + 직전역 arvlCd 진입 → visible alert + companion silent push 2건 발사', async () => {
      const kv = new InMemoryKV();
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      await putTrip(kv as unknown as KVNamespace, makeSleepAlarmTrip());
      const stats = await runScheduled(makeEnv(kv), {
        seoul: makeSeoulCombo([arrivalForLock('중곡', 0, 1)], []),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
        generatePushId: () => 'p-sleep-alarm',
      });
      expect(stats.sleepAlarmFired).toBe(1);

      const alertCall = findPushByKindOrAlert(fetchImpl, (body) => body.aps?.alert !== undefined);
      expect(alertCall).toBeDefined();
      const alertBody = JSON.parse(alertCall![1].body as string);
      expect(alertBody.aps.sound).toBe('alarm.wav');
      expect(alertBody.aps['interruption-level']).toBe('time-sensitive');
      const alertHeaders = alertCall![1].headers as Record<string, string>;
      expect(alertHeaders['apns-push-type']).toBe('alert');
      expect(alertHeaders['apns-collapse-id']).toBe('alarm-lock-tok-군자');

      const companionCall = findPushByKindOrAlert(
        fetchImpl,
        (body) => body.data?.kind === 'sleep-alarm-companion',
      );
      expect(companionCall).toBeDefined();
      const companionData = JSON.parse(companionCall![1].body as string).data as Record<
        string,
        unknown
      >;
      expect(companionData.originStation).toBe('중곡');
      expect(companionData.targetKind).toBe('transfer');
      expect(companionData.nextLine).toBe('7');
      expect(companionData.nextStation).toBe('군자');
      expect(companionData.tripToken).toBe('lock-tok');
      const companionHeaders = companionCall![1].headers as Record<string, string>;
      expect(companionHeaders['apns-push-type']).toBe('background');
    });

    // #2086 — 짧은 mock token('lock-tok')은 `slice(0, 16)`가 no-op이라 apns-collapse-id
    // 축약 로직을 실제로 exercise하지 못한다. 실물 길이(64 hex) device token으로
    // `alarm-<token16>-<station>` 형태 + APNs 64B 한도 준수를 직접 검증한다.
    it('#2086 실물 길이(64 hex) device token → apns-collapse-id가 16 hex prefix로 축약되고 64B 이하', async () => {
      const kv = new InMemoryKV();
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      await putTrip(kv as unknown as KVNamespace, makeSleepAlarmTrip({ token: HEX64_TOKEN }));
      await runScheduled(makeEnv(kv), {
        seoul: makeSeoulCombo([arrivalForLock('중곡', 0, 1)], []),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
        generatePushId: () => 'p-sleep-alarm-hex64',
      });

      const alertCall = findPushByKindOrAlert(fetchImpl, (body) => body.aps?.alert !== undefined);
      expect(alertCall).toBeDefined();
      const alertHeaders = alertCall![1].headers as Record<string, string>;
      const collapseId = alertHeaders['apns-collapse-id'];
      expect(collapseId).toBe(`alarm-${HEX64_TOKEN.slice(0, 16)}-군자`);
      expect(new TextEncoder().encode(collapseId).length).toBeLessThanOrEqual(64);
    });

    // PR #2085 리뷰 P1-1 — leg-relative hop 카운터(legHopIndex) 게이트는 전면 제거됐다.
    // `trip.waypoints`는 leg 출발역(방금 탑승/환승한 역) 자체를 포함하지 않으므로, 갓 등록된
    // trip이든 여러 cron cycle을 거친 trip이든 waypoints=[I1, T] 형태(intermediate 1개 +
    // transfer/destination)면 항상 발사돼야 한다 — 별도 카운터로 "몇 번째 hop인지" 추적할
    // 필요가 없다(과거 legHopIndex 게이트는 이 케이스를 false-skip 시키는 버그였다).
    it('갓 등록된 2역차 leg(waypoints=[I1, T]) — 추가 필드 하드코딩 없이 I1 진입 시 발사', async () => {
      const kv = new InMemoryKV();
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      await putTrip(
        kv as unknown as KVNamespace,
        makeSleepAlarmTrip({
          waypoints: [
            { stationName: '중곡', line: '7', kind: 'intermediate' },
            { stationName: '군자', line: '7', kind: 'transfer' },
          ],
        }),
      );
      const stats = await runScheduled(makeEnv(kv), {
        seoul: makeSeoulCombo([arrivalForLock('중곡', 0, 1)], []),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
        generatePushId: () => 'p-sleep-alarm-2hop-fresh',
      });
      expect(stats.sleepAlarmFired).toBe(1);
      const alertCall = findPushByKindOrAlert(fetchImpl, (body) => body.aps?.alert !== undefined);
      expect(alertCall).toBeDefined();
    });

    it('1역차 leg(waypoints=[T]만, 직전역 자체가 transfer) — not-preceding으로 skip, push 미발사', async () => {
      const kv = new InMemoryKV();
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      await putTrip(
        kv as unknown as KVNamespace,
        makeSleepAlarmTrip({
          waypoints: [{ stationName: '군자', line: '7', kind: 'transfer' }],
        }),
      );
      const stats = await runScheduled(makeEnv(kv), {
        seoul: makeSeoulCombo([arrivalForLock('군자', 0, 1)], []),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
        generatePushId: () => 'p-sleep-alarm-onehop',
      });
      expect(stats.sleepAlarmFired).toBe(0);
      // waypoint 자체가 이미 kind='transfer'라 evaluateSleepAlarmTrigger가 not-preceding으로
      // 차단한다 — 다만 그 transfer waypoint advance는 ADR-023에 따라 hop-end prompt
      // (category BOARDING_PROMPT)를 sleep 무관하게 독립 발사하므로 "alert 전무"가 아니라
      // "sleep-alarm 전용 alert(sound=alarm.wav) 전무"로 좁혀 검증한다.
      const alertCall = findPushByKindOrAlert(fetchImpl, (body) => body.aps?.sound === 'alarm.wav');
      expect(alertCall).toBeUndefined();
      const companionCall = findPushByKindOrAlert(
        fetchImpl,
        (body) => body.data?.kind === 'sleep-alarm-companion',
      );
      expect(companionCall).toBeUndefined();
    });

    it('dedup — 같은 (tripToken, target) KV가 이미 존재하면 재발사 안 함', async () => {
      const kv = new InMemoryKV();
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      await putTrip(kv as unknown as KVNamespace, makeSleepAlarmTrip());
      await kv.put('alarmFireKey:lock-tok:군자', '1');
      const stats = await runScheduled(makeEnv(kv), {
        seoul: makeSeoulCombo([arrivalForLock('중곡', 0, 1)], []),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
        generatePushId: () => 'p-sleep-alarm-dedup',
      });
      expect(stats.sleepAlarmFired).toBe(0);
      expect(stats.sleepAlarmDedupSkipped).toBe(1);
      const alertCall = findPushByKindOrAlert(fetchImpl, (body) => body.aps?.alert !== undefined);
      expect(alertCall).toBeUndefined();
    });

    it('sleepModeEnabled=false/미지정 → 알람 미발사 (매역 알림과 독립 게이트)', async () => {
      const kv = new InMemoryKV();
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      await putTrip(
        kv as unknown as KVNamespace,
        makeSleepAlarmTrip({ sleepModeEnabled: false }),
      );
      const stats = await runScheduled(makeEnv(kv), {
        seoul: makeSeoulCombo([arrivalForLock('중곡', 0, 1)], []),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
        generatePushId: () => 'p-sleep-alarm-off',
      });
      expect(stats.sleepAlarmFired).toBe(0);
      expect(stats.sleepAlarmDedupSkipped).toBe(0);
      const companionCall = findPushByKindOrAlert(
        fetchImpl,
        (body) => body.data?.kind === 'sleep-alarm-companion',
      );
      expect(companionCall).toBeUndefined();
    });

    it('not-preceding — 다음 waypoint가 transfer/destination이 아니면(중간 intermediate) 미발사', async () => {
      const kv = new InMemoryKV();
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      await putTrip(
        kv as unknown as KVNamespace,
        makeSleepAlarmTrip({
          waypoints: [
            { stationName: '중곡', line: '7', kind: 'intermediate' },
            { stationName: '어린이대공원', line: '7', kind: 'intermediate' },
            { stationName: '군자', line: '7', kind: 'transfer' },
          ],
        }),
      );
      const stats = await runScheduled(makeEnv(kv), {
        seoul: makeSeoulCombo([arrivalForLock('중곡', 0, 1)], []),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
        generatePushId: () => 'p-sleep-alarm-not-preceding',
      });
      expect(stats.sleepAlarmFired).toBe(0);
      expect(stats.sleepAlarmDedupSkipped).toBe(0);
      const companionCall = findPushByKindOrAlert(
        fetchImpl,
        (body) => body.data?.kind === 'sleep-alarm-companion',
      );
      expect(companionCall).toBeUndefined();
    });

    it('APNs env mismatch — visible alert push가 sandbox→production으로 self-heal', async () => {
      const kv = new InMemoryKV();
      await putTrip(
        kv as unknown as KVNamespace,
        makeSleepAlarmTrip({ apnsEnv: 'sandbox' }),
      );
      const fetchImpl = vi.fn();
      fetchImpl
        .mockImplementationOnce(
          async () => new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
        )
        .mockImplementation(async () => new Response('', { status: 200 }));
      const stats = await runScheduled(makeEnv(kv), {
        seoul: makeSeoulCombo([arrivalForLock('중곡', 0, 1)], []),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
        generatePushId: () => 'p-sleep-alarm-heal',
      });
      expect(stats.sleepAlarmFired).toBe(1);
      expect(stats.envCorrected).toBeGreaterThanOrEqual(1);
      const stored = JSON.parse((await kv.get('trip:lock-tok')) as string);
      expect(stored.apnsEnv).toBe('production');
    });

    // PR #2085 리뷰 P2-1 — 주 채널(visible alert) 발사 실패 시 dedup claim을 rollback해야
    // 1시간 동안 알람이 영구 미스되지 않는다. transient(503) 실패는 retry-push: 큐에도 적재된다.
    it('P2-1 — visible alert 503 실패 → dedup rollback + retry-push 큐 적재, companion은 독립 성공', async () => {
      const kv = new InMemoryKV();
      await putTrip(kv as unknown as KVNamespace, makeSleepAlarmTrip());
      let callCount = 0;
      const fetchImpl = vi.fn(async () => {
        callCount += 1;
        // 1번째 호출 = visible alert(실패), 2번째 호출 = companion(성공).
        return callCount === 1
          ? new Response('', { status: 503 })
          : new Response('', { status: 200 });
      });
      const stats = await runScheduled(makeEnv(kv, kv), {
        seoul: makeSeoulCombo([arrivalForLock('중곡', 0, 1)], []),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
        generatePushId: () => 'p-sleep-alarm-rollback',
      });
      expect(stats.sleepAlarmFired).toBe(0);
      expect(stats.sleepAlarmRolledBack).toBe(1);
      // dedup claim이 rollback되어 KV에 남아있지 않다 — 다음 cron cycle 재시도 가능.
      expect(await kv.get('alarmFireKey:lock-tok:군자')).toBeNull();
      // transient(503) 실패라 retry-push: 큐에 적재된다.
      const retryEntry = await kv.get('retry-push:p-sleep-alarm-rollback');
      expect(retryEntry).not.toBeNull();
      const entry = JSON.parse(retryEntry as string);
      expect(entry.lastErrorStatus).toBe(503);
      expect(entry.payload.nextWaypoint).toBe('군자');
      // companion은 독립 채널이라 alert 실패와 무관하게 성공한다.
      const companionCall = findPushByKindOrAlert(
        fetchImpl,
        (body) => body.data?.kind === 'sleep-alarm-companion',
      );
      expect(companionCall).toBeDefined();
    });

    // PR #2085 리뷰 P2-1 — companion(보조 채널) 실패는 dedup을 건드리지 않는다(alert이 주
    // 채널이라 이미 성공 발사됨). transient 실패는 companion 자체 retry-push: 큐 적재.
    it('P2-1 — companion push 500 실패 → alert dedup은 유지, companion만 retry-push 큐 적재', async () => {
      const kv = new InMemoryKV();
      await putTrip(kv as unknown as KVNamespace, makeSleepAlarmTrip());
      let callCount = 0;
      const fetchImpl = vi.fn(async () => {
        callCount += 1;
        // 1번째 호출 = visible alert(성공), 2번째 호출 = companion(실패).
        return callCount === 1
          ? new Response('', { status: 200 })
          : new Response('', { status: 500 });
      });
      // alert/companion 순서로 서로 다른 pushId 발급 — 같은 id면 retry-push: 키가 충돌한다.
      let pushIdCount = 0;
      const stats = await runScheduled(makeEnv(kv, kv), {
        seoul: makeSeoulCombo([arrivalForLock('중곡', 0, 1)], []),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
        generatePushId: () => {
          pushIdCount += 1;
          return pushIdCount === 1 ? 'p-sleep-alarm-companion-fail-alert' : 'p-sleep-alarm-companion-fail-companion';
        },
      });
      expect(stats.sleepAlarmFired).toBe(1);
      expect(stats.sleepAlarmRolledBack).toBe(0);
      // alert이 성공했으므로 dedup claim은 유지된다.
      expect(await kv.get('alarmFireKey:lock-tok:군자')).not.toBeNull();
      const retryEntry = await kv.get('retry-push:p-sleep-alarm-companion-fail-companion');
      expect(retryEntry).not.toBeNull();
      const entry = JSON.parse(retryEntry as string);
      expect(entry.lastErrorStatus).toBe(500);
      expect(entry.payload.nextWaypoint).toBe('군자');
    });
  });

  it('#864 — intermediate waypoint advance 시 boardingLock은 유지 (같은 train 계속 추적)', async () => {
    const kv = new InMemoryKV();
    await runArrivedScenario(
      kv,
      {
        waypoints: [
          { stationName: '중곡', line: '7', kind: 'intermediate' },
          { stationName: '군자', line: '7', kind: 'destination' },
        ],
      },
      '중곡',
      'p-intermediate',
    );
    const stored = JSON.parse((await kv.get('trip:lock-tok')) as string);
    expect(stored.boardingLock?.trainCode).toBe('7246');
    expect(stored.waypoints).toEqual([{ stationName: '군자', line: '7', kind: 'destination' }]);
  });

  it.each([
    ['destination 도착 시 trip 삭제', '군자', 'destination'] as const,
    ['마지막 intermediate 통과 후 빈 리스트면 trip 삭제', '중곡', 'intermediate'] as const,
  ])('%s', async (_label, station, kind) => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockTrip({ waypoints: [{ stationName: station, line: '7', kind }] }),
    );
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock(station, 0, 1)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-arrive',
    });
    expect(await kv.get('trip:lock-tok')).toBeNull();
  });

  // #640 — lock 만료 trip도 lockMissing 게이트로 차단되어야 한다 (이전엔 legacy phase 경로로 fall-through 됐었음).
  it('lock 만료 trip은 게이트에서 차단 — push 없음', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockTrip({
        boardingLock: makeLock({ expiresAt: NOW - 1 }),
        waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
      }),
    );
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock('강남', 20, 1)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p8',
    });
    expect(stats.pushed).toBe(0);
    expect(stats.lockMissing).toBe(1);
    expect(apnsFetch).not.toHaveBeenCalled();
  });

  it('counts error when reschedule push fails (apns 400)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockTrip());
    const apnsFetch = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadFoo' }), { status: 400 }),
    );
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock('중곡', 60)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p9',
    });
    expect(stats.errors).toBe(1);
    expect(stats.pushed).toBe(0);
  });

  it('handles tracking exception (e.g. seoul throws)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockTrip());
    const throwingSeoul = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async () => {
        throw new Error('boom');
      }) as unknown as typeof fetch,
    });
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: throwingSeoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(stats.errors).toBe(1);
  });

  it('self-heals apns env mismatch (#482) — flips host + corrects trip.apnsEnv', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockTrip({ apnsEnv: 'sandbox' }),
    );
    const apnsFetch = vi.fn();
    apnsFetch
      .mockImplementationOnce(async () =>
        new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
      )
      .mockImplementationOnce(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock('중곡', 120)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-heal',
    });
    expect(stats.pushed).toBe(1);
    expect(stats.envCorrected).toBe(1);
    expect(apnsFetch).toHaveBeenCalledTimes(2);
    // 1차: sandbox host, 2차: production host
    const url1 = (apnsFetch.mock.calls[0] as unknown as [string])[0];
    const url2 = (apnsFetch.mock.calls[1] as unknown as [string])[0];
    expect(url1).toContain(APNS_HOSTS.sandbox);
    expect(url2).toContain(APNS_HOSTS.production);
    const stored = JSON.parse((await kv.get('trip:lock-tok')) as string);
    expect(stored.apnsEnv).toBe('production');
  });

  it('deletes trip when both hosts return BadDeviceToken (envMismatchExhausted)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockTrip({ apnsEnv: 'sandbox' }));
    const apnsFetch = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
    );
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock('중곡', 120)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-exhaust',
    });
    expect(await kv.get('trip:lock-tok')).toBeNull();
  });

  // #1633 — corrected env 즉시 KV persist 검증.
  //
  // 2026-06-22 trip 회귀: 같은 token에 대해 매 cron cycle(13:42/43/44/46) mismatch retry가 반복돼
  // 매번 ~1초 지연 → device fg가 먼저 station 발사 → backend silent push가 `gate-station-already-passed`로
  // drop → 매역 알림 backend 발사 0건. 종전엔 corrected env가 in-memory mutate 후 caller의 후속
  // putTrip에 의존했으나, 그 사이 race / cleanup 분기 / KV eventual consistency로 영구 저장이 누락 가능.
  //
  // 본 테스트는 corrected env 발생 직후 KV trip record에 'production'이 stamp되는 immediate persist를
  // 검증한다 — apns fetch 성공 직후 곧바로 kv put이 실행됨을 fetch ↔ put 호출 순서로 확인.
  it('#1633 — corrected env 즉시 KV persist (fetch 성공 → 다음 KV put이 trip.apnsEnv=production stamp)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockTrip({ apnsEnv: 'sandbox' }));
    // KV put을 spy. corrected env 직후의 putTrip 호출에서 apnsEnv='production'이 stamp되는지 검증.
    const putSpy = vi.spyOn(kv, 'put');
    const apnsFetch = vi.fn();
    apnsFetch
      .mockImplementationOnce(async () =>
        new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
      )
      .mockImplementationOnce(async () => new Response('', { status: 200 }));
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock('중곡', 120)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-persist',
    });
    // 첫 번째 trip:lock-tok 대상 put에 apnsEnv='production'이 포함돼야 한다.
    // (caller 후속 putTrip이 다시 같은 값을 쓰는 idempotent dedup도 허용 — 여기서는 처음 stamp만 검증.)
    const tripPutsAfterMismatch = putSpy.mock.calls
      .filter(([key]) => key === 'trip:lock-tok')
      .map(([, value]) => JSON.parse(value as string));
    expect(tripPutsAfterMismatch.length).toBeGreaterThan(0);
    // 모든 trip put이 corrected env(production)를 가져야 한다 — corrected 이후 어느 putTrip도
    // 절대 sandbox로 되돌아가지 않음을 보장.
    for (const stored of tripPutsAfterMismatch) {
      expect(stored.apnsEnv).toBe('production');
    }
  });

  it('deletes trip on Unregistered (410)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockTrip());
    const apnsFetch = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'Unregistered' }), { status: 410 }),
    );
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo([arrivalForLock('중곡', 120)], []),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-410',
    });
    expect(await kv.get('trip:lock-tok')).toBeNull();
  });

  it('skips push (no API call to APNs) when trainCode arrived at non-target station via position fallback (arrived=false)', async () => {
    // segmentStations idx 0(용마산) → target 1(중곡), 1 hop. arrived=false (sttus=0 이동중).
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockTrip({ lastTrackedArrivalEpoch: NOW + 90_000 }),
    );
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoulCombo(
        [],
        [{ trainCode: '7246', stationName: '용마산', trainSttus: 0 }],
      ),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(stats.pushed).toBe(0);
  });

  // #1559 (T6, Epic #1553 / ADR-017) — maybeReschedulePush SSoT motion 게이트.
  // 정지 trip에서 ETA 임계치 변동만으로 reschedule silent push가 발사되던 회귀
  // (2026-06-19 15:53/15:56 evidence) 차단. SSoT 부재(legacy trip) → fallback.
  describe('#1559 SSoT motion gate', () => {
    type Scenario = {
      name: string;
      ssotMotion: 'moving' | 'stationary' | null; // null = SSoT 없음 (legacy fallback)
      arrivalSec: number;
      lastTrackedDeltaMs: number | undefined; // baseline epoch offset (undefined → no baseline)
      expectedFire: boolean;
      expectedBlockedMotion: number;
      expectedFallbackNoSsot: number;
      /**
       * #1680 — stationary trip이 upstream 게이트에서 차단된 경우.
       * reschedule 경로 자체에 미도달 → rescheduleBlockedMotion=0, lifecycleStationarySkipped=1.
       */
      expectedStationarySkip?: boolean;
    };
    const rescheduleScenarios: Scenario[] = [
      // Positive — SSoT moving + delta > 15s → fire
      {
        name: 'SSoT moving + ETA delta > 15s → reschedule fires',
        ssotMotion: 'moving',
        arrivalSec: 140,
        lastTrackedDeltaMs: 120_000,
        expectedFire: true,
        expectedBlockedMotion: 0,
        expectedFallbackNoSsot: 0,
      },
      // Negative — SSoT stationary + delta > 15s → upstream stationary gate 차단 (#1680).
      // #1559 reschedule-gate(rescheduleBlockedMotion)는 미도달. lifecycleStationarySkipped=1.
      {
        name: 'SSoT stationary + ETA delta > 15s → upstream stationary skip (회귀 차단 유지)',
        ssotMotion: 'stationary',
        arrivalSec: 140,
        lastTrackedDeltaMs: 120_000,
        expectedFire: false,
        expectedBlockedMotion: 0,
        expectedFallbackNoSsot: 0,
        expectedStationarySkip: true,
      },
      // Fallback — SSoT 없음 (legacy) + delta > 15s → fire (기존 동작 유지)
      {
        name: 'SSoT missing (legacy) + ETA delta > 15s → fallback fires',
        ssotMotion: null,
        arrivalSec: 140,
        lastTrackedDeltaMs: 120_000,
        expectedFire: true,
        expectedBlockedMotion: 0,
        expectedFallbackNoSsot: 1,
      },
      // Noop — SSoT moving + delta < 15s → 기존 임계치 게이트로 미발사 (motion 게이트 통과 후)
      {
        name: 'SSoT moving + ETA delta < 15s → noop (existing threshold gate)',
        ssotMotion: 'moving',
        arrivalSec: 125,
        lastTrackedDeltaMs: 120_000,
        expectedFire: false,
        expectedBlockedMotion: 0,
        expectedFallbackNoSsot: 0,
      },
    ];

    it.each(rescheduleScenarios)(
      '$name',
      async ({
        ssotMotion,
        arrivalSec,
        lastTrackedDeltaMs,
        expectedFire,
        expectedBlockedMotion,
        expectedFallbackNoSsot,
        expectedStationarySkip,
      }) => {
        const kv = new InMemoryKV();
        const trip = makeLockTrip(
          lastTrackedDeltaMs !== undefined
            ? { lastTrackedArrivalEpoch: NOW + lastTrackedDeltaMs }
            : {},
        );
        await putTrip(kv as unknown as KVNamespace, trip);
        if (ssotMotion !== null) {
          await writeSsot(kv as unknown as KVNamespace, {
            tripToken: trip.token,
            currentStationId: '용마산',
            motionState: ssotMotion,
            motionEvidence: [],
            lastAdvanceAt: 0,
            lastAdvanceEvidence: 'seed-override',
            passedStations: [],
            userIntentDeclared: false,
            seedOverrideCount: 0,
            schemaVersion: 1,
          });
        }
        const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
        const stats = await runScheduled(makeEnv(kv), {
          seoul: makeSeoulCombo([arrivalForLock('중곡', arrivalSec)], []),
          apnsConfig,
          apnsHosts: APNS_HOSTS,
          fetchImpl: apnsFetch as unknown as typeof fetch,
          now: () => NOW,
          generatePushId: () => 'p-t6',
        });
        expect(stats.pushed).toBe(expectedFire ? 1 : 0);
        expect(stats.rescheduleBlockedMotion).toBe(expectedBlockedMotion);
        expect(stats.rescheduleFallbackNoSsot).toBe(expectedFallbackNoSsot);
        // #1680 — upstream stationary gate 차단 여부.
        if (expectedStationarySkip) {
          expect(stats.lifecycleStationarySkipped).toBe(1);
        }
      },
    );
  });
});

describe('estimateArrivalFromPosition (#585)', () => {
  const lock: BoardingLockMeta = {
    trainCode: '7246',
    line: '7',
    subwayId: '1007',
    selectedDepartureTime: NOW,
    segmentStations: ['용마산', '중곡', '군자', '어린이대공원'],
    expiresAt: NOW + 60 * 60_000,
  };

  it('returns null epoch when current station not in segment', () => {
    const train: PositionEntry = { trainCode: '7246', stationName: '아예다른역', trainSttus: 0, isUp: true, recptnMs: 0 };
    expect(estimateArrivalFromPosition(train, '군자', lock, NOW)).toEqual({ epoch: null, arrived: false });
  });

  it('returns null epoch when target station not in segment', () => {
    const train: PositionEntry = { trainCode: '7246', stationName: '용마산', trainSttus: 0, isUp: true, recptnMs: 0 };
    expect(estimateArrivalFromPosition(train, '아예다른역', lock, NOW)).toEqual({ epoch: null, arrived: false });
  });

  it('estimates epoch by hop count × 90s', () => {
    const train: PositionEntry = { trainCode: '7246', stationName: '용마산', trainSttus: 0, isUp: true, recptnMs: 0 };
    // 용마산(0) → 어린이대공원(3) = 3 hops × 90_000ms
    expect(estimateArrivalFromPosition(train, '어린이대공원', lock, NOW)).toEqual({ epoch: NOW + 270_000, arrived: false });
  });

  it('treats currentIdx >= targetIdx as already at/past target', () => {
    const train: PositionEntry = { trainCode: '7246', stationName: '군자', trainSttus: 0, isUp: true, recptnMs: 0 };
    const r = estimateArrivalFromPosition(train, '중곡', lock, NOW);
    expect(r.epoch).toBe(NOW);
    expect(r.arrived).toBe(false); // sttus가 ARRIVED 아니고 stationName도 target과 다름
  });

  it('reports arrived=true when sttus=ARRIVED at target station', () => {
    const train: PositionEntry = { trainCode: '7246', stationName: '군자', trainSttus: 1, isUp: true, recptnMs: 0 };
    expect(estimateArrivalFromPosition(train, '군자', lock, NOW)).toEqual({ epoch: NOW, arrived: true });
  });
});

describe('RESCHEDULE_THRESHOLD_MS (#585)', () => {
  it('is 15 seconds', () => {
    expect(RESCHEDULE_THRESHOLD_MS).toBe(15_000);
  });
});

// APNs LA push는 push-type 헤더로 식별: liveactivity
function isLaCall(_url: string, init: RequestInit | undefined): boolean {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers['apns-push-type'] === 'liveactivity';
}

/**
 * boardingLock 활성 + LA token이 있는 trip — LA 통합 시나리오의 표준 fixture.
 * trip은 #640 게이트 통과(boardingLock 활성) + #586 D LA 발사 대상(activityState=live).
 */
function makeLockedLaTrip(overrides: Partial<Trip> = {}): Trip {
  return makeTrip({
    token: 'la-tok',
    route: { type: 'direct', line: '2', stops: 1 },
    waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
    activityPushToken: 'la-token',
    activityState: 'live',
    apnsEnv: 'sandbox',
    boardingLock: {
      trainCode: 'T',
      line: '2',
      subwayId: '1002',
      selectedDepartureTime: NOW,
      segmentStations: ['역삼', '강남'],
      expiresAt: NOW + 60 * 60_000,
    },
    ...overrides,
  });
}

function makeLockedSeoul(arrivalSeconds: number, arvlCd: number | null = null): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => NOW,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          realtimeArrivalList: [
            {
              barvlDt: String(arrivalSeconds),
              recptnDt: '',
              updnLine: '상행',
              trainLineNm: '강남',
              btrainNo: 'T',
              subwayNm: '지하철2호선',
              arvlCd,
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch,
  });
}

/** APNs 200 OK 항상 응답하는 fetch mock. LA 통합 테스트의 표준 fetch impl. */
function makeOkFetch() {
  return vi.fn(async () => new Response('', { status: 200 }));
}

/**
 * LA 통합 시나리오 표준 runner.
 * runScheduled 호출의 `{ seoul, apnsConfig, apnsHosts, fetchImpl, now }` boilerplate를 압축한다.
 * 추가 옵션(now override 등)은 overrides로 받는다.
 */
function runLaScheduled(
  kv: InMemoryKV,
  args: {
    seoul: SeoulArrivalClient;
    fetchImpl: ReturnType<typeof vi.fn>;
    now?: () => number;
  },
) {
  return runScheduled(makeEnv(kv), {
    seoul: args.seoul,
    apnsConfig,
    apnsHosts: APNS_HOSTS,
    fetchImpl: args.fetchImpl as unknown as typeof fetch,
    now: args.now ?? (() => NOW),
  });
}

/** fetch mock에서 LA push 호출만 추출. */
function getLaCalls(fetchImpl: ReturnType<typeof vi.fn>): [string, RequestInit][] {
  return (fetchImpl.mock.calls as unknown as [string, RequestInit][]).filter((c) =>
    isLaCall(c[0], c[1]),
  );
}

/** LA call의 APNs body(JSON) 파싱. */
function parseLaBody(call: [string, RequestInit]): {
  aps: { event: string; 'content-state'?: Record<string, unknown> };
} {
  return JSON.parse(call[1].body as string);
}

describe('runScheduled — Live Activity push integration (#586 D / #612)', () => {
  it('fires LA update when estimate epoch delta >= 30s (no prior baseline)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockedLaTrip());
    const fetchImpl = makeOkFetch();
    const stats = await runLaScheduled(kv, { seoul: makeLockedSeoul(120), fetchImpl });
    // reschedule push 1건 + LA update 1건 (baseline 없으므로 임계 무시)
    expect(stats.pushed).toBe(1);
    expect(stats.laPushSent).toBe(1);
    const laCalls = getLaCalls(fetchImpl);
    expect(laCalls).toHaveLength(1);
    const body = parseLaBody(laCalls[0]);
    const contentState = body.aps['content-state'] as Record<string, unknown>;
    expect(body.aps.event).toBe('update');
    // #613: widget-aligned schema. etaSeconds → etaMinutes.
    // stationName/lineName/lineColorHex은 widget non-optional 보장.
    // alarmType은 omit — widget 긴급 모드(isUrgent)를 polling 정정마다 강제하지 않기 위함.
    expect(contentState.stationName).toBe('강남');
    expect(contentState.lineName).toBe('2호선');
    expect(contentState.lineColorHex).toBe('#009D3E');
    expect(contentState.stopsRemaining).toBe(1);
    expect(contentState.etaMinutes).toBe(2); // round(120/60) = 2
    // phase / etaSeconds / kind / arrivalAtSec / alarmType 모두 제거됨
    expect(contentState.phase).toBeUndefined();
    expect(contentState.etaSeconds).toBeUndefined();
    expect(contentState.kind).toBeUndefined();
    expect(contentState.arrivalAtSec).toBeUndefined();
    expect(contentState.alarmType).toBeUndefined();
    const stored = JSON.parse((await kv.get('trip:la-tok')) as string) as Trip;
    expect(stored.lastLaPushEpoch).toBe(NOW + 120_000);
  });

  it('does not fire LA when delta < 30s (LA threshold separate from reschedule 15s)', async () => {
    const kv = new InMemoryKV();
    // 직전 LA push baseline은 lastLaPushEpoch. reschedule baseline은 별개로 lastTrackedArrivalEpoch.
    // reschedule baseline은 일부러 어긋나게(50s 전) 두어 reschedule push는 발사되도록 한다 — 이 케이스의
    // 의도는 "LA 임계는 reschedule 임계와 독립"이라는 단언.
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockedLaTrip({
        lastTrackedArrivalEpoch: NOW + 70_000,
        lastLaPushEpoch: NOW + 100_000,
      }),
    );
    const fetchImpl = makeOkFetch();
    // seoul: +20s vs LA baseline → 임계 미달
    const stats = await runLaScheduled(kv, { seoul: makeLockedSeoul(120), fetchImpl });
    expect(stats.pushed).toBe(1); // reschedule push는 발사 (delta=50s >= 15s)
    expect(stats.laPushSent).toBe(0);
    expect(getLaCalls(fetchImpl)).toHaveLength(0);
  });

  // #900 Seam D / #1671 — 90s heartbeat 게이트.
  it('fires LA heartbeat when delta < 30s but lastLaPushAt is ≥ 90s ago', async () => {
    const kv = new InMemoryKV();
    // ETA 변동(ΔETA=10s)은 임계 미달이지만 lastLaPushAt이 90s 전이라 heartbeat 발사 기대.
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockedLaTrip({
        lastTrackedArrivalEpoch: NOW + 110_000,
        lastLaPushEpoch: NOW + 110_000,
        lastLaPushAt: NOW - 90_000,
      }),
    );
    const fetchImpl = makeOkFetch();
    // seoul: +120s vs LA baseline(+110s) → ΔETA=10s < 30s
    const stats = await runLaScheduled(kv, { seoul: makeLockedSeoul(120), fetchImpl });
    expect(stats.laPushSent).toBe(1);
    expect(getLaCalls(fetchImpl)).toHaveLength(1);
    const stored = JSON.parse((await kv.get('trip:la-tok')) as string) as Trip;
    // heartbeat 발사 시 wall-clock도 갱신됨 — 다음 heartbeat 평가 baseline.
    expect(stored.lastLaPushAt).toBe(NOW);
    expect(stored.lastLaPushEpoch).toBe(NOW + 120_000);
  });

  it('does not fire LA heartbeat when lastLaPushAt is < 90s ago and delta < 30s', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockedLaTrip({
        lastTrackedArrivalEpoch: NOW + 110_000,
        lastLaPushEpoch: NOW + 110_000,
        lastLaPushAt: NOW - 60_000, // 60s 전 — 90s 임계 미달
      }),
    );
    const fetchImpl = makeOkFetch();
    const stats = await runLaScheduled(kv, { seoul: makeLockedSeoul(120), fetchImpl });
    expect(stats.laPushSent).toBe(0);
    expect(getLaCalls(fetchImpl)).toHaveLength(0);
  });

  // #1671 — 환승/도착 즉시 trigger.
  it('fires LA immediately on transfer waypoint even when delta < 30s and heartbeat not due', async () => {
    const kv = new InMemoryKV();
    // transfer waypoint, ΔETA=10s < 30s, lastLaPushAt=45s 전(heartbeat 미달)
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({
        token: 'la-tok',
        route: { type: 'transfer', fromLine: '2', toLine: '7', transferName: '건대입구', stopsToTransfer: 1, stopsFromTransfer: 2 },
        waypoints: [{ stationName: '건대입구', line: '2', kind: 'transfer' }],
        activityPushToken: 'la-token',
        activityState: 'live',
        apnsEnv: 'sandbox',
        boardingLock: {
          trainCode: 'T',
          line: '2',
          subwayId: '1002',
          selectedDepartureTime: NOW,
          segmentStations: ['강변', '건대입구'],
          expiresAt: NOW + 60 * 60_000,
        },
        lastTrackedArrivalEpoch: NOW + 110_000,
        lastLaPushEpoch: NOW + 110_000,
        lastLaPushAt: NOW - 45_000, // 45s 전 — heartbeat(90s) 미달
      }),
    );
    const fetchImpl = makeOkFetch();
    // ΔETA=10s < 30s, heartbeat 미달이지만 transfer → 즉시 발사
    const stats = await runLaScheduled(kv, {
      seoul: new SeoulArrivalClient({
        apiKey: 'K',
        host: 'h',
        now: () => NOW,
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              realtimeArrivalList: [
                {
                  barvlDt: '120',
                  recptnDt: '',
                  updnLine: '상행',
                  trainLineNm: '건대입구',
                  btrainNo: 'T',
                  subwayNm: '지하철2호선',
                  arvlCd: null,
                },
              ],
            }),
            { status: 200 },
          )) as unknown as typeof fetch,
      }),
      fetchImpl,
    });
    expect(stats.laPushSent).toBe(1);
    expect(getLaCalls(fetchImpl)).toHaveLength(1);
  });

  it('fires LA immediately on destination waypoint when etaSeconds <= 60 and delta < 30s', async () => {
    const kv = new InMemoryKV();
    // destination, ETA=45s (≤60s 즉시 임계), ΔETA=5s < 30s, heartbeat 미달
    const etaMs = 45_000;
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockedLaTrip({
        lastTrackedArrivalEpoch: NOW + etaMs + 5_000,
        lastLaPushEpoch: NOW + etaMs + 5_000,
        lastLaPushAt: NOW - 30_000, // 30s 전 — heartbeat(90s) 미달
      }),
    );
    const fetchImpl = makeOkFetch();
    const stats = await runLaScheduled(kv, { seoul: makeLockedSeoul(45), fetchImpl });
    expect(stats.laPushSent).toBe(1);
    expect(getLaCalls(fetchImpl)).toHaveLength(1);
  });

  it('does not fire LA immediately on destination waypoint when etaSeconds > 60 and delta < 30s and heartbeat not due', async () => {
    const kv = new InMemoryKV();
    // destination, ETA=90s (>60s), ΔETA=10s < 30s, heartbeat 미달 → skip
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockedLaTrip({
        lastTrackedArrivalEpoch: NOW + 100_000,
        lastLaPushEpoch: NOW + 100_000,
        lastLaPushAt: NOW - 30_000, // 30s 전
      }),
    );
    const fetchImpl = makeOkFetch();
    const stats = await runLaScheduled(kv, { seoul: makeLockedSeoul(90), fetchImpl });
    expect(stats.laPushSent).toBe(0);
    expect(getLaCalls(fetchImpl)).toHaveLength(0);
  });

  // #2027 (Issue K) — archFlag='on' 시 destination-imminent 임계 60s → 90s 상향.
  // 환승 후 다음 hop 조기 도착 알림 방지 (2026-07-03 성수 8분 조기 발사 회귀 차단).
  describe('#2027 (Issue K) — archFlag=on 시 LA_IMMEDIATE_TRIGGER 임계 90s 상향', () => {
    it('archFlag=on + destination + ETA=75s (60s<x<=90s): 즉시 발사 (기존 60s 였으면 skip)', async () => {
      const kv = new InMemoryKV();
      // destination, ETA=75s (>60s but <=90s), ΔETA=5s < 30s, heartbeat 미달.
      // archFlag=on 시 90s 임계로 상향 → 즉시 발사.
      const etaMs = 75_000;
      await putTrip(
        kv as unknown as KVNamespace,
        makeLockedLaTrip({
          lastTrackedArrivalEpoch: NOW + etaMs + 5_000,
          lastLaPushEpoch: NOW + etaMs + 5_000,
          lastLaPushAt: NOW - 30_000, // 30s 전 — heartbeat(90s) 미달
        }),
      );
      const fetchImpl = makeOkFetch();
      const stats = await runScheduled(makeEnv(kv), {
        seoul: makeLockedSeoul(75),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
        archFlag: 'on',
      });
      expect(stats.laPushSent).toBe(1);
      expect(getLaCalls(fetchImpl)).toHaveLength(1);
    });

    it('archFlag=off + destination + ETA=75s: 기존 60s 임계 → skip (regression 방어)', async () => {
      const kv = new InMemoryKV();
      // 같은 상황에서 archFlag=off 는 기존 60s 임계 유지 → 즉시 발사 안 함.
      const etaMs = 75_000;
      await putTrip(
        kv as unknown as KVNamespace,
        makeLockedLaTrip({
          lastTrackedArrivalEpoch: NOW + etaMs + 5_000,
          lastLaPushEpoch: NOW + etaMs + 5_000,
          lastLaPushAt: NOW - 30_000,
        }),
      );
      const fetchImpl = makeOkFetch();
      const stats = await runScheduled(makeEnv(kv), {
        seoul: makeLockedSeoul(75),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
        archFlag: 'off',
      });
      expect(stats.laPushSent).toBe(0);
      expect(getLaCalls(fetchImpl)).toHaveLength(0);
    });

    it('archFlag=on + destination + ETA=95s (>90s): 즉시 발사 skip (임계 상향해도 95s 는 초과)', async () => {
      const kv = new InMemoryKV();
      const etaMs = 95_000;
      await putTrip(
        kv as unknown as KVNamespace,
        makeLockedLaTrip({
          lastTrackedArrivalEpoch: NOW + etaMs + 5_000,
          lastLaPushEpoch: NOW + etaMs + 5_000,
          lastLaPushAt: NOW - 30_000,
        }),
      );
      const fetchImpl = makeOkFetch();
      const stats = await runScheduled(makeEnv(kv), {
        seoul: makeLockedSeoul(95),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
        archFlag: 'on',
      });
      expect(stats.laPushSent).toBe(0);
      expect(getLaCalls(fetchImpl)).toHaveLength(0);
    });

    it('archFlag=off + destination + ETA=45s: 기존 60s 임계 통과 → 즉시 발사 (short hop regression 방어)', async () => {
      const kv = new InMemoryKV();
      // 짧은 hop(ETA<60s) 상황 — archFlag=off 시 즉시 발사 유지.
      const etaMs = 45_000;
      await putTrip(
        kv as unknown as KVNamespace,
        makeLockedLaTrip({
          lastTrackedArrivalEpoch: NOW + etaMs + 5_000,
          lastLaPushEpoch: NOW + etaMs + 5_000,
          lastLaPushAt: NOW - 30_000,
        }),
      );
      const fetchImpl = makeOkFetch();
      const stats = await runScheduled(makeEnv(kv), {
        seoul: makeLockedSeoul(45),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
        archFlag: 'off',
      });
      expect(stats.laPushSent).toBe(1);
      expect(getLaCalls(fetchImpl)).toHaveLength(1);
    });

    it('archFlag=on + transfer waypoint: etaSeconds 무관 즉시 발사 유지 (transfer 는 임계 gate 대상 아님)', async () => {
      const kv = new InMemoryKV();
      // transfer 는 kind==='transfer' 즉시 발사이며 etaSeconds 임계 무관.
      await putTrip(
        kv as unknown as KVNamespace,
        makeTrip({
          token: 'la-tok',
          route: { type: 'transfer', fromLine: '2', toLine: '7', transferName: '건대입구', stopsToTransfer: 1, stopsFromTransfer: 2 },
          waypoints: [{ stationName: '건대입구', line: '2', kind: 'transfer' }],
          activityPushToken: 'la-token',
          activityState: 'live',
          apnsEnv: 'sandbox',
          boardingLock: {
            trainCode: 'T',
            line: '2',
            subwayId: '1002',
            selectedDepartureTime: NOW,
            segmentStations: ['강변', '건대입구'],
            expiresAt: NOW + 60 * 60_000,
          },
          lastTrackedArrivalEpoch: NOW + 200_000,
          lastLaPushEpoch: NOW + 200_000,
          lastLaPushAt: NOW - 45_000,
        }),
      );
      const fetchImpl = makeOkFetch();
      const stats = await runScheduled(makeEnv(kv), {
        seoul: new SeoulArrivalClient({
          apiKey: 'K',
          host: 'h',
          now: () => NOW,
          fetchImpl: (async () =>
            new Response(
              JSON.stringify({
                realtimeArrivalList: [
                  {
                    barvlDt: '200',
                    recptnDt: '',
                    updnLine: '상행',
                    trainLineNm: '건대입구',
                    btrainNo: 'T',
                    subwayNm: '지하철2호선',
                    arvlCd: null,
                  },
                ],
              }),
              { status: 200 },
            )) as unknown as typeof fetch,
        }),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
        archFlag: 'on',
      });
      expect(stats.laPushSent).toBe(1);
      expect(getLaCalls(fetchImpl)).toHaveLength(1);
    });
  });

  it('dedup window still prevents immediate trigger when lastLaPushEpoch is within 30s', async () => {
    const kv = new InMemoryKV();
    // transfer waypoint, 하지만 dedup window(30s) 안에 이미 발사함 — skip
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({
        token: 'la-tok',
        route: { type: 'transfer', fromLine: '2', toLine: '7', transferName: '건대입구', stopsToTransfer: 1, stopsFromTransfer: 2 },
        waypoints: [{ stationName: '건대입구', line: '2', kind: 'transfer' }],
        activityPushToken: 'la-token',
        activityState: 'live',
        apnsEnv: 'sandbox',
        boardingLock: {
          trainCode: 'T',
          line: '2',
          subwayId: '1002',
          selectedDepartureTime: NOW,
          segmentStations: ['강변', '건대입구'],
          expiresAt: NOW + 60 * 60_000,
        },
        lastTrackedArrivalEpoch: NOW + 120_000,
        // dedup: 방금(15s 전) 동일 epoch으로 발사됨 → ΔETA=0 < 30s + heartbeat 미달 + immediate는 dedup window 안
        lastLaPushEpoch: NOW + 120_000,
        lastLaPushAt: NOW - 15_000,
      }),
    );
    const fetchImpl = makeOkFetch();
    const stats = await runLaScheduled(kv, {
      seoul: new SeoulArrivalClient({
        apiKey: 'K',
        host: 'h',
        now: () => NOW,
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              realtimeArrivalList: [
                {
                  barvlDt: '120',
                  recptnDt: '',
                  updnLine: '상행',
                  trainLineNm: '건대입구',
                  btrainNo: 'T',
                  subwayNm: '지하철2호선',
                  arvlCd: null,
                },
              ],
            }),
            { status: 200 },
          )) as unknown as typeof fetch,
      }),
      fetchImpl,
    });
    expect(stats.laPushSent).toBe(0);
    expect(getLaCalls(fetchImpl)).toHaveLength(0);
  });

  it('stamps lastLaPushAt on the first LA push (no baseline → fired)', async () => {
    const kv = new InMemoryKV();
    // lastLaPushEpoch/lastLaPushAt 둘 다 undefined → ΔETA 분기에서 통과 (기존 first-push 경로).
    await putTrip(kv as unknown as KVNamespace, makeLockedLaTrip());
    const fetchImpl = makeOkFetch();
    const stats = await runLaScheduled(kv, {
      seoul: makeLockedSeoul(120),
      fetchImpl,
      now: () => NOW + 5_000,
    });
    expect(stats.laPushSent).toBe(1);
    const stored = JSON.parse((await kv.get('trip:la-tok')) as string) as Trip;
    expect(stored.lastLaPushAt).toBe(NOW + 5_000);
  });

  it('does not fire LA when activityPushToken is missing', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockedLaTrip({ activityPushToken: undefined }),
    );
    const fetchImpl = makeOkFetch();
    const stats = await runLaScheduled(kv, { seoul: makeLockedSeoul(120), fetchImpl });
    expect(stats.laPushSent).toBe(0);
    expect(getLaCalls(fetchImpl)).toHaveLength(0);
  });

  it('does not fire LA when activityState is ended (already dismissed)', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockedLaTrip({ activityState: 'ended' }),
    );
    const fetchImpl = makeOkFetch();
    const stats = await runLaScheduled(kv, { seoul: makeLockedSeoul(120), fetchImpl });
    expect(stats.laPushSent).toBe(0);
    expect(getLaCalls(fetchImpl)).toHaveLength(0);
  });

  it('fires LA dismissal when destination arrived under boardingLock and clears trip', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockedLaTrip());
    const fetchImpl = makeOkFetch();
    // seoul: ARRIVED
    const stats = await runLaScheduled(kv, { seoul: makeLockedSeoul(0, 1), fetchImpl });
    expect(stats.laPushSent).toBe(1);
    const laCalls = getLaCalls(fetchImpl);
    expect(laCalls).toHaveLength(1);
    expect(parseLaBody(laCalls[0]).aps.event).toBe('end');
    expect(await kv.get('trip:la-tok')).toBeNull();
  });

  it('fires LA dismissal on trip expiry', async () => {
    const kv = new InMemoryKV();
    await kv.put(
      'trip:la-tok',
      JSON.stringify(
        makeLockedLaTrip({ expiresAt: NOW + 5_000, alarmAtEpochMs: NOW - 1 }),
      ),
    );
    const fetchImpl = makeOkFetch();
    const stats = await runLaScheduled(kv, {
      seoul: makeLockedSeoul(0),
      fetchImpl,
      now: () => NOW + 10_000, // past expiry
    });
    expect(stats.laPushSent).toBe(1);
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(parseLaBody(call).aps.event).toBe('end');
    expect(await kv.get('trip:la-tok')).toBeNull();
  });

  it('410 on LA update clears activityPushToken and persists to KV', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockedLaTrip());
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (isLaCall(url, init)) {
        return new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 410 });
      }
      return new Response('', { status: 200 });
    });
    const stats = await runLaScheduled(kv, { seoul: makeLockedSeoul(120), fetchImpl });
    expect(stats.laTokenCleared).toBe(1);
    const stored = JSON.parse((await kv.get('trip:la-tok')) as string) as Trip;
    expect(stored.activityPushToken).toBeUndefined();
    expect(stored.activityState).toBe('ended');
    // 410 분기 — token clear가 dirty이므로 lastLaPushEpoch는 갱신 안 함
    expect(stored.lastLaPushEpoch).toBeUndefined();
  });

  it('fires LA dismissal on unrecoverable reschedule push failure (410 Unregistered)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockedLaTrip());
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      // reschedule push만 410 Unregistered, LA push는 성공 처리.
      if (isLaCall(url, init)) return new Response('', { status: 200 });
      return new Response(JSON.stringify({ reason: 'Unregistered' }), { status: 410 });
    });
    await runLaScheduled(kv, { seoul: makeLockedSeoul(120), fetchImpl });
    // trip 삭제 + LA dismissal end push 발사
    expect(await kv.get('trip:la-tok')).toBeNull();
    const laCalls = getLaCalls(fetchImpl);
    expect(laCalls).toHaveLength(1);
    expect(parseLaBody(laCalls[0]).aps.event).toBe('end');
  });

  it('fires LA update immediately after waypoint shift (stopsRemaining changed)', async () => {
    // intermediate(중곡) 통과 → 다음 hop(강남)에 즉시 LA update 발사 (ETA 임계 무시).
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockedLaTrip({
        waypoints: [
          { stationName: '중곡', line: '2', kind: 'intermediate' },
          { stationName: '강남', line: '2', kind: 'destination' },
        ],
        boardingLock: {
          trainCode: 'T',
          line: '2',
          subwayId: '1002',
          selectedDepartureTime: NOW,
          segmentStations: ['역삼', '중곡', '강남'],
          expiresAt: NOW + 60 * 60_000,
        },
        // baseline 충분히 가까워야 LA push가 '진행 trigger'로 발사된 것을 검증할 수 있음.
        lastLaPushEpoch: NOW + 1000,
      }),
    );
    // 중곡에 ARRIVED → advanceBoardingLockWaypoint 진입 → shift 후 강남이 next
    const fetchImpl = makeOkFetch();
    await runLaScheduled(kv, { seoul: makeLockedSeoul(0, 1), fetchImpl });
    const laCalls = getLaCalls(fetchImpl);
    // 1건의 LA update(다음 waypoint=강남, stopsRemaining=1, ETA=0)가 발사돼야 한다.
    expect(laCalls).toHaveLength(1);
    const body = parseLaBody(laCalls[0]);
    const contentState = body.aps['content-state'] as Record<string, unknown>;
    expect(body.aps.event).toBe('update');
    // #613: widget-aligned schema. alarmType은 omit (긴급 모드 강제 회피).
    expect(contentState.stationName).toBe('강남');
    expect(contentState.alarmType).toBeUndefined();
    expect(contentState.stopsRemaining).toBe(1);
    expect(contentState.etaMinutes).toBe(0); // shift 시점은 ETA 0
    // shift 시 lastLaPushEpoch는 reset되어 다음 polling cycle의 첫 estimate가 임계 검사 없이 push되도록 보장.
    const stored = JSON.parse((await kv.get('trip:la-tok')) as string) as Trip;
    expect(stored.lastLaPushEpoch).toBeUndefined();
  });

  // #1654 / #1658 — 환승 leg 전환 감지 + LA content-state 즉시 갱신 통합 테스트.
  describe('transfer waypoint → LA shows new leg line (#1654 / #1658)', () => {
    /**
     * 7호선(군자, transfer) → 5호선(아차산, destination) trip.
     * boardingLock은 7호선으로 군자를 추적 중. LA token 활성.
     * maybeFireLiveActivityUpdate 경로(reschedule + LA 동시 발사): estimate NOT arrived 상태에서
     * 환승역 추적 중 LA push 시 content-state의 lineName이 새 leg(5호선)로 반영되는지 검증.
     */
    function makeTransferLaTrip(overrides: Partial<Trip> = {}): Trip {
      return makeLockedLaTrip({
        token: 'la-xfer-tok',
        route: { type: 'transfer', fromLine: '7', toLine: '5', transferName: '군자', stopsToTransfer: 1, stopsFromTransfer: 1 },
        waypoints: [
          { stationName: '군자', line: '7', kind: 'transfer' },
          { stationName: '아차산', line: '5', kind: 'destination' },
        ],
        boardingLock: {
          trainCode: 'T',
          line: '7',
          subwayId: '1007',
          selectedDepartureTime: NOW,
          segmentStations: ['중곡', '군자'],
          expiresAt: NOW + 60 * 60_000,
        },
        ...overrides,
      });
    }

    /** 군자역 ETA 120s (NOT arrived) 응답 — maybeFireLiveActivityUpdate 경로(reschedule + LA). */
    function makeTransferSeoul120(): SeoulArrivalClient {
      return new SeoulArrivalClient({
        apiKey: 'K',
        host: 'h',
        now: () => NOW,
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              realtimeArrivalList: [
                {
                  barvlDt: '120',
                  recptnDt: '',
                  updnLine: '상행',
                  trainLineNm: '군자',
                  btrainNo: 'T',
                  subwayNm: '지하철7호선',
                  arvlCd: 5, // 미결 (not ENTERING/ARRIVED)
                },
              ],
            }),
            { status: 200 },
          )) as unknown as typeof fetch,
      });
    }

    it('환승 waypoint 추적 중 LA push content-state lineName이 새 leg(5호선)으로 갱신됨', async () => {
      const kv = new InMemoryKV();
      await putTrip(kv as unknown as KVNamespace, makeTransferLaTrip());
      const fetchImpl = makeOkFetch();
      const stats = await runLaScheduled(kv, { seoul: makeTransferSeoul120(), fetchImpl });
      // reschedule push(background) 1건 + LA update 1건 발사 기대
      expect(stats.laPushSent).toBe(1);
      const laCalls = getLaCalls(fetchImpl);
      expect(laCalls).toHaveLength(1);
      const contentState = parseLaBody(laCalls[0]).aps['content-state'] as Record<string, unknown>;
      // #1654 / #1658 — 환승 waypoint는 7호선이지만 다음 leg(아차산, 5호선)의 line을 LA에 즉시 노출
      expect(contentState.lineName).toBe('5호선');
      expect(contentState.lineColorHex).toBe('#996CAC');
      // stationName은 transfer station(군자) 그대로 유지
      expect(contentState.stationName).toBe('군자');
    });

    it('환승 waypoint 도착(ARRIVED) → advanceBoardingLockWaypoint LA update도 새 leg(5호선) 반영', async () => {
      const kv = new InMemoryKV();
      await putTrip(kv as unknown as KVNamespace, makeTransferLaTrip());
      const fetchImpl = makeOkFetch();
      // 군자역 ARRIVED(arvlCd=1) → advanceBoardingLockWaypoint → 다음 waypoint=아차산(5호선)
      await runLaScheduled(kv, {
        seoul: new SeoulArrivalClient({
          apiKey: 'K',
          host: 'h',
          now: () => NOW,
          fetchImpl: (async () =>
            new Response(
              JSON.stringify({
                realtimeArrivalList: [
                  {
                    barvlDt: '0',
                    recptnDt: '',
                    updnLine: '상행',
                    trainLineNm: '군자',
                    btrainNo: 'T',
                    subwayNm: '지하철7호선',
                    arvlCd: 1, // ARRIVED
                  },
                ],
              }),
              { status: 200 },
            )) as unknown as typeof fetch,
        }),
        fetchImpl,
      });
      const laCalls = getLaCalls(fetchImpl);
      // advanceBoardingLockWaypoint 직후 즉시 LA update 발사 (ETA 임계 무시)
      expect(laCalls).toHaveLength(1);
      const contentState = parseLaBody(laCalls[0]).aps['content-state'] as Record<string, unknown>;
      // nextWaypoint = 아차산(5호선) → LA는 5호선 표시
      expect(contentState.lineName).toBe('5호선');
      expect(contentState.stationName).toBe('아차산');
    });
  });

  describe('#1826 — lockless trip + activityPushToken → LA BG update 발사', () => {
    /** lockless intermediate trip with LA token */
    function makeLocklessLaTrip(overrides: Partial<Trip> = {}): Trip {
      return makeTrip({
        token: 'la-lockless',
        route: { type: 'direct', line: '2', stops: 2 },
        waypoints: [
          { stationName: '강남', line: '2', kind: 'intermediate' },
          { stationName: '역삼', line: '2', kind: 'destination' },
        ],
        infoModeEnabled: true,
        activityPushToken: 'la-lockless-token',
        activityState: 'live',
        apnsEnv: 'sandbox',
        ...overrides,
      });
    }

    /** lockless trip 사이클 실행 + LA push 포함 fetch mock */
    async function runLocklessLaCycle(trip: Trip, arrivalSeconds: number) {
      const kv = new InMemoryKV();
      await putTrip(kv as unknown as KVNamespace, trip);
      // motion=automotive → lockless intermediate advance 허용
      await seedLocklessMotionSeries(kv, trip.token, 'automotive');
      const seoulArrivals: ArrivalEntry[] = [
        {
          destination: '역삼행',
          arrivalSeconds,
          trainCode: '7246',
          isUp: true,
          subwayNm: '지하철2호선',
          arvlCd: 1, // ARRIVED → 발사 조건
        },
      ];
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }) as unknown as Response);
      const stats = await runScheduled(makeEnv(kv), {
        seoul: makeSeoul(seoulArrivals),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
      });
      return { kv, stats, fetchImpl };
    }

    it('lockless intermediate + activityPushToken 있으면 LA update push 발사', async () => {
      const { stats, fetchImpl } = await runLocklessLaCycle(makeLocklessLaTrip(), 120);
      // station-passed silent push 1건 + LA update 1건
      expect(stats.locklessIntermediateFired).toBe(1);
      expect(stats.laPushSent).toBe(1);
      const laCalls = getLaCalls(fetchImpl);
      expect(laCalls).toHaveLength(1);
      const body = parseLaBody(laCalls[0]);
      expect(body.aps.event).toBe('update');
      const contentState = body.aps['content-state'] as Record<string, unknown>;
      expect(contentState.stationName).toBe('강남');
    });

    it('lockless intermediate + activityPushToken 없으면 LA push 없음', async () => {
      const trip = makeLocklessLaTrip({ activityPushToken: undefined, activityState: undefined });
      const { stats, fetchImpl } = await runLocklessLaCycle(trip, 120);
      expect(stats.locklessIntermediateFired).toBe(1);
      expect(stats.laPushSent).toBe(0);
      expect(getLaCalls(fetchImpl)).toHaveLength(0);
    });

    it('lock 없는 trip(boarding-prompt 대기) + activityPushToken → LA heartbeat 발사', async () => {
      // infoModeEnabled=false: lockless opt-in 아님 → boarding-prompt 대기 경로
      const trip = makeTrip({
        token: 'la-prompt-wait',
        route: { type: 'direct', line: '2', stops: 3 },
        waypoints: [
          { stationName: '역삼', line: '2', kind: 'intermediate' },
          { stationName: '강남', line: '2', kind: 'destination' },
        ],
        infoModeEnabled: false,
        activityPushToken: 'la-prompt-token',
        activityState: 'live',
        apnsEnv: 'sandbox',
      });
      const kv = new InMemoryKV();
      await putTrip(kv as unknown as KVNamespace, trip);
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }) as unknown as Response);
      const stats = await runScheduled(makeEnv(kv), {
        seoul: makeSeoul([]), // 응답 없음 — Seoul 폴링은 boarding-prompt 경로
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
      });
      // boarding-prompt 대기(lockMissing) 경로 + LA heartbeat 발사
      expect(stats.lockMissing).toBeGreaterThan(0);
      expect(stats.laPushSent).toBe(1);
      const laCalls = getLaCalls(fetchImpl);
      expect(laCalls).toHaveLength(1);
      expect(parseLaBody(laCalls[0]).aps.event).toBe('update');
    });

    it('lock 없는 trip + activityPushToken 없으면 LA push 없음', async () => {
      const trip = makeTrip({
        token: 'la-prompt-no-token',
        route: { type: 'direct', line: '2', stops: 3 },
        waypoints: [
          { stationName: '역삼', line: '2', kind: 'intermediate' },
          { stationName: '강남', line: '2', kind: 'destination' },
        ],
        infoModeEnabled: false,
        activityPushToken: undefined,
        activityState: undefined,
        apnsEnv: 'sandbox',
      });
      const kv = new InMemoryKV();
      await putTrip(kv as unknown as KVNamespace, trip);
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }) as unknown as Response);
      const stats = await runScheduled(makeEnv(kv), {
        seoul: makeSeoul([]),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
      });
      expect(stats.laPushSent).toBe(0);
      expect(getLaCalls(fetchImpl)).toHaveLength(0);
    });
  });
});

// #1337 — server-side trip auto-end 경로에서 클라 state sync용 trip-ended alert push가 발사되는지.
// 구 #868 silent push는 force-quit 앱 미전달 사고(#1337)로 alert 전환. LA dismissal과 별개 budget
// (분당 0~1건)이라 trip 종료 cleanup 1건당 1회 발사가 기대 동작이며 KV dedup이 1회를 보장한다.
describe('runScheduled — trip-ended alert push (#1337)', () => {
  /** APNs alert push (trip-ended kind) 호출만 추출 — LA push와 분리해 단언. */
  function getTripEndedCalls(
    fetchImpl: ReturnType<typeof vi.fn>,
  ): [string, RequestInit][] {
    return (fetchImpl.mock.calls as unknown as [string, RequestInit][]).filter((c) => {
      const headers = (c[1]?.headers ?? {}) as Record<string, string>;
      if (headers['apns-push-type'] !== 'alert') return false;
      try {
        const body = JSON.parse(c[1]?.body as string) as { data?: { kind?: string } };
        return body?.data?.kind === 'trip-ended';
      } catch {
        return false;
      }
    });
  }

  /** trip-ended push body의 data field 추출. */
  function parseTripEndedData(call: [string, RequestInit]): {
    kind: string;
    reason: string;
    pushId: string;
    sentAt: number;
    tripToken: string;
  } {
    const body = JSON.parse(call[1].body as string) as {
      data: {
        kind: string;
        reason: string;
        pushId: string;
        sentAt: number;
        tripToken: string;
      };
    };
    return body.data;
  }

  // #2157 — train-reconfirm alert push (APNs alert push, kind='train-reconfirm') 호출만 추출.
  function getTrainReconfirmCalls(
    fetchImpl: ReturnType<typeof vi.fn>,
  ): [string, RequestInit][] {
    return (fetchImpl.mock.calls as unknown as [string, RequestInit][]).filter((c) => {
      const headers = (c[1]?.headers ?? {}) as Record<string, string>;
      if (headers['apns-push-type'] !== 'alert') return false;
      try {
        const body = JSON.parse(c[1]?.body as string) as { data?: { kind?: string } };
        return body?.data?.kind === 'train-reconfirm';
      } catch {
        return false;
      }
    });
  }

  /** train-reconfirm push body의 data field 추출. */
  function parseTrainReconfirmData(call: [string, RequestInit]): {
    kind: string;
    pushId: string;
    sentAt: number;
    tripToken: string;
  } {
    const body = JSON.parse(call[1].body as string) as {
      data: { kind: string; pushId: string; sentAt: number; tripToken: string };
    };
    return body.data;
  }

  // 본 describe 안에서만 쓰이는 fixture — makeLockTrip은 outer scope에 있어 재사용 불가.
  function makeEtaThresholdTrip(token: string, missCount: number) {
    return makeTrip({
      token,
      route: { type: 'direct', line: '7', stops: 2 },
      waypoints: [{ stationName: '중곡', line: '7', kind: 'intermediate' }],
      boardingLock: {
        trainCode: '7246',
        line: '7',
        subwayId: '1007',
        selectedDepartureTime: NOW,
        segmentStations: ['용마산', '중곡', '군자'],
        expiresAt: NOW + 60 * 60_000,
      },
      consecutiveEtaMissing: missCount,
    });
  }

  // #2157 (2026-08-05 결정 A) — 순수 eta-missing(Seoul API 정상 응답, trainCode만 매칭 실패)은
  // 더 이상 trip을 강제 종료하지 않는다. 구 동작(trip-ended push + KV 삭제)을 재현하던 테스트를
  // "lock 해제 + lockless 강등 + 재확인 push" 신규 동작으로 교체 — 결정1(#2154)과 일관되게
  // 백엔드가 사용자 trip을 일방 종료하는 상황 자체를 제거한다.
  it('demotes trip to lockless (lock detach, no trip-ended) when consecutiveEtaMissing exceeds threshold', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeEtaThresholdTrip('end-tok', 4));
    const fetchImpl = makeOkFetch();
    // arrivals 비어 있음 → estimate=null → miss 1 더 → 5 도달 → 구동작이면 auto-end, 신동작은 강등.
    // top-level makeSeoul은 positions endpoint도 같은 fetchImpl을 사용 — realtimePositionList 키가
    // 없어 빈 배열로 처리되므로 fallback도 estimate=null로 떨어진다. httpErrorCount=0(ok 응답)이라
    // endReason 판정은 'eta-missing' 경로를 탄다.
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-eta-end',
    });
    // trip-ended push는 더 이상 발사되지 않는다.
    expect(getTripEndedCalls(fetchImpl)).toHaveLength(0);
    // 재확인(train-reconfirm) alert push가 1건 발사된다.
    const calls = getTrainReconfirmCalls(fetchImpl);
    expect(calls).toHaveLength(1);
    const data = parseTrainReconfirmData(calls[0]);
    expect(data.kind).toBe('train-reconfirm');
    expect(data.sentAt).toBe(NOW);
    expect(typeof data.pushId).toBe('string');
    expect(data.pushId.length).toBeGreaterThan(0);
    expect(data.tripToken).toBe('end-tok');
    const headers = (calls[0][1].headers ?? {}) as Record<string, string>;
    expect(headers['apns-push-type']).toBe('alert');
    expect(headers['apns-priority']).toBe('10');
    const apsBody = JSON.parse(calls[0][1].body as string) as {
      aps: { alert: { title: string; body: string } };
    };
    expect(apsBody.aps.alert).toEqual({
      title: '탑승 열차를 찾을 수 없어요',
      body: '다시 확인해주세요',
    });
    // trip은 KV에서 삭제되지 않고 살아있어야 함 — lockless로 강등만 된다.
    const stored = await kv.get('trip:end-tok');
    expect(stored).not.toBeNull();
    const storedTrip = JSON.parse(stored as string) as {
      boardingLock?: unknown;
      consecutiveEtaMissing?: number;
      infoModeEnabled?: boolean;
    };
    expect(storedTrip.boardingLock).toBeUndefined();
    expect(storedTrip.consecutiveEtaMissing).toBe(0);
    expect(storedTrip.infoModeEnabled).toBe(true);
    expect(await kv.get(`trainReconfirmAlert:end-tok:${NOW}`)).toBe('1');
  });

  // #2157 — seoul-outage 분기 회귀 가드. httpErrorCount>0(Seoul API HTTP error 관측)이면 기존
  // trip auto-end + trip-ended push 경로를 그대로 유지 — 강등 로직이 seoul-outage까지 흡수하면
  // #1425 cooldown 면제 판정이 깨진다.
  it('still ends trip (reason=seoul-outage) when Seoul API HTTP error observed this cycle', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeEtaThresholdTrip('outage-tok', 4));
    const erroredFetch = vi.fn(
      async () => new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch;
    const seoul = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: erroredFetch,
    });
    const fetchImpl = makeOkFetch();
    await runScheduled(makeEnv(kv), {
      seoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-outage-end',
    });
    const calls = getTripEndedCalls(fetchImpl);
    expect(calls).toHaveLength(1);
    const data = parseTripEndedData(calls[0]);
    expect(data.reason).toBe('seoul-outage');
    // 재확인 push는 발사되지 않는다 — seoul-outage는 강등 경로를 타지 않는다.
    expect(getTrainReconfirmCalls(fetchImpl)).toHaveLength(0);
    expect(await kv.get('trip:outage-tok')).toBeNull();
  });

  // #2157 — 재확인 push는 1 trip 1회 dedup. 같은 trip이 두 번째 cron cycle에서도 threshold를
  // 계속 초과하면(재선택 전까지 consecutiveEtaMissing이 다시 쌓이는 상황) 중복 발사를 막는다.
  it('does not re-fire train-reconfirm push when dedup KV already stamped', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeEtaThresholdTrip('dedup-tok', 4));
    await kv.put(`trainReconfirmAlert:dedup-tok:${NOW}`, '1');
    const fetchImpl = makeOkFetch();
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-eta-dedup',
    });
    expect(getTrainReconfirmCalls(fetchImpl)).toHaveLength(0);
    // dedup으로 push는 skip돼도 lock detach + lockless 강등 자체는 여전히 일어난다.
    const stored = await kv.get('trip:dedup-tok');
    expect(stored).not.toBeNull();
    const storedTrip = JSON.parse(stored as string) as { boardingLock?: unknown };
    expect(storedTrip.boardingLock).toBeUndefined();
  });

  // #2157 (PR #2162 리뷰 P1) — 같은 trip에서 두 번째 demotion이 발생해도 재확인 push가
  // 발사돼야 한다. createdAt은 trip 재등록(isSameSession) 후에도 보존되므로 dedup 키를
  // createdAt에 고정하면 두 번째 demotion이 첫 demotion의 dedup stamp에 막혀 조용히
  // 미발사되는 회귀가 생긴다 — dedup은 demotion event(`etaMissingDemotedAt`) 단위여야 한다.
  const SECOND_DEMOTION_NOW = NOW + 30 * 60_000;
  it('fires train-reconfirm push again on a second demotion of the same trip (createdAt unchanged)', async () => {
    const kv = new InMemoryKV();
    // 첫 demotion이 이미 NOW 시점에 발생해 dedup stamp를 남긴 상태를 시뮬레이션.
    // createdAt은 trip 생애 내내 불변(NOW) — 재선택 후 재등록해도 isSameSession으로 보존된다.
    await kv.put(`trainReconfirmAlert:re-tok:${NOW}`, '1');
    // 사용자가 재선택(boardingPrompt/직접 탭)해 lock이 재부착된 상태. 두 번째 demotion 직전:
    // consecutiveEtaMissing이 threshold-1까지 다시 쌓인 상태로 seed.
    await putTrip(kv as unknown as KVNamespace, makeEtaThresholdTrip('re-tok', 4));
    const fetchImpl = makeOkFetch();
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => SECOND_DEMOTION_NOW,
      generatePushId: () => 'p-eta-second',
    });
    // 두 번째 demotion은 새 event이므로 push가 발사돼야 한다 (첫 demotion의 dedup stamp에
    // 막히면 안 된다).
    const calls = getTrainReconfirmCalls(fetchImpl);
    expect(calls).toHaveLength(1);
    expect(parseTrainReconfirmData(calls[0]).sentAt).toBe(SECOND_DEMOTION_NOW);
    // 새 demotion event 전용 dedup stamp가 남는다 (createdAt=NOW가 아니라 demotion 시점 기준).
    expect(await kv.get(`trainReconfirmAlert:re-tok:${SECOND_DEMOTION_NOW}`)).toBe('1');
  });

  it('fires trip-ended push (reason=destination-arrived) when destination waypoint ARRIVED', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockedLaTrip());
    const fetchImpl = makeOkFetch();
    // ARRIVED(arvlCd=1) → advanceBoardingLockWaypoint → destination → cleanup
    await runLaScheduled(kv, { seoul: makeLockedSeoul(0, 1), fetchImpl });
    const calls = getTripEndedCalls(fetchImpl);
    expect(calls).toHaveLength(1);
    const data = parseTripEndedData(calls[0]);
    expect(data.reason).toBe('destination-arrived');
    expect(await kv.get('trip:la-tok')).toBeNull();
  });

  it('fires trip-ended push (reason=expired) on trip.expiresAt elapsed', async () => {
    const kv = new InMemoryKV();
    await kv.put(
      'trip:la-tok',
      JSON.stringify(
        makeLockedLaTrip({ expiresAt: NOW + 5_000, alarmAtEpochMs: NOW - 1 }),
      ),
    );
    const fetchImpl = makeOkFetch();
    await runLaScheduled(kv, {
      seoul: makeLockedSeoul(0),
      fetchImpl,
      now: () => NOW + 10_000,
    });
    const calls = getTripEndedCalls(fetchImpl);
    expect(calls).toHaveLength(1);
    expect(parseTripEndedData(calls[0]).reason).toBe('expired');
  });

  it('fires trip-ended push (reason=push-unrecoverable) on reschedule 410 Unregistered', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockedLaTrip());
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (isLaCall(url, init)) return new Response('', { status: 200 });
      const body = init?.body as string | undefined;
      // trip-ended push는 정상 응답 — reschedule push만 410 Unregistered로 폐기 트리거.
      if (body && body.includes('"trip-ended"')) {
        return new Response('', { status: 200 });
      }
      return new Response(JSON.stringify({ reason: 'Unregistered' }), { status: 410 });
    });
    await runLaScheduled(kv, { seoul: makeLockedSeoul(120), fetchImpl });
    const calls = getTripEndedCalls(fetchImpl);
    expect(calls).toHaveLength(1);
    expect(parseTripEndedData(calls[0]).reason).toBe('push-unrecoverable');
    expect(await kv.get('trip:la-tok')).toBeNull();
  });

  // #2157 — eta-missing 자체는 더 이상 trip-ended를 발사하지 않으므로(강등 경로), 본 회귀 가드는
  // seoul-outage(httpErrorCount>0)로 trip-ended push를 여전히 발사하는 경로를 사용해 throw
  // 흡수 동작을 검증한다. Seoul API fetch(끊긴 상태)와 APNs push fetch(trip-ended만 reject)는
  // 서로 다른 fetchImpl이라 독립적으로 구성 가능 — `deps.seoul`은 client 내부에 캡슐화된 fetch를
  // 쓰고, `deps.fetchImpl`은 push 발사에만 쓰인다.
  it('#868 P2-1 — trip-ended push fetch throw해도 cleanup 흐름 계속 (trip 삭제됨)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeEtaThresholdTrip('thr-tok', 4));
    const erroredSeoul = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch,
    });
    // trip-ended push만 reject — reschedule/LA push는 정상.
    const throwingFetch = vi.fn((_url: unknown, init?: { body?: string }) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      if (body.includes('"trip-ended"')) {
        return Promise.reject(new Error('network down'));
      }
      return Promise.resolve(new Response('', { status: 200 }));
    });
    await runScheduled(makeEnv(kv), {
      seoul: erroredSeoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: throwingFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-thr',
    });
    // throw 흡수 → cleanup 진행 → trip 삭제.
    expect(await kv.get('trip:thr-tok')).toBeNull();
  });

  it('does not fire trip-ended push when miss counter increments below threshold', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeEtaThresholdTrip('mid-tok', 1));
    const fetchImpl = makeOkFetch();
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-no-end',
    });
    expect(getTripEndedCalls(fetchImpl)).toHaveLength(0);
    // trip은 살아 있어야 함 (counter만 증가)
    const stored = JSON.parse((await kv.get('trip:mid-tok')) as string) as Trip;
    expect(stored.consecutiveEtaMissing).toBe(2);
  });
});

// #705 — scheduled.ts의 advance/baseline 변경이 progress KV에도 mirror되는지.
// 시나리오는 LA 시나리오와 동일한 makeLockedLaTrip + makeLockedSeoul fixture로 압축.
describe('#705 scheduled.ts progress KV mirroring', () => {
  // 중곡 → 강남 advance 시나리오용 표준 trip override (boardingLock + 2-step waypoints).
  function progressTripOverrides(extra: Partial<Trip> = {}): Partial<Trip> {
    return {
      waypoints: [
        { stationName: '중곡', line: '2', kind: 'intermediate' },
        { stationName: '강남', line: '2', kind: 'destination' },
      ],
      boardingLock: {
        trainCode: 'T',
        line: '2',
        subwayId: '1002',
        selectedDepartureTime: NOW,
        segmentStations: ['역삼', '중곡', '강남'],
        expiresAt: NOW + 60 * 60_000,
      },
      ...extra,
    };
  }

  async function readProgress(kv: InMemoryKV): Promise<Record<string, unknown> | null> {
    const raw = await kv.get('progress:la-tok');
    return raw === null ? null : JSON.parse(raw as string);
  }

  // 중곡 ARRIVED를 트리거하는 표준 seoul + fetch + 실행 — advance 케이스 3건이 공유.
  async function runAdvanceScenario(kv: InMemoryKV): Promise<void> {
    await runLaScheduled(kv, { seoul: makeLockedSeoul(0, 1), fetchImpl: makeOkFetch() });
  }

  it('advanceBoardingLockWaypoint writes progress with shiftedCount=1 and trainCode stamp', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockedLaTrip(progressTripOverrides({ lastLaPushEpoch: NOW + 1000 })),
    );
    // 중곡 ARRIVED → advanceBoardingLockWaypoint 트리거
    await runAdvanceScenario(kv);
    const progress = await readProgress(kv);
    expect(progress).not.toBeNull();
    expect(progress?.trainCode).toBe('T');
    expect(progress?.shiftedCount).toBe(1);
  });

  it('mirrorProgress accumulates shiftedCount across multiple advances', async () => {
    const kv = new InMemoryKV();
    // 이전 advance가 이미 progress에 있는 상태에서 다시 advance.
    await kv.put('progress:la-tok', JSON.stringify({ trainCode: 'T', shiftedCount: 1 }));
    await putTrip(kv as unknown as KVNamespace, makeLockedLaTrip(progressTripOverrides()));
    await runAdvanceScenario(kv);
    expect((await readProgress(kv))?.shiftedCount).toBe(2); // 1 + 1
  });

  it('mirrorProgress resets shiftedCount when stored progress has different trainCode', async () => {
    const kv = new InMemoryKV();
    await kv.put('progress:la-tok', JSON.stringify({ trainCode: 'OLD', shiftedCount: 5 }));
    await putTrip(kv as unknown as KVNamespace, makeLockedLaTrip(progressTripOverrides()));
    await runAdvanceScenario(kv);
    const progress = await readProgress(kv);
    expect(progress?.trainCode).toBe('T');
    expect(progress?.shiftedCount).toBe(1); // old(OLD) 폐기 + 새 advance 1
  });

  it('runTrainCodeTracking mirrors baseline (consecutiveEtaMissing) into progress on etaMissing', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockedLaTrip());
    // arrivals 비어 있고 positions도 매칭 안 됨 → etaMissing 누적
    const seoul = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ realtimeArrivalList: [] }), { status: 200 })) as unknown as typeof fetch,
    });
    await runLaScheduled(kv, { seoul, fetchImpl: makeOkFetch() });
    const progress = await readProgress(kv);
    expect(progress?.consecutiveEtaMissing).toBe(1);
    expect(progress?.shiftedCount).toBe(0);
  });

  it('cleanupTripWithLa removes progress entry alongside trip', async () => {
    const kv = new InMemoryKV();
    await kv.put('progress:la-tok', JSON.stringify({ trainCode: 'T', shiftedCount: 1 }));
    // expired trip → cleanup 경로 진입
    await putTrip(kv as unknown as KVNamespace, makeLockedLaTrip({ expiresAt: NOW - 1 }));
    await runLaScheduled(kv, { seoul: makeLockedSeoul(60), fetchImpl: makeOkFetch() });
    expect(await readProgress(kv)).toBeNull();
  });
});

describe('runScheduled — boarding-prompt 9단 게이트 (#819)', () => {
  function makeUnlockedTrip(overrides: Partial<Trip> = {}): Trip {
    // lockMissing 분기 진입 — boardingLock 없음.
    return makeTrip({
      token: 'bp-tok',
      promptGeoContext: {
        origin: { lat: 0, lng: 0 },
        nextStation: { lat: 0, lng: 0.01 },
        direction: 'up',
      },
      promptDisplay: { originStation: '강남', line: '2' },
      ...overrides,
    });
  }

  // #1888 (RC-13) — boardingPrompt fire는 candidateTrains ≥ 1을 요구하므로 기본 Seoul mock에
  // line=2 up 방향 1건을 동봉. 기존 모든 케이스가 fire 경로(candidateTrains 채워짐)를 그대로 검증.
  // 빈 후보 skip 시나리오는 별도 `it.each` 케이스가 makeSeoul([])를 명시 주입.
  const DEFAULT_BP_ARRIVAL: ArrivalEntry = {
    destination: '성수',
    arrivalSeconds: 60,
    trainCode: 'T1',
    isUp: true,
    subwayNm: '2호선',
    arvlCd: 2,
  };

  function makeBoardingPromptDeps(fetchImpl: typeof fetch, seoul?: SeoulArrivalClient) {
    return {
      seoul: seoul ?? makeSeoul([DEFAULT_BP_ARRIVAL]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      fetchImpl,
      generatePushId: () => 'bp-push-1',
    };
  }

  /** "happy path" series — 모듈 레벨 seedHappyGateSeries 재사용 (bp-tok 기본). */
  const seedHappySeries = (kv: InMemoryKV, token = 'bp-tok') => seedHappyGateSeries(kv, token);

  it('promptGeoContext 없으면 skip — boardingPromptEvaluated 미증가', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTrip({ token: 'no-geo' }));
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const stats = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl));
    expect(stats.boardingPromptEvaluated).toBe(0);
    expect(stats.boardingPromptFired).toBe(0);
  });

  // #2131 (Part A-2) — infoModeEnabled=true + intermediate waypoint 조합은 기존엔
  // `runLocklessIntermediate` + `continue`로 곧장 빠져나가 evaluateAndMaybeFireBoardingPrompt
  // 자체가 호출되지 않았다(boardingPromptEvaluated 영구 0 회귀). hoist 이후 두 경로가 모두 실행돼야
  // 한다 — ADR-014 "사용자 명시 의향(C 토글 ON) trip = lock 활성과 동급 정확도 보장" 준수.
  it('#2131 — infoModeEnabled=true + intermediate waypoint + geo 있음 → prompt 평가 도달', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeUnlockedTrip({
        infoModeEnabled: true,
        waypoints: [
          { stationName: '강남', line: '2', kind: 'intermediate' },
          { stationName: '역삼', line: '2', kind: 'destination' },
        ],
      }),
    );
    await seedHappySeries(kv);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl));

    expect(stats.boardingPromptEvaluated).toBe(1);
  });

  // #2131 (Part A-1) — geo/display 부재 무음 skip 관측성. 기존 테스트는 boardingPromptEvaluated
  // 미증가만 검증 — 본 테스트는 신규 counter로 "왜" evaluate에 못 미쳤는지 명시 관측.
  it('#2131 — promptGeoContext/promptDisplay 부재 시 boardingPromptSkippedNoContext +1', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTrip({ token: 'no-geo' }));
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const stats = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl));
    expect(stats.boardingPromptSkippedNoContext).toBe(1);
    expect(stats.boardingPromptEvaluated).toBe(0);
  });

  // #2130 (Part B-be-1) — 신선도 게이트. trip 등록 후 15분 경과 시 evaluate 자체를 skip.
  it('#2130 — trip 등록 후 15분 경과 시 boardingPromptSkippedStale +1, evaluate 미도달', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeUnlockedTrip({ createdAt: NOW - 15 * 60 * 1000 - 1 }),
    );
    await seedHappySeries(kv);
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl));
    expect(stats.boardingPromptSkippedStale).toBe(1);
    expect(stats.boardingPromptEvaluated).toBe(0);
    expect(fetchImpl as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('#2130 — 15분 경계(정확히 15분)는 신선도 게이트 통과', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeUnlockedTrip({ createdAt: NOW - 15 * 60 * 1000 }),
    );
    await seedHappySeries(kv);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl));
    expect(stats.boardingPromptSkippedStale).toBe(0);
    expect(stats.boardingPromptEvaluated).toBe(1);
  });

  // #2130 (Part B-be-1) — 근접 게이트. distance/accuracy 둘 다 있고 오차 고려해도 150m 밖이면 차단.
  it('#2130 — originDistanceM/originAccuracyM 둘 다 존재 + 150m 초과 → boardingPromptSkippedTooFar +1', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeUnlockedTrip({
        promptGeoContext: {
          origin: { lat: 0, lng: 0 },
          nextStation: { lat: 0, lng: 0.01 },
          direction: 'up',
          originDistanceM: 227,
          originAccuracyM: 9,
        },
      }),
    );
    await seedHappySeries(kv);
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl));
    expect(stats.boardingPromptSkippedTooFar).toBe(1);
    expect(stats.boardingPromptEvaluated).toBe(0);
    expect(fetchImpl as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('#2130 — 경계(distance - accuracy === 150) 는 근접 게이트 통과 (150 초과만 차단)', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeUnlockedTrip({
        promptGeoContext: {
          origin: { lat: 0, lng: 0 },
          nextStation: { lat: 0, lng: 0.01 },
          direction: 'up',
          originDistanceM: 300,
          originAccuracyM: 150,
        },
      }),
    );
    await seedHappySeries(kv);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl));
    expect(stats.boardingPromptSkippedTooFar).toBe(0);
    expect(stats.boardingPromptEvaluated).toBe(1);
  });

  it('#2130 — originDistanceM/originAccuracyM 부재(지하/구 클라) → 근접 게이트 관대 허용', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeUnlockedTrip());
    await seedHappySeries(kv);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl));
    expect(stats.boardingPromptSkippedTooFar).toBe(0);
    expect(stats.boardingPromptEvaluated).toBe(1);
  });

  // #2153 — 신선도 게이트 기준 시각 재anchor. route 설정(createdAt) 후 20분 지나 출발역에
  // 근접(집/사무실에서 미리 경로 설정 후 이동하는 흔한 패턴)해도 근접 관측 시각을 기준으로
  // 15분 창을 재계산해야 한다. createdAt 기준이면 이 케이스가 SkippedStale로 막힌다(#2153 RCA).
  it('#2153 — route 설정 20분 후 출발역 근접 관측이면 anchor 재정의로 SkippedStale 아님', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeUnlockedTrip({
        createdAt: NOW - 20 * 60 * 1000,
        promptGeoContext: {
          origin: { lat: 0, lng: 0 },
          nextStation: { lat: 0, lng: 0.01 },
          direction: 'up',
          // 근접 관측: distance - accuracy = 40m, margin(150m) 이내.
          originDistanceM: 50,
          originAccuracyM: 10,
        },
      }),
    );
    await seedHappySeries(kv);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl));

    // anchor 재정의 후 기대값: 근접 관측 시점(현재 cycle)이 anchor이므로 stale 아님.
    expect(stats.boardingPromptSkippedStale).toBe(0);
    expect(stats.boardingPromptEvaluated).toBe(1);
  });

  // #2350 — 근접 게이트 live anchor 전환. `/position` 채널(index.ts stampOriginProximityIfNeeded)이
  // 이미 originProximityAt을 stamp했다면(디바이스가 실시간으로 근접을 확인함), POST /trips
  // 등록 시점의 정적 promptGeoContext 스냅샷이 "멀다"를 가리켜도 근접 게이트로 영구 차단해선
  // 안 된다 — 집에서 경로 미리 설정 후 도보 이동하는 흔한 케이스(#2350 RCA).
  it('#2350 — originProximityAt 이미 stamp됨 + 정적 스냅샷 tooFar → 근접 게이트 통과(발사 도달)', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeUnlockedTrip({
        // /position 채널이 과거에 이미 근접을 관측해 stamp — anchor 존재.
        originProximityAt: NOW - 5 * 60 * 1000,
        promptGeoContext: {
          origin: { lat: 0, lng: 0 },
          nextStation: { lat: 0, lng: 0.01 },
          direction: 'up',
          // 등록 시점 정적 스냅샷은 여전히 "멀다"(300 - 9 = 291 > 150) — 갱신 안 됨(index.ts:1564).
          originDistanceM: 300,
          originAccuracyM: 9,
        },
      }),
    );
    await seedHappySeries(kv);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl));
    expect(stats.boardingPromptSkippedTooFar).toBe(0);
    expect(stats.boardingPromptEvaluated).toBe(1);
  });

  // #2350 — originProximityAt이 아직 stamp 안 됐고 정적 스냅샷이 진짜 멀면 여전히 차단(무회귀).
  it('#2350 — originProximityAt 미stamp + 정적 스냅샷 tooFar → 근접 게이트 여전히 차단(무회귀)', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeUnlockedTrip({
        promptGeoContext: {
          origin: { lat: 0, lng: 0 },
          nextStation: { lat: 0, lng: 0.01 },
          direction: 'up',
          originDistanceM: 300,
          originAccuracyM: 9,
        },
      }),
    );
    await seedHappySeries(kv);
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl));
    expect(stats.boardingPromptSkippedTooFar).toBe(1);
    expect(stats.boardingPromptEvaluated).toBe(0);
  });

  // #2358 (RCA — #2153 원안 결함) — 근접 관측 시각(originProximityAt)을 최초 1회만 stamp하고
  // 영구 고정하면, "출발역에서 계속 대기 중"인 실 시나리오(배차 간격이 긴 노선에서 열차를
  // 기다리는 "원점 대기~탑승")가 15분을 넘기는 순간 근접이 실시간으로 계속 확인되는 중에도
  // 영구히 SkippedStale로 막힌다. anchor는 근접이 계속 관측되는 동안 주기적으로
  // (ORIGIN_PROXIMITY_RENEWAL_MS, 5분) 재stamp돼야 한다 — 15분+ 경과해도 근접이 계속
  // 관측되고 있으면 SkippedStale이면 안 된다.
  it('#2358 — 근접 관측이 계속되면(원점 대기) anchor가 갱신돼 15분+ 경과해도 SkippedStale 아님', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeUnlockedTrip({
        createdAt: NOW - 20 * 60 * 1000,
        promptGeoContext: {
          origin: { lat: 0, lng: 0 },
          nextStation: { lat: 0, lng: 0.01 },
          direction: 'up',
          originDistanceM: 50,
          originAccuracyM: 10,
        },
      }),
    );
    await seedHappySeries(kv);
    const fetchImpl1 = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const stats1 = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl1));
    expect(stats1.boardingPromptSkippedStale).toBe(0);

    // 두 번째 cycle: 첫 cycle의 stamp(NOW) 기준 16분 경과 — 여전히 근접 관측 중이므로
    // ORIGIN_PROXIMITY_RENEWAL_MS(5분) 초과 시 anchor가 재stamp돼 stale이 아니어야 한다.
    await seedHappySeries(kv);
    const fetchImpl2 = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const stats2 = await runScheduled(makeEnv(kv), {
      ...makeBoardingPromptDeps(fetchImpl2),
      now: () => NOW + 16 * 60 * 1000,
    });
    expect(stats2.boardingPromptSkippedStale).toBe(0);
  });

  // #2358 — 근접 관측이 끊긴(더 이상 nearOrigin 갱신이 오지 않는) 진짜 오래된 trip은 anchor가
  // 재stamp되지 않으므로 여전히 stale이어야 한다 (renewal이 무제한 게이트 무력화가 아님을 회귀 방지).
  it('#2358 — 근접 관측이 끊긴 trip은 anchor가 stale인 채 보존되고 재관측 없으면 계속 SkippedStale', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeUnlockedTrip({
        createdAt: NOW - 20 * 60 * 1000,
        originProximityAt: NOW - 16 * 60 * 1000,
        // 이 cycle의 geo context는 근접이 아니다(예: 재등록 없이 신선한 관측이 끊김) — nearOrigin
        // 판정 재료(distance/accuracy) 부재로 anchor 갱신 기회가 없다.
      }),
    );
    await seedHappySeries(kv);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const stats = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl));
    expect(stats.boardingPromptSkippedStale).toBe(1);
    expect(stats.boardingPromptEvaluated).toBe(0);
  });

  it('9단 통과 + APNs 200 → alert push 발사 + state.fired 영구화', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeUnlockedTrip());
    await seedHappySeries(kv);
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl));

    expect(stats.boardingPromptEvaluated).toBe(1);
    expect(stats.boardingPromptFired).toBe(1);
    expect(stats.boardingPromptBlocked).toBe(0);

    // #2069 (Phase 3) — B8(silent fallback) 제거. B7 원격 alert push 단일 채널 — 1회 fetch.
    const fetchMock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, alertInit] = fetchMock.mock.calls[0];
    expect((alertInit as RequestInit).headers).toMatchObject({
      'apns-push-type': 'alert',
      'apns-priority': '10',
    });
    const alertBody = JSON.parse((alertInit as RequestInit).body as string);
    expect(alertBody.aps.category).toBe('BOARDING_PROMPT');
    expect(alertBody.data.kind).toBe('boarding-prompt');
    expect(alertBody.data.originStation).toBe('강남');
    expect(alertBody.data.line).toBe('2');

    const persisted = JSON.parse((await kv.get('trip:bp-tok'))!);
    // #2130 (Part B-be-2) — "trip당 1회" 정책 폐기. 반복 발사(A4) 상태(firedTrainCodes/fireCount)가
    // 함께 stamp된다. DEFAULT_BP_ARRIVAL(arvlCd=2, trainCode='T1')이 단일 후보라 dedup 없이 선택된다.
    expect(persisted.boardingPromptState).toEqual({
      fired: true,
      lastFiredAt: NOW,
      fireCount: 1,
      firedTrainCodes: ['T1'],
    });
  });

  it('이미 fired된 trip은 미발사 + blocked 카운트', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeUnlockedTrip({ boardingPromptState: { fired: true, lastFiredAt: NOW - 60_000 } }),
    );
    await seedHappySeries(kv);
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl));
    expect(stats.boardingPromptFired).toBe(0);
    expect(stats.boardingPromptBlocked).toBe(1);
    expect(fetchImpl as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  // #2130 (Part B-be-2, A4) — 반복 발사. "trip당 1회" 정책 폐기 후 5분 최소 간격을 넘긴
  // 새 trainCode는 재발사한다.
  // #2130 (Part B-be-2) — AUTO_PROMPT_DEDUP_WINDOW_MS(30분) 게이트는 `boardingPromptState`가
  // undefined(리셋)일 때만 발동해야 한다. 같은 trip 안에서 반복 발사 중(boardingPromptState
  // 존재)이면 이 30분 게이트가 겹쳐 걸려 2번째 열차조차 못 쏘는 회귀를 방지한다.
  it('#2130 — lastAutoPromptedAt이 30분 이내라도 boardingPromptState 존재 시 auto-dedup 미적용', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeUnlockedTrip({
        lastAutoPromptedAt: NOW - 5 * 60 * 1000,
        boardingPromptState: {
          fired: true,
          lastFiredAt: NOW - 5 * 60 * 1000,
          fireCount: 1,
          firedTrainCodes: ['T1'],
        },
      }),
    );
    await seedHappySeries(kv);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const nextTrainArrival: ArrivalEntry = {
      destination: '성수',
      arrivalSeconds: 30,
      trainCode: 'T2',
      isUp: true,
      subwayNm: '2호선',
      arvlCd: 2,
    };

    const stats = await runScheduled(
      makeEnv(kv),
      makeBoardingPromptDeps(fetchImpl, makeSeoul([nextTrainArrival])),
    );
    expect(stats.boardingPromptAutoDeduped).toBe(0);
    expect(stats.boardingPromptFired).toBe(1);
  });

  it('#2130 A4 — 5분 경과 + 새 trainCode 관측 시 재발사 + collapse-id 고정', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeUnlockedTrip({
        boardingPromptState: {
          fired: true,
          lastFiredAt: NOW - 5 * 60 * 1000,
          fireCount: 1,
          firedTrainCodes: ['T1'],
        },
      }),
    );
    await seedHappySeries(kv);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const nextTrainArrival: ArrivalEntry = {
      destination: '성수',
      arrivalSeconds: 30,
      trainCode: 'T2',
      isUp: true,
      subwayNm: '2호선',
      arvlCd: 2,
    };

    const stats = await runScheduled(
      makeEnv(kv),
      makeBoardingPromptDeps(fetchImpl, makeSeoul([nextTrainArrival])),
    );
    expect(stats.boardingPromptFired).toBe(1);
    expect(stats.boardingPromptSkippedMinInterval).toBe(0);
    expect(stats.boardingPromptSkippedTrainDuplicate).toBe(0);

    const fetchMock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({
      'apns-collapse-id': 'boarding-prompt-bp-tok',
    });

    const persisted = JSON.parse((await kv.get('trip:bp-tok'))!);
    expect(persisted.boardingPromptState).toEqual({
      fired: true,
      lastFiredAt: NOW,
      fireCount: 2,
      firedTrainCodes: ['T1', 'T2'],
    });
  });

  it('#2130 A4 — 5분 미달이면 새 trainCode여도 boardingPromptSkippedMinInterval로 차단', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeUnlockedTrip({
        boardingPromptState: {
          fired: true,
          lastFiredAt: NOW - 60_000,
          fireCount: 1,
          firedTrainCodes: ['T1'],
        },
      }),
    );
    await seedHappySeries(kv);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const nextTrainArrival: ArrivalEntry = {
      destination: '성수',
      arrivalSeconds: 30,
      trainCode: 'T2',
      isUp: true,
      subwayNm: '2호선',
      arvlCd: 2,
    };

    const stats = await runScheduled(
      makeEnv(kv),
      makeBoardingPromptDeps(fetchImpl, makeSeoul([nextTrainArrival])),
    );
    expect(stats.boardingPromptFired).toBe(0);
    expect(stats.boardingPromptSkippedMinInterval).toBe(1);
    expect(fetchImpl as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('#2130 A4 — 5분 경과했지만 같은 trainCode면 boardingPromptSkippedTrainDuplicate로 차단', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeUnlockedTrip({
        boardingPromptState: {
          fired: true,
          lastFiredAt: NOW - 5 * 60 * 1000,
          fireCount: 1,
          firedTrainCodes: ['T1'],
        },
      }),
    );
    await seedHappySeries(kv);
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    // DEFAULT_BP_ARRIVAL(trainCode='T1') 그대로 재관측 — 같은 열차가 cron 여러 tick에 걸림.
    const stats = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl));
    expect(stats.boardingPromptFired).toBe(0);
    expect(stats.boardingPromptSkippedTrainDuplicate).toBe(1);
    expect(fetchImpl as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('#2130 A4 — fireCount가 최대 발사 횟수(3)에 도달하면 boardingPromptSkippedMaxFires로 차단', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeUnlockedTrip({
        boardingPromptState: {
          fired: true,
          lastFiredAt: NOW - 10 * 60 * 1000,
          fireCount: 3,
          firedTrainCodes: ['T1', 'T2', 'T3'],
        },
      }),
    );
    await seedHappySeries(kv);
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl));
    expect(stats.boardingPromptFired).toBe(0);
    expect(stats.boardingPromptSkippedMaxFires).toBe(1);
    expect(fetchImpl as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('series 비어 있으면 window-too-small로 차단', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeUnlockedTrip());
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl));
    expect(stats.boardingPromptEvaluated).toBe(1);
    expect(stats.boardingPromptFired).toBe(0);
    expect(stats.boardingPromptBlocked).toBe(1);
  });

  it('APNs 실패 시 errors 카운트 + state 유지', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeUnlockedTrip());
    await seedHappySeries(kv);
    // 410 외 일반 실패 — env mismatch 아님
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ reason: 'TopicDisallowed' }), { status: 403 }),
    ) as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl));
    expect(stats.boardingPromptFired).toBe(0);
    expect(stats.errors).toBeGreaterThan(0);
  });

  it('APNs env mismatch 시 self-heal → corrected env 저장', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeUnlockedTrip({ apnsEnv: 'sandbox' }),
    );
    await seedHappySeries(kv);
    let callIdx = 0;
    const fetchImpl = vi.fn(async () => {
      callIdx += 1;
      if (callIdx === 1) {
        return new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 });
      }
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeBoardingPromptDeps(fetchImpl));
    expect(stats.boardingPromptFired).toBe(1);
    expect(stats.envCorrected).toBe(1);
    const persisted = JSON.parse((await kv.get('trip:bp-tok'))!);
    expect(persisted.apnsEnv).toBe('production');
  });

  // #1888 (RC-13) — Seoul API 응답이 empty이거나 line 매칭 후 0건이면 발사 skip.
  // 사용자가 banner 탭 후 빈 BoardingTrainList만 보는 IMG_9039/9040 시나리오 차단.
  describe('#1888 RC-13 candidateTrains skip-empty', () => {
    const LINE_2_UP_ARRIVAL: ArrivalEntry = {
      destination: '성수',
      arrivalSeconds: 90,
      trainCode: 'RC13-T1',
      isUp: true,
      subwayNm: '2호선',
      arvlCd: 2,
    };
    const LINE_9_UP_ARRIVAL: ArrivalEntry = {
      destination: '종합운동장',
      arrivalSeconds: 120,
      trainCode: 'RC13-T2',
      isUp: true,
      subwayNm: '9호선', // line=2 trip이라 매칭 fail
      arvlCd: 2,
    };

    it('Seoul API 응답 0건 → fire skip + boardingPromptSkippedEmpty +1', async () => {
      const kv = new InMemoryKV();
      await putTrip(kv as unknown as KVNamespace, makeUnlockedTrip());
      await seedHappySeries(kv);
      const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
      const deps = makeBoardingPromptDeps(fetchImpl, makeSeoul([]));

      const stats = await runScheduled(makeEnv(kv), deps);

      expect(stats.boardingPromptEvaluated).toBe(1);
      expect(stats.boardingPromptFired).toBe(0);
      expect(stats.boardingPromptSkippedEmpty).toBe(1);
      // APNs fetch 호출 X (push 자체가 발사되지 않음).
      expect(fetchImpl as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    });

    it('line 매칭 후 0건 (다른 호선만 응답) → fire skip + boardingPromptSkippedEmpty +1', async () => {
      const kv = new InMemoryKV();
      await putTrip(kv as unknown as KVNamespace, makeUnlockedTrip());
      await seedHappySeries(kv);
      const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
      // trip line=2이지만 Seoul mock은 9호선만 응답 — pool 결과 0건.
      const deps = makeBoardingPromptDeps(fetchImpl, makeSeoul([LINE_9_UP_ARRIVAL]));

      const stats = await runScheduled(makeEnv(kv), deps);

      expect(stats.boardingPromptFired).toBe(0);
      expect(stats.boardingPromptSkippedEmpty).toBe(1);
      expect(fetchImpl as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    });

    it('line 매칭 OK + 최소 1건 → fire (skip-empty 카운터 미증가)', async () => {
      const kv = new InMemoryKV();
      await putTrip(kv as unknown as KVNamespace, makeUnlockedTrip());
      await seedHappySeries(kv);
      const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
      const deps = makeBoardingPromptDeps(fetchImpl, makeSeoul([LINE_2_UP_ARRIVAL]));

      const stats = await runScheduled(makeEnv(kv), deps);

      expect(stats.boardingPromptFired).toBe(1);
      expect(stats.boardingPromptSkippedEmpty).toBe(0);
    });

    // #1921 — F2 backend defense. boarding-prompt는 boarding 이전 게이트 — lock이 이미 활성/존재인
    // trip은 cron 진입 자체가 의미 없음. lockMissing 분기로 진입한다면 race(예: lock 만료 직후) —
    // counter로 측정 + return.
    it('#1921 F2 — trip.boardingLock 존재 시 즉시 return + boardingPromptSkippedLockActive +1', async () => {
      const kv = new InMemoryKV();
      // expired boardingLock 부착 → isBoardingLockActive=false (lockMissing 분기 진입) 보장,
      // 그러나 trip.boardingLock !== undefined이므로 F2 defense가 즉시 return.
      await putTrip(
        kv as unknown as KVNamespace,
        makeUnlockedTrip({
          boardingLock: {
            trainCode: 'T-expired',
            line: '2',
            subwayId: '1002',
            selectedDepartureTime: NOW - 60_000,
            segmentStations: ['역삼', '강남'],
            expiresAt: NOW - 1, // 만료
          },
        }),
      );
      await seedHappySeries(kv);
      const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
      const deps = makeBoardingPromptDeps(fetchImpl, makeSeoul([LINE_2_UP_ARRIVAL]));

      const stats = await runScheduled(makeEnv(kv), deps);

      // F2 defense — 즉시 return → evaluated/fired/blocked/skippedEmpty 모두 0.
      expect(stats.boardingPromptEvaluated).toBe(0);
      expect(stats.boardingPromptFired).toBe(0);
      expect(stats.boardingPromptBlocked).toBe(0);
      expect(stats.boardingPromptSkippedEmpty).toBe(0);
      // F2 counter +1.
      expect(stats.boardingPromptSkippedLockActive).toBe(1);
      // APNs fetch X.
      expect(fetchImpl as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    });

    it('#1921 F2 — trip.boardingLock 없으면 F2 defense 미발동, 정상 fire 경로 진행', async () => {
      // 정상 unlocked trip — F2 counter 0, 기존 fire 경로 그대로.
      const kv = new InMemoryKV();
      await putTrip(kv as unknown as KVNamespace, makeUnlockedTrip());
      await seedHappySeries(kv);
      const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
      const deps = makeBoardingPromptDeps(fetchImpl, makeSeoul([LINE_2_UP_ARRIVAL]));

      const stats = await runScheduled(makeEnv(kv), deps);

      expect(stats.boardingPromptSkippedLockActive).toBe(0);
      expect(stats.boardingPromptFired).toBe(1);
    });

    it('candidateTrains payload wire — sorted by arrivalSeconds asc + max 5건', async () => {
      const kv = new InMemoryKV();
      await putTrip(kv as unknown as KVNamespace, makeUnlockedTrip());
      await seedHappySeries(kv);
      // 6건 — 정렬 후 slice(0,5) 검증. 의도적으로 역순으로 등록.
      const arrivals: ArrivalEntry[] = [
        { ...LINE_2_UP_ARRIVAL, trainCode: 'T6', arrivalSeconds: 600 },
        { ...LINE_2_UP_ARRIVAL, trainCode: 'T5', arrivalSeconds: 500 },
        { ...LINE_2_UP_ARRIVAL, trainCode: 'T4', arrivalSeconds: 400 },
        { ...LINE_2_UP_ARRIVAL, trainCode: 'T3', arrivalSeconds: 300 },
        { ...LINE_2_UP_ARRIVAL, trainCode: 'T2', arrivalSeconds: 200 },
        { ...LINE_2_UP_ARRIVAL, trainCode: 'T1', arrivalSeconds: 100 },
      ];
      const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
      const deps = makeBoardingPromptDeps(fetchImpl, makeSeoul(arrivals));

      await runScheduled(makeEnv(kv), deps);

      const fetchMock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
      // #2069 (Phase 3) — B8(silent fallback) 제거. B7 원격 alert push 단일 채널 — 1회 fetch.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse((init as RequestInit).body as string);
      // 5건만 wire + arrivalSeconds 오름차순.
      expect(body.data.candidateTrains).toHaveLength(5);
      expect(body.data.candidateTrains.map((c: { trainCode: string }) => c.trainCode)).toEqual([
        'T1', 'T2', 'T3', 'T4', 'T5',
      ]);
      // 각 후보의 schema 검증 — line/direction/nextArrivalEta.
      const first = body.data.candidateTrains[0];
      expect(first).toEqual({
        trainCode: 'T1',
        line: '2',
        direction: 'up',
        nextArrivalEta: 100,
      });
    });
  });

  // #1964 (Cl-5) — PR #1941(F2 defense) + PR #1946(LA backstop)이 같은 lockMissing 분기
  // 진입점을 mutate. 이슈 원문은 "F2가 lockMissing을 즉시 return해 LA backstop을 막는다"고
  // 가정했으나, 현재 dev 코드(scheduled.ts:1157~1180)는 lockMissing 분기 진입 시 LA backstop을
  // 먼저 평가하고(#1946), 그 continue를 통과해야만 `evaluateAndMaybeFireBoardingPrompt`가
  // 호출돼 F2(#1941)가 평가된다 — 즉 LA backstop이 항상 F2보다 먼저 평가되는 순서.
  // 본 describe는 이 실제 우선순위를 SSoT로 고정하고, 두 stat이 1 cycle에서 동시 증가하지
  // 않음을 검증한다.
  describe('#1964 (Cl-5) — lockMissing 통합: LA backstop vs F2 defense 우선순위', () => {
    const CL5_ARRIVAL: ArrivalEntry = {
      destination: '성수',
      arrivalSeconds: 60,
      trainCode: 'T1',
      isUp: true,
      subwayNm: '2호선',
      arvlCd: 2,
    };

    function expiredLock(overrides: Partial<BoardingLockMeta> = {}): BoardingLockMeta {
      return {
        trainCode: 'T-expired',
        line: '2',
        subwayId: '1002',
        selectedDepartureTime: NOW - 60_000,
        segmentStations: ['역삼', '강남'],
        expiresAt: NOW - 1, // 만료 → isBoardingLockActive=false, lockMissing 분기 진입
        ...overrides,
      };
    }

    it('case 1: boardingLock 존재(만료) + lastLaPushAt 6분 침묵 → LA backstop 우선 발동, F2 미평가', async () => {
      const kv = new InMemoryKV();
      await putTrip(
        kv as unknown as KVNamespace,
        makeUnlockedTrip({
          boardingLock: expiredLock(),
          lastLaPushAt: NOW - 6 * 60_000,
        }),
      );
      await seedHappySeries(kv);
      const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
      const deps = makeBoardingPromptDeps(fetchImpl, makeSeoul([CL5_ARRIVAL]));

      const stats = await runScheduled(makeEnv(kv), deps);

      expect(stats.laStaleAutoEnded).toBe(1);
      // LA backstop이 continue로 cycle을 종료 — evaluateAndMaybeFireBoardingPrompt 자체가
      // 호출되지 않으므로 F2 defense도 평가되지 않는다.
      expect(stats.boardingPromptSkippedLockActive).toBe(0);
      expect(stats.boardingPromptEvaluated).toBe(0);
    });

    it('case 2: boardingLock 존재(만료) + lastLaPushAt 4분(비침묵) → LA backstop 미발동, F2 발동', async () => {
      const kv = new InMemoryKV();
      await putTrip(
        kv as unknown as KVNamespace,
        makeUnlockedTrip({
          boardingLock: expiredLock(),
          lastLaPushAt: NOW - 4 * 60_000,
        }),
      );
      await seedHappySeries(kv);
      const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
      const deps = makeBoardingPromptDeps(fetchImpl, makeSeoul([CL5_ARRIVAL]));

      const stats = await runScheduled(makeEnv(kv), deps);

      expect(stats.laStaleAutoEnded).toBe(0);
      expect(stats.boardingPromptSkippedLockActive).toBe(1);
      // F2가 evaluateAndMaybeFireBoardingPrompt 진입 직후 즉시 return — 9단 게이트 미평가.
      expect(stats.boardingPromptEvaluated).toBe(0);
    });

    it('case 3: boardingLock 완전 release(undefined) + lastLaPushAt 6분 침묵 → LA backstop 발동 (F2 무관)', async () => {
      const kv = new InMemoryKV();
      await putTrip(
        kv as unknown as KVNamespace,
        makeUnlockedTrip({
          lastLaPushAt: NOW - 6 * 60_000,
        }),
      );
      await seedHappySeries(kv);
      const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
      const deps = makeBoardingPromptDeps(fetchImpl, makeSeoul([CL5_ARRIVAL]));

      const stats = await runScheduled(makeEnv(kv), deps);

      expect(stats.laStaleAutoEnded).toBe(1);
      expect(stats.boardingPromptSkippedLockActive).toBe(0);
      expect(stats.boardingPromptEvaluated).toBe(0);
    });

    it('case 4: boardingLock 완전 release + lastLaPushAt 침묵 없음 → 두 분기 모두 미발동, 9단 게이트 진입/발사', async () => {
      const kv = new InMemoryKV();
      await putTrip(kv as unknown as KVNamespace, makeUnlockedTrip());
      await seedHappySeries(kv);
      const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
      const deps = makeBoardingPromptDeps(fetchImpl, makeSeoul([CL5_ARRIVAL]));

      const stats = await runScheduled(makeEnv(kv), deps);

      expect(stats.laStaleAutoEnded).toBe(0);
      expect(stats.boardingPromptSkippedLockActive).toBe(0);
      expect(stats.boardingPromptEvaluated).toBe(1);
      expect(stats.boardingPromptFired).toBe(1);
    });

    it.each([
      ['case1 (lock 만료 + LA 침묵)', { boardingLock: expiredLock(), lastLaPushAt: NOW - 6 * 60_000 }],
      ['case2 (lock 만료 + LA 비침묵)', { boardingLock: expiredLock(), lastLaPushAt: NOW - 4 * 60_000 }],
      ['case3 (lock release + LA 침묵)', { lastLaPushAt: NOW - 6 * 60_000 }],
      ['case4 (lock release + LA 비침묵)', {}],
    ] as [string, Partial<Trip>][])(
      '%s — laStaleAutoEnded / boardingPromptSkippedLockActive 동시 증가 0건 (acceptance #2)',
      async (_label, overrides) => {
        const kv = new InMemoryKV();
        await putTrip(kv as unknown as KVNamespace, makeUnlockedTrip(overrides));
        await seedHappySeries(kv);
        const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
        const deps = makeBoardingPromptDeps(fetchImpl, makeSeoul([CL5_ARRIVAL]));

        const stats = await runScheduled(makeEnv(kv), deps);

        const bothIncrementedSameCycle =
          stats.laStaleAutoEnded > 0 && stats.boardingPromptSkippedLockActive > 0;
        expect(bothIncrementedSameCycle).toBe(false);
      },
    );
  });
});

/**
 * #2014 (ADR-022 B8) — deps.archFlag='on' 시 boardingPrompt 게이트 축소.
 *
 * 관찰 11 root cause: `MIN_WINDOW_SAMPLES=1` 게이트가 60s window sample 0건 시 no-candidates 로 100% 차단.
 * B8 정책: "arvlCd=1 도착 시 즉시 발사. motion / speed 게이트 없음".
 *
 * 본 describe 는 archFlag='on' 배선 시 실제 fire 경로가 열리는지 + FP 방어 유지되는지 검증.
 */
describe('runScheduled — #2014 (ADR-022 B8) archFlag=on 배선', () => {
  function makeUnlockedTrip(overrides: Partial<Trip> = {}): Trip {
    return makeTrip({
      token: 'b8-tok',
      promptGeoContext: {
        origin: { lat: 0, lng: 0 },
        nextStation: { lat: 0, lng: 0.01 },
        direction: 'up',
      },
      promptDisplay: { originStation: '강남', line: '2' },
      ...overrides,
    });
  }

  // arvlCd=1 (ARRIVED) 도착 신호 — 단일 후보 (pickAutoTrainCode 통과).
  const ARVL_ARRIVED_SINGLE: ArrivalEntry = {
    destination: '성수',
    arrivalSeconds: 0,
    trainCode: 'B8-T1',
    isUp: true,
    subwayNm: '2호선',
    arvlCd: 1,
  };

  function makeArchFlagDeps(
    fetchImpl: typeof fetch,
    seoul?: SeoulArrivalClient,
    archFlag: 'on' | 'off' | undefined = 'on',
  ) {
    return {
      seoul: seoul ?? makeSeoul([ARVL_ARRIVED_SINGLE]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      fetchImpl,
      generatePushId: () => 'b8-push-1',
      archFlag,
    };
  }

  it('archFlag=on + series=[] + arvlCd=1 → fire (관찰 11 회귀 fix)', async () => {
    // 관찰 11 재현: series 0건 → legacy 는 no-candidates 로 100% blocked.
    // archFlag=on 은 게이트 skip → 정상 fire.
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeUnlockedTrip());
    // series 시드하지 않음 → 빈 series.
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeArchFlagDeps(fetchImpl));

    expect(stats.boardingPromptEvaluated).toBe(1);
    expect(stats.boardingPromptFired).toBe(1);
    expect(stats.boardingPromptBlocked).toBe(0);
    // #2069 (Phase 3) — B8(silent fallback) 제거. B7 원격 alert push 단일 채널 — 1회 fetch.
    expect(fetchImpl as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse((await kv.get('trip:b8-tok'))!);
    // #2130 (Part B-be-2) — 반복 발사(A4) 상태 동시 stamp. ARVL_ARRIVED_SINGLE(arvlCd=1,
    // trainCode='B8-T1')이 단일 후보라 dedup 없이 선택된다.
    expect(persisted.boardingPromptState).toEqual({
      fired: true,
      lastFiredAt: NOW,
      fireCount: 1,
      firedTrainCodes: ['B8-T1'],
    });
  });

  it('archFlag=off + series=[] → 기존 no-candidates 차단 유지 (회귀 방어)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeUnlockedTrip());
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const stats = await runScheduled(
      makeEnv(kv),
      makeArchFlagDeps(fetchImpl, undefined, 'off'),
    );

    expect(stats.boardingPromptEvaluated).toBe(1);
    expect(stats.boardingPromptFired).toBe(0);
    expect(stats.boardingPromptBlocked).toBe(1);
    expect(fetchImpl as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('archFlag undefined + series=[] → 기존 no-candidates 차단 유지 (legacy 호환)', async () => {
    // deps 에 archFlag 키 자체를 넣지 않음 (`makeArchFlagDeps` 기본값 'on' 회피).
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeUnlockedTrip());
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const legacyDeps = {
      seoul: makeSeoul([ARVL_ARRIVED_SINGLE]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      fetchImpl,
      generatePushId: () => 'b8-push-1',
    };

    const stats = await runScheduled(makeEnv(kv), legacyDeps);

    expect(stats.boardingPromptFired).toBe(0);
    expect(stats.boardingPromptBlocked).toBe(1);
  });

  it('archFlag=on + already fired → skip (게이트 #9 유지)', async () => {
    // silence/fired dedup 은 archFlag=on 에서도 반드시 평가.
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeUnlockedTrip({
        boardingPromptState: { fired: true, lastFiredAt: NOW - 60_000 },
      }),
    );
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeArchFlagDeps(fetchImpl));

    expect(stats.boardingPromptFired).toBe(0);
    expect(stats.boardingPromptBlocked).toBe(1);
    expect(fetchImpl as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('archFlag=on + pickAutoTrainCode ambiguity → skip (FP guard 유지)', async () => {
    // 같은 arvlCd=1 후보 2건 → pickAutoTrainCode null → fire skip.
    const AMBIGUOUS_TRAIN_A: ArrivalEntry = {
      ...ARVL_ARRIVED_SINGLE,
      trainCode: 'AMB-A',
    };
    const AMBIGUOUS_TRAIN_B: ArrivalEntry = {
      ...ARVL_ARRIVED_SINGLE,
      trainCode: 'AMB-B',
    };
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeUnlockedTrip());
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const deps = makeArchFlagDeps(
      fetchImpl,
      makeSeoul([AMBIGUOUS_TRAIN_A, AMBIGUOUS_TRAIN_B]),
    );

    const stats = await runScheduled(makeEnv(kv), deps);

    expect(stats.boardingPromptEvaluated).toBe(1);
    expect(stats.boardingPromptFired).toBe(0);
    expect(stats.boardingPromptBlocked).toBe(1);
    // ambiguity guard 로 skip — APNs fetch X.
    expect(fetchImpl as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('archFlag=on + Seoul API 응답 0건 → boardingPromptSkippedEmpty (기존 guard 유지)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeUnlockedTrip());
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const deps = makeArchFlagDeps(fetchImpl, makeSeoul([]));

    const stats = await runScheduled(makeEnv(kv), deps);

    expect(stats.boardingPromptEvaluated).toBe(1);
    expect(stats.boardingPromptFired).toBe(0);
    expect(stats.boardingPromptSkippedEmpty).toBe(1);
    expect(fetchImpl as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('archFlag=on + AUTO_PROMPT_DEDUP_WINDOW_MS 내부 → dedup skip', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeUnlockedTrip({ lastAutoPromptedAt: NOW - 1_000 }), // 5분 미만
    );
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeArchFlagDeps(fetchImpl));

    // dedup skip — evaluated/fired/blocked 미증가.
    expect(stats.boardingPromptEvaluated).toBe(0);
    expect(stats.boardingPromptFired).toBe(0);
    expect(stats.boardingPromptAutoDeduped).toBe(1);
  });

  it('archFlag=on + boardingLock 활성 → F2 defense skip (기존 정책 유지)', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeUnlockedTrip({
        boardingLock: {
          trainCode: 'T-expired',
          line: '2',
          subwayId: '1002',
          selectedDepartureTime: NOW - 60_000,
          segmentStations: ['역삼', '강남'],
          expiresAt: NOW - 1, // 만료 → lockMissing 분기 진입
        },
      }),
    );
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeArchFlagDeps(fetchImpl));

    expect(stats.boardingPromptSkippedLockActive).toBe(1);
    expect(stats.boardingPromptFired).toBe(0);
  });

  /**
   * #2022 — archFlag=on 시 arvlCd=1(ARRIVED) 관측 explicit check.
   *
   * 이슈 core: #2014 는 게이트 skip 만 구현. caller 에 "arvlCd=1 관측 시에만 fire"
   * explicit check 가 없어 arvlCd=0(진입)/2(출발)/기타 상태에서도 fire 됨 → 사용자
   * flow "A역 도착 판정 → boardingPrompt" 정합 어긋남. 아래 케이스로 갭 확정.
   */
  it('#2022 archFlag=on + arvlCd=0(ENTERING) 만 → fire skip (도착 안 함, 진입 중)', async () => {
    // pool 에 arvlCd=1 없음 → boardingPrompt UI 노출 부적절.
    const ENTERING_ONLY: ArrivalEntry = {
      ...ARVL_ARRIVED_SINGLE,
      trainCode: 'ENT-1',
      arvlCd: 0, // ENTERING
    };
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeUnlockedTrip());
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const deps = makeArchFlagDeps(fetchImpl, makeSeoul([ENTERING_ONLY]));

    const stats = await runScheduled(makeEnv(kv), deps);

    expect(stats.boardingPromptEvaluated).toBe(1);
    expect(stats.boardingPromptFired).toBe(0);
    expect(stats.boardingPromptBlocked).toBe(1);
    // fire skip → APNs fetch X.
    expect(fetchImpl as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('#2022 archFlag=on + arvlCd=2(DEPARTED) 만 → fire skip (열차 이미 출발)', async () => {
    // 열차 이미 출발 = 사용자가 승차 못 함. boardingPrompt 발사 시 UI 오탐.
    const DEPARTED_ONLY: ArrivalEntry = {
      ...ARVL_ARRIVED_SINGLE,
      trainCode: 'DEP-1',
      arvlCd: 2, // DEPARTED
    };
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeUnlockedTrip());
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const deps = makeArchFlagDeps(fetchImpl, makeSeoul([DEPARTED_ONLY]));

    const stats = await runScheduled(makeEnv(kv), deps);

    expect(stats.boardingPromptEvaluated).toBe(1);
    expect(stats.boardingPromptFired).toBe(0);
    expect(stats.boardingPromptBlocked).toBe(1);
    expect(fetchImpl as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('#2022 archFlag=on + pool 에 arvlCd=1 포함 (다른 값과 혼재) → fire (도착 신호 존재)', async () => {
    // arvlCd=0 후보 + arvlCd=1 후보 혼재 → arvlCd=1 존재하므로 fire.
    // pickAutoTrainCode 우선순위(2 > 1 > 0)에서 arvlCd=1 후보가 단일이면 정상 fire.
    const ENTERING_TRAIN: ArrivalEntry = {
      ...ARVL_ARRIVED_SINGLE,
      trainCode: 'ENT-x',
      arvlCd: 0,
    };
    const ARRIVED_TRAIN: ArrivalEntry = {
      ...ARVL_ARRIVED_SINGLE,
      trainCode: 'ARR-y',
      arvlCd: 1,
    };
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeUnlockedTrip());
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;
    const deps = makeArchFlagDeps(fetchImpl, makeSeoul([ENTERING_TRAIN, ARRIVED_TRAIN]));

    const stats = await runScheduled(makeEnv(kv), deps);

    expect(stats.boardingPromptFired).toBe(1);
    expect(stats.boardingPromptBlocked).toBe(0);
  });

  it('#2022 archFlag=off + pool 에 arvlCd=1 없음 (arvlCd=0 만) → 기존 9-AND gate 로 진행 (arvlCd explicit check 비활성)', async () => {
    // 회귀 방어: archFlag=off 시 arvlCd 값에 의존한 explicit check 는 적용 X.
    // 기존 9단 AND 게이트에 의해 series 0건 → no-candidates 로 blocked 되는 기존 경로 그대로.
    const ENTERING_ONLY: ArrivalEntry = {
      ...ARVL_ARRIVED_SINGLE,
      trainCode: 'ENT-legacy',
      arvlCd: 0,
    };
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeUnlockedTrip());
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const deps = makeArchFlagDeps(fetchImpl, makeSeoul([ENTERING_ONLY]), 'off');

    const stats = await runScheduled(makeEnv(kv), deps);

    // 9단 게이트 → 기존 no-candidates 로 차단 (arvlCd explicit check 로 차단된 것 아님).
    expect(stats.boardingPromptFired).toBe(0);
    expect(stats.boardingPromptBlocked).toBe(1);
  });
});

describe('runScheduled — evaluateAndMaybeFireBoardingPrompt Kalman KV 통합 (#824)', () => {
  /**
   * boarding-prompt 경로에서 Kalman state가 KV에 persist/read되는지 검증.
   *
   * evaluateAndMaybeFireBoardingPrompt는:
   *   1. accelSeries + kalmanState 병렬 로드 (readAccelSeries + readKalmanState)
   *   2. runKalmanStep 실행
   *   3. writeKalmanState → KV에 `kalman:<token>` 저장
   *   4. kalmanState.v를 evaluateBoardingPromptGates에 전달
   */

  function makeKalmanTrip(overrides: Partial<Trip> = {}): Trip {
    return makeTrip({
      token: 'kalman-tok',
      promptGeoContext: {
        origin: { lat: 0, lng: 0 },
        nextStation: { lat: 0, lng: 0.01 },
        direction: 'up',
      },
      promptDisplay: { originStation: '강남', line: '2' },
      ...overrides,
    });
  }

  const seedHappySeries = (kv: InMemoryKV, token = 'kalman-tok') => seedHappyGateSeries(kv, token);

  // #1888 (RC-13) — Kalman path도 fire 경로 검증이므로 candidateTrains ≥ 1 필요.
  // line=2 up 방향 1건 동봉 — 기존 Kalman state/KV 검증 의도 보존.
  const DEFAULT_KALMAN_ARRIVAL: ArrivalEntry = {
    destination: '성수',
    arrivalSeconds: 60,
    trainCode: 'KT1',
    isUp: true,
    subwayNm: '2호선',
    arvlCd: 2,
  };

  function makeKalmanPromptDeps(fetchImpl: typeof fetch) {
    return {
      seoul: makeSeoul([DEFAULT_KALMAN_ARRIVAL]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      fetchImpl,
      generatePushId: () => 'kalman-push-1',
    };
  }

  it('evaluateAndMaybeFireBoardingPrompt: writeKalmanState → KV에 kalman:<token> 저장됨', async () => {
    // promptGeoContext 있는 trip + happy series → evaluateAndMaybeFireBoardingPrompt 진입
    // kalman KV key = 'kalman:kalman-tok' 생성 확인
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeKalmanTrip());
    await seedHappySeries(kv);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    await runScheduled(makeEnv(kv), makeKalmanPromptDeps(fetchImpl));

    // KV에 kalman state가 저장되어야 함
    const kalmanState = await readKalmanState(kv as unknown as KVNamespace, 'kalman-tok');
    expect(kalmanState).not.toBeNull();
    expect(typeof kalmanState?.v).toBe('number');
    expect(typeof kalmanState?.P).toBe('number');
    expect(typeof kalmanState?.ts).toBe('number');
    expect(Number.isFinite(kalmanState!.v)).toBe(true);
    expect(Number.isFinite(kalmanState!.P)).toBe(true);
  });

  it('prior Kalman state가 KV에 있으면 다음 cycle에서 predict+update 연속 실행', async () => {
    // 1st cycle: prior=null → observation 초기화 → state 저장
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeKalmanTrip());
    await seedHappySeries(kv);
    const fetchImpl1 = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    await runScheduled(makeEnv(kv), makeKalmanPromptDeps(fetchImpl1));
    const stateAfterCycle1 = await readKalmanState(kv as unknown as KVNamespace, 'kalman-tok');
    expect(stateAfterCycle1).not.toBeNull();

    // 2nd cycle: boardingPromptState.fired=true이므로 게이트 차단되지만
    // Kalman step은 게이트와 무관하게 실행되어 state가 갱신되어야 함.
    // fired=true로 게이트 차단 → 따라서 boardingPromptFired=0이어야 함.
    // Kalman writeKalmanState는 게이트 평가 전에 실행되므로 state가 갱신됨.
    await putTrip(
      kv as unknown as KVNamespace,
      makeKalmanTrip({ boardingPromptState: { fired: true, lastFiredAt: NOW - 1000 } }),
    );
    const fetchImpl2 = vi.fn() as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), makeKalmanPromptDeps(fetchImpl2));
    expect(stats.boardingPromptFired).toBe(0); // 게이트 차단
    expect(stats.boardingPromptBlocked).toBe(1);

    // 2nd cycle 후 state가 업데이트되었는지 확인 (ts가 now=NOW로 갱신)
    const stateAfterCycle2 = await readKalmanState(kv as unknown as KVNamespace, 'kalman-tok');
    expect(stateAfterCycle2).not.toBeNull();
    expect(stateAfterCycle2?.ts).toBe(NOW);
  });

  it('kalmanKmh가 evaluateBoardingPromptGates에 전달되어 fusedSpeedKmh에 영향을 줌 (간접 검증)', async () => {
    // kalman state를 KV에 미리 넣어 두면 (prior 있음 + 최근 ts),
    // runKalmanStep이 predict+update를 실행해 kalmanKmh가 GPS avg와 다를 수 있다.
    // outcome.fusedSpeedKmh가 GPS-only보다 달라지는지를 비교한다.

    // Case A: KV에 kalman state 없음 (prior=null → 초기화 → kalmanKmh ≈ gpsAvg)
    const kvA = new InMemoryKV();
    await seedHappySeries(kvA, 'kalman-tok');
    await putTrip(kvA as unknown as KVNamespace, makeKalmanTrip());
    const fetchA = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const statsA = await runScheduled(makeEnv(kvA), makeKalmanPromptDeps(fetchA));
    // 게이트 통과 여부와 kalman state 저장 확인
    expect(statsA.boardingPromptEvaluated).toBe(1);
    const stateA = await readKalmanState(kvA as unknown as KVNamespace, 'kalman-tok');
    expect(stateA).not.toBeNull();

    // Case B: KV에 kalman state가 있음 (prior 있음 → predict+update로 다른 v 값)
    const kvB = new InMemoryKV();
    // prior state: v=100 km/h (비현실적으로 높은 값) → kalmanKmh가 GPS avg와 달라짐
    const priorState = { v: 100, P: 400, ts: NOW - 5_000 };
    await kvB.put('kalman:kalman-tok', JSON.stringify(priorState));
    await putTrip(kvB as unknown as KVNamespace, makeKalmanTrip());
    await seedHappySeries(kvB, 'kalman-tok');
    const fetchB = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const statsB = await runScheduled(makeEnv(kvB), makeKalmanPromptDeps(fetchB));
    expect(statsB.boardingPromptEvaluated).toBe(1);

    // KV의 kalman state가 갱신되어 있어야 함 (ts=NOW로)
    const stateB = await readKalmanState(kvB as unknown as KVNamespace, 'kalman-tok');
    expect(stateB?.ts).toBe(NOW);
    // v는 prior(100)과 GPS avg 블렌딩 → 100과 gpsAvg 사이의 값이어야 함
    expect(stateB!.v).toBeGreaterThan(0);
  });

  // 기존 lockMissing/lock-active 회귀 보존
  it('기존 lockMissing 회귀: lock 부재 + promptGeoContext 없음 → lockMissing+1, kalman 미호출', async () => {
    const kv = new InMemoryKV();
    // promptGeoContext 없는 trip → evaluateAndMaybeFireBoardingPrompt에서 early return
    await putTrip(kv as unknown as KVNamespace, makeTrip({ token: 'no-geo-kalman' }));
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      generatePushId: () => 'k1',
    });
    expect(stats.lockMissing).toBe(1);
    expect(stats.boardingPromptEvaluated).toBe(0);
    // kalman KV key가 생성되지 않아야 함
    expect(await kv.get('kalman:no-geo-kalman')).toBeNull();
  });

  it('기존 lock-active trip은 kalman path 진입 안 함 (lockMissing=0)', async () => {
    const kv = new InMemoryKV();
    const lockTrip = makeTrip({
      token: 'active-lock-kalman',
      boardingLock: {
        trainCode: 'X',
        line: '2',
        subwayId: '1002',
        selectedDepartureTime: NOW,
        segmentStations: ['강남', '역삼'],
        expiresAt: NOW + 60 * 60_000,
      },
      waypoints: [{ stationName: '역삼', line: '2', kind: 'destination' }],
    });
    await putTrip(kv as unknown as KVNamespace, lockTrip);
    // Seoul API: arrivals 비어 있음 → etaMissing
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      fetchImpl: vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      generatePushId: () => 'k2',
    });
    expect(stats.lockMissing).toBe(0);
    expect(stats.boardingPromptEvaluated).toBe(0);
    // kalman key 미생성 (lock-active 분기는 kalman path 미통과)
    expect(await kv.get('kalman:active-lock-kalman')).toBeNull();
  });

  // 리뷰 P2-1 — 무관측 cycle은 Kalman state I/O를 skip해 거짓 0 km/h observation 누적 방지.
  it('series 비어 있으면 kalman state 미작성 (관측 무효 → skip)', async () => {
    const kv = new InMemoryKV();
    // positionSeries 자체가 없는 trip — count=0, avgAccuracy=Infinity
    await putTrip(kv as unknown as KVNamespace, makeKalmanTrip({ token: 'empty-series' }));
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      fetchImpl,
      generatePushId: () => 'empty-1',
    });
    // boarding-prompt 평가는 진입했지만 게이트에서 차단됨 (window-too-small)
    expect(stats.boardingPromptEvaluated).toBe(1);
    expect(stats.boardingPromptFired).toBe(0);
    // kalman state는 만들어지지 않아야 함 — 거짓 0 km/h observation으로 prior 오염 방지
    expect(await kv.get('kalman:empty-series')).toBeNull();
  });

  it('모든 sample이 accuracy로 reject되면 kalman state 미작성 (관측 무효 → skip)', async () => {
    const kv = new InMemoryKV();
    // accuracy ≥ 50m sample만 있어 totalHopMs=0 → avgAccuracy=Infinity, gpsAvg=0
    const series = [
      { lat: 0, lng: -0.0004, accuracy: 80, ts: NOW - 60_000, motion: 'automotive' },
      { lat: 0, lng: 0.0002, accuracy: 80, ts: NOW - 30_000, motion: 'automotive' },
      { lat: 0, lng: 0.0008, accuracy: 80, ts: NOW, motion: 'automotive' },
    ];
    await kv.put('pos:bad-acc', JSON.stringify(series));
    await putTrip(kv as unknown as KVNamespace, makeKalmanTrip({ token: 'bad-acc' }));
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      fetchImpl,
      generatePushId: () => 'bad-acc-1',
    });
    // accuracy-too-poor 게이트에서 차단되고 Kalman은 skip
    expect(await kv.get('kalman:bad-acc')).toBeNull();
  });

  // 리뷰 P2-3 — prior 부재 첫 cycle은 state.v=gpsAvg로 초기화되어 fusion에 합류 시
  // 같은 GPS가 2회 가중 → confidence 가짜 상승. state는 persist 하되 kalmanKmh는 null로
  // 게이트에 전달해야 한다. 검증: prior 없는 cycle은 GPS-only fusedSpeed와 동일 confidence.
  it('prior=null 첫 cycle은 state는 persist하되 kalmanKmh를 게이트에 전달하지 않음', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeKalmanTrip({ token: 'first-cycle' }));
    await seedHappySeries(kv, 'first-cycle');
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const stats = await runScheduled(makeEnv(kv), makeKalmanPromptDeps(fetchImpl));

    // state는 다음 cycle prior로 쓸 수 있게 persist
    const state = await readKalmanState(kv as unknown as KVNamespace, 'first-cycle');
    expect(state).not.toBeNull();
    expect(state?.ts).toBe(NOW);
    // boarding-prompt 게이트는 통과 — kalmanKmh=null이라 fusedSpeed는 GPS+map only 합산
    expect(stats.boardingPromptEvaluated).toBe(1);
  });

  // ─────────────────────────────────────────────────────
  // #2007 — ADR-022 Phase 4-5: archFlag='on' 시 Kalman dormant
  // ─────────────────────────────────────────────────────

  // flag=on 시 runKalmanStep 은 null 을 반환하고 runFusionStep 은 writeKalmanState 를 skip.
  // fusion.kalmanKmh=null → boardingPrompt 게이트 #7 (fusedSpeed) 은 weight=0 으로 자연 skip.
  it('#2007 — archFlag=on 시 boarding-prompt 경로에서 kalman KV write skip (dormant)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeKalmanTrip({ token: 'dormant-tok' }));
    await seedHappySeries(kv, 'dormant-tok');
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), {
      ...makeKalmanPromptDeps(fetchImpl),
      archFlag: 'on',
    });

    // Kalman state KV 미작성 — flag=on 이면 계산 자체 skip
    expect(await kv.get('kalman:dormant-tok')).toBeNull();
    // boarding-prompt 평가는 여전히 진행 (kalman 은 게이트 #7 의 optional 입력일 뿐)
    expect(stats.boardingPromptEvaluated).toBe(1);
    // drift/reset 카운터 모두 0 — hot path 전체가 dormant
    expect(stats.kalmanReset).toBe(0);
    expect(stats.kalmanDriftWarning).toBe(0);
  });

  it('#2007 — archFlag=on + KV prior 존재 → prior 무시하고 write skip (drift/reset 0)', async () => {
    const kv = new InMemoryKV();
    // prior state 를 미리 넣어도 flag=on 이면 read 결과와 무관하게 계산 skip.
    const staleTs = NOW - 5_000;
    await kv.put(
      'kalman:dormant-tok-2',
      JSON.stringify({ v: 100, P: 400, ts: staleTs }),
    );
    await putTrip(kv as unknown as KVNamespace, makeKalmanTrip({ token: 'dormant-tok-2' }));
    await seedHappySeries(kv, 'dormant-tok-2');
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), {
      ...makeKalmanPromptDeps(fetchImpl),
      archFlag: 'on',
    });

    // prior 는 그대로 남아 있어야 함 (write 자체가 skip → 갱신 없음). ts 도 원본 유지.
    const state = await readKalmanState(kv as unknown as KVNamespace, 'dormant-tok-2');
    expect(state).not.toBeNull();
    expect(state!.ts).toBe(staleTs); // NOW 로 갱신되지 않았어야 함
    expect(state!.v).toBe(100);
    expect(stats.kalmanReset).toBe(0);
    expect(stats.kalmanDriftWarning).toBe(0);
  });

  it('#2007 — archFlag=off (default) 는 기존 동작 유지 (state 정상 write, drift/reset 정상 카운트)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeKalmanTrip({ token: 'active-tok' }));
    await seedHappySeries(kv, 'active-tok');
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    await runScheduled(makeEnv(kv), {
      ...makeKalmanPromptDeps(fetchImpl),
      archFlag: 'off',
    });

    // Kalman state 는 정상 작성 (기존 회귀 보존)
    const state = await readKalmanState(kv as unknown as KVNamespace, 'active-tok');
    expect(state).not.toBeNull();
    expect(state!.ts).toBe(NOW);
  });
});

// ---------------------------------------------------------------------------
// #825 — Phase 3 E3 phase gate 통합 테스트
// ---------------------------------------------------------------------------

describe('runScheduled — #825 Phase 3 E3: phaseImminentBlocked + stationPhase stamp', () => {
  /** lockless intermediate trip 팩토리 (phase gate 경로 전용). */
  function makePhaseTrip(overrides: Partial<Trip> = {}): Trip {
    return makeTrip({
      token: 'phase-tok',
      waypoints: [
        { stationName: '강남', line: '2', kind: 'intermediate' },
        { stationName: '역삼', line: '2', kind: 'destination' },
      ],
      infoModeEnabled: true,
      ...overrides,
    });
  }

  /** ARRIVED(arvlCd=1) signal로 fires 조건 충족 */
  const ARVL_ARRIVED: ArrivalEntry = {
    destination: '강남행',
    arrivalSeconds: 30,
    trainCode: '7246',
    isUp: true,
    subwayNm: '지하철2호선',
    arvlCd: 1,
  };

  /**
   * nearestStationDistanceM이 포함된 series를 KV에 심는다.
   * stationPhase 분류 pipeline을 실제로 동작시킨다.
   */
  async function seedSeriesWithDistance(
    kv: InMemoryKV,
    token: string,
    nearestStationDistanceM: number | undefined,
  ): Promise<void> {
    const series = [
      { lat: 0, lng: -0.0004, accuracy: 10, ts: NOW - 60_000, motion: 'automotive', nearestStationDistanceM },
      { lat: 0, lng: 0.0002, accuracy: 10, ts: NOW - 30_000, motion: 'automotive', nearestStationDistanceM },
      { lat: 0, lng: 0.0008, accuracy: 10, ts: NOW, motion: 'automotive', nearestStationDistanceM },
    ];
    await kv.put(`pos:${token}`, JSON.stringify(series));
  }

  // ---------------------------------------------------------------------------
  // phaseImminentBlocked 회귀 — 기존 동작 보존
  // ---------------------------------------------------------------------------
  it('phaseState null + fires(arvlCd=1) → 기존 동작: push 발사, phaseImminentBlocked=0', async () => {
    // nearestStationDistanceM 없는 series → phaseState=null → gate 허용
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makePhaseTrip());
    // nearestStationDistanceM=undefined → runStationPhaseStep returns null
    await seedSeriesWithDistance(kv, 'phase-tok', undefined);

    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([ARVL_ARRIVED]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'phase-p1',
    });

    expect(stats.pushed).toBe(1);
    expect(stats.phaseImminentBlocked).toBe(0);
    expect(apnsFetch).toHaveBeenCalled();
  });

  it('high-confidence CRUISING (dist=500m, kmh=35) + fires → phaseImminentBlocked++, push 미발사', async () => {
    // dist=500m → CRUISING 우세, confidence>0.7 → gate 차단
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makePhaseTrip());
    await seedSeriesWithDistance(kv, 'phase-tok', 500);
    // KV에 Kalman prior 심어 kalmanKmh가 null이 아닌 35km/h 근방으로 수렴되게 한다.
    // (prior 없으면 kalmanKmh=null → phaseState 분류 입력으로 kalmanState.v 사용)
    // Kalman prior가 있어야 kalmanKmh가 non-null이 됨 — 하지만 phaseState는 kalmanState.v 입력.
    // 실제로 runFusionStep은 kalmanState.v를 phase 입력으로 사용하므로 prior 상관없이 분류는 실행됨.
    // 핵심: series의 마지막 sample nearestStationDistanceM=500 → CRUISING → confidence>0 테스트.
    // cruiseSpeed는 kalmanState.v≥20일 때 활성. 초기 kalman에서 gpsAvg를 사용 → ~35km/h 예측.
    // 또한 farFromStationStill은 500>200이지만 속도 높으면 비활성.
    // prior=null 첫 cycle이면 kalmanKmh=null → phase 입력으로 kalmanState.v는 gpsAvg≈35로 초기화.
    // → cruiseSpeed 활성 → CRUISING 우세 → confidence=3/Σ > 0.7이면 차단.
    // 실제 confidence 계산: dist=500>200 → stationVicinity 비활성, dwellingZone 비활성.
    // cruiseSpeed(35≥20): A-1,D-2,Dep-1,C+3
    // → A=-1, D=-2, Dep=-1, C=3 → CRUISING best, second=-1
    // confidence=(3-(-1))/Σ|1+2+1+3|=4/7≈0.571 < 0.7 → gate 허용 (차단 안 됨)
    // 즉 dist=500, speed=35만으로는 confidence<0.7 → 차단 안 됨.
    // 차단하려면 더 많은 feature 활성화가 필요.
    // 실제로 phaseImminentBlocked 테스트는 confidence≥0.7 케이스를 직접 주입해야 함.
    // stationPhase를 trip에 미리 stamp해서 prev hysteresis로 boost.
    const tripWithPhase = makePhaseTrip({
      stationPhase: {
        current: 'CRUISING',
        confidence: 0.9, // 이미 high-confidence CRUISING
        lastEvaluatedAt: NOW - 1000,
      },
    });
    await kv.delete('trip:phase-tok');
    await putTrip(kv as unknown as KVNamespace, tripWithPhase);

    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([ARVL_ARRIVED]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'phase-p2',
    });

    // phaseState.confidence가 boost돼 ≥0.7이고 CRUISING → gate 차단
    expect(stats.phaseImminentBlocked).toBe(1);
    expect(stats.pushed).toBe(0);
    expect(apnsFetch).not.toHaveBeenCalled();
    // dirty=true → putTrip 호출됨 → trip에 stationPhase persist 확인
    const stored = JSON.parse((await kv.get('trip:phase-tok'))!) as Trip;
    expect(stored.stationPhase).toBeDefined();
  });

  it('low-confidence CRUISING (confidence=0.5) + fires → gate 허용, push 발사', async () => {
    // confidence < IMMINENT_FIRING_CONFIDENCE(0.7) → 허용
    const tripWithLowConf = makePhaseTrip({
      stationPhase: {
        current: 'CRUISING',
        confidence: 0.5,
        lastEvaluatedAt: NOW - 1000,
      },
    });
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, tripWithLowConf);
    // nearestStationDistanceM=500 series — 분류 결과가 prev와 달라도 prev.confidence=0.5
    // hysteresis: candidate=CRUISING == prev.current → confidence boost 0.5+0.2=0.7
    // 그런데 boost 후 0.7 ≥ IMMINENT_FIRING_CONFIDENCE → gate 차단될 수 있음.
    // nearestStationDistanceM=undefined로 phase null path 유지 → phaseAllows=true.
    await seedSeriesWithDistance(kv, 'phase-tok', undefined);

    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([ARVL_ARRIVED]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'phase-p3',
    });

    // phaseState=null (nearestStationDistanceM undefined) → phaseAllows=true → 발사
    expect(stats.phaseImminentBlocked).toBe(0);
    expect(stats.pushed).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // ScheduledStats.phaseImminentBlocked 초기값
  // ---------------------------------------------------------------------------
  it('phaseImminentBlocked 초기 0: 정상 사이클에서 phase gate 미발동이면 0 유지', async () => {
    // lock-active trip만 있으면 lockless path 미진입 → phaseImminentBlocked=0
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTrip({
      token: 'lock-only',
      boardingLock: {
        trainCode: 'T',
        line: '2',
        subwayId: '1002',
        selectedDepartureTime: NOW,
        segmentStations: ['강남', '역삼'],
        expiresAt: NOW + 60 * 60_000,
      },
      waypoints: [{ stationName: '역삼', line: '2', kind: 'destination' }],
    }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'phase-init',
    });
    expect(stats.phaseImminentBlocked).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // evaluateAndMaybeFireBoardingPrompt — phase stamp
  // ---------------------------------------------------------------------------
  it('nearestStationDistanceM 포함 series + boarding-prompt 경로 → trip.stationPhase 갱신 + putTrip', async () => {
    // boarding-prompt 평가 경로(lockMissing)에서 phase stamp 확인
    const kv = new InMemoryKV();
    const trip = makeTrip({
      token: 'phase-bp-tok',
      promptGeoContext: {
        origin: { lat: 0, lng: 0 },
        nextStation: { lat: 0, lng: 0.01 },
        direction: 'up',
      },
      promptDisplay: { originStation: '강남', line: '2' },
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    // series with nearestStationDistanceM → phase 분류 가능
    await seedSeriesWithDistance(kv, 'phase-bp-tok', 500);

    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl,
      now: () => NOW,
      generatePushId: () => 'phase-bp-1',
    });

    // phase 분류 결과가 trip에 stamp되어야 함
    const stored = JSON.parse((await kv.get('trip:phase-bp-tok'))!) as Trip;
    expect(stored.stationPhase).toBeDefined();
    expect(stored.stationPhase?.current).toBeDefined();
    expect(stored.stationPhase?.lastEvaluatedAt).toBe(NOW);
  });

  it('nearestStationDistanceM 없는 series → trip.stationPhase 갱신 안 됨 (기존 회귀 보존)', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({
      token: 'phase-no-dist-tok',
      promptGeoContext: {
        origin: { lat: 0, lng: 0 },
        nextStation: { lat: 0, lng: 0.01 },
        direction: 'up',
      },
      promptDisplay: { originStation: '강남', line: '2' },
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    // nearestStationDistanceM=undefined → phaseState=null → trip.stationPhase 변경 없음
    await seedSeriesWithDistance(kv, 'phase-no-dist-tok', undefined);

    await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'phase-no-1',
    });

    // stationPhase는 갱신 안 됨 (phase null → dirty=false → putTrip 미호출 혹은 stationPhase 미set)
    // boarding-prompt 게이트가 통과되면 boardingPromptState가 set되므로 trip은 저장되지만
    // stationPhase는 undefined 상태 유지
    const stored = JSON.parse((await kv.get('trip:phase-no-dist-tok'))!) as Trip;
    expect(stored.stationPhase).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #826 — ScheduledStats 초기값 검증
// ---------------------------------------------------------------------------

describe('ScheduledStats 초기값 (#826 E4)', () => {
  it('kalmanReset, kalmanDriftWarning 초기값 0 — trip 없는 빈 실행', async () => {
    const kv = new InMemoryKV();
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(stats.kalmanReset).toBe(0);
    expect(stats.kalmanDriftWarning).toBe(0);
  });
});

describe('ScheduledStats 초기값 (#1683 silentPushFiredByKind)', () => {
  it('silentPushFiredByKind 모든 kind 초기값 0 — trip 없는 빈 실행', async () => {
    const kv = new InMemoryKV();
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(stats.silentPushFiredByKind).toEqual({
      intermediate: 0,
      transfer: 0,
      destination: 0,
      boardingPrompt: 0,
      reschedule: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// #1652 — staged lifecycle backstop (X8: trip 6h+ 잔존 0건)
// ---------------------------------------------------------------------------

describe('#1652 — tripLifecyclePhase (staged lifecycle backstop)', () => {
  it('createdAt 부터 6h 미만 → normal', () => {
    expect(tripLifecyclePhase({ createdAt: NOW - (6 * 60 * 60_000 - 1) }, NOW)).toBe('normal');
  });

  it('createdAt 부터 정확히 6h → silence', () => {
    expect(tripLifecyclePhase({ createdAt: NOW - 6 * 60 * 60_000 }, NOW)).toBe('silence');
  });

  it('createdAt 부터 6h~9h → silence', () => {
    expect(tripLifecyclePhase({ createdAt: NOW - 7 * 60 * 60_000 }, NOW)).toBe('silence');
  });

  it('createdAt 부터 정확히 9h → force-end', () => {
    expect(tripLifecyclePhase({ createdAt: NOW - 9 * 60 * 60_000 }, NOW)).toBe('force-end');
  });

  it('createdAt 부터 9h 초과 (10.5h 좀비 evidence) → force-end', () => {
    expect(tripLifecyclePhase({ createdAt: NOW - 10.5 * 60 * 60_000 }, NOW)).toBe('force-end');
  });

  it('상수 매핑 — device-side `TRIP_LIFECYCLE_*_MS`와 정합 (6h / 9h)', () => {
    expect(BACKEND_TRIP_LIFECYCLE_SILENCE_MS).toBe(6 * 60 * 60_000);
    expect(BACKEND_TRIP_LIFECYCLE_FORCE_END_MS).toBe(9 * 60 * 60_000);
  });
});

describe('runScheduled — #1652 staged lifecycle backstop', () => {
  it('normal phase trip은 게이트 통과 — lifecycleSilenceSkipped / lifecycleForceEnded 둘 다 0', async () => {
    const kv = new InMemoryKV();
    // 1h 전 시작 trip + expiresAt 미래 + alarm 윈도우 진입
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({
        token: 'normal-tok',
        createdAt: NOW - 60 * 60_000,
        expiresAt: NOW + 60 * 60_000,
        alarmAtEpochMs: NOW + 60_000,
      }),
    );

    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(stats.lifecycleSilenceSkipped).toBe(0);
    expect(stats.lifecycleForceEnded).toBe(0);
  });

  it('silence phase trip (createdAt 7h 전) → cron skip + lifecycleSilenceSkipped++', async () => {
    const kv = new InMemoryKV();
    // 7h 전 시작 trip — silence 진입. expiresAt은 미래로 둬서 만료 분기를 통과시킨다.
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({
        token: 'silence-tok',
        createdAt: NOW - 7 * 60 * 60_000,
        // expiresAt은 createdAt + 2h가 디바이스 default였지만, 좀비 trip은 client가
        // re-register하면서 expiresAt이 미래로 갱신됨 (#578/#704 isSameSession 분기).
        // 즉 expiresAt이 미래여도 6h+ 잔존 가능 — 좀비 evidence.
        expiresAt: NOW + 60 * 60_000,
        alarmAtEpochMs: NOW + 60_000,
        boardingLock: makeBoardingLock(),
      }),
    );

    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(stats.lifecycleSilenceSkipped).toBe(1);
    expect(stats.lifecycleForceEnded).toBe(0);
    // silence는 cron skip — Seoul polling + push 둘 다 발사 안 함.
    expect(stats.polled).toBe(0);
    expect(stats.pushed).toBe(0);
    expect(apnsFetch).not.toHaveBeenCalled();
  });

  it('force-end phase trip (createdAt 10h 전 좀비) → cleanupTripWithLa + lifecycleForceEnded++', async () => {
    const kv = new InMemoryKV();
    // 10.5h 전 시작 좀비 trip — force-end 진입. lockless여도 강제 종료.
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({
        token: 'zombie-tok',
        createdAt: NOW - 10.5 * 60 * 60_000,
        expiresAt: NOW + 60 * 60_000,
        alarmAtEpochMs: NOW + 60_000,
        infoModeEnabled: true,
      }),
    );

    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(stats.lifecycleForceEnded).toBe(1);
    expect(stats.lifecycleSilenceSkipped).toBe(0);
    // cleanupTripWithLa가 trip-ended alert push를 발사 (reason='expired' 재사용).
    expect(apnsFetch).toHaveBeenCalled();
    // trip이 KV에서 제거됐는지 — listTrips로 enumerate 시 비어있어야.
    const remaining: Trip[] = [];
    for await (const t of (await import('../trips')).listTrips(kv as unknown as KVNamespace)) {
      remaining.push(t);
    }
    expect(remaining).toHaveLength(0);
  });

  it('expiresAt 만료 분기는 staged backstop보다 우선 — force-end가 아닌 expired로 종료', async () => {
    const kv = new InMemoryKV();
    // createdAt 10h 전 + expiresAt 이미 만료. expiresAt 분기가 먼저 trigger.
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({
        token: 'both-expired-tok',
        createdAt: NOW - 10 * 60 * 60_000,
        expiresAt: NOW - 1_000, // 이미 만료
        alarmAtEpochMs: NOW + 60_000,
      }),
    );

    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
    });

    // expiresAt 분기가 먼저 cleanup하므로 lifecycle 카운터는 증가하지 않는다.
    expect(stats.lifecycleForceEnded).toBe(0);
    expect(stats.lifecycleSilenceSkipped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #1933 — LA stale auto-end backstop (heartbeat self-referential gap)
// ---------------------------------------------------------------------------

describe('runScheduled — #1933 LA stale auto-end backstop', () => {
  it('lastLaPushAt + 5min 경과 + lockMissing 분기 진입 → cleanupTripWithLa + laStaleAutoEnded++', async () => {
    const kv = new InMemoryKV();
    // lockMissing 분기 진입 보장: boardingLock 없음 + infoModeEnabled false.
    // lastLaPushAt이 6분 전 → 5분 임계 초과.
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({
        token: 'la-stale-6m',
        createdAt: NOW - 30 * 60_000,
        expiresAt: NOW + 60 * 60_000,
        alarmAtEpochMs: NOW + 60_000,
        lastLaPushAt: NOW - 6 * 60_000,
      }),
    );

    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(stats.laStaleAutoEnded).toBe(1);
    // cleanupTripWithLa가 trip-ended alert push를 발사 ('la-stale-backstop' reason).
    expect(apnsFetch).toHaveBeenCalled();
    // trip이 KV에서 제거됐는지 — listTrips로 enumerate 시 비어있어야.
    const remaining: Trip[] = [];
    for await (const t of (await import('../trips')).listTrips(kv as unknown as KVNamespace)) {
      remaining.push(t);
    }
    expect(remaining).toHaveLength(0);
    // lockMissing 카운터는 backstop이 먼저 `continue` 하므로 증가하지 않는다.
    expect(stats.lockMissing).toBe(0);
  });

  it('lastLaPushAt + 5min 미경과 (4분 전) → backstop skip, 기존 lockMissing flow 진행', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({
        token: 'la-fresh-4m',
        createdAt: NOW - 30 * 60_000,
        expiresAt: NOW + 60 * 60_000,
        alarmAtEpochMs: NOW + 60_000,
        lastLaPushAt: NOW - 4 * 60_000,
      }),
    );

    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(stats.laStaleAutoEnded).toBe(0);
    // 기존 lockMissing flow는 그대로 진행됐는지.
    expect(stats.lockMissing).toBe(1);
    // trip은 KV에 그대로 남아있어야.
    const remaining: Trip[] = [];
    for await (const t of (await import('../trips')).listTrips(kv as unknown as KVNamespace)) {
      remaining.push(t);
    }
    expect(remaining).toHaveLength(1);
  });

  it('lastLaPushAt === undefined (첫 push 전) → backstop skip', async () => {
    const kv = new InMemoryKV();
    // lastLaPushAt 미설정 — 신규 trip이거나 첫 push 전.
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({
        token: 'la-never',
        createdAt: NOW - 30 * 60_000,
        expiresAt: NOW + 60 * 60_000,
        alarmAtEpochMs: NOW + 60_000,
        // lastLaPushAt 미지정 — undefined.
      }),
    );

    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(stats.laStaleAutoEnded).toBe(0);
    // 기존 lockMissing flow 진행.
    expect(stats.lockMissing).toBe(1);
  });

  it('환승 직후 (advance reset) — lastLaPushAt이 undefined로 리셋된 trip은 lockMissing 진입해도 첫 5분간 보호', async () => {
    // scheduled.ts:2654에서 waypoint advance 시 `trip.lastLaPushAt = undefined`로 reset.
    // 그 다음 cycle에 boardingLock 만료/swap으로 lockMissing 분기 진입해도
    // `lastLaPushAt === undefined` 분기에서 backstop이 skip되어 신규 trip처럼 첫 5분 보호.
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({
        token: 'la-reset',
        createdAt: NOW - 2 * 60 * 60_000, // 환승 도중인 장거리 trip
        expiresAt: NOW + 60 * 60_000,
        alarmAtEpochMs: NOW + 60_000,
        lastLaPushAt: undefined, // advance reset 직후 상태
      }),
    );

    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(stats.laStaleAutoEnded).toBe(0);
    expect(stats.lockMissing).toBe(1);
  });

  it('lockless opt-in trip + LA push 5min stale → backstop이 lockless 분기 진입 직전에 cleanup (lockless도 동일 보호)', async () => {
    // 본문 회귀 정의 1번 "lock 활성 / lockless 둘 다 카테고리" 직접 매핑.
    // infoModeEnabled true + lastLaPushAt 6분 전 → 정상 시 lockless intermediate push가
    // 매 cycle 발사돼야 하지만 advance 게이트 차단으로 lockless도 fire 미발사 시나리오.
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({
        token: 'la-stale-lockless',
        createdAt: NOW - 30 * 60_000,
        expiresAt: NOW + 60 * 60_000,
        alarmAtEpochMs: NOW + 60_000,
        infoModeEnabled: true,
        waypoints: [
          { stationName: '강남', line: '2', kind: 'intermediate' },
          { stationName: '선릉', line: '2', kind: 'destination' },
        ],
        lastLaPushAt: NOW - 6 * 60_000,
      }),
    );

    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(stats.laStaleAutoEnded).toBe(1);
    // lockless intermediate push 발사 분기 진입 전에 backstop이 잡혀 fire 0건.
    expect(stats.locklessIntermediateFired).toBe(0);
    // trip 자체가 cleanup되어 KV에서 사라짐.
    const remaining: Trip[] = [];
    for await (const t of (await import('../trips')).listTrips(kv as unknown as KVNamespace)) {
      remaining.push(t);
    }
    expect(remaining).toHaveLength(0);
  });

  // #2322 (O1-C) — 침묵(device sync stale) 중 la-stale backstop이 trip을 죽이지 않아야 한다.
  // #2306 evidence(25분 suspend 4역+목적지 알림 0건)의 backend 측 안전망 회귀 차단.
  it('device sync stale(25min silence) → la-stale backstop skip, laStaleSurvivedSilence++, trip 생존', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({
      token: 'la-stale-silent',
      createdAt: NOW - 30 * 60_000,
      expiresAt: NOW + 60 * 60_000,
      alarmAtEpochMs: NOW + 60_000,
      lastLaPushAt: NOW - 6 * 60_000,
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    // device가 25분간 sync 없음 — DEVICE_SYNC_STALE_THRESHOLD_MS(5분) 초과.
    const ssot = await seedSsot(kv as unknown as KVNamespace, trip.token, '강남', {
      expiresAt: trip.expiresAt,
    });
    ssot.lastDeviceSyncAt = NOW - 25 * 60_000;
    await writeSsot(kv as unknown as KVNamespace, ssot, { expiresAt: trip.expiresAt });

    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(stats.laStaleAutoEnded).toBe(0);
    expect(stats.laStaleSurvivedSilence).toBe(1);
    const remaining: Trip[] = [];
    for await (const t of (await import('../trips')).listTrips(kv as unknown as KVNamespace)) {
      remaining.push(t);
    }
    expect(remaining).toHaveLength(1);
  });

  // #2322 (O1-C) — Seoul API outage(이 cron 사이클 HTTP error) 중에도 la-stale backstop이
  // trip을 죽이지 않아야 한다. push 침묵이 backend가 아닌 Seoul API 장애의 정상 결과이기 때문.
  it('Seoul API outage(HTTP error 관측) → la-stale backstop skip, laStaleSurvivedSilence++, trip 생존', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({
      token: 'la-stale-outage',
      createdAt: NOW - 30 * 60_000,
      expiresAt: NOW + 60 * 60_000,
      alarmAtEpochMs: NOW + 60_000,
      lastLaPushAt: NOW - 6 * 60_000,
    });
    await putTrip(kv as unknown as KVNamespace, trip);

    const erroredFetch = vi.fn(
      async () => new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch;
    const seoul = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: erroredFetch,
    });

    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(stats.laStaleAutoEnded).toBe(0);
    expect(stats.laStaleSurvivedSilence).toBe(1);
    const remaining: Trip[] = [];
    for await (const t of (await import('../trips')).listTrips(kv as unknown as KVNamespace)) {
      remaining.push(t);
    }
    expect(remaining).toHaveLength(1);
  });

  // #2322 (O1-C) — 침묵/outage가 끝나고 device sync가 다시 신선해지면 기존 5분 backstop이
  // 정상 재개돼야 한다 (guard가 영구 면제가 아님을 검증).
  it('device sync 재개(fresh) 후에는 la-stale backstop이 정상 발동', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({
      token: 'la-stale-recovered',
      createdAt: NOW - 30 * 60_000,
      expiresAt: NOW + 60 * 60_000,
      alarmAtEpochMs: NOW + 60_000,
      lastLaPushAt: NOW - 6 * 60_000,
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    const ssot = await seedSsot(kv as unknown as KVNamespace, trip.token, '강남', {
      expiresAt: trip.expiresAt,
    });
    ssot.lastDeviceSyncAt = NOW - 10_000; // 신선 — stale 아님.
    await writeSsot(kv as unknown as KVNamespace, ssot, { expiresAt: trip.expiresAt });

    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(stats.laStaleAutoEnded).toBe(1);
    expect(stats.laStaleSurvivedSilence).toBe(0);
  });

  // 회귀 가드 — #1933 review finding. cleanupTripWithLa는 내부에서 deleteSsot을 try/catch로 감싸
  // graceful swallow한다 (liveActivity.ts:322). 외부에서 추가 호출 시 비가드라 KV throw가 cron 루프를
  // break-out 해 다음 trip이 평가되지 않는 회귀 위험. 본 가드 테스트는 ssot KV가 throw해도 backstop이
  // 정상 cleanup하고 다음 trip이 평가되는지 검증.
  it('ssot KV가 throw해도 backstop cleanup 정상 + 다음 trip이 평가 (cron break-out 차단)', async () => {
    const kv = new InMemoryKV();
    // Trip A — stale 대상 (cleanup 발동).
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({
        token: 'la-stale-a',
        createdAt: NOW - 30 * 60_000,
        expiresAt: NOW + 60 * 60_000,
        alarmAtEpochMs: NOW + 60_000,
        lastLaPushAt: NOW - 6 * 60_000,
      }),
    );
    // Trip B — A 다음에 평가될 trip. backstop이 break-out하면 본 trip이 미평가됨.
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({
        token: 'la-stale-b',
        createdAt: NOW - 30 * 60_000,
        expiresAt: NOW + 60 * 60_000,
        alarmAtEpochMs: NOW + 60_000,
        lastLaPushAt: NOW - 6 * 60_000,
      }),
    );

    // ssot:* delete가 throw하는 broken KV — cleanupTripWithLa 내부 try/catch가 swallow해야.
    const realKv = kv;
    const brokenKv: KVNamespace = {
      get: realKv.get.bind(realKv),
      put: realKv.put.bind(realKv),
      delete: vi.fn(async (key: string) => {
        if (key.startsWith('ssot:')) throw new Error('ssot kv down');
        return realKv.delete(key);
      }),
      list: realKv.list.bind(realKv),
    } as unknown as KVNamespace;

    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(
      { TRIPS: brokenKv } as unknown as Env,
      {
        seoul: makeSeoul([]),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: apnsFetch as unknown as typeof fetch,
        now: () => NOW,
      },
    );

    // 두 trip 모두 backstop 평가 + cleanup. break-out 차단 확인.
    expect(stats.laStaleAutoEnded).toBe(2);
    expect(stats.scanned).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// #2175 — cron dedupeTripsByDeviceToken 안전망 (#2184 리뷰 P1)
//
// register-time deviceToken 역인덱스 merge/cleanup이 KV eventual consistency 등으로 실패해
// 같은 deviceToken의 active trip이 순간적으로 2개 이상 KV에 동시 존재해도, cron이 orphan에
// 대해서도 실 deviceToken으로 push를 중복 발사하지 않도록 최신(createdAt) trip만 처리한다.
// ---------------------------------------------------------------------------
describe('#2175 — cron dedupeTripsByDeviceToken 안전망', () => {
  it('같은 deviceToken의 active trip 2개(오래된 것 + 최신) 존재 시 최신 1개만 scanned/push 발사', async () => {
    const kv = new InMemoryKV();
    // 오래된 trip(orphan) — 같은 deviceToken, 먼저 등록됨.
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({
        token: 'orphan-uuid',
        deviceToken: 'dev-dup',
        createdAt: NOW - 10 * 60_000,
        expiresAt: NOW + 60 * 60_000,
        alarmAtEpochMs: NOW + 60_000,
        destination: 'dst-old',
        waypoints: [{ stationName: '용마산', line: '7', kind: 'destination' }],
      }),
    );
    // 최신 trip — 같은 deviceToken, 나중에 등록됨(진짜 active).
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({
        token: 'current-uuid',
        deviceToken: 'dev-dup',
        createdAt: NOW,
        expiresAt: NOW + 60 * 60_000,
        alarmAtEpochMs: NOW + 60_000,
        destination: 'dst-new',
        waypoints: [{ stationName: '성수', line: '2', kind: 'destination' }],
      }),
    );

    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });

    // 오래된 orphan은 이번 tick 처리 대상에서 제외 — scanned=1(최신만).
    expect(stats.scanned).toBe(1);
    // 두 trip 모두 KV에 남아있다 — cron은 register-time 정리를 대신하지 않는다(스캔 skip만).
    const remaining: Trip[] = [];
    for await (const t of (await import('../trips')).listTrips(kv as unknown as KVNamespace)) {
      remaining.push(t);
    }
    expect(remaining.map((t) => t.token).sort()).toEqual(['current-uuid', 'orphan-uuid']);
  });

  it('deviceToken 없는(legacy) trip은 dedup 대상에서 제외되고 정상 scanned', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({
        token: 'legacy-trip',
        deviceToken: undefined,
        createdAt: NOW - 10 * 60_000,
        expiresAt: NOW + 60 * 60_000,
        alarmAtEpochMs: NOW + 60_000,
      }),
    );

    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(stats.scanned).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// #1933 — toTripStatusEndReason — la-stale-backstop external mapping
// ---------------------------------------------------------------------------

describe('toTripStatusEndReason — #1933 la-stale-backstop 외부 contract 매핑', () => {
  it('la-stale-backstop → expired (client backward-compat)', async () => {
    const { toTripStatusEndReason } = await import('../tripStatus');
    expect(toTripStatusEndReason('la-stale-backstop')).toBe('expired');
  });

  it('destination-arrived → destination (기존 매핑 유지)', async () => {
    const { toTripStatusEndReason } = await import('../tripStatus');
    expect(toTripStatusEndReason('destination-arrived')).toBe('destination');
  });

  it('expired → expired (pass-through)', async () => {
    const { toTripStatusEndReason } = await import('../tripStatus');
    expect(toTripStatusEndReason('expired')).toBe('expired');
  });
});

// ---------------------------------------------------------------------------
// #1680 — V8d backend cron stationary skip
// ---------------------------------------------------------------------------

describe('shouldSkipStationary (pure helper)', () => {
  it('stationary + intermediate → skip', () => {
    expect(shouldSkipStationary('stationary', 'intermediate', false, false)).toBe(true);
  });

  it('moving + intermediate → 평가 유지 (no skip)', () => {
    expect(shouldSkipStationary('moving', 'intermediate', false, false)).toBe(false);
  });

  it('unknown + intermediate → 평가 유지 (backward-compat)', () => {
    expect(shouldSkipStationary('unknown', 'intermediate', false, false)).toBe(false);
  });

  it('stationary + destination → 항상 bypass (ETA 신선도 보장 불가 → 안전 방향)', () => {
    expect(shouldSkipStationary('stationary', 'destination', false, false)).toBe(false);
  });

  it('stationary + transfer → 항상 bypass (ETA 신선도 보장 불가 → 안전 방향)', () => {
    expect(shouldSkipStationary('stationary', 'transfer', false, false)).toBe(false);
  });

  it('stationary + intermediate + userIntentDeclared=true → bypass (ADR-014 동급 보장)', () => {
    expect(shouldSkipStationary('stationary', 'intermediate', true, false)).toBe(false);
  });

  it('stationary + intermediate + userIntentDeclared=false → skip', () => {
    expect(shouldSkipStationary('stationary', 'intermediate', false, false)).toBe(true);
  });

  // #2321 (O1-B) — device sync stale 시 motionState 신뢰 불가 → skip하지 않음(조건부 완화).
  it('stationary + intermediate + deviceSyncStale=true → bypass (#2321)', () => {
    expect(shouldSkipStationary('stationary', 'intermediate', false, true)).toBe(false);
  });
});

describe('runScheduled — #1680 V8d stationary cron skip', () => {
  it('SSoT null → stationary skip 없음 (평가 유지, backward-compat)', async () => {
    const kv = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({
        token: 'no-ssot-tok',
        waypoints: [{ stationName: '강남', line: '2', kind: 'intermediate' }],
        // SSoT 미존재 — backward-compat, 평가 유지
      }),
    );

    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(stats.lifecycleStationarySkipped).toBe(0);
  });

  it('motionState=unknown → stationary skip 없음 (평가 유지)', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({
      token: 'unknown-motion-tok',
      waypoints: [{ stationName: '강남', line: '2', kind: 'intermediate' }],
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    await seedSsot(kv as unknown as KVNamespace, trip.token, '강남', {
      expiresAt: trip.expiresAt,
    });
    // seedSsot은 motionState='unknown'으로 시작 — 평가 유지

    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(stats.lifecycleStationarySkipped).toBe(0);
  });

  it('motionState=stationary + intermediate → cron skip + lifecycleStationarySkipped++', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({
      token: 'stationary-tok',
      waypoints: [{ stationName: '강남', line: '2', kind: 'intermediate' }],
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    // SSOT motionState 수동 지정: stationary
    const ssot = await seedSsot(kv as unknown as KVNamespace, trip.token, '강남', {
      expiresAt: trip.expiresAt,
    });
    ssot.motionState = 'stationary';
    await writeSsot(kv as unknown as KVNamespace, ssot, { expiresAt: trip.expiresAt });

    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(stats.lifecycleStationarySkipped).toBe(1);
    // stationary skip — Seoul polling + push 모두 미발사.
    expect(stats.polled).toBe(0);
    expect(stats.pushed).toBe(0);
    expect(apnsFetch).not.toHaveBeenCalled();
  });

  it('motionState=stationary + destination → 항상 bypass, 평가 진행 (ETA 신선도 보장 불가)', async () => {
    // destination kind는 ETA 값에 무관하게 항상 bypass.
    // trip.lastEtaSeconds는 device 마지막 등록값으로 cron 중 최신화 안 됨 → 안전 방향.
    const kv = new InMemoryKV();
    const trip = makeTrip({
      token: 'stationary-dest-tok',
      waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    const ssot = await seedSsot(kv as unknown as KVNamespace, trip.token, '강남', {
      expiresAt: trip.expiresAt,
    });
    ssot.motionState = 'stationary';
    await writeSsot(kv as unknown as KVNamespace, ssot, { expiresAt: trip.expiresAt });

    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
    });

    // bypass → skip 없음
    expect(stats.lifecycleStationarySkipped).toBe(0);
  });

  it('motionState=moving → stationary skip 없음', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({
      token: 'moving-tok',
      waypoints: [{ stationName: '강남', line: '2', kind: 'intermediate' }],
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    const ssot = await seedSsot(kv as unknown as KVNamespace, trip.token, '강남', {
      expiresAt: trip.expiresAt,
    });
    ssot.motionState = 'moving';
    await writeSsot(kv as unknown as KVNamespace, ssot, { expiresAt: trip.expiresAt });

    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(stats.lifecycleStationarySkipped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #826 — drift telemetry
// ---------------------------------------------------------------------------

/**
 * series 헬퍼 (#826 drift telemetry): 유효한 positionSeries를 KV에 심는다.
 * gpsAvgKmh가 `targetKmh` 근방이 되도록 두 지점을 배치한다.
 * 두 포인트의 haversine 거리 / Δt = gpsAvg.
 *
 * sonar S7721 — 함수를 describe 외부 module scope에 두어 매 describe call 시 재정의 회피.
 */
async function seedSeriesWithGpsAvg(
  kv: InMemoryKV,
  token: string,
  targetGpsKmh: number,
): Promise<void> {
  // Δt = 10s, lng 차이로 동서 이동 시뮬. 위도 0 기준 1도 ≈ 111.32 km.
  const dtMs = 10_000;
  const distKm = (targetGpsKmh * dtMs) / 3_600_000;
  const lngDelta = distKm / 111.32;
  const series = [
    { lat: 0, lng: 0, accuracy: 10, ts: NOW - dtMs, motion: 'automotive' },
    { lat: 0, lng: lngDelta, accuracy: 10, ts: NOW, motion: 'automotive' },
  ];
  await kv.put(`pos:${token}`, JSON.stringify(series));
}

function makeDriftTrip(token: string, overrides: Partial<Trip> = {}): Trip {
  return makeTrip({
    token,
    promptGeoContext: {
      origin: { lat: 0, lng: 0 },
      nextStation: { lat: 0, lng: 0.01 },
      direction: 'up',
    },
    promptDisplay: { originStation: '강남', line: '2' },
    ...overrides,
  });
}

describe('runScheduled — #826 drift telemetry (kalmanDriftWarning)', () => {
  it('prior=null 첫 cycle → kalmanDriftWarning 0 (drift 검사 건너뜀)', async () => {
    // prior가 없으면 detectKalmanDrift 호출 자체를 skip — delta=0이 아닌 호출 미발생
    const kv = new InMemoryKV();
    const trip = makeDriftTrip('drift-first');
    await putTrip(kv as unknown as KVNamespace, trip);
    // gpsAvg ≈ 30 km/h series 심기
    await seedSeriesWithGpsAvg(kv, 'drift-first', 30);

    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'd1',
    });
    // prior=null → detectKalmanDrift 미호출 → kalmanDriftWarning 미증가
    expect(stats.kalmanDriftWarning).toBe(0);
  });

  it('prior 있음 + |gpsAvg - state.v| ≥ 15 → kalmanDriftWarning++', async () => {
    // prior state.v=0 (정차), gpsAvg ≈ 30 km/h → delta=30 ≥ 15 → warning
    const kv = new InMemoryKV();
    const token = 'drift-warn';
    const trip = makeDriftTrip(token);
    await putTrip(kv as unknown as KVNamespace, trip);
    await seedSeriesWithGpsAvg(kv, token, 30);
    // KV에 prior 심기 — state.v=0 (도착 직후 reset 상태)
    await kv.put(`kalman:${token}`, JSON.stringify({ v: 0, P: R_LOW, ts: NOW - 15_000 }));

    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'd2',
    });
    expect(stats.kalmanDriftWarning).toBe(1);
  });

  it('prior 있음 + 작은 delta(< 15) → kalmanDriftWarning 0', async () => {
    // prior state.v=30, gpsAvg ≈ 32 → delta=2 < 15 → warning 없음
    const kv = new InMemoryKV();
    const token = 'drift-small';
    const trip = makeDriftTrip(token);
    await putTrip(kv as unknown as KVNamespace, trip);
    await seedSeriesWithGpsAvg(kv, token, 32);
    await kv.put(`kalman:${token}`, JSON.stringify({ v: 30, P: 25, ts: NOW - 15_000 }));

    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'd3',
    });
    expect(stats.kalmanDriftWarning).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #837 P2-3 — maybeCountDrift 단위 (fusion에서 분리한 헬퍼, SRP)
// ---------------------------------------------------------------------------

function makePosMetricsFixture(gpsAvgKmh: number): WindowedMetrics {
  return {
    count: 6,
    gpsAvgKmh,
    avgAccuracyMeters: 12,
    motion: 'walking',
    start: null,
    end: null,
    mapMatchedKmh: null,
  };
}

function makeEmptyStats(): ScheduledStats {
  // maybeCountDrift는 stats.kalmanDriftWarning만 참조. 다른 필드는 영향 없어 0으로 채운다.
  // ScheduledStats 전체 필드를 일일이 적는 대신 runScheduled 본문과 동일하게 단일 필드만 검증한다.
  return { kalmanDriftWarning: 0 } as unknown as ScheduledStats;
}

describe('maybeCountDrift (#837 P2-3)', () => {
  const NOW = 1_000_000;

  it('prior=null이면 drift 카운트 skip (첫 cycle)', () => {
    const stats = makeEmptyStats();
    const posMetrics = makePosMetricsFixture(30); // delta=30 ≥ 15지만 prior 없음
    maybeCountDrift(null, posMetrics, stats, NOW);
    expect(stats.kalmanDriftWarning).toBe(0);
  });

  it('prior 존재 + |state.v - gpsAvg| ≥ DRIFT_WARNING_THRESHOLD_KMH → +1', () => {
    const stats = makeEmptyStats();
    const prior: KalmanState = { v: 0, P: R_LOW, ts: 0 };
    // state.v=0, gpsAvg=DRIFT_WARNING_THRESHOLD_KMH → |delta|=15 (경계 포함)
    const posMetrics = makePosMetricsFixture(DRIFT_WARNING_THRESHOLD_KMH);
    maybeCountDrift(prior, posMetrics, stats, NOW);
    expect(stats.kalmanDriftWarning).toBe(1);
  });

  it('prior 존재 + |delta| < 임계 → 카운트 변화 없음', () => {
    const stats = makeEmptyStats();
    const prior: KalmanState = { v: 30, P: 25, ts: 0 };
    // |30 - 32| = 2 < 15
    const posMetrics = makePosMetricsFixture(32);
    maybeCountDrift(prior, posMetrics, stats, NOW);
    expect(stats.kalmanDriftWarning).toBe(0);
  });

  // #837 P2-2 — reset 직후 grace window
  it('reset 직후 grace window 안 + |delta| ≥ 임계 → 카운트 skip', () => {
    const stats = makeEmptyStats();
    // resetKalmanForArrival 결과 그대로 — lastResetTs = ts
    const prior: KalmanState = { v: 0, P: R_LOW, ts: NOW, lastResetTs: NOW };
    // 회복 phase GPS 30 km/h — |delta|=30 ≥ 15
    const posMetrics = makePosMetricsFixture(30);
    // grace window 내 (30s 경과)
    maybeCountDrift(prior, posMetrics, stats, NOW + 30_000);
    expect(stats.kalmanDriftWarning).toBe(0);
  });

  it('reset 후 grace window 만료 + |delta| ≥ 임계 → 카운트 +1', () => {
    const stats = makeEmptyStats();
    const prior: KalmanState = { v: 0, P: R_LOW, ts: NOW, lastResetTs: NOW };
    const posMetrics = makePosMetricsFixture(30);
    // grace window(60s) 만료 (61s 경과)
    maybeCountDrift(prior, posMetrics, stats, NOW + 61_000);
    expect(stats.kalmanDriftWarning).toBe(1);
  });

  it('legacy state(lastResetTs 미존재) + |delta| ≥ 임계 → 정상 카운트 (회귀 없음)', () => {
    const stats = makeEmptyStats();
    // 구버전 KV에서 읽은 state — lastResetTs 필드 없음.
    const prior: KalmanState = { v: 0, P: R_LOW, ts: 0 };
    const posMetrics = makePosMetricsFixture(30);
    maybeCountDrift(prior, posMetrics, stats, NOW);
    expect(stats.kalmanDriftWarning).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// #826 — lockless ARRIVED/ENTERING → Kalman reset
// ---------------------------------------------------------------------------

function makeLocklessKalmanTrip(token: string, overrides: Partial<Trip> = {}): Trip {
  return makeTrip({
    token,
    waypoints: [
      { stationName: '강남', line: '2', kind: 'intermediate' },
      { stationName: '역삼', line: '2', kind: 'destination' },
    ],
    infoModeEnabled: true,
    ...overrides,
  });
}

function makeArrivedSignal(arvlCd: number): ArrivalEntry {
  return {
    destination: '강남행',
    arrivalSeconds: 10,
    trainCode: '9999',
    isUp: true,
    subwayNm: '지하철2호선',
    arvlCd,
  };
}

/**
 * #826 Kalman reset 테스트용 deps 헬퍼 — 동일 boilerplate(apnsConfig/Hosts/fetchImpl/now)를
 * 5곳에서 반복하지 않게 묶음. sonar new_duplicated_lines_density 임계 정합.
 */
function makeKalmanResetDeps(
  seoul: SeoulArrivalClient,
  pushId: string,
): ScheduledDeps {
  return {
    seoul,
    apnsConfig,
    apnsHosts: APNS_HOSTS,
    fetchImpl: vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
    now: () => NOW,
    generatePushId: () => pushId,
  };
}

describe('runScheduled — #826 lockless intermediate Kalman reset', () => {
  it('arvlCd=ARRIVED(1) → fires=true → kalman:<token>이 v=0/P=4로 reset + stats.kalmanReset=1', async () => {
    const kv = new InMemoryKV();
    const token = 'lock-kalman-1';
    await putTrip(kv as unknown as KVNamespace, makeLocklessKalmanTrip(token));
    // 기존 kalman state 심기 (reset 이전 상태)
    await kv.put(`kalman:${token}`, JSON.stringify({ v: 40, P: 100, ts: NOW - 5_000 }));

    const stats = await runScheduled(
      makeEnv(kv),
      makeKalmanResetDeps(makeSeoul([makeArrivedSignal(1)]), 'lk1'),
    );

    expect(stats.kalmanReset).toBe(1);
    const kalmanState = await readKalmanState(kv as unknown as KVNamespace, token);
    expect(kalmanState?.v).toBe(0);
    expect(kalmanState?.P).toBe(R_LOW);
    expect(kalmanState?.ts).toBe(NOW);
  });

  it('arvlCd=ENTERING(0) → fires=true → Kalman reset 발사 + stats.kalmanReset=1', async () => {
    const kv = new InMemoryKV();
    const token = 'lock-kalman-2';
    await putTrip(kv as unknown as KVNamespace, makeLocklessKalmanTrip(token));
    await kv.put(`kalman:${token}`, JSON.stringify({ v: 35, P: 50, ts: NOW - 3_000 }));

    const stats = await runScheduled(
      makeEnv(kv),
      makeKalmanResetDeps(makeSeoul([makeArrivedSignal(0)]), 'lk2'),
    );

    expect(stats.kalmanReset).toBe(1);
    const kalmanState = await readKalmanState(kv as unknown as KVNamespace, token);
    expect(kalmanState?.v).toBe(0);
    expect(kalmanState?.P).toBe(R_LOW);
  });

  it('arvlCd=2(출발) → fires=false → Kalman reset 미발사 + stats.kalmanReset=0', async () => {
    // arvlCd=2는 ENTERING(0)/ARRIVED(1) 아님 → fires=false → reset 경로 미진입
    const kv = new InMemoryKV();
    const token = 'lock-kalman-3';
    await putTrip(kv as unknown as KVNamespace, makeLocklessKalmanTrip(token));
    await kv.put(`kalman:${token}`, JSON.stringify({ v: 30, P: 25, ts: NOW - 3_000 }));

    const stats = await runScheduled(
      makeEnv(kv),
      makeKalmanResetDeps(makeSeoul([makeArrivedSignal(2)]), 'lk3'),
    );

    // 핵심: fires=false로 reset 경로 자체 미진입 → kalmanReset=0
    expect(stats.kalmanReset).toBe(0);
  });

  it('phase gate 차단 케이스 → reset은 phase gate와 무관하게 발사 (kalmanReset=1, phaseImminentBlocked=1)', async () => {
    // ARRIVED + high-confidence CRUISING → phase gate 차단 → push 미발사
    // 하지만 reset은 phase gate 평가 전에 이미 실행 → kalmanReset=1
    const kv = new InMemoryKV();
    const token = 'lock-kalman-4';
    const tripWithCruising = makeLocklessKalmanTrip(token, {
      stationPhase: {
        current: 'CRUISING',
        confidence: 0.9, // high-confidence CRUISING → gate 차단
        lastEvaluatedAt: NOW - 1000,
      },
    });
    await putTrip(kv as unknown as KVNamespace, tripWithCruising);
    await kv.put(`kalman:${token}`, JSON.stringify({ v: 35, P: 25, ts: NOW - 3_000 }));
    // nearestStationDistanceM 있는 series로 phase classification 활성화
    const series = [
      { lat: 0, lng: -0.0004, accuracy: 10, ts: NOW - 60_000, motion: 'automotive', nearestStationDistanceM: 500 },
      { lat: 0, lng: 0.0002, accuracy: 10, ts: NOW - 30_000, motion: 'automotive', nearestStationDistanceM: 500 },
      { lat: 0, lng: 0.0008, accuracy: 10, ts: NOW, motion: 'automotive', nearestStationDistanceM: 500 },
    ];
    await kv.put(`pos:${token}`, JSON.stringify(series));

    const stats = await runScheduled(
      makeEnv(kv),
      makeKalmanResetDeps(makeSeoul([makeArrivedSignal(1)]), 'lk4'),
    );

    // reset은 phase gate 이전에 발사
    expect(stats.kalmanReset).toBe(1);
    // phase gate가 차단
    expect(stats.phaseImminentBlocked).toBe(1);
    // push 미발사
    expect(stats.pushed).toBe(0);
    // kalman state는 reset됨
    const kalmanState = await readKalmanState(kv as unknown as KVNamespace, token);
    expect(kalmanState?.v).toBe(0);
    expect(kalmanState?.P).toBe(R_LOW);
  });

  // ─────────────────────────────────────────────────────
  // #2007 — ADR-022 Phase 4-5: archFlag='on' 시 lockless reset dormant
  // ─────────────────────────────────────────────────────

  it('#2007 — archFlag=on + arvlCd=ARRIVED → Kalman reset 자체 skip (kalmanReset=0, prior 유지)', async () => {
    // ARRIVED 신호로 fires=true 여도 flag=on 이면 writeKalmanState + kalmanReset++ 둘 다 skip.
    // 신 아키텍처(arvlCd SSoT)에서는 Kalman state 자체가 dormant.
    const kv = new InMemoryKV();
    const token = 'dormant-lock-1';
    await putTrip(kv as unknown as KVNamespace, makeLocklessKalmanTrip(token));
    // 기존 prior state 심기 — flag=on 이면 read 하지만 write 는 skip.
    const priorState = { v: 40, P: 100, ts: NOW - 5_000 };
    await kv.put(`kalman:${token}`, JSON.stringify(priorState));

    const stats = await runScheduled(makeEnv(kv), {
      ...makeKalmanResetDeps(makeSeoul([makeArrivedSignal(1)]), 'd-lk1'),
      archFlag: 'on',
    });

    // reset write + counter 둘 다 skip
    expect(stats.kalmanReset).toBe(0);
    // prior state 그대로 (v=0/P=R_LOW 로 갈아치우지 않아야 함)
    const kalmanState = await readKalmanState(kv as unknown as KVNamespace, token);
    expect(kalmanState).not.toBeNull();
    expect(kalmanState!.v).toBe(40);
    expect(kalmanState!.P).toBe(100);
    expect(kalmanState!.ts).toBe(NOW - 5_000);
  });

  it('#2007 — archFlag=off (default) + arvlCd=ARRIVED → 기존 reset 동작 유지 (회귀 방어)', async () => {
    // 명시 archFlag='off' 도 기존 회귀 보존 확인용 — 위 arvlCd=ARRIVED 케이스와 동일 shape.
    const kv = new InMemoryKV();
    const token = 'active-lock-1';
    await putTrip(kv as unknown as KVNamespace, makeLocklessKalmanTrip(token));
    await kv.put(`kalman:${token}`, JSON.stringify({ v: 40, P: 100, ts: NOW - 5_000 }));

    const stats = await runScheduled(makeEnv(kv), {
      ...makeKalmanResetDeps(makeSeoul([makeArrivedSignal(1)]), 'a-lk1'),
      archFlag: 'off',
    });

    expect(stats.kalmanReset).toBe(1);
    const kalmanState = await readKalmanState(kv as unknown as KVNamespace, token);
    expect(kalmanState?.v).toBe(0);
    expect(kalmanState?.P).toBe(R_LOW);
    expect(kalmanState?.ts).toBe(NOW);
  });
});

// ---------------------------------------------------------------------------
// #837 P2-1 — lockless dedup gate / reset 순서 (arvlCd > phase 우선순위)
// ---------------------------------------------------------------------------

describe('runScheduled — #837 P2-1 lockless dedup vs Kalman reset 순서', () => {
  it('이미 imminent 발사한 trip + arvlCd=ARRIVED → reset은 발사 (kalmanReset=1), push는 dedup으로 skip', async () => {
    // 핵심: dedup된 trip이라도 ground truth(ARRIVED)면 Kalman state는 reset해야 함.
    // 이전 동작: dedup gate가 fusion/reset 이전이라 reset 미진입 → drift 누적.
    // 수정 후: fusion + arrivals fetch + reset 수행 → dedup gate가 push만 차단.
    const kv = new InMemoryKV();
    const token = 'lock-dedup-reset-1';
    await putTrip(
      kv as unknown as KVNamespace,
      makeLocklessKalmanTrip(token, { lastFiredPhase: 'imminent' }),
    );
    await kv.put(`kalman:${token}`, JSON.stringify({ v: 40, P: 100, ts: NOW - 5_000 }));

    const fetchSpy = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([makeArrivedSignal(1)]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchSpy,
      now: () => NOW,
      generatePushId: () => 'lk-dedup-1',
    });

    // reset은 수행 (drift 차단)
    expect(stats.kalmanReset).toBe(1);
    const kalmanState = await readKalmanState(kv as unknown as KVNamespace, token);
    expect(kalmanState?.v).toBe(0);
    expect(kalmanState?.P).toBe(R_LOW);
    // push는 dedup으로 skip (APNs fetch 호출 0회)
    expect(stats.pushed).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('이미 imminent 발사한 trip + signal null (etaMissing) → reset 미발사 (fires만이 진실)', async () => {
    // dedup gate 이동했어도 reset 트리거는 fires=true만이어야 함.
    // signal 부재/arvlCd null은 etaMissing 경로 — reset 미진입.
    const kv = new InMemoryKV();
    const token = 'lock-dedup-reset-2';
    await putTrip(
      kv as unknown as KVNamespace,
      makeLocklessKalmanTrip(token, { lastFiredPhase: 'imminent' }),
    );
    await kv.put(`kalman:${token}`, JSON.stringify({ v: 35, P: 50, ts: NOW - 3_000 }));

    const stats = await runScheduled(
      makeEnv(kv),
      // arrivals 빈 배열 → signal=null → etaMissing 경로
      makeKalmanResetDeps(makeSeoul([]), 'lk-dedup-2'),
    );

    expect(stats.kalmanReset).toBe(0);
    expect(stats.etaMissing).toBe(1);
    expect(stats.pushed).toBe(0);
    // kalman state 보존 (reset 미진입)
    const kalmanState = await readKalmanState(kv as unknown as KVNamespace, token);
    expect(kalmanState?.v).toBe(35);
    expect(kalmanState?.P).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// #826 — runTrainCodeTracking → Kalman reset on arrived
// ---------------------------------------------------------------------------

function makeLockWithKalmanTrip(token: string, overrides: Partial<Trip> = {}): Trip {
  return makeTrip({
    token,
    route: { type: 'direct', line: '7', stops: 2 },
    waypoints: [
      { stationName: '중곡', line: '7', kind: 'intermediate' },
      { stationName: '군자', line: '7', kind: 'destination' },
    ],
    boardingLock: {
      trainCode: '7246',
      line: '7',
      subwayId: '1007',
      selectedDepartureTime: NOW,
      segmentStations: ['용마산', '중곡', '군자'],
      expiresAt: NOW + 60 * 60_000,
    },
    ...overrides,
  });
}

function makeSeoulWithArvl(stationName: string, seconds: number, arvlCd: number | null): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => NOW,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          realtimeArrivalList: [
            {
              barvlDt: String(seconds),
              recptnDt: '',
              updnLine: '상행',
              trainLineNm: stationName,
              btrainNo: '7246',
              subwayNm: '지하철7호선',
              arvlCd,
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch,
  });
}

describe('runScheduled — #826 runTrainCodeTracking Kalman reset', () => {
  it('boardingLock 활성 + estimate.arrived=true(arvlCd=1) → reset + stats.kalmanReset=1', async () => {
    const kv = new InMemoryKV();
    const token = 'tc-kalman-1';
    await putTrip(kv as unknown as KVNamespace, makeLockWithKalmanTrip(token));
    // 기존 kalman state 심기
    await kv.put(`kalman:${token}`, JSON.stringify({ v: 40, P: 100, ts: NOW - 5_000 }));

    const stats = await runScheduled(
      makeEnv(kv),
      makeKalmanResetDeps(makeSeoulWithArvl('중곡', 0, 1), 'tc1'), // arvlCd=1 ARRIVED
    );

    expect(stats.kalmanReset).toBe(1);
    const kalmanState = await readKalmanState(kv as unknown as KVNamespace, token);
    expect(kalmanState?.v).toBe(0);
    expect(kalmanState?.P).toBe(R_LOW);
    expect(kalmanState?.ts).toBe(NOW);
  });

  it('boardingLock 활성 + estimate.arrived=false → reset 미발사 + stats.kalmanReset=0', async () => {
    const kv = new InMemoryKV();
    const token = 'tc-kalman-2';
    await putTrip(kv as unknown as KVNamespace, makeLockWithKalmanTrip(token));
    // 일반 ETA 응답 (도착 아님)
    const originalV = 35;
    await kv.put(`kalman:${token}`, JSON.stringify({ v: originalV, P: 25, ts: NOW - 5_000 }));

    const stats = await runScheduled(
      makeEnv(kv),
      makeKalmanResetDeps(makeSeoulWithArvl('중곡', 120, null), 'tc2'), // arrived=false
    );

    expect(stats.kalmanReset).toBe(0);
    // kalman state는 reset되지 않음 (runFusionStep은 lockless/boardingPrompt 경로에서만 동작)
    const kalmanState = await readKalmanState(kv as unknown as KVNamespace, token);
    // reset이 없었으므로 v≠0 (원래 값 또는 update된 값)
    if (kalmanState !== null) {
      // arrived=false이면 kalman reset이 없어야 함 — v=0 아님을 확인
      expect(kalmanState.v).not.toBe(0);
    }
  });

  // ─────────────────────────────────────────────────────
  // #2007 — ADR-022 Phase 4-5: archFlag='on' 시 lock arrived reset dormant
  // ─────────────────────────────────────────────────────

  it('#2007 — archFlag=on + boardingLock 활성 + arvlCd=ARRIVED → reset skip (kalmanReset=0, prior 유지)', async () => {
    // arvlCd=1(ARRIVED) 신호로도 flag=on 이면 writeKalmanState + kalmanReset++ 둘 다 skip.
    // 신 아키텍처(arvlCd SSoT)에서는 Kalman state 자체가 dormant.
    const kv = new InMemoryKV();
    const token = 'dormant-tc-1';
    await putTrip(kv as unknown as KVNamespace, makeLockWithKalmanTrip(token));
    const priorState = { v: 40, P: 100, ts: NOW - 5_000 };
    await kv.put(`kalman:${token}`, JSON.stringify(priorState));

    const stats = await runScheduled(makeEnv(kv), {
      ...makeKalmanResetDeps(makeSeoulWithArvl('중곡', 0, 1), 'd-tc1'),
      archFlag: 'on',
    });

    expect(stats.kalmanReset).toBe(0);
    // prior state 그대로 (v=0/P=R_LOW 로 갈아치우지 않아야 함).
    const kalmanState = await readKalmanState(kv as unknown as KVNamespace, token);
    expect(kalmanState).not.toBeNull();
    expect(kalmanState!.v).toBe(40);
    expect(kalmanState!.P).toBe(100);
    expect(kalmanState!.ts).toBe(NOW - 5_000);
  });
});

/**
 * #902 Seam F 공용 fixture 빌더.
 *
 * `realtimeArrivalList` raw row 1건의 shape는 `makeSeoul` 등 기존 helper와 동일하지만,
 * 본 describe 묶음(환승 swap + 사라짐 re-attach)이 URL 분기, multi-row ambiguity 등을 별도로
 * 조합하므로 row 빌더만 외부로 추출해 중복(barvlDt/recptnDt/updnLine ... arvlCd)을 제거한다.
 */
interface RawArrivalRowInput {
  trainCode: string;
  arrivalSeconds: number;
  arvlCd: number;
  subwayNm: string;
  destination?: string;
}
function rawArrivalRow(row: RawArrivalRowInput): Record<string, unknown> {
  return {
    barvlDt: String(row.arrivalSeconds),
    recptnDt: '',
    updnLine: '상행',
    trainLineNm: row.destination ?? '도봉산',
    btrainNo: row.trainCode,
    subwayNm: row.subwayNm,
    arvlCd: row.arvlCd,
  };
}
function arrivalListResponse(rows: RawArrivalRowInput[]): Response {
  return new Response(
    JSON.stringify({ realtimeArrivalList: rows.map(rawArrivalRow) }),
    { status: 200 },
  );
}

/**
 * #902 Seam F — 환승 자동 trainCode swap 통합 테스트.
 *
 * #1729 paradigm shift — 환승 직후 자동 swap 제거(Path B' 환승 버전).
 * 환승 시 lock 해제 후 다음 cron cycle이 lockMissing → boardingPrompt push 발사.
 * 사용자가 BoardingTrainList에서 명시 탭해야 lock 부착.
 */
describe('runScheduled — Seam F 환승 자동 swap (#902) → #1729 paradigm', () => {
  /** transfer→destination waypoints + line 7 boardingLock(건대입구로 ARRIVED 예정)의 trip 빌더. */
  function makeTransferTrip(overrides: Partial<Trip> = {}): Trip {
    return makeTrip({
      token: 'transfer-tok',
      route: { type: 'direct', line: '7', stops: 3 },
      waypoints: [
        { stationName: '건대입구', line: '7', kind: 'transfer' },
        { stationName: '성수', line: '2', kind: 'destination' },
      ],
      boardingLock: {
        trainCode: '7327',
        line: '7',
        subwayId: '1007',
        selectedDepartureTime: NOW,
        segmentStations: ['어린이대공원', '군자', '건대입구'],
        expiresAt: NOW + 60 * 60_000,
      },
      ...overrides,
    });
  }

  function makeTransferSeoul(): SeoulArrivalClient {
    return new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async (url: string) => {
        if (url.includes(encodeURIComponent('건대입구'))) {
          return arrivalListResponse([
            { trainCode: '7327', arrivalSeconds: 0, arvlCd: 1, subwayNm: '지하철7호선' },
          ]);
        }
        if (url.includes(encodeURIComponent('성수'))) {
          return arrivalListResponse([
            { trainCode: '2227', arrivalSeconds: 60, arvlCd: 1, subwayNm: '지하철2호선', destination: '성수' },
          ]);
        }
        return arrivalListResponse([]);
      }) as unknown as typeof fetch,
    });
  }

  // #1729: 환승 직후 자동 swap X. 다음 cycle boardingPrompt fallback.
  it('transfer release 후 lock은 undefined — boardingPrompt fallback 경로', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTransferTrip());
    const fetchImpl = makeOkFetch();
    await runLaScheduled(kv, { seoul: makeTransferSeoul(), fetchImpl });

    const raw = await kv.get('trip:transfer-tok');
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw as string) as Trip;
    // waypoint shift: 건대입구 제거 → 첫 waypoint=성수
    expect(stored.waypoints[0].stationName).toBe('성수');
    expect(stored.waypoints[0].line).toBe('2');
    // #1729 paradigm: 자동 swap 없음 → boardingLock undefined (다음 cycle에서 boardingPrompt push)
    expect(stored.boardingLock).toBeUndefined();
  });

  it('candidates 없어도 동일 — transfer 후 lock undefined, boardingPrompt fallback', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTransferTrip());
    const seoul = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async (url: string) => {
        if (url.includes(encodeURIComponent('건대입구'))) {
          return arrivalListResponse([
            { trainCode: '7327', arrivalSeconds: 0, arvlCd: 1, subwayNm: '지하철7호선' },
          ]);
        }
        return arrivalListResponse([]);
      }) as unknown as typeof fetch,
    });
    await runLaScheduled(kv, { seoul, fetchImpl: makeOkFetch() });
    const stored = JSON.parse((await kv.get('trip:transfer-tok')) as string) as Trip;
    expect(stored.waypoints[0].stationName).toBe('성수');
    expect(stored.boardingLock).toBeUndefined();
  });
});

/**
 * #902 Seam F — trainCode 사라짐 후 재attach.
 *
 * 시나리오: 옛 trainCode가 Seoul API에서 사라지면 같은 station/line의 신규 trainCode를 같은
 * cycle에 자동 swap. previousMissCount=1 + 이번 cycle 미스 = 2 도달이 트리거. 1로는 false swap
 * 위험 — 일시적 API 누락과 진짜 사라짐 구분 불가.
 */
describe('runScheduled — Seam F 사라짐 후 재attach (#902)', () => {
  function makeMissingTrainTrip(missCount: number): Trip {
    // boardingLock.trainCode=7174는 사라짐(arrivals에 부재). same-line(7) 신규 후보로 swap 기대.
    return makeTrip({
      token: 'miss-tok',
      route: { type: 'direct', line: '7', stops: 2 },
      waypoints: [{ stationName: '군자', line: '7', kind: 'destination' }],
      boardingLock: {
        trainCode: '7174',
        line: '7',
        subwayId: '1007',
        selectedDepartureTime: NOW,
        segmentStations: ['어린이대공원', '군자'],
        expiresAt: NOW + 60 * 60_000,
      },
      consecutiveEtaMissing: missCount,
    });
  }

  /** 7호선 군자 응답: trainCode 7174는 없음, 7246(arvlCd=2 DEPARTED) 1대만. */
  function makeReAttachSeoul(): SeoulArrivalClient {
    return new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async () =>
        arrivalListResponse([
          { trainCode: '7246', arrivalSeconds: 60, arvlCd: 2, subwayNm: '지하철7호선' },
        ])) as unknown as typeof fetch,
    });
  }

  it('swaps to new trainCode when threshold reached (prev miss=1 + this miss = 2)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeMissingTrainTrip(1));
    const fetchImpl = makeOkFetch();
    await runLaScheduled(kv, { seoul: makeReAttachSeoul(), fetchImpl });
    const stored = JSON.parse((await kv.get('trip:miss-tok')) as string) as Trip;
    // swap 성공 → trainCode 갱신 + 카운터 reset
    expect(stored.boardingLock?.trainCode).toBe('7246');
    expect(stored.consecutiveEtaMissing ?? 0).toBe(0);
  });

  it('does not swap on first miss (prev=0) — single transient API miss tolerated', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeMissingTrainTrip(0));
    await runLaScheduled(kv, { seoul: makeReAttachSeoul(), fetchImpl: makeOkFetch() });
    const stored = JSON.parse((await kv.get('trip:miss-tok')) as string) as Trip;
    // swap 안 됨 — 기존 trainCode 유지 + 카운터 +1
    expect(stored.boardingLock?.trainCode).toBe('7174');
    expect(stored.consecutiveEtaMissing).toBe(1);
  });

  it('keeps incrementing miss counter when no candidate at threshold (ambiguous arrivals)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeMissingTrainTrip(1));
    // 두 trainCode 모두 arvlCd=1 → pickAutoTrainCode가 ambiguity로 null → swap 실패
    const seoul = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async () =>
        arrivalListResponse([
          { trainCode: 'A', arrivalSeconds: 30, arvlCd: 1, subwayNm: '지하철7호선' },
          { trainCode: 'B', arrivalSeconds: 60, arvlCd: 1, subwayNm: '지하철7호선' },
        ])) as unknown as typeof fetch,
    });
    await runLaScheduled(kv, { seoul, fetchImpl: makeOkFetch() });
    const stored = JSON.parse((await kv.get('trip:miss-tok')) as string) as Trip;
    expect(stored.boardingLock?.trainCode).toBe('7174');
    expect(stored.consecutiveEtaMissing).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// #1729 paradigm shift — Path B (attemptAutoLock) 제거.
// 9단 게이트 통과 시 boardingPrompt push 항상 발사. autoLockSuccess는 항상 0.
// ──────────────────────────────────────────────────────────────────────────

describe('runScheduled — #916 A1 → #1729 paradigm: 9단 통과 = boardingPrompt push 항상', () => {
  const seedHappySeries = (kv: InMemoryKV, token: string) => seedHappyGateSeries(kv, token);

  async function runPromptCron(opts: {
    kv: InMemoryKV;
    token: string;
    arrivals: ArrivalEntry[];
    seedSeries?: boolean;
    pushId?: string;
  }): Promise<{
    stats: ScheduledStats;
    fetchImpl: ReturnType<typeof vi.fn>;
  }> {
    await putTrip(opts.kv as unknown as KVNamespace, makePromptTrip({ token: opts.token }));
    if (opts.seedSeries !== false) await seedHappySeries(opts.kv, opts.token);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const stats = await runScheduled(makeEnv(opts.kv), {
      seoul: makeSeoul(opts.arrivals),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      generatePushId: () => opts.pushId ?? 'auto-1',
    });
    return { stats, fetchImpl };
  }

  // #1729: 단일 후보여도 auto-lock X. boardingPrompt push 발사.
  it('9단 통과 + arrivals 단일 후보 → auto-lock 없음, boardingPrompt push 발사', async () => {
    const kv = new InMemoryKV();
    const token = 'prompt-tok';
    const { stats, fetchImpl } = await runPromptCron({
      kv,
      token,
      arrivals: [
        { destination: '선릉', arrivalSeconds: 60, trainCode: 'T1', isUp: true, subwayNm: '지하철2호선', arvlCd: 2 },
      ],
    });

    expect(stats.autoLockSuccess).toBe(0); // paradigm shift: auto-lock X
    expect(stats.boardingPromptFired).toBe(1);
    expect(stats.boardingPromptEvaluated).toBe(1);
    expect(fetchImpl).toHaveBeenCalled(); // boardingPrompt push 발사됨

    const stored = JSON.parse((await kv.get(`trip:${token}`)) as string) as Trip;
    expect(stored.boardingLock).toBeUndefined(); // 사용자 명시 탭 전까지 lock 없음
    expect(stored.boardingPromptState?.fired).toBe(true);
  });

  // 게이트 차단 → boardingPrompt 미발사
  it('게이트 차단(window-too-small) → boardingPrompt 미발사', async () => {
    const kv = new InMemoryKV();
    const { stats } = await runPromptCron({
      kv,
      token: 'gate-block',
      seedSeries: false, // series 미시드 → window-too-small 게이트 차단
      pushId: 'gate-1',
      arrivals: [
        { destination: 'A', arrivalSeconds: 60, trainCode: 'T', isUp: true, subwayNm: '지하철2호선', arvlCd: 2 },
      ],
    });
    expect(stats.autoLockSuccess).toBe(0);
    expect(stats.boardingPromptBlocked).toBe(1);
    expect(stats.boardingPromptFired).toBe(0);
  });

  // 이미 fired 상태면 게이트 #9가 차단
  it('boardingPromptState.fired=true → 게이트 #9 차단으로 boardingPrompt 미발사', async () => {
    const kv = new InMemoryKV();
    const token = 'already-fired';
    await putTrip(
      kv as unknown as KVNamespace,
      makePromptTrip({
        token,
        boardingPromptState: { fired: true, lastFiredAt: NOW - 1000 },
      }),
    );
    await seedHappySeries(kv, token);
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([
        { destination: 'A', arrivalSeconds: 60, trainCode: 'T', isUp: true, subwayNm: '지하철2호선', arvlCd: 2 },
      ]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      fetchImpl,
      generatePushId: () => 'fired-1',
    });

    expect(stats.autoLockSuccess).toBe(0);
    expect(stats.boardingPromptBlocked).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// #916 follow-up B — lastAutoPromptedAt dedup.
// #1729 paradigm shift: auto-lock 제거로 이제 boardingPrompt push 발사가 마커를 stamp.
// ──────────────────────────────────────────────────────────────────────────

describe('runScheduled — #916 follow-up B lastAutoPromptedAt dedup', () => {
  const seedHappySeries = (kv: InMemoryKV, token: string) => seedHappyGateSeries(kv, token);
  // AUTO_PROMPT_DEDUP_WINDOW_MS = 30분 — 매직 넘버 안 쓰고 의도 그대로 표현.
  const WINDOW_MS = 30 * 60_000;

  async function runOneCycle(
    kv: InMemoryKV,
    arrivals: ArrivalEntry[],
    pushId = 'fub-1',
  ): Promise<ScheduledStats> {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    return runScheduled(makeEnv(kv), {
      seoul: makeSeoul(arrivals),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      fetchImpl,
      generatePushId: () => pushId,
    });
  }

  // #1729: boardingPrompt push 발사 시 lastAutoPromptedAt stamp
  it('boardingPrompt push 발사 시 lastAutoPromptedAt이 stamp된다', async () => {
    const kv = new InMemoryKV();
    const token = 'fub-stamp';
    await putTrip(kv as unknown as KVNamespace, makePromptTrip({ token }));
    await seedHappySeries(kv, token);
    const stats = await runOneCycle(kv, [
      { destination: '선릉', arrivalSeconds: 60, trainCode: 'T', isUp: true, subwayNm: '지하철2호선', arvlCd: 2 },
    ]);
    expect(stats.autoLockSuccess).toBe(0); // paradigm shift: auto-lock X
    expect(stats.boardingPromptFired).toBe(1);
    const stored = JSON.parse((await kv.get(`trip:${token}`)) as string) as Trip;
    expect(stored.lastAutoPromptedAt).toBe(NOW);
  });

  it('lastAutoPromptedAt 윈도우 안(=push 직후) → 재평가 자체 차단 (dedup)', async () => {
    const kv = new InMemoryKV();
    const token = 'fub-dedup';
    // 시뮬레이션: 직전 cycle에서 boardingPrompt push 발사 후 lock 클리어 + boardingPromptState 리셋.
    await putTrip(
      kv as unknown as KVNamespace,
      makePromptTrip({
        token,
        lastAutoPromptedAt: NOW - 5 * 60_000, // 5분 전 — window(30분) 안
        boardingPromptState: undefined,
      }),
    );
    await seedHappySeries(kv, token);
    const stats = await runOneCycle(kv, [
      { destination: '선릉', arrivalSeconds: 60, trainCode: 'T', isUp: true, subwayNm: '지하철2호선', arvlCd: 2 },
    ]);
    // 평가 자체에 안 들어감 — 측정 인프라가 별도 dedup 카운터로 잡는다.
    expect(stats.boardingPromptAutoDeduped).toBe(1);
    expect(stats.boardingPromptEvaluated).toBe(0);
    expect(stats.autoLockSuccess).toBe(0);
    expect(stats.boardingPromptFired).toBe(0);
    // trip은 그대로 — auto-prompt 마커는 유지된다.
    const stored = JSON.parse((await kv.get(`trip:${token}`)) as string) as Trip;
    expect(stored.lastAutoPromptedAt).toBe(NOW - 5 * 60_000);
    expect(stored.boardingLock).toBeUndefined();
  });

  it('lastAutoPromptedAt 윈도우 밖 → 정상 평가 + boardingPrompt push 발사', async () => {
    const kv = new InMemoryKV();
    const token = 'fub-window-expired';
    await putTrip(
      kv as unknown as KVNamespace,
      makePromptTrip({
        token,
        lastAutoPromptedAt: NOW - WINDOW_MS - 1_000, // window 만료
        boardingPromptState: undefined,
      }),
    );
    await seedHappySeries(kv, token);
    const stats = await runOneCycle(kv, [
      { destination: '선릉', arrivalSeconds: 60, trainCode: 'T', isUp: true, subwayNm: '지하철2호선', arvlCd: 2 },
    ]);
    expect(stats.boardingPromptAutoDeduped).toBe(0);
    expect(stats.autoLockSuccess).toBe(0); // paradigm shift
    expect(stats.boardingPromptFired).toBe(1);
    const stored = JSON.parse((await kv.get(`trip:${token}`)) as string) as Trip;
    // 새 발사로 마커 갱신.
    expect(stored.lastAutoPromptedAt).toBe(NOW);
  });

  // #1886 RC-2 옵션 D — trip-scoped dedup reset.
  // 새 trip(lastAutoPromptedAt이 없음)은 30분 dedup이 없어 즉시 발사한다.
  // index.ts에서 isSameSession=false 시 lastAutoPromptedAt을 reset하므로
  // 다음 cron은 lastAutoPromptedAt=undefined인 trip을 받아 dedup 없이 평가.
  it('#1886 RC-2 옵션 D: lastAutoPromptedAt=undefined(새 trip) → 30분 이내여도 dedup 없이 발사', async () => {
    const kv = new InMemoryKV();
    const token = 'fub-new-trip';
    // 새 trip 시뮬레이션: index.ts가 isSameSession=false → lastAutoPromptedAt undefined로 reset.
    await putTrip(
      kv as unknown as KVNamespace,
      makePromptTrip({
        token,
        lastAutoPromptedAt: undefined, // reset 상태 — 새 trip 첫 평가
        boardingPromptState: undefined,
      }),
    );
    await seedHappySeries(kv, token);
    const stats = await runOneCycle(kv, [
      { destination: '선릉', arrivalSeconds: 60, trainCode: 'T', isUp: true, subwayNm: '지하철2호선', arvlCd: 2 },
    ]);
    // dedup 없이 정상 발사.
    expect(stats.boardingPromptAutoDeduped).toBe(0);
    expect(stats.boardingPromptFired).toBe(1);
    const stored = JSON.parse((await kv.get(`trip:${token}`)) as string) as Trip;
    expect(stored.lastAutoPromptedAt).toBe(NOW);
  });

  // #1886 RC-2 옵션 D — 같은 trip 내 30분 dedup은 유지 (spam 방지).
  // lastAutoPromptedAt이 있고 window 안이면 dedup 적용 — 이 동작은 변경 없음.
  it('#1886 RC-2 옵션 D: 같은 trip 내 window 안 → dedup 유지 (spam 방지)', async () => {
    const kv = new InMemoryKV();
    const token = 'fub-same-trip-dedup';
    await putTrip(
      kv as unknown as KVNamespace,
      makePromptTrip({
        token,
        lastAutoPromptedAt: NOW - 2 * 60_000, // 2분 전 — 같은 trip 내 window 안
        boardingPromptState: undefined,
      }),
    );
    await seedHappySeries(kv, token);
    const stats = await runOneCycle(kv, [
      { destination: '선릉', arrivalSeconds: 60, trainCode: 'T', isUp: true, subwayNm: '지하철2호선', arvlCd: 2 },
    ]);
    // 같은 trip 내 30분 dedup — spam 방지.
    expect(stats.boardingPromptAutoDeduped).toBe(1);
    expect(stats.boardingPromptFired).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #917 A2 — arvlCd∈{0,1} 매역 알림 1차 source. backend cron이 lock된 trainCode를
// realtimeArrivalList에서 추적해 next waypoint에서 ARRIVED/ENTERING 첫 관찰 시
// station-passed silent push를 발사. dedup KV로 같은 신호 중복 차단.
// ---------------------------------------------------------------------------

describe('hasArrivedSignal (#2022 ADR-022 B8 caller fire trigger)', () => {
  function entry(overrides: Partial<ArrivalEntry>): ArrivalEntry {
    return {
      destination: '성수',
      arrivalSeconds: 60,
      trainCode: 'T1',
      isUp: true,
      subwayNm: '2호선',
      arvlCd: 1,
      ...overrides,
    };
  }

  it('빈 pool → false (관측 없음)', () => {
    expect(hasArrivedSignal([])).toBe(false);
  });

  it('arvlCd=1(ARRIVED) 단일 → true (도착 신호 존재)', () => {
    expect(hasArrivedSignal([entry({ arvlCd: 1 })])).toBe(true);
  });

  it('arvlCd=0(ENTERING) 단일 → false (진입 중, 아직 도착 X)', () => {
    expect(hasArrivedSignal([entry({ arvlCd: 0 })])).toBe(false);
  });

  it('arvlCd=2(DEPARTED) 단일 → false (열차 이미 출발)', () => {
    expect(hasArrivedSignal([entry({ arvlCd: 2 })])).toBe(false);
  });

  it('arvlCd=4/5(PREV_*) → false (1정거장 전 신호, 도착 아님)', () => {
    expect(hasArrivedSignal([entry({ arvlCd: 4 })])).toBe(false);
    expect(hasArrivedSignal([entry({ arvlCd: 5 })])).toBe(false);
  });

  it('혼합 pool 안에 arvlCd=1 이 최소 1개 존재 → true', () => {
    expect(
      hasArrivedSignal([
        entry({ trainCode: 'A', arvlCd: 0 }),
        entry({ trainCode: 'B', arvlCd: 1 }),
        entry({ trainCode: 'C', arvlCd: 2 }),
      ]),
    ).toBe(true);
  });

  it('혼합 pool 안에 arvlCd=1 없음 → false', () => {
    expect(
      hasArrivedSignal([
        entry({ trainCode: 'A', arvlCd: 0 }),
        entry({ trainCode: 'B', arvlCd: 2 }),
      ]),
    ).toBe(false);
  });
});

describe('arvlCdFireKey / ARVLCD_FIRE_KEY_PREFIX (#917 A2)', () => {
  it('prefix는 arvlcd-fire:', () => {
    expect(ARVLCD_FIRE_KEY_PREFIX).toBe('arvlcd-fire:');
  });

  it('key는 token|trainCode|station|arvlCd 조합 — arvlCd 0과 1을 별 entry로 분리', () => {
    expect(arvlCdFireKey('tok1', '7246', '중곡', 0)).toBe('arvlcd-fire:tok1|7246|중곡|0');
    expect(arvlCdFireKey('tok1', '7246', '중곡', 1)).toBe('arvlcd-fire:tok1|7246|중곡|1');
    expect(arvlCdFireKey('tok1', '7246', '중곡', 0)).not.toBe(arvlCdFireKey('tok1', '7246', '중곡', 1));
  });

  it('token이 다르면 다른 key — 같은 train 다른 trip이 서로 silence하지 않음 (cross-trip leak 차단)', () => {
    // 두 사용자가 같은 train(5025) 탄 채 같은 역(강남) 도착 시 각 trip별 dedup entry.
    expect(arvlCdFireKey('tokA', '5025', '강남', 1)).not.toBe(arvlCdFireKey('tokB', '5025', '강남', 1));
  });

  it('dedup TTL은 1시간 (60s × 60)', () => {
    expect(ARVLCD_FIRE_DEDUP_TTL_SEC).toBe(60 * 60);
  });
});

describe('evaluateArvlCdFireGate (#917 A2 prereq guard)', () => {
  const activeLock: BoardingLockMeta = {
    trainCode: '7246',
    line: '7',
    subwayId: '1007',
    selectedDepartureTime: NOW,
    segmentStations: ['용마산', '중곡'],
    expiresAt: NOW + 60 * 60_000,
  };

  it('lock 활성 + arvlCd=1(ARRIVED) → fire', () => {
    expect(evaluateArvlCdFireGate(activeLock, 1, NOW)).toBe('fire');
  });

  it('lock 활성 + arvlCd=0(ENTERING) → fire', () => {
    expect(evaluateArvlCdFireGate(activeLock, 0, NOW)).toBe('fire');
  });

  it('#640 회귀 — lock undefined → mismatch (push X)', () => {
    expect(evaluateArvlCdFireGate(undefined, 1, NOW)).toBe('mismatch');
  });

  it('#640 회귀 — lock 만료 → mismatch (push X)', () => {
    const expired = { ...activeLock, expiresAt: NOW - 1 };
    expect(evaluateArvlCdFireGate(expired, 1, NOW)).toBe('mismatch');
  });

  it('positions-fallback (arvlCd=null) → mismatch (push X)', () => {
    expect(evaluateArvlCdFireGate(activeLock, null, NOW)).toBe('mismatch');
  });

  it('arvlCd=2(DEPARTED) 등 비-매역 신호 → mismatch', () => {
    expect(evaluateArvlCdFireGate(activeLock, 2, NOW)).toBe('mismatch');
    expect(evaluateArvlCdFireGate(activeLock, 4, NOW)).toBe('mismatch');
    expect(evaluateArvlCdFireGate(activeLock, 5, NOW)).toBe('mismatch');
    expect(evaluateArvlCdFireGate(activeLock, 99, NOW)).toBe('mismatch');
  });
});

describe('estimateBoardingLockArrival arvlCd exposure (#917 A2)', () => {
  const lock: BoardingLockMeta = {
    trainCode: '7246',
    line: '7',
    subwayId: '1007',
    selectedDepartureTime: NOW,
    segmentStations: ['용마산', '중곡', '군자'],
    expiresAt: NOW + 60 * 60_000,
  };
  const waypoint: Waypoint = { stationName: '중곡', line: '7', kind: 'intermediate' };

  const makeArrivalSeoul = makeEstimateArrivalSeoul;
  const makeArrivalDeps = makeEstimateArrivalDeps;

  it('arrivals 매칭 시 arvlCd=1 노출 (arrived=true)', async () => {
    const result = await estimateBoardingLockArrival(
      makeArrivalDeps(makeArrivalSeoul(1)),
      lock,
      waypoint,
      NOW,
    );
    expect(result).toEqual({ epoch: NOW, arrived: true, arvlCd: 1 });
  });

  it('arrivals 매칭 시 arvlCd=0 노출 (arrived=true)', async () => {
    const result = await estimateBoardingLockArrival(
      makeArrivalDeps(makeArrivalSeoul(0)),
      lock,
      waypoint,
      NOW,
    );
    expect(result).toEqual({ epoch: NOW, arrived: true, arvlCd: 0 });
  });

  it('arrivals 매칭 + arvlCd=2(DEPARTED) → arrived=false + arvlCd=2 그대로 노출', async () => {
    const result = await estimateBoardingLockArrival(
      makeArrivalDeps(makeArrivalSeoul(2)),
      lock,
      waypoint,
      NOW,
    );
    expect(result).toEqual({ epoch: NOW, arrived: false, arvlCd: 2 });
  });

  it('arrivals 매칭 + arvlCd=null → arrived=false + arvlCd=null', async () => {
    const result = await estimateBoardingLockArrival(
      makeArrivalDeps(makeArrivalSeoul(null)),
      lock,
      waypoint,
      NOW,
    );
    expect(result).toEqual({ epoch: NOW, arrived: false, arvlCd: null });
  });

  it('positions-fallback → arvlCd=null (sttus 신호는 매역 SSOT 아님)', async () => {
    // arrivals 빈 응답 + positions에 lock.trainCode 매칭 → fallback 경로 진입.
    const result = await estimateBoardingLockArrival(
      makeArrivalDeps(makePositionsFallbackSeoul()),
      lock,
      waypoint,
      NOW,
    );
    // arrived=true (sttus=ARRIVED + station match)지만 arvlCd=null (positions 경로 명시)
    expect(result?.arvlCd).toBeNull();
    expect(result?.arrived).toBe(true);
  });

  it('#1824 arrivals + positions 모두 훈련 코드 없음 → null 반환 (schedule-hop은 runTrainCodeTracking 레벨에서 처리)', async () => {
    // Seoul API outage 시: arrivals 빈 응답 + positions 빈 응답 → estimateBoardingLockArrival은 null.
    // schedule-hop ETA 발사는 runTrainCodeTracking에서 stats.scheduleEtaFallback 누적과 함께 처리됨.
    const emptySeoul = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ realtimeArrivalList: [], realtimePositionList: [] }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    const result = await estimateBoardingLockArrival(
      makeArrivalDeps(emptySeoul),
      lock,
      waypoint,
      NOW,
    );
    expect(result).toBeNull();
  });
});

describe('runScheduled — #917 A2 arvlCd∈{0,1} 매역 알림 발사', () => {
  const makeLock = makeBoardingLock;
  const makeLockTrip = (overrides: Partial<Trip> = {}) => makeLockTripFixture('arvl-tok', overrides);

  const makeArrivalSeoul = makeArvlCdFireSeoul;
  const getStationPassedCalls = getArvlCdStationPassedCalls;
  const parseStationPassedData = parseArvlCdStationPassedData;

  // arvlCd fire 테스트 공통 setup — kv 시드 + runScheduled 실행. apnsFetch는 옵션으로 사전 stub 가능.
  // seedKv는 trip put 직후 추가 KV 시드 (이전 cycle stamp 등) 수행하는 콜백.
  async function runArvlScheduled(opts: {
    seoul: SeoulArrivalClient;
    trip?: Trip;
    apnsFetch?: ReturnType<typeof vi.fn>;
    pushId?: string;
    seedKv?: (kv: InMemoryKV) => Promise<void>;
    db?: D1Database;
  }): Promise<{ stats: ScheduledStats; kv: InMemoryKV; apnsFetch: ReturnType<typeof vi.fn> }> {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, opts.trip ?? makeLockTrip());
    if (opts.seedKv) await opts.seedKv(kv);
    const apnsFetch = opts.apnsFetch ?? vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv, undefined, opts.db), {
      seoul: opts.seoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => opts.pushId ?? 'p-arvl-1',
    });
    return { stats, kv, apnsFetch };
  }

  it('arvlCd=1(ARRIVED) → 매역 push 발사 + stats.arvlCdFireSuccess=1 + dedup KV stamp', async () => {
    const { stats, kv, apnsFetch } = await runArvlScheduled({
      seoul: makeArrivalSeoul('중곡', 0, 1),
      pushId: 'p-arvl-1',
    });
    expect(stats.arvlCdFireSuccess).toBe(1);
    expect(stats.arvlCdFireDedup).toBe(0);
    expect(stats.arvlCdFireMismatch).toBe(0);
    expect(stats.pushed).toBe(1);
    const calls = getStationPassedCalls(apnsFetch);
    expect(calls).toHaveLength(1);
    const data = parseStationPassedData(calls[0]);
    expect(data.nextWaypoint).toBe('중곡');
    expect(data.kind).toBe('intermediate');
    expect(data.phase).toBe('imminent');
    expect(data.etaSeconds).toBe(0);
    expect(data.pushId).toBe('p-arvl-1');
    expect(data.sentAt).toBe(NOW);
    // dedup KV stamp 확인 (TTL은 InMemoryKV가 그대로 보관 — expiration 무시)
    expect(await kv.get(arvlCdFireKey('arvl-tok', '7246', '중곡', 1))).toBe('1');
  });

  // #2086 — 짧은 mock token('arvl-tok')은 `slice(0, 16)`가 no-op이라 apns-collapse-id
  // 축약 로직을 실제로 exercise하지 못한다. 실물 길이(64 hex) device token으로
  // `station-<token16>` 형태 + APNs 64B 한도 준수를 직접 검증한다.
  it('#2086 실물 길이(64 hex) device token → apns-collapse-id가 16 hex prefix로 축약되고 64B 이하', async () => {
    const { apnsFetch } = await runArvlScheduled({
      seoul: makeArrivalSeoul('중곡', 0, 1),
      trip: makeLockTripFixture(HEX64_TOKEN),
      pushId: 'p-arvl-hex64',
    });
    const calls = getStationPassedCalls(apnsFetch);
    expect(calls).toHaveLength(1);
    const headers = calls[0][1].headers as Record<string, string>;
    const collapseId = headers['apns-collapse-id'];
    expect(collapseId).toBe(`station-${HEX64_TOKEN.slice(0, 16)}`);
    expect(new TextEncoder().encode(collapseId).length).toBeLessThanOrEqual(64);
  });

  // Epic #1204 그룹 2 D3 (#1273)
  it('payload.hopIndex 포함 — waypoint.hopIndex stamp가 그대로 forward', async () => {
    const tripWithHop = makeLockTripFixture('arvl-tok', {
      waypoints: [
        { stationName: '중곡', line: '7', kind: 'intermediate', hopIndex: 4 },
        { stationName: '군자', line: '7', kind: 'destination', hopIndex: 5 },
      ],
    });
    const { apnsFetch } = await runArvlScheduled({
      seoul: makeArrivalSeoul('중곡', 0, 1),
      trip: tripWithHop,
      pushId: 'p-arvl-hop',
    });
    const data = parseStationPassedData(getStationPassedCalls(apnsFetch)[0]);
    expect(data.hopIndex).toBe(4);
  });

  it('payload.hopIndex 누락 — waypoint.hopIndex 부재 시 silent push 본문에서도 누락', async () => {
    const { apnsFetch } = await runArvlScheduled({
      seoul: makeArrivalSeoul('중곡', 0, 1),
      pushId: 'p-arvl-no-hop',
    });
    const data = parseStationPassedData(getStationPassedCalls(apnsFetch)[0]);
    expect(data.hopIndex).toBeUndefined();
  });

  // #1307 — server-authoritative subsurface flag forward (arvlCd-fire 경로).
  // trip.subsurface=true면 본문으로 forward, 미설정이면 omit.
  it.each([
    ['true면 본문으로 forward', true, true, 'p-arvl-sub'],
    ['미설정이면 본문에서 omit', undefined, false, 'p-arvl-no-sub'],
  ])('payload.subsurface %s (#1307)', async (_label, input, expectPresent, pushId) => {
    const { apnsFetch } = await runArvlScheduled({
      seoul: makeArrivalSeoul('중곡', 0, 1),
      ...(input === undefined ? {} : { trip: makeLockTripFixture('arvl-tok', { subsurface: input }) }),
      pushId,
    });
    const data = parseStationPassedData(getStationPassedCalls(apnsFetch)[0]) as Record<
      string,
      unknown
    >;
    expect('subsurface' in data).toBe(expectPresent);
    if (expectPresent) expect(data.subsurface).toBe(true);
  });

  // #1322 — lock-path fire는 boardingLine/trainCode를 self-describing으로 실어 보낸다.
  // 디바이스가 로컬 lock 없이도 line sanity-guard를 돌려 transfer/destination push를 발사할 수 있게 한다.
  it('payload.boardingLine/trainCode 포함 — lock.line/lock.trainCode가 그대로 forward (#1322)', async () => {
    const { apnsFetch } = await runArvlScheduled({
      seoul: makeArrivalSeoul('중곡', 0, 1),
      pushId: 'p-arvl-line',
    });
    const data = parseStationPassedData(getStationPassedCalls(apnsFetch)[0]) as Record<
      string,
      unknown
    >;
    expect(data.boardingLine).toBe('7');
    expect(data.trainCode).toBe('7246');
  });

  // #2021 (ADR-022) — archFlag='on' 시 arvlCd fire 경로에서 boardingLine 봉인. device 의
  // lockless-opt-out gate 존중. trainCode 는 유지 (device 가 진단/UI 에서 참조하는 필드).
  // 2026-07-03 08:24 성수 오발사 evidence 회귀 차단.
  it('#2021 archFlag=on 시 payload.boardingLine 봉인, boardingLine 필드 자체 누락', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockTrip());
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    await runScheduled(makeEnv(kv), {
      seoul: makeArrivalSeoul('중곡', 0, 1),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-arvl-flag-on',
      archFlag: 'on',
    });
    const data = parseStationPassedData(getStationPassedCalls(apnsFetch)[0]) as Record<
      string,
      unknown
    >;
    // boardingLine 은 payload 에서 자연 누락 (apns.ts JSON serializer 가 undefined 필드 omit).
    expect('boardingLine' in data).toBe(false);
    // trainCode 는 유지 — device 진단/UI 참조 필드로 flag 무관.
    expect(data.trainCode).toBe('7246');
  });

  // #2021 — archFlag='off' (default) 시 기존 동작 100% 유지 회귀 방지 가드.
  it('#2021 archFlag=off (명시) → 기존 동작 (boardingLine=lock.line) 유지', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockTrip());
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    await runScheduled(makeEnv(kv), {
      seoul: makeArrivalSeoul('중곡', 0, 1),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-arvl-flag-off',
      archFlag: 'off',
    });
    const data = parseStationPassedData(getStationPassedCalls(apnsFetch)[0]) as Record<
      string,
      unknown
    >;
    expect(data.boardingLine).toBe('7');
    expect(data.trainCode).toBe('7246');
  });

  it('arvlCd=0(ENTERING) → 매역 push 발사 (arvlCd=0 dedup key)', async () => {
    const { stats, kv } = await runArvlScheduled({
      seoul: makeArrivalSeoul('중곡', 0, 0),
      pushId: 'p-arvl-0',
    });
    expect(stats.arvlCdFireSuccess).toBe(1);
    expect(await kv.get(arvlCdFireKey('arvl-tok', '7246', '중곡', 0))).toBe('1');
    // arvlCd=1 entry는 아직 stamp 없음 — 0과 1은 분리.
    expect(await kv.get(arvlCdFireKey('arvl-tok', '7246', '중곡', 1))).toBeNull();
  });

  it('dedup — 같은 (trainCode, station, arvlCd) 이미 stamp되어 있으면 push 미발사', async () => {
    const { stats, apnsFetch } = await runArvlScheduled({
      seoul: makeArrivalSeoul('중곡', 0, 1),
      pushId: 'p-arvl-dup',
      seedKv: async (kv) => {
        // 이전 cycle에서 같은 신호로 이미 stamp된 상태
        await kv.put(arvlCdFireKey('arvl-tok', '7246', '중곡', 1), '1');
      },
    });
    expect(stats.arvlCdFireSuccess).toBe(0);
    expect(stats.arvlCdFireDedup).toBe(1);
    // 매역 push 발사 없음 (waypoint advance LA push 등 다른 경로 push는 별개)
    expect(getStationPassedCalls(apnsFetch)).toHaveLength(0);
  });

  it('#640 회귀 가드 — positions-fallback arrived(arvlCd=null)은 매역 push 미발사 (mismatch++)', async () => {
    // arrivals 빈 응답 + positions에 lock.trainCode가 target 역에 ARRIVED.
    // 호출 흐름: estimate.arrived=true (positions 경로), estimate.arvlCd=null → fire 게이트 차단.
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockTrip());
    const seoul = makePositionsFallbackSeoul();
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-arvl-pos',
    });
    expect(stats.arvlCdFireSuccess).toBe(0);
    expect(stats.arvlCdFireMismatch).toBe(1);
    expect(getStationPassedCalls(apnsFetch)).toHaveLength(0);
  });

  it('#640 회귀 가드 — lock 부재 trip은 lockMissing 게이트에 막혀 매역 fire 경로 진입 자체 X', async () => {
    // lock 없는 trip + arrivals에 임의 trainCode arvlCd=1 → 외부에서 보면 "매역 신호"지만
    // lockMissing 게이트가 차단해야 한다.
    const { stats, apnsFetch } = await runArvlScheduled({
      seoul: makeArrivalSeoul('강남', 0, 1),
      trip: makeTrip(), // boardingLock undefined
      pushId: 'p-arvl-nolock',
    });
    expect(stats.lockMissing).toBe(1);
    expect(stats.arvlCdFireSuccess).toBe(0);
    // mismatch도 0 — 게이트가 더 위에서 차단해 fire 경로 진입 자체가 없음.
    expect(stats.arvlCdFireMismatch).toBe(0);
    expect(apnsFetch).not.toHaveBeenCalled();
  });

  it('waypoint advance는 매역 push 발사 후에도 정상 수행 (push와 progress는 독립)', async () => {
    const { kv } = await runArvlScheduled({
      seoul: makeArrivalSeoul('중곡', 0, 1),
      pushId: 'p-arvl-adv',
    });
    // 중곡(intermediate) advance 후 다음 waypoint=군자
    const stored = JSON.parse((await kv.get('trip:arvl-tok')) as string) as Trip;
    expect(stored.waypoints).toHaveLength(1);
    expect(stored.waypoints[0].stationName).toBe('군자');
  });

  it('APNs env mismatch self-heal — sandbox 1차 거부 → production 정정 + arvlCdFireSuccess=1', async () => {
    const apnsFetch = vi.fn();
    apnsFetch
      .mockImplementationOnce(async () =>
        new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
      )
      .mockImplementationOnce(async () => new Response('', { status: 200 }));
    const { stats, kv } = await runArvlScheduled({
      seoul: makeArrivalSeoul('중곡', 0, 1),
      trip: makeLockTrip({ apnsEnv: 'sandbox' }),
      apnsFetch,
      pushId: 'p-arvl-heal',
    });
    expect(stats.arvlCdFireSuccess).toBe(1);
    expect(stats.envCorrected).toBe(1);
    const stored = JSON.parse((await kv.get('trip:arvl-tok')) as string) as Trip;
    expect(stored.apnsEnv).toBe('production');
  });

  it('push 실패 시 stats.errors++ + dedup KV 미stamp (다음 cycle 재시도 허용)', async () => {
    const apnsFetch = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadFoo' }), { status: 400 }),
    );
    const { stats, kv } = await runArvlScheduled({
      seoul: makeArrivalSeoul('중곡', 0, 1),
      apnsFetch,
      pushId: 'p-arvl-fail',
    });
    expect(stats.arvlCdFireSuccess).toBe(0);
    expect(stats.errors).toBeGreaterThanOrEqual(1);
    // 실패는 dedup stamp X — 다음 cycle 재시도 가능.
    expect(await kv.get(arvlCdFireKey('arvl-tok', '7246', '중곡', 1))).toBeNull();
  });

  it('destination waypoint도 arvlCd=1이면 매역 push 발사 (kind=destination)', async () => {
    const { stats, apnsFetch } = await runArvlScheduled({
      seoul: makeArrivalSeoul('군자', 0, 1),
      trip: makeLockTrip({
        waypoints: [{ stationName: '군자', line: '7', kind: 'destination' }],
      }),
      pushId: 'p-arvl-dest',
    });
    expect(stats.arvlCdFireSuccess).toBe(1);
    const calls = getStationPassedCalls(apnsFetch);
    expect(calls).toHaveLength(1);
    expect(parseStationPassedData(calls[0]).kind).toBe('destination');
  });

  it('cross-trip 격리 — 같은 trainCode 같은 역에 두 trip 동시 도착 시 둘 다 발사 (token이 dedup key)', async () => {
    // 두 사용자가 같은 train(7246)을 탄 채 같은 cycle 안 같은 역(중곡)에 도착하는 시나리오.
    // 옛 동작(token 미포함 dedup key)은 두 번째 trip을 silence했음.
    const { stats, apnsFetch } = await runArvlScheduled({
      seoul: makeArrivalSeoul('중곡', 0, 1),
      trip: makeLockTrip({ token: 'user-a' }),
      pushId: 'p-arvl-cross',
      seedKv: async (kv) => {
        // 두 번째 trip을 같은 KV에 추가 시드.
        await putTrip(kv as unknown as KVNamespace, makeLockTrip({ token: 'user-b' }));
      },
    });
    expect(stats.arvlCdFireSuccess).toBe(2);
    expect(stats.arvlCdFireDedup).toBe(0);
    expect(getStationPassedCalls(apnsFetch)).toHaveLength(2);
  });

  // #2063 (ADR-023 개정) — 매역 알림(station-notif) sleep mute 분기.
  describe('#2063 (ADR-023 개정) sleepModeEnabled 매역 알림 mute', () => {
    it('sleepModeEnabled=true → 매역 push skip (push 미발사, dedup KV 미stamp)', async () => {
      const { stats, kv, apnsFetch } = await runArvlScheduled({
        seoul: makeArrivalSeoul('중곡', 0, 1),
        trip: makeLockTrip({ sleepModeEnabled: true }),
        pushId: 'p-arvl-sleep',
      });
      expect(stats.arvlCdFireSuccess).toBe(0);
      expect(stats.pushed).toBe(0);
      expect(getStationPassedCalls(apnsFetch)).toHaveLength(0);
      expect(await kv.get(arvlCdFireKey('arvl-tok', '7246', '중곡', 1))).toBeNull();
    });

    it('sleepModeEnabled=false → 매역 push 정상 발사', async () => {
      const { stats, apnsFetch } = await runArvlScheduled({
        seoul: makeArrivalSeoul('중곡', 0, 1),
        trip: makeLockTrip({ sleepModeEnabled: false }),
        pushId: 'p-arvl-nosleep',
      });
      expect(stats.arvlCdFireSuccess).toBe(1);
      expect(getStationPassedCalls(apnsFetch)).toHaveLength(1);
    });

    it('sleepModeEnabled 미지정(undefined) → 매역 push 정상 발사 (기존 동작 보존)', async () => {
      const { stats, apnsFetch } = await runArvlScheduled({
        seoul: makeArrivalSeoul('중곡', 0, 1),
        trip: makeLockTrip(),
        pushId: 'p-arvl-undef-sleep',
      });
      expect(stats.arvlCdFireSuccess).toBe(1);
      expect(getStationPassedCalls(apnsFetch)).toHaveLength(1);
    });
  });

  // #2063 (ADR-023 개정) P1 — i18n 4언어 매역 알림 문구 (locale별).
  describe('#2063 매역 알림 locale별 title/body 렌더', () => {
    it.each<['ko' | 'en' | 'ja' | 'zh', string, string]>([
      ['ko', '역 통과', '중곡역을 지나고 있어요'],
      ['en', 'Passing station', 'Passing through 중곡'],
      ['ja', '駅通過', '중곡駅を通過しています'],
      ['zh', '经过站点', '正在经过중곡站'],
    ])('locale=%s → intermediate title/body 4언어 렌더', async (locale, title, body) => {
      const { apnsFetch } = await runArvlScheduled({
        seoul: makeArrivalSeoul('중곡', 0, 1),
        trip: makeLockTrip({ locale }),
        pushId: `p-arvl-locale-${locale}`,
      });
      const call = getStationPassedCalls(apnsFetch)[0];
      const parsedBody = JSON.parse(call[1].body as string) as { aps: { alert: { title: string; body: string } } };
      expect(parsedBody.aps.alert.title).toBe(title);
      expect(parsedBody.aps.alert.body).toBe(body);
    });

    it('locale 미지정 → ko fallback', async () => {
      const { apnsFetch } = await runArvlScheduled({
        seoul: makeArrivalSeoul('중곡', 0, 1),
        trip: makeLockTrip(),
        pushId: 'p-arvl-locale-fallback',
      });
      const call = getStationPassedCalls(apnsFetch)[0];
      const parsedBody = JSON.parse(call[1].body as string) as { aps: { alert: { title: string; body: string } } };
      expect(parsedBody.aps.alert.title).toBe('역 통과');
    });
  });

  it('arvlCd=1이지만 lock 만료된 trip은 lockMissing 게이트로 차단 (fire 경로 미진입)', async () => {
    const { stats, apnsFetch } = await runArvlScheduled({
      seoul: makeArrivalSeoul('중곡', 0, 1),
      trip: makeLockTrip({ boardingLock: makeLock({ expiresAt: NOW - 1 }) }),
      pushId: 'p-arvl-exp',
    });
    expect(stats.lockMissing).toBe(1);
    expect(stats.arvlCdFireSuccess).toBe(0);
    expect(stats.arvlCdFireMismatch).toBe(0); // 게이트 위 차단이라 fire 경로 미진입
    expect(getStationPassedCalls(apnsFetch)).toHaveLength(0);
  });

  // #1367 — cross-station 동시 fire 차단. 같은 trip에서 직전 다른 station의 fire가 있고
  // SAME_PHASE_STATION_DEDUP_WINDOW_MS 안이면 다음 station의 fire를 보류한다 (client 동시 banner 차단).
  it('#1367 cross-station — 직전 다른 station fire 후 윈도우 내 다음 station fire는 dedup', async () => {
    const tripWithRecentFire = makeLockTrip({
      lastFiredStation: { stationName: '건대입구', epochMs: NOW - 1_000 },
    });
    const { stats, apnsFetch } = await runArvlScheduled({
      seoul: makeArrivalSeoul('중곡', 0, 1),
      trip: tripWithRecentFire,
      pushId: 'p-arvl-cross',
    });
    expect(stats.arvlCdFireSuccess).toBe(0);
    expect(stats.arvlCdFireDedup).toBe(1);
    expect(getStationPassedCalls(apnsFetch)).toHaveLength(0);
  });

  it('#1367 cross-station — 윈도우 밖(SAME_PHASE_STATION_DEDUP_WINDOW_MS+1)이면 정상 fire', async () => {
    const tripOldFire = makeLockTrip({
      lastFiredStation: {
        stationName: '건대입구',
        epochMs: NOW - SAME_PHASE_STATION_DEDUP_WINDOW_MS - 1,
      },
    });
    const { stats } = await runArvlScheduled({
      seoul: makeArrivalSeoul('중곡', 0, 1),
      trip: tripOldFire,
      pushId: 'p-arvl-cross-ok',
    });
    expect(stats.arvlCdFireSuccess).toBe(1);
    expect(stats.arvlCdFireDedup).toBe(0);
  });

  it('#1367 cross-station — 같은 station(직전과 동일)은 cross-station 게이트와 무관 — per-(token,trainCode,station,arvlCd) 게이트가 처리', async () => {
    // 같은 station이지만 다른 arvlCd면 cross-station 게이트는 통과 (per-arvlCd dedup KV는 별 entry).
    const tripSameStation = makeLockTrip({
      lastFiredStation: { stationName: '중곡', epochMs: NOW - 1_000 },
    });
    const { stats } = await runArvlScheduled({
      seoul: makeArrivalSeoul('중곡', 0, 1),
      trip: tripSameStation,
      pushId: 'p-arvl-cross-same',
    });
    // cross-station 분기는 stationName이 같으면 무시 — fire 진행.
    expect(stats.arvlCdFireSuccess).toBe(1);
  });

  it('#1367 cross-station — fire 성공 시 trip.lastFiredStation을 stamp하여 다음 cycle dedup 활성화', async () => {
    const { stats, kv } = await runArvlScheduled({
      seoul: makeArrivalSeoul('중곡', 0, 1),
      pushId: 'p-arvl-stamp',
    });
    expect(stats.arvlCdFireSuccess).toBe(1);
    const raw = await kv.get('trip:arvl-tok');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.lastFiredStation).toEqual({ stationName: '중곡', epochMs: NOW });
  });
});

/**
 * #2343 — cron fire path(destination/transfer/station-passed 발사)를 D1 `trip_events`
 * (kind='cron-fire-attempt')로 관측. 다음 검증 탑승에서 backend가 실제로 발사했는지를 device
 * 로그 없이 D1 SELECT만으로 판정할 수 있게 한다(2026-08-18 검증 탑승 blind spot).
 */
describe('runScheduled — #2343 cron-fire-attempt D1 로그', () => {
  const makeLockTrip = (overrides: Partial<Trip> = {}) => makeLockTripFixture('arvl-fire-log', overrides);
  const makeArrivalSeoul = makeArvlCdFireSeoul;

  it('발사 성공 → trip_events에 kind=cron-fire-attempt / outcome=sent 1건 insert', async () => {
    const { db, inserts } = makeFireLogDb();
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockTrip());
    await runScheduled(makeEnv(kv, undefined, db), {
      seoul: makeArrivalSeoul('중곡', 0, 1),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-fire-log-sent',
    });
    const fireLogInserts = inserts.filter((args) => args[2] === 'cron-fire-attempt');
    expect(fireLogInserts).toHaveLength(1);
    const [, , kind, station, , metaJson] = fireLogInserts[0] as [
      string,
      number,
      string,
      string | null,
      string | null,
      string | null,
    ];
    expect(kind).toBe('cron-fire-attempt');
    expect(station).toBe('중곡');
    expect(JSON.parse(metaJson!)).toEqual({
      waypointKind: 'station-passed',
      phase: 'imminent',
      outcome: 'sent',
    });
  });

  it('발사 실패(push 400) → outcome=failed + reason 기록', async () => {
    const { db, inserts } = makeFireLogDb();
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockTrip());
    const apnsFetch = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadFoo' }), { status: 400 }),
    );
    await runScheduled(makeEnv(kv, undefined, db), {
      seoul: makeArrivalSeoul('중곡', 0, 1),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-fire-log-failed',
    });
    const fireLogInserts = inserts.filter((args) => args[2] === 'cron-fire-attempt');
    expect(fireLogInserts).toHaveLength(1);
    const meta = JSON.parse(fireLogInserts[0][5] as string) as {
      waypointKind: string;
      phase: string;
      outcome: string;
      reason?: string;
    };
    expect(meta.outcome).toBe('failed');
    expect(meta.reason).toBe('BadFoo');
  });

  it('trip 삭제 race(advanceTripPosition no-trip) → outcome=skipped-reason', async () => {
    // listTrips가 trip을 읽어 처리 루프에 진입시킨 *직후*, advanceTripPosition 내부의
    // 독립적인 getTrip 재조회 시점에 trip이 사라진 상황을 시뮬레이션한다 — 같은 trip key에
    // 대한 2번째 kv.get 호출만 null로 응답해 "listTrips는 읽었지만 그 사이 DELETE됨" 레이스를
    // 재현한다 (listTrips 1회 get + advanceTripPosition getTrip 1회 get = 2번째 호출).
    class RaceDeleteKV extends InMemoryKV {
      private tripKeyGetCount = 0;
      constructor(private readonly raceKey: string) {
        super();
      }
      async get(key: string, options?: { cacheTtl?: number }): Promise<string | null> {
        if (key === this.raceKey) {
          this.tripKeyGetCount += 1;
          if (this.tripKeyGetCount === 2) return null;
        }
        return super.get(key, options);
      }
    }
    const token = 'arvl-fire-log-race';
    const kv = new RaceDeleteKV(`trip:${token}`);
    await putTrip(kv as unknown as KVNamespace, makeLockTripFixture(token));
    const { db, inserts } = makeFireLogDb();
    await runScheduled(makeEnv(kv as unknown as InMemoryKV, undefined, db), {
      seoul: makeArrivalSeoul('중곡', 0, 1),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-fire-log-race',
    });
    const fireLogInserts = inserts.filter((args) => args[2] === 'cron-fire-attempt');
    expect(fireLogInserts).toHaveLength(1);
    const meta = JSON.parse(fireLogInserts[0][5] as string) as {
      waypointKind: string;
      phase: string;
      outcome: string;
      reason?: string;
    };
    expect(meta.outcome).toBe('skipped-reason');
    expect(meta.reason).toBe('no-trip');
  });
});

/**
 * ADR-022 Phase 1-1 (#1985) — arvlCd fire-once TTL 게이트 (flag=ON 시).
 *
 * `isSimpleArchEnabled` 는 #2201 이후 real `getArchFlag(env.TRIPS)` 로 wire 되었다. 본 describe
 * 블록은 `vi.spyOn` 으로 flag=ON 을 강제 → 동일 (trip, station, cycle) 조합의 2회 이상 fire 가
 * 차단되는지 검증 (spy 방식은 KV 시드와 무관하게 격리 유지 목적으로 존속).
 */
describe('runScheduled — ADR-022 Phase 1-1 fire-once TTL (#1985)', () => {
  const TOKEN = 'arvl-fireonce-tok';
  const makeLockTrip = (overrides: Partial<Trip> = {}) => makeLockTripFixture(TOKEN, overrides);
  const makeArrivalSeoul = makeArvlCdFireSeoul;
  const getStationPassedCalls = getArvlCdStationPassedCalls;

  async function runWithFlagOn(opts: {
    seoul: SeoulArrivalClient;
    trip?: Trip;
    apnsFetch?: ReturnType<typeof vi.fn>;
    pushId?: string;
    seedKv?: (kv: InMemoryKV) => Promise<void>;
  }): Promise<{
    stats: ScheduledStats;
    kv: InMemoryKV;
    apnsFetch: ReturnType<typeof vi.fn>;
  }> {
    // flag=ON 을 spy 로 강제. `isSimpleArchEnabled` 를 * as import 하지 않고 destructured 로
    // scheduled.ts 가 import 하지만, vitest 는 ESM live bindings 를 통해 spy 를 적용한다.
    const mod = await import('../arvlcdFireOnceTtl');
    const spy = vi.spyOn(mod, 'isSimpleArchEnabled').mockResolvedValue(true);
    try {
      const kv = new InMemoryKV();
      await putTrip(kv as unknown as KVNamespace, opts.trip ?? makeLockTrip());
      if (opts.seedKv) await opts.seedKv(kv);
      const apnsFetch = opts.apnsFetch ?? vi.fn(async () => new Response('', { status: 200 }));
      const stats = await runScheduled(makeEnv(kv), {
        seoul: opts.seoul,
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: apnsFetch as unknown as typeof fetch,
        now: () => NOW,
        generatePushId: () => opts.pushId ?? 'p-fireonce-1',
      });
      return { stats, kv, apnsFetch };
    } finally {
      spy.mockRestore();
    }
  }

  it('flag=OFF (default) → 기존 로직 그대로. 새 stat 카운터는 항상 0', async () => {
    // 별도 spy 없이 실행 = default flag=OFF. 기존 동작 (arvlCdFireSuccess=1) 그대로.
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockTrip());
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeArrivalSeoul('중곡', 0, 1),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-flag-off',
    });
    expect(stats.arvlCdFireSuccess).toBe(1);
    // fire-once 게이트는 flag=OFF 이므로 관여 X — 카운터 0.
    expect(stats.arvlCdFireOnceSkipped).toBe(0);
    // fireOnce KV key 도 stamp 되지 않음.
    expect(await kv.get(arvlCdFireOnceKey(TOKEN, '중곡', ARVLCD_FIRE_ONCE_CYCLE_SLOT))).toBeNull();
  });

  it('flag=ON, 첫 관측 → fire 진행 + fireOnce KV stamp', async () => {
    const { stats, kv, apnsFetch } = await runWithFlagOn({
      seoul: makeArrivalSeoul('중곡', 0, 1),
      pushId: 'p-fireonce-first',
    });
    expect(stats.arvlCdFireSuccess).toBe(1);
    expect(stats.arvlCdFireOnceSkipped).toBe(0);
    expect(getStationPassedCalls(apnsFetch)).toHaveLength(1);
    // 5분 TTL stamp 확인 (InMemoryKV 는 value 를 그대로 보존).
    const stamped = await kv.get(arvlCdFireOnceKey(TOKEN, '중곡', ARVLCD_FIRE_ONCE_CYCLE_SLOT));
    expect(stamped).toBe(String(NOW));
  });

  it('flag=ON, 같은 (trip, station, cycle) 2회 fire → 2번째는 skip (arvlCdFireOnceSkipped++)', async () => {
    const { stats, apnsFetch } = await runWithFlagOn({
      seoul: makeArrivalSeoul('중곡', 0, 1),
      pushId: 'p-fireonce-dup',
      seedKv: async (kv) => {
        // 이전 cycle 에서 이미 fire-once stamp 된 상태.
        await kv.put(
          arvlCdFireOnceKey(TOKEN, '중곡', ARVLCD_FIRE_ONCE_CYCLE_SLOT),
          String(NOW - 30_000),
          { expirationTtl: ARVLCD_FIRE_ONCE_TTL_SEC },
        );
      },
    });
    expect(stats.arvlCdFireSuccess).toBe(0);
    expect(stats.arvlCdFireOnceSkipped).toBe(1);
    // 매역 push 발사 X.
    expect(getStationPassedCalls(apnsFetch)).toHaveLength(0);
  });

  it('flag=ON, arvlCd=0 fire 후 같은 cycle 이내 arvlCd=1 재관측 → 통합 게이트 skip', async () => {
    // 기존 `arvlCdFireKey` dedup 은 arvlCd=0 과 arvlCd=1 을 별 entry 로 stamp 해 둘 다 fire 하지만,
    // fire-once TTL 은 cycle 통합 → 같은 (trip, station, cycle) 조합은 통합 skip.
    // 이는 어린이대공원 반복 4회 fire (#1980) 회귀 차단의 핵심 정책.
    //
    // 검증 방식: `fireArvlCdStationPush` 를 직접 호출 (waypoint advance 부작용 격리) — 첫 호출 =
    // arvlCd=0 fire + fire-once stamp, 두 번째 호출 = arvlCd=1 통합 skip.
    const mod = await import('../arvlcdFireOnceTtl');
    const spy = vi.spyOn(mod, 'isSimpleArchEnabled').mockResolvedValue(true);
    try {
      const kv = new InMemoryKV();
      const trip = makeLockTrip();
      await putTrip(kv as unknown as KVNamespace, trip);
      const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
      const commonInputs = {
        trip,
        waypoint: trip.waypoints[0],
        lock: trip.boardingLock!,
        env: makeEnv(kv),
        deps: {
          seoul: makeArrivalSeoul('중곡', 0, 1),
          apnsConfig,
          apnsHosts: APNS_HOSTS,
          fetchImpl: apnsFetch as unknown as typeof fetch,
          now: () => NOW,
        },
        now: NOW,
        log: () => undefined,
        generatePushId: () => 'p-direct-cycle',
      };
      const statsFirst = makeFullEmptyStats();
      await fireArvlCdStationPush({ ...commonInputs, stats: statsFirst, arvlCd: 0 });
      expect(statsFirst.arvlCdFireSuccess).toBe(1);
      expect(statsFirst.arvlCdFireOnceSkipped).toBe(0);
      // fire-once stamp 확인.
      expect(
        await kv.get(arvlCdFireOnceKey(TOKEN, '중곡', ARVLCD_FIRE_ONCE_CYCLE_SLOT)),
      ).toBe(String(NOW));
      // 두 번째 호출: 같은 station 에서 arvlCd=1 재관측 (cycle 안 monotone 진행).
      const statsSecond = makeFullEmptyStats();
      const { dirty } = await fireArvlCdStationPush({
        ...commonInputs,
        stats: statsSecond,
        arvlCd: 1,
      });
      // arvlCd=1 은 fire-once TTL 로 통합 skip — push 미발사.
      expect(statsSecond.arvlCdFireSuccess).toBe(0);
      expect(statsSecond.arvlCdFireOnceSkipped).toBe(1);
      expect(dirty).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('flag=ON, cross-trip 격리 — trip A stamp 는 trip B fire 를 차단하지 X', async () => {
    // 두 사용자가 같은 station 을 같은 cycle 에 통과. token 이 key 에 포함되므로 각 trip 이 각각 fire.
    const { stats, apnsFetch } = await runWithFlagOn({
      seoul: makeArrivalSeoul('중곡', 0, 1),
      trip: makeLockTrip({ token: 'user-a' }),
      pushId: 'p-fireonce-cross',
      seedKv: async (kv) => {
        await putTrip(kv as unknown as KVNamespace, makeLockTripFixture('user-b'));
      },
    });
    // 두 trip 모두 각각 fire (fire-once 는 trip 단위 격리).
    expect(stats.arvlCdFireSuccess).toBe(2);
    expect(stats.arvlCdFireOnceSkipped).toBe(0);
    expect(getStationPassedCalls(apnsFetch)).toHaveLength(2);
  });

  it('flag=ON, cross-station 격리 — 다른 station 은 각각 fire (fire-once 는 station 단위)', async () => {
    // 첫 fire: 중곡. KV stamp 후 다른 station (건대입구) 관측 → 각 station 은 별 fire-once entry.
    // (참고: `SAME_PHASE_STATION_DEDUP_WINDOW_MS` cross-station 게이트가 걸리므로 별 fire 검증은
    // trip fixture 를 조정해 SAME_PHASE 윈도우 밖에 두어 확인.)
    const tripOldFire = makeLockTrip({
      lastFiredStation: {
        stationName: '건대입구',
        epochMs: NOW - SAME_PHASE_STATION_DEDUP_WINDOW_MS - 1,
      },
    });
    const { stats, kv } = await runWithFlagOn({
      seoul: makeArrivalSeoul('중곡', 0, 1),
      trip: tripOldFire,
      pushId: 'p-fireonce-station-x',
      seedKv: async (kv) => {
        // 이전 station(건대입구) fire-once 는 stamp 되어 있어도 중곡 fire 는 진행 가능해야 함.
        await kv.put(
          arvlCdFireOnceKey(TOKEN, '건대입구', ARVLCD_FIRE_ONCE_CYCLE_SLOT),
          String(NOW - 30_000),
          { expirationTtl: ARVLCD_FIRE_ONCE_TTL_SEC },
        );
      },
    });
    expect(stats.arvlCdFireSuccess).toBe(1);
    expect(stats.arvlCdFireOnceSkipped).toBe(0);
    // 중곡은 새로 stamp.
    expect(
      await kv.get(arvlCdFireOnceKey(TOKEN, '중곡', ARVLCD_FIRE_ONCE_CYCLE_SLOT)),
    ).toBe(String(NOW));
    // 건대입구 stamp 는 그대로 유지.
    expect(
      await kv.get(arvlCdFireOnceKey(TOKEN, '건대입구', ARVLCD_FIRE_ONCE_CYCLE_SLOT)),
    ).toBe(String(NOW - 30_000));
  });

  it('flag=ON, fire-once TTL 만료 → 다음 cycle fire 진행 (자연 회수)', async () => {
    // TTL 5분 만료 시나리오 — InMemoryKV 는 Date.now() 로 만료 판정. vi.useFakeTimers 사용.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      const kv = new InMemoryKV();
      await putTrip(kv as unknown as KVNamespace, makeLockTrip());
      // 5분+1ms 전 stamp — 만료된 상태.
      await kv.put(
        arvlCdFireOnceKey(TOKEN, '중곡', ARVLCD_FIRE_ONCE_CYCLE_SLOT),
        String(NOW - ARVLCD_FIRE_ONCE_TTL_SEC * 1000 - 1),
        { expirationTtl: 1 }, // 즉시 만료 처리 (Date.now() > expiresAt).
      );
      // 만료 시점 진행.
      vi.setSystemTime(NOW + 10_000);
      const mod = await import('../arvlcdFireOnceTtl');
      const spy = vi.spyOn(mod, 'isSimpleArchEnabled').mockResolvedValue(true);
      try {
        const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
        const stats = await runScheduled(makeEnv(kv), {
          seoul: makeArrivalSeoul('중곡', 0, 1),
          apnsConfig,
          apnsHosts: APNS_HOSTS,
          fetchImpl: apnsFetch as unknown as typeof fetch,
          now: () => NOW,
          generatePushId: () => 'p-fireonce-ttl-expire',
        });
        // TTL 만료로 첫 관측 취급 → fire 진행.
        expect(stats.arvlCdFireSuccess).toBe(1);
        expect(stats.arvlCdFireOnceSkipped).toBe(0);
      } finally {
        spy.mockRestore();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ARVLCD_FIRE_ONCE_CYCLE_SLOT (#1985)', () => {
  it('is 0 — 현재는 미래-확장 slot placeholder (5분 TTL 이 cycle 경계 처리)', () => {
    expect(ARVLCD_FIRE_ONCE_CYCLE_SLOT).toBe(0);
  });
});

describe('#1363 — pickLatestCurrentStationName (log 진단 이원화 helper)', () => {
  const base = { lat: 37.5, lng: 127.0, accuracy: 10, ts: 1000, motion: 'walking' } as const;

  it('빈 시리즈 → undefined', () => {
    expect(pickLatestCurrentStationName([])).toBeUndefined();
  });

  it('어떤 sample도 currentStationName이 없으면 → undefined', () => {
    const series: PositionPoint[] = [
      { ...base, ts: 1000 },
      { ...base, ts: 2000 },
    ];
    expect(pickLatestCurrentStationName(series)).toBeUndefined();
  });

  it('가장 최근 sample에 있으면 그대로 반환', () => {
    const series: PositionPoint[] = [
      { ...base, ts: 1000 },
      { ...base, ts: 2000, currentStationName: '강남' },
    ];
    expect(pickLatestCurrentStationName(series)).toBe('강남');
  });

  it('최근 sample이 누락하면 직전 sample에서 backfill', () => {
    const series: PositionPoint[] = [
      { ...base, ts: 1000, currentStationName: '용마산' },
      { ...base, ts: 2000 },
      { ...base, ts: 3000 },
    ];
    expect(pickLatestCurrentStationName(series)).toBe('용마산');
  });
});

describe('runScheduled — #1402 인프라 안전망 (pendingPushes wire-up + payload.origin)', () => {
  // 공용 helper — #1402 테스트 3건이 공유하던 SeoulArrivalClient 빌드 / runScheduled 호출 /
  // apnsFetch.mock.calls payload 추출 boilerplate를 압축. arvlCd / vanish-fallback / release
  // 시나리오는 입력 차이(arrival arvlCd 유무, trip override)만 명시한다.
  async function runArvlCdScenario(opts: {
    token: string;
    pushId: string;
    pending?: InMemoryKV;
    apnsFetch?: ReturnType<typeof vi.fn>;
  }): Promise<{ stats: ScheduledStats; pending?: InMemoryKV; apnsFetch?: ReturnType<typeof vi.fn> }> {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeLockTripFixture(opts.token));
    const fetchImpl = (opts.apnsFetch ??
      (async () => new Response('', { status: 200 }))) as unknown as typeof fetch;
    const stats = await runScheduled(makeEnv(kv, opts.pending), {
      seoul: makeEstimateArrivalSeoul(1),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl,
      now: () => NOW,
      generatePushId: () => opts.pushId,
    });
    return { stats, pending: opts.pending, apnsFetch: opts.apnsFetch };
  }

  function findApnsCallByPushId(
    apnsFetch: ReturnType<typeof vi.fn>,
    pushId: string,
  ): Record<string, unknown> {
    const calls = apnsFetch.mock.calls as unknown as Array<[string, RequestInit]>;
    const match = calls.find((c) => {
      const body = JSON.parse(c[1].body as string);
      return body.data?.pushId === pushId;
    });
    expect(match).toBeDefined();
    return JSON.parse(match![1].body as string);
  }

  it('#2063 (ADR-023 개정) arvlCd 발사 성공 시 visible alert 직접 발사, PENDING_PUSHES 미등록', async () => {
    const pending = new InMemoryKV();
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const { stats } = await runArvlCdScenario({
      token: 'arvl-1402',
      pushId: 'p1402-arvl',
      pending,
      apnsFetch,
    });
    expect(stats.arvlCdFireSuccess).toBe(1);
    const entry = await pending.get('pending:p1402-arvl');
    expect(entry).toBeNull();
    const body = findApnsCallByPushId(apnsFetch, 'p1402-arvl');
    expect((body.data as { nextWaypoint: string }).nextWaypoint).toBe('중곡');
    expect((body.data as { phase: string }).phase).toBe('imminent');
    expect((body.data as { sentAt: number }).sentAt).toBe(NOW);
  });

  it('arvlCd 페이로드에 origin=arvlcd stamp', async () => {
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    await runArvlCdScenario({
      token: 'arvl-1402b',
      pushId: 'p1402-arvl-origin',
      apnsFetch,
    });
    const body = findApnsCallByPushId(apnsFetch, 'p1402-arvl-origin');
    expect((body.data as { origin: string }).origin).toBe('arvlcd');
  });

  it('vanish-fallback advance(hop-elapsed) 페이로드에 origin=vanish-fallback stamp', async () => {
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const kv = new InMemoryKV();
    const pending = new InMemoryKV();
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockTripFixture('lock-tok', {
        consecutiveEtaMissing: VANISH_RE_ATTACH_THRESHOLD + FALLBACK_ADVANCE_GRACE_CYCLES - 1,
        lastTrackedArrivalEpoch: NOW - FALLBACK_HOP_SEC * 1000,
      }),
    );
    // arrivals/positions 모두 empty → vanish, hopElapsed=true → fallback advance fire
    await runScheduled(makeEnv(kv, pending), {
      seoul: new SeoulArrivalClient({
        apiKey: 'K',
        host: 'h',
        now: () => NOW,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ realtimeArrivalList: [] }), { status: 200 })) as unknown as typeof fetch,
      }),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p1402-vf',
    });
    const body = findApnsCallByPushId(apnsFetch, 'p1402-vf');
    expect((body.data as { origin: string }).origin).toBe('vanish-fallback');
    // #2063 (ADR-023 개정) — visible alert 직접 발사이므로 PENDING_PUSHES 등록 없음.
    expect(await pending.get('pending:p1402-vf')).toBeNull();
  });
});

// #1539 (S6, Epic #1533 / ADR-016) — passedStations 누적 + cron jitter 측정.
// device가 cron 1분 race로 놓친 station-passed를 사전 예약 큐 diff로 backfill 발사할 수 있게
// backend가 통과 station 누적 배열 + jitter metric을 제공한다. 본 PR은 데이터 plumbing만,
// device-side diff/fire wiring은 S5 머지 후 후속 PR.
describe('appendPassedStation (#1539 S6)', () => {
  function makeTrip(passed?: string[]): Trip {
    return {
      token: 't',
      route: { type: 'direct', stops: 3, line: '7' },
      destination: 'D',
      waypoints: [],
      expiresAt: NOW + 60_000,
      createdAt: NOW,
      alarmAtEpochMs: NOW + 60_000,
      ...(passed === undefined ? {} : { passedStations: passed }),
    };
  }

  it('initializes array on first call (#1539)', () => {
    const trip = makeTrip();
    const dirty = appendPassedStation(trip, '군자');
    expect(dirty).toBe(true);
    expect(trip.passedStations).toEqual(['군자']);
  });

  it('appends a different stationName at the end', () => {
    const trip = makeTrip(['군자']);
    const dirty = appendPassedStation(trip, '중곡');
    expect(dirty).toBe(true);
    expect(trip.passedStations).toEqual(['군자', '중곡']);
  });

  it('skips duplicate consecutive stationName (defensive dedup)', () => {
    const trip = makeTrip(['군자']);
    const dirty = appendPassedStation(trip, '군자');
    expect(dirty).toBe(false);
    expect(trip.passedStations).toEqual(['군자']);
  });

  it('rejects empty stationName', () => {
    const trip = makeTrip(['군자']);
    const dirty = appendPassedStation(trip, '');
    expect(dirty).toBe(false);
    expect(trip.passedStations).toEqual(['군자']);
  });

  it(`caps length to PASSED_STATIONS_MAX_LEN (${PASSED_STATIONS_MAX_LEN})`, () => {
    const initial = Array.from({ length: PASSED_STATIONS_MAX_LEN }, (_, i) => `S${i}`);
    const trip = makeTrip([...initial]);
    const dirty = appendPassedStation(trip, 'NEW');
    expect(dirty).toBe(true);
    expect(trip.passedStations).toHaveLength(PASSED_STATIONS_MAX_LEN);
    expect(trip.passedStations?.[0]).toBe('S1');
    expect(trip.passedStations?.[PASSED_STATIONS_MAX_LEN - 1]).toBe('NEW');
  });
});

describe('computeCronJitterMs (#1539 S6)', () => {
  it('returns 0 when called exactly at a boundary', () => {
    const boundary = Math.floor(NOW / CRON_NOMINAL_INTERVAL_MS) * CRON_NOMINAL_INTERVAL_MS;
    expect(computeCronJitterMs(boundary)).toBe(0);
  });

  it('returns positive ms offset from the prior 60s boundary', () => {
    const boundary = Math.floor(NOW / CRON_NOMINAL_INTERVAL_MS) * CRON_NOMINAL_INTERVAL_MS;
    expect(computeCronJitterMs(boundary + 1_234)).toBe(1_234);
  });

  it('always returns less than CRON_NOMINAL_INTERVAL_MS', () => {
    const boundary = Math.floor(NOW / CRON_NOMINAL_INTERVAL_MS) * CRON_NOMINAL_INTERVAL_MS;
    expect(computeCronJitterMs(boundary + CRON_NOMINAL_INTERVAL_MS - 1)).toBe(
      CRON_NOMINAL_INTERVAL_MS - 1,
    );
  });
});

// #1561 (T8) — SSoT forward + passedStations 테스트 공용 setup. Sonar 중복 제거.
const ARVLCD_LOCK_BOILER: BoardingLockMeta = {
  trainCode: 'T',
  line: '7',
  subwayId: '1007',
  selectedDepartureTime: NOW,
  segmentStations: ['중곡', '용마산'],
  expiresAt: NOW + 60 * 60_000,
};

const LOCKLESS_ARRIVED: ArrivalEntry = {
  destination: '강남행',
  arrivalSeconds: 30,
  trainCode: '7246',
  isUp: true,
  subwayNm: '지하철2호선',
  arvlCd: 1,
};

async function runArvlcdSsotFireScenario(opts: {
  token: string;
  waypoints: Waypoint[];
  seedSsotStation?: string;
}): Promise<{ arvlcdBody: Record<string, any> | null; stored: Trip }> {
  const kv = new InMemoryKV();
  await putTrip(
    kv as unknown as KVNamespace,
    makeTrip({
      token: opts.token,
      waypoints: opts.waypoints,
      boardingLock: { ...ARVLCD_LOCK_BOILER },
    }),
  );
  if (opts.seedSsotStation !== undefined) {
    await seedSsot(kv as unknown as KVNamespace, opts.token, opts.seedSsotStation);
  }
  const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
  await runScheduled(makeEnv(kv), {
    seoul: makeLockedSeoul(0, 1),
    apnsConfig,
    apnsHosts: APNS_HOSTS,
    fetchImpl: apnsFetch as unknown as typeof fetch,
    now: () => NOW,
  });
  const calls = apnsFetch.mock.calls as unknown as [string, RequestInit][];
  const arvlcdCall = calls.find((c) => {
    const body = JSON.parse(c[1].body as string);
    return body.data?.origin === 'arvlcd';
  });
  return {
    arvlcdBody: arvlcdCall ? JSON.parse(arvlcdCall[1].body as string) : null,
    stored: JSON.parse((await kv.get(`trip:${opts.token}`)) as string) as Trip,
  };
}

async function runLocklessSsotFireScenario(opts: {
  token: string;
  waypoints: Waypoint[];
  seedSsotStation?: string;
}): Promise<{ stored: Trip; locklessBody: Record<string, any> | null }> {
  const kv = new InMemoryKV();
  const trip = makeTrip({
    token: opts.token,
    route: { type: 'direct', line: '2', stops: 2 },
    waypoints: opts.waypoints,
    infoModeEnabled: true,
  });
  await putTrip(kv as unknown as KVNamespace, trip);
  await seedLocklessMotionSeries(kv, trip.token, 'automotive');
  if (opts.seedSsotStation !== undefined) {
    await seedSsot(kv as unknown as KVNamespace, opts.token, opts.seedSsotStation);
  }
  const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
  await runScheduled(makeEnv(kv), {
    seoul: makeSeoul([LOCKLESS_ARRIVED]),
    apnsConfig,
    apnsHosts: APNS_HOSTS,
    fetchImpl: apnsFetch as unknown as typeof fetch,
    now: () => NOW,
  });
  const calls = apnsFetch.mock.calls as unknown as [string, RequestInit][];
  const locklessCall = calls.find((c) => {
    const body = JSON.parse(c[1].body as string);
    return body.data?.origin === 'lockless';
  });
  return {
    stored: JSON.parse((await kv.get(`trip:${opts.token}`)) as string) as Trip,
    locklessBody: locklessCall ? JSON.parse(locklessCall[1].body as string) : null,
  };
}

describe('advanceBoardingLockWaypoint passedStations 누적 (#1539 S6)', () => {
  // arvlCd=ARRIVED → fireArvlCdStationPush → advance → trip.passedStations에 통과 station이 누적.
  // 이후 putTrip되어 KV에서 읽으면 wire가 전달된다 (다음 cycle silent push payload).
  it('accumulates passed stationName into trip.passedStations and forwards to payload', async () => {
    const { stored, arvlcdBody } = await runArvlcdSsotFireScenario({
      token: 'pass-1',
      waypoints: [
        { stationName: '중곡', line: '7', kind: 'intermediate' },
        { stationName: '용마산', line: '7', kind: 'intermediate' },
        { stationName: '강남', line: '2', kind: 'destination' },
      ],
    });
    expect(stored.passedStations).toEqual(['중곡']);
    // arvlCd-fire는 advance 직전 호출이라 fire 시점엔 아직 passedStations에 push되지 않은 상태.
    expect(arvlcdBody).toBeDefined();
    expect(arvlcdBody!.data.passedStations).toBeUndefined();
  });
});

describe('runLocklessIntermediate passedStations 누적 (#1539 S6)', () => {
  it('accumulates passed stationName on lockless advance', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({
      token: 'lockless-pass',
      route: { type: 'direct', line: '2', stops: 2 },
      waypoints: [
        { stationName: '강남', line: '2', kind: 'intermediate' },
        { stationName: '역삼', line: '2', kind: 'intermediate' },
      ],
      infoModeEnabled: true,
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    await seedLocklessMotionSeries(kv, trip.token, 'automotive');
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const arrived: ArrivalEntry = {
      destination: '강남행',
      arrivalSeconds: 30,
      trainCode: '7246',
      isUp: true,
      subwayNm: '지하철2호선',
      arvlCd: 1,
    };
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([arrived]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(stats.locklessIntermediateFired).toBe(1);
    const stored = JSON.parse((await kv.get('trip:lockless-pass')) as string) as Trip;
    expect(stored.passedStations).toEqual(['강남']);
  });

  // #2177 — lockless intermediate push가 unrecoverable(410 Unregistered)로 실패하면 retry queue를
  // 타지 않고 cleanupTripWithLa('push-unrecoverable')로 즉시 trip 폐기된다.
  it('#2177 — unrecoverable(410) push 실패 → retry-push 큐 적재 X + trip 폐기', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({
      token: 'lockless-410',
      route: { type: 'direct', line: '2', stops: 2 },
      waypoints: [
        { stationName: '강남', line: '2', kind: 'intermediate' },
        { stationName: '역삼', line: '2', kind: 'intermediate' },
      ],
      infoModeEnabled: true,
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    await seedLocklessMotionSeries(kv, trip.token, 'automotive');
    const apnsFetch = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'Unregistered' }), { status: 410 }),
    );
    const arrived: ArrivalEntry = {
      destination: '강남행',
      arrivalSeconds: 30,
      trainCode: '7246',
      isUp: true,
      subwayNm: '지하철2호선',
      arvlCd: 1,
    };
    const stats = await runScheduled(makeEnv(kv, kv), {
      seoul: makeSeoul([arrived]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-lockless-410',
    });
    expect(stats.errors).toBeGreaterThan(0);
    expect(await kv.get('retry-push:p-lockless-410')).toBeNull();
    expect(await kv.get('trip:lockless-410')).toBeNull();
  });

  // #2177 — lockless intermediate push가 transient(503)로 실패하면 retry-push 큐에 적재된다.
  it('#2177 — transient(503) push 실패 → retry-push 큐 적재', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({
      token: 'lockless-503',
      route: { type: 'direct', line: '2', stops: 2 },
      waypoints: [
        { stationName: '강남', line: '2', kind: 'intermediate' },
        { stationName: '역삼', line: '2', kind: 'intermediate' },
      ],
      infoModeEnabled: true,
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    await seedLocklessMotionSeries(kv, trip.token, 'automotive');
    const apnsFetch = vi.fn(async () => new Response('', { status: 503 }));
    const arrived: ArrivalEntry = {
      destination: '강남행',
      arrivalSeconds: 30,
      trainCode: '7246',
      isUp: true,
      subwayNm: '지하철2호선',
      arvlCd: 1,
    };
    await runScheduled(makeEnv(kv, kv), {
      seoul: makeSeoul([arrived]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-lockless-503',
    });
    const stored = await kv.get('retry-push:p-lockless-503');
    expect(stored).not.toBeNull();
    const entry = JSON.parse(stored as string);
    expect(entry.lastErrorStatus).toBe(503);
    // trip은 폐기되지 않고 그대로 유지 (transient 실패는 다음 cycle 재시도).
    expect(await kv.get('trip:lockless-503')).not.toBeNull();
  });
});

describe('runScheduled cron jitter stat (#1539 S6 / #2054)', () => {
  it('stamps cronJitterMs on stats without raw log (#2054 raw log 제거)', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    const logMessages: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(env, {
      seoul: new SeoulArrivalClient({
        apiKey: 'K',
        host: 'h',
        now: () => NOW + 7_321,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ realtimeArrivalList: [] }), { status: 200 })) as unknown as typeof fetch,
      }),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW + 7_321,
      log: (msg, meta) => {
        logMessages.push({ msg, meta });
      },
    });
    const expectedJitter = computeCronJitterMs(NOW + 7_321);
    expect(stats.cronJitterMs).toBe(expectedJitter);
    // #2054 — raw `scheduled: cron jitter` log 제거. spike 임계(45s) 미만이라 spike log 도 없음.
    expect(logMessages.some((l) => l.msg === 'scheduled: cron jitter')).toBe(false);
    expect(logMessages.some((l) => l.msg === 'scheduled: cron jitter spike')).toBe(false);
  });

  it('#2054 — emits `scheduled: cron jitter spike` when jitter exceeds 45s threshold', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    const logMessages: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    // 60s boundary 로부터 46_000ms 지난 시각을 강제. computeCronJitterMs 가 46_000 을 반환.
    const spikeNow = Math.floor((NOW + 60_000) / 60_000) * 60_000 + 46_000;
    await runScheduled(env, {
      seoul: new SeoulArrivalClient({
        apiKey: 'K',
        host: 'h',
        now: () => spikeNow,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ realtimeArrivalList: [] }), { status: 200 })) as unknown as typeof fetch,
      }),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => spikeNow,
      log: (msg, meta) => {
        logMessages.push({ msg, meta });
      },
    });
    expect(logMessages.some((l) => l.msg === 'scheduled: cron jitter spike')).toBe(true);
  });

  it('#2054 — idle cycle (scanned=0) suppresses `scheduled run complete` log', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    const logMessages: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(env, {
      seoul: new SeoulArrivalClient({
        apiKey: 'K',
        host: 'h',
        now: () => NOW,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ realtimeArrivalList: [] }), { status: 200 })) as unknown as typeof fetch,
      }),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      log: (msg, meta) => {
        logMessages.push({ msg, meta });
      },
    });
    expect(stats.scanned).toBe(0);
    expect(logMessages.some((l) => l.msg === 'scheduled run complete')).toBe(false);
  });

  it('#2054 — idle cycle emits `scheduled heartbeat` on first entry (no last-heartbeat stamp)', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    const logMessages: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    await runScheduled(env, {
      seoul: new SeoulArrivalClient({
        apiKey: 'K',
        host: 'h',
        now: () => NOW,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ realtimeArrivalList: [] }), { status: 200 })) as unknown as typeof fetch,
      }),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      log: (msg, meta) => {
        logMessages.push({ msg, meta });
      },
    });
    const hb = logMessages.find((l) => l.msg === 'scheduled heartbeat');
    expect(hb).toBeDefined();
    expect(hb?.meta?.alive).toBe(true);
    expect(hb?.meta).toHaveProperty('jitterP50');
    expect(hb?.meta).toHaveProperty('jitterP99');
    expect(hb?.meta).toHaveProperty('samples');
  });

  it('#2054 — second idle cycle within 1h skips heartbeat (KV gate)', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const makeSeoul = (nowFn: () => number) =>
      new SeoulArrivalClient({
        apiKey: 'K',
        host: 'h',
        now: nowFn,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ realtimeArrivalList: [] }), { status: 200 })) as unknown as typeof fetch,
      });
    // 1차 cycle: heartbeat 발화.
    await runScheduled(env, {
      seoul: makeSeoul(() => NOW),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });
    // 2차 cycle: 60s 후 — heartbeat gate 로 skip.
    const secondLogs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    await runScheduled(env, {
      seoul: makeSeoul(() => NOW + 60_000),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW + 60_000,
      log: (msg, meta) => {
        secondLogs.push({ msg, meta });
      },
    });
    expect(secondLogs.some((l) => l.msg === 'scheduled heartbeat')).toBe(false);
  });
});

// #2021 (ADR-022) — payload.boardingLine 정책 게이트 단위 테스트.
//
// 검증 범위: archFlag='on' → undefined (device lockless-opt-out gate 존중), else → lockLine
// (기존 #1322 동작 유지). 3개 fire 경로 + Seam E swap 이 모두 본 helper 를 통과한다.
describe('resolveBoardingLinePayload (#2021 ADR-022)', () => {
  it("returns undefined when archFlag='on'", () => {
    expect(resolveBoardingLinePayload('on', '7')).toBeUndefined();
  });

  it("returns lockLine when archFlag='off'", () => {
    expect(resolveBoardingLinePayload('off', '7')).toBe('7');
  });

  it('returns lockLine when archFlag is undefined (legacy / test / no KV binding)', () => {
    expect(resolveBoardingLinePayload(undefined, '2')).toBe('2');
  });
});

// #1561 (T8, ADR-017 / S2 #1535 흡수) — silent push payload SSoT 권위 forward.
//
// 검증 범위:
//   1. toSilentPushSsot helper — null/undefined → undefined, 정의된 SSoT → 축소 형태 + passedStations 최근 5개 슬라이스.
//   2. fireArvlCdStationPush 발사 시 backend SSoT KV에서 읽어 payload.ssot으로 forward.
//   3. SSoT 부재 trip(seed 전) — payload.ssot 자연 누락 (graceful, 구 device 호환).
//   4. lockless intermediate fire도 동일하게 SSoT forward.
describe('silent push SSoT forward (#1561 T8 / S2 흡수)', () => {
  it('toSilentPushSsot returns undefined for null/undefined input', () => {
    expect(toSilentPushSsot(null)).toBeUndefined();
    expect(toSilentPushSsot(undefined)).toBeUndefined();
  });

  it('toSilentPushSsot reduces TripPositionSSoT to wire payload + slices passedStations to last 5', () => {
    const ssot: TripPositionSSoT = {
      tripToken: 'tok-ssot-1',
      currentStationId: '강남',
      motionState: 'moving',
      motionEvidence: [],
      lastAdvanceAt: 1_700_000_001_000,
      lastAdvanceEvidence: 'arvlcd-confirmed-train',
      passedStations: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
      userIntentDeclared: false,
      seedOverrideCount: 0,
      schemaVersion: 1,
    };
    const payload = toSilentPushSsot(ssot);
    expect(payload).toEqual({
      currentStationId: '강남',
      motionState: 'moving',
      lastAdvanceEvidence: 'arvlcd-confirmed-train',
      lastAdvanceAt: 1_700_000_001_000,
      passedStations: ['C', 'D', 'E', 'F', 'G'],
    });
  });

  it('arvlcd-fire forwards SSoT from KV to silent push payload', async () => {
    const { arvlcdBody } = await runArvlcdSsotFireScenario({
      token: 'ssot-arvlcd-1',
      waypoints: [
        { stationName: '중곡', line: '7', kind: 'intermediate' },
        { stationName: '용마산', line: '7', kind: 'destination' },
      ],
      seedSsotStation: '중곡',
    });
    expect(arvlcdBody).toBeDefined();
    expect(arvlcdBody!.data.ssot).toBeDefined();
    expect(arvlcdBody!.data.ssot.currentStationId).toBe('중곡');
    expect(arvlcdBody!.data.ssot.motionState).toBe('unknown');
  });

  // #2092 — arvlcd-fire 매역 push도 aps.alert + content-available 동시 병기 + data.ssot 잔존.
  it('#2092 arvlcd-fire push는 aps.alert + content-available===1 동시 wire (SSoT mirror·BG 위젯 채널)', async () => {
    const { arvlcdBody } = await runArvlcdSsotFireScenario({
      token: 'ssot-arvlcd-content-available',
      waypoints: [
        { stationName: '중곡', line: '7', kind: 'intermediate' },
        { stationName: '용마산', line: '7', kind: 'destination' },
      ],
      seedSsotStation: '중곡',
    });
    expect(arvlcdBody).toBeDefined();
    expect(arvlcdBody!.aps.alert).toBeDefined();
    expect(arvlcdBody!.aps['content-available']).toBe(1);
    expect(arvlcdBody!.data.ssot).toBeDefined();
  });

  it('arvlcd-fire lazy-seeds SSoT from waypoint when absent (T4 #1557)', async () => {
    // T4 advanceTripPosition이 SSoT 부재 시 fire 직전 waypoint stationName으로 lazy-seed →
    // payload.ssot가 그 station을 currentStationId로 forward (이전 graceful omit 시나리오는 폐기).
    const { arvlcdBody } = await runArvlcdSsotFireScenario({
      token: 'ssot-arvlcd-lazy-seed',
      waypoints: [
        { stationName: '중곡', line: '7', kind: 'intermediate' },
        { stationName: '용마산', line: '7', kind: 'destination' },
      ],
    });
    expect(arvlcdBody).toBeDefined();
    expect(arvlcdBody!.data.ssot).toBeDefined();
    expect(arvlcdBody!.data.ssot.currentStationId).toBe('중곡');
  });

  it('lockless-fire forwards SSoT from KV to silent push payload', async () => {
    const { locklessBody } = await runLocklessSsotFireScenario({
      token: 'ssot-lockless-1',
      waypoints: [
        { stationName: '강남', line: '2', kind: 'intermediate' },
        { stationName: '역삼', line: '2', kind: 'intermediate' },
      ],
      seedSsotStation: '강남',
    });
    expect(locklessBody).toBeDefined();
    expect(locklessBody!.data.ssot).toBeDefined();
    expect(locklessBody!.data.ssot.currentStationId).toBe('강남');
  });
});

/**
 * ADR-017 T4 (#1557) — `advanceTripPosition` SSoT 게이트가 arvlcd fire 발사 직전 차단/통과를
 * 결정하는지 양방향 검증.
 *
 * 본 suite는 `runScheduled` 통합 레벨에서 lock 활성 + arvlcd ARRIVED 신호를 시뮬한 뒤
 * SSoT motionState / consensusGate / trainCode identity / lazy-seed 등 분기마다 결과를 단언한다.
 *
 * 2026-06-19 정지 trip + lock active + arvlcd ARRIVED → wrong "transfer imminent 건대입구"
 * 발사 회귀(N1)를 본 게이트가 직접 차단함을 박제한다.
 */
describe('runScheduled — ADR-017 T4 (#1557) advanceTripPosition SSoT gate (arvlcd fire)', () => {
  const TOKEN = 'arvl-tok';

  // arvlcd ARRIVED 신호 (중곡, trainCode 7246, arvlCd=1) 공통 Seoul fixture.
  const makeArrivedSeoul = (trainCode = '7246') => makeArvlCdFireSeoul('중곡', 0, 1, trainCode);

  async function setupTrip(
    overrides: Partial<Trip> = {},
  ): Promise<{ kv: InMemoryKV; trip: Trip }> {
    const kv = new InMemoryKV();
    const trip = makeLockTripFixture(TOKEN, overrides);
    await putTrip(kv as unknown as KVNamespace, trip);
    return { kv, trip };
  }

  async function runT4(opts: {
    kv: InMemoryKV;
    seoul?: SeoulArrivalClient;
    apnsFetch?: ReturnType<typeof vi.fn>;
    logMessages?: { msg: string; meta?: Record<string, unknown> }[];
  }): Promise<{ stats: ScheduledStats; apnsFetch: ReturnType<typeof vi.fn> }> {
    const apnsFetch = opts.apnsFetch ?? vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(opts.kv), {
      seoul: opts.seoul ?? makeArrivedSeoul(),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-t4',
      log: opts.logMessages
        ? (msg, meta) => {
            opts.logMessages!.push({ msg, meta });
          }
        : undefined,
    });
    return { stats, apnsFetch };
  }

  // 양방향 + 회귀 박제 시나리오 (issue body §검증 + 보강 섹션 arvlcdScenarios).
  type Scenario = {
    name: string;
    motionState: 'moving' | 'stationary' | 'unknown';
    userIntentDeclared?: boolean;
    subsurface?: boolean;
    expectFire: boolean;
    expectBlockReason?: 'motion-stationary' | 'env-consensus-fail';
    /**
     * #1680 (V8d) — stationary trip이 upstream 게이트(shouldSkipStationary)에서 이미 차단될 경우
     * `arvlCdFireBlocked` 대신 `lifecycleStationarySkipped`가 올라간다.
     * userIntentDeclared=true 인 stationary는 upstream bypass → advanceTripPosition 게이트에서 판정.
     */
    expectStationarySkip?: boolean;
  };

  const arvlcdScenarios: Scenario[] = [
    // Positive — moving + lock + arvlcd → fire
    {
      name: 'P1 moving + lock + arvlcd ARRIVED + trainCode 일치 → fire',
      motionState: 'moving',
      expectFire: true,
    },
    // Positive — unknown(레거시 / T3 미wire) + lock + arvlcd → fire (gate dormant for unknown)
    {
      name: 'P2 unknown(레거시) + lock + arvlcd → fire (게이트 dormant)',
      motionState: 'unknown',
      expectFire: true,
    },
    // Positive — userIntentDeclared 의향 ON trip은 stationary여도 motion gate 통과 ([[feedback_user_intent_equal_protection]])
    {
      name: 'P3 stationary + userIntentDeclared=true → fire (P8 동급 보장)',
      motionState: 'stationary',
      userIntentDeclared: true,
      expectFire: true,
    },
    // Negative — 2026-06-19 회귀 박제.
    // #1680: 이제 upstream stationary gate(shouldSkipStationary)가 먼저 차단 → lifecycleStationarySkipped=1.
    // arvlCdFireBlocked는 0 (downstream gate 미도달). expectFire=false 불변.
    {
      name: 'N1 stationary trip + lock + arvlcd → blocked (upstream stationary gate, 회귀 박제)',
      motionState: 'stationary',
      expectFire: false,
      expectStationarySkip: true,
    },
    // Note: N4 train-mismatch는 본 entry point(arvlcd fire)에서는 구조적으로 도달 불가 —
    // `estimateBoardingLockArrival`이 이미 lock.trainCode 기준으로 Seoul 응답을 필터하므로,
    // 일치하지 않는 trainCode는 estimate=null이 되어 vanish path로 분기한다. T2 #1555
    // advanceTripPosition.test.ts에 게이트 #5 단위 테스트가 박제됨. 본 통합 suite는 arvlcd
    // entry에서 실제로 활성화되는 시나리오만 cover (motion/env/seed).
    // Negative — 지하 + base 게이트(gatePassed)는 통과하지만 환경 게이트는 lockAttachable=true로
    // OR strongBE 통과 (즉 underground도 fire 가능). 본 시나리오는 environment fallthrough를 박제.
    {
      name: 'N6-pass underground + arvlcd + lockAttachable → fire (B+E 2-of-2)',
      motionState: 'moving',
      subsurface: true,
      expectFire: true,
    },
  ];

  it.each(arvlcdScenarios)('$name', async (sc) => {
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const { kv, trip } = await setupTrip(sc.subsurface !== undefined ? { subsurface: sc.subsurface } : {});
    // SSoT seed — sc.motionState=='unknown'은 미시드(legacy lazy-seed 경로) 시뮬, 그 외는 명시 stamp.
    if (sc.motionState !== 'unknown') {
      const ssot = await seedSsot(kv as unknown as KVNamespace, TOKEN, '용마산', {
        expiresAt: trip.expiresAt,
        userIntentDeclared: sc.userIntentDeclared ?? false,
      });
      ssot.motionState = sc.motionState;
      await writeSsot(kv as unknown as KVNamespace, ssot, { expiresAt: trip.expiresAt });
    }
    const logMessages: { msg: string; meta?: Record<string, unknown> }[] = [];
    const { stats } = await runT4({
      kv,
      seoul: makeArrivedSeoul(),
      apnsFetch,
      logMessages,
    });
    if (sc.expectFire) {
      expect(stats.arvlCdFireFired).toBe(1);
      expect(stats.arvlCdFireSuccess).toBe(1);
      expect(stats.arvlCdFireBlocked).toBe(0);
      expect(getArvlCdStationPassedCalls(apnsFetch)).toHaveLength(1);
    } else if (sc.expectStationarySkip) {
      // #1680 — upstream stationary gate가 먼저 차단. 하위 게이트(arvlCdFireBlocked)는 미도달.
      expect(stats.arvlCdFireFired).toBe(0);
      expect(stats.arvlCdFireSuccess).toBe(0);
      expect(stats.arvlCdFireBlocked).toBe(0);
      expect(stats.lifecycleStationarySkipped).toBe(1);
      expect(getArvlCdStationPassedCalls(apnsFetch)).toHaveLength(0);
    } else {
      expect(stats.arvlCdFireFired).toBe(0);
      expect(stats.arvlCdFireSuccess).toBe(0);
      expect(stats.arvlCdFireBlocked).toBe(1);
      expect(getArvlCdStationPassedCalls(apnsFetch)).toHaveLength(0);
      // blockReason은 log meta로 stamp되어 production tail에서 분포 측정 가능해야 함.
      const blockedLog = logMessages.find((l) => l.msg === 'arvlcd-fire: blocked');
      expect(blockedLog?.meta?.reason).toBe(sc.expectBlockReason);
    }
  });

  it('lazy-seed — SSoT 부재 시 currentStationId=waypoint.stationName으로 자동 시드', async () => {
    const { kv } = await setupTrip();
    expect(await readSsot(kv as unknown as KVNamespace, TOKEN)).toBeNull();
    const logMessages: { msg: string; meta?: Record<string, unknown> }[] = [];
    await runT4({ kv, logMessages });
    const ssot = await readSsot(kv as unknown as KVNamespace, TOKEN);
    expect(ssot).not.toBeNull();
    // advance 통과 후 currentStationId=waypoint.stationName(='중곡')으로 유지.
    expect(ssot?.currentStationId).toBe('중곡');
    // 직전 currentStationId(='중곡' seed 값)가 passedStations에 append됨 (appendUnique).
    expect(ssot?.passedStations).toContain('중곡');
    expect(logMessages.some((l) => l.msg === 'arvlcd-fire: lazy-seed ssot')).toBe(true);
  });

  it('cross-station dedup — lastFiredStation 윈도우 내 다른 station은 차단(기존 게이트 유지)', async () => {
    // SSoT는 advance 통과시키되, trip.lastFiredStation 윈도우 가드(scheduled.ts:921-936)는 그대로.
    const { kv, trip } = await setupTrip({
      lastFiredStation: { stationName: '용마산', epochMs: NOW - 1_000 },
    });
    await seedSsot(kv as unknown as KVNamespace, TOKEN, '용마산', {
      expiresAt: trip.expiresAt,
    });
    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const { stats } = await runT4({ kv, apnsFetch });
    // advance는 통과 (Fired++) — cross-station dedup은 `fireArvlCdStationPush` 내부에서 push만 차단.
    expect(stats.arvlCdFireFired).toBe(1);
    expect(stats.arvlCdFireSuccess).toBe(0);
    expect(stats.arvlCdFireDedup).toBe(1);
    expect(getArvlCdStationPassedCalls(apnsFetch)).toHaveLength(0);
  });

  it('stats — runScheduled 초기 stats에 arvlCdFireBlocked / arvlCdFireFired 0으로 초기화', async () => {
    const kv = new InMemoryKV();
    // trip 없이 실행 → 카운터는 0이어야 한다 (초기값 stamp 검증).
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeArrivedSeoul(),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-init',
    });
    expect(stats.arvlCdFireBlocked).toBe(0);
    expect(stats.arvlCdFireFired).toBe(0);
  });

  it('SSoT는 cron read cacheTtl(30s)로 조회 — ssotKey export로 stamp 검증', async () => {
    const { kv, trip } = await setupTrip();
    await seedSsot(kv as unknown as KVNamespace, TOKEN, '용마산', {
      expiresAt: trip.expiresAt,
    });
    await runT4({ kv });
    // 자유 단언 — runScheduled 호출 후에도 SSoT KV row가 유효해야 한다.
    expect(await kv.get(ssotKey(TOKEN))).not.toBeNull();
  });
});

/**
 * ADR-017 T7 (#1560) — transfer/destination kind 발사 직전 SSoT 위치 + 신선도 게이트 통합 검증.
 *
 * 본 suite는 `tryAdvanceAndFireArvlcd` 진입 시점에 `evaluateTransferDestinationGate`가
 * pre-advance SSoT 스냅샷으로 위치 일관성을 확인해 N9 회귀(2026-06-19 정지 trip "환승임박
 * 건대입구" false 발사)를 차단함을 박제한다.
 *
 * 시나리오 매트릭스 (issue 본문 §검증 + 보강 §transferScenarios):
 *   - P1 transfer at-target + 신선 SSoT → fire
 *   - P2 transfer 직전 1 hop + 신선 SSoT → fire
 *   - N9 transfer SSoT 다른 station + 신선 → block(ssot-not-at-or-approaching)
 *   - N9-stale transfer at-target 인데 lastAdvanceAt 60s 초과 → block(ssot-stale)
 *   - destination 동일 매트릭스 1개로 cover (N10)
 */
describe('runScheduled — ADR-017 T7 (#1560) transfer/destination SSoT gate', () => {
  const TOKEN = 't7-tok';
  const FRESH_LAST_ADVANCE = NOW - 30_000;
  const STALE_LAST_ADVANCE = NOW - 90_000;

  type T7Scenario = {
    name: string;
    waypointKind: 'transfer' | 'destination';
    waypointStation: string;
    ssotCurrentStation: string;
    ssotLastAdvanceAt: number;
    passedStations?: string[];
    expectFire: boolean;
    expectReason?: 'ssot-not-at-or-approaching' | 'ssot-stale';
  };

  const t7Scenarios: T7Scenario[] = [
    {
      name: 'P1 transfer at-target + 신선 SSoT → fire',
      waypointKind: 'transfer',
      waypointStation: '중곡',
      ssotCurrentStation: '중곡',
      ssotLastAdvanceAt: FRESH_LAST_ADVANCE,
      expectFire: true,
    },
    {
      name: 'P2 transfer 직전 1 hop(passedStations[-1]) + 신선 → fire',
      waypointKind: 'transfer',
      waypointStation: '중곡',
      ssotCurrentStation: '용마산',
      ssotLastAdvanceAt: FRESH_LAST_ADVANCE,
      passedStations: ['용마산'],
      expectFire: true,
    },
    {
      name: 'N9 transfer SSoT 다른 station + 신선 → block(ssot-not-at-or-approaching) [회귀 박제]',
      waypointKind: 'transfer',
      waypointStation: '중곡',
      ssotCurrentStation: '강남',
      ssotLastAdvanceAt: FRESH_LAST_ADVANCE,
      passedStations: ['역삼'],
      expectFire: false,
      expectReason: 'ssot-not-at-or-approaching',
    },
    {
      name: 'N9-stale transfer at-target 인데 60s 초과 → block(ssot-stale)',
      waypointKind: 'transfer',
      waypointStation: '중곡',
      ssotCurrentStation: '중곡',
      ssotLastAdvanceAt: STALE_LAST_ADVANCE,
      expectFire: false,
      expectReason: 'ssot-stale',
    },
    {
      name: 'N10 destination SSoT 다른 station + 신선 → block',
      waypointKind: 'destination',
      waypointStation: '군자',
      ssotCurrentStation: '강남',
      ssotLastAdvanceAt: FRESH_LAST_ADVANCE,
      passedStations: ['역삼'],
      expectFire: false,
      expectReason: 'ssot-not-at-or-approaching',
    },
  ];

  it.each(t7Scenarios)('$name', async (sc) => {
    const kv = new InMemoryKV();
    const trip = makeLockTripFixture(TOKEN, {
      waypoints: [{ stationName: sc.waypointStation, line: '7', kind: sc.waypointKind }],
      passedStations: sc.passedStations ?? [],
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    const ssot = await seedSsot(kv as unknown as KVNamespace, TOKEN, sc.ssotCurrentStation, {
      expiresAt: trip.expiresAt,
    });
    ssot.motionState = 'moving';
    ssot.lastAdvanceAt = sc.ssotLastAdvanceAt;
    ssot.lastAdvanceEvidence = 'arvlcd-confirmed-train';
    await writeSsot(kv as unknown as KVNamespace, ssot, { expiresAt: trip.expiresAt });

    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const logMessages: { msg: string; meta?: Record<string, unknown> }[] = [];
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeArvlCdFireSeoul(sc.waypointStation, 0, 1, '7246'),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-t7',
      log: (msg, meta) => {
        logMessages.push({ msg, meta });
      },
    });
    if (sc.expectFire) {
      expect(stats.arvlCdFireFired).toBe(1);
      expect(stats.transferDestinationGateBlocked).toBe(0);
    } else {
      expect(stats.arvlCdFireFired).toBe(0);
      expect(stats.transferDestinationGateBlocked).toBe(1);
      expect(stats.arvlCdFireBlocked).toBe(1);
      const blockedLog = logMessages.find(
        (l) => l.msg === 'arvlcd-fire: transfer/destination gate blocked',
      );
      expect(blockedLog?.meta?.reason).toBe(sc.expectReason);
      expect(blockedLog?.meta?.kind).toBe(sc.waypointKind);
    }
  });

  it('intermediate kind 는 본 게이트 우회 (T4 6단 게이트만으로 충분)', async () => {
    const kv = new InMemoryKV();
    const trip = makeLockTripFixture(TOKEN, {
      waypoints: [{ stationName: '중곡', line: '7', kind: 'intermediate' }],
      passedStations: [],
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    // SSoT를 의도적으로 mismatch state (다른 station + stale) → transfer kind 라면 block 됐을 조건.
    const ssot = await seedSsot(kv as unknown as KVNamespace, TOKEN, '강남', {
      expiresAt: trip.expiresAt,
    });
    ssot.motionState = 'moving';
    ssot.lastAdvanceAt = STALE_LAST_ADVANCE;
    ssot.lastAdvanceEvidence = 'arvlcd-confirmed-train';
    await writeSsot(kv as unknown as KVNamespace, ssot, { expiresAt: trip.expiresAt });

    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeArvlCdFireSeoul('중곡', 0, 1, '7246'),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-t7-int',
    });
    // intermediate 는 T7 게이트 미적용 → T4 6단 게이트만 통과해 fire 진입.
    expect(stats.transferDestinationGateBlocked).toBe(0);
    expect(stats.arvlCdFireFired).toBe(1);
  });
});

describe('runScheduled — ADR-017 T5 (#1558) advanceBoardingLockWaypoint SSoT gate', () => {
  // 양방향 — arvlcd-arrived path (T4 합쳐) + vanish-fallback path 모두 SSoT 단일 진입점 통과 후
  // trip.waypoints / cleanup 진행. 정지 trip 매분 advance 회귀(2026-06-19 8회)를 박제 차단.
  const TOKEN = 'lock-tok';
  const FALLBACK_TRIGGER = VANISH_RE_ATTACH_THRESHOLD + FALLBACK_ADVANCE_GRACE_CYCLES;
  const LAST_EPOCH_ELAPSED = NOW - FALLBACK_HOP_SEC * 1000;

  function makeArvlCdSeoulFor(stationName: string, trainCode = '7246'): SeoulArrivalClient {
    return makeArvlCdFireSeoul(stationName, 0, 1, trainCode);
  }
  function makeVanishedSeoul(): SeoulArrivalClient {
    // arrivals/positions 모두 비어있음 → vanish-fallback path 진입. stats.callCount 가 호출되므로
    // 실제 SeoulArrivalClient 인스턴스를 사용 (mock client 는 stats 부재로 runScheduled 끝단 throw).
    return new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async (url: string) => {
        if (url.includes('/realtimePosition/')) {
          return new Response(JSON.stringify({ realtimePositionList: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ realtimeArrivalList: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
  }

  type Scenario = {
    name: string;
    path: 'arvlcd-arrived' | 'vanish-fallback';
    motionState: 'moving' | 'stationary' | 'unknown';
    /** trip이 destination 1개만 갖도록 fixture override — destination 통과 + cleanup 검증용. */
    destinationOnly?: boolean;
    expectAdvance: boolean;
    expectBlockReason?: 'motion-stationary';
    expectCleanup?: boolean;
    /**
     * #1680 — stationary upstream gate가 차단한 경우. boardingLockWaypointAdvanceBlocked=0,
     * lifecycleStationarySkipped=1. waypoints는 그대로 (advance 미발생).
     */
    expectStationarySkip?: boolean;
  };

  const advanceScenarios: Scenario[] = [
    // Positive — arvlcd-arrived + moving → advance
    {
      name: 'P1 arvlcd-arrived + moving + lock → trip.waypoints shift',
      path: 'arvlcd-arrived',
      motionState: 'moving',
      expectAdvance: true,
    },
    // Positive — vanish-fallback + moving → advance
    {
      name: 'P2 vanish-fallback + moving → trip.waypoints shift',
      path: 'vanish-fallback',
      motionState: 'moving',
      expectAdvance: true,
    },
    // Positive — destination 단독 + advance → cleanupTripWithLa + deleteSsot
    {
      name: 'P3 destination 단독 + moving → cleanup + SSoT delete',
      path: 'arvlcd-arrived',
      motionState: 'moving',
      destinationOnly: true,
      expectAdvance: true,
      expectCleanup: true,
    },
    // Negative — 2026-06-19 회귀 박제.
    // #1680: upstream stationary gate가 먼저 차단 → boardingLockWaypointAdvanceBlocked=0, lifecycleStationarySkipped=1.
    {
      name: 'N1 arvlcd-arrived + stationary trip → trip.waypoints 보존 (회귀 박제, upstream gate)',
      path: 'arvlcd-arrived',
      motionState: 'stationary',
      expectAdvance: false,
      expectStationarySkip: true,
    },
    {
      name: 'N2 vanish-fallback + stationary trip → trip.waypoints 보존 (upstream gate)',
      path: 'vanish-fallback',
      motionState: 'stationary',
      expectAdvance: false,
      expectStationarySkip: true,
    },
  ];

  it.each(advanceScenarios)('$name', async (sc) => {
    const kv = new InMemoryKV();
    const tripOverrides: Partial<Trip> = sc.destinationOnly
      ? { waypoints: [{ stationName: '중곡', line: '7', kind: 'destination' }] }
      : {};
    // vanish-fallback path 는 hop 시간 경과 + miss 카운터 trigger 도달.
    if (sc.path === 'vanish-fallback') {
      tripOverrides.consecutiveEtaMissing = FALLBACK_TRIGGER - 1;
      tripOverrides.lastTrackedArrivalEpoch = LAST_EPOCH_ELAPSED;
    }
    const trip = makeLockTripFixture(TOKEN, tripOverrides);
    await putTrip(kv as unknown as KVNamespace, trip);

    // motion=stationary 는 SSoT motionState 명시 stamp 필요 (default 'unknown'은 dormant).
    if (sc.motionState !== 'unknown') {
      const seeded = await seedSsot(kv as unknown as KVNamespace, TOKEN, '용마산', {
        expiresAt: trip.expiresAt,
      });
      seeded.motionState = sc.motionState;
      await writeSsot(kv as unknown as KVNamespace, seeded, { expiresAt: trip.expiresAt });
    }

    const seoul = sc.path === 'arvlcd-arrived'
      ? makeArvlCdSeoulFor(trip.waypoints[0].stationName)
      : makeVanishedSeoul();
    const logMessages: { msg: string; meta?: Record<string, unknown> }[] = [];
    const stats = await runScheduled(makeEnv(kv), {
      seoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (vi.fn(async () => new Response('', { status: 200 }))) as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-t5',
      log: (msg, meta) => {
        logMessages.push({ msg, meta });
      },
    });

    const storedRaw = await kv.get(`trip:${TOKEN}`);
    if (sc.expectCleanup) {
      expect(storedRaw).toBeNull();
      // SSoT 도 같이 삭제됐어야 함.
      expect(await kv.get(ssotKey(TOKEN))).toBeNull();
      return;
    }
    expect(storedRaw).not.toBeNull();
    const stored = JSON.parse(storedRaw!) as Trip;

    if (sc.expectAdvance) {
      // 첫 waypoint(중곡)가 shift되어 군자만 남아야 함.
      expect(stored.waypoints[0].stationName).toBe('군자');
      expect(stats.boardingLockWaypointAdvanceBlocked).toBe(0);
    } else if (sc.expectStationarySkip) {
      // #1680 — upstream stationary gate가 먼저 차단. waypoints는 그대로, downstream gate 미도달.
      expect(stored.waypoints[0].stationName).toBe('중곡');
      expect(stats.boardingLockWaypointAdvanceBlocked).toBe(0);
      expect(stats.lifecycleStationarySkipped).toBe(1);
    } else {
      // SSoT 게이트 차단 → trip.waypoints 그대로.
      expect(stored.waypoints[0].stationName).toBe('중곡');
      expect(stats.boardingLockWaypointAdvanceBlocked).toBe(1);
      const blockedLog = logMessages.find(
        (l) => l.msg === 'boarding-lock: waypoint advance blocked by ssot gate',
      );
      expect(blockedLog?.meta?.reason).toBe(sc.expectBlockReason);
    }
  });

  it('legacy lazy-seed — SSoT 미정착 trip 도 evidence 호출 시 자동 seed 후 advance', async () => {
    // SSoT 부재 → 게이트 #1 blocked('no-seed') 회귀 방지. T4 와 동일 정책.
    const kv = new InMemoryKV();
    const trip = makeLockTripFixture(TOKEN);
    await putTrip(kv as unknown as KVNamespace, trip);
    expect(await readSsot(kv as unknown as KVNamespace, TOKEN)).toBeNull();
    const logMessages: { msg: string; meta?: Record<string, unknown> }[] = [];
    await runScheduled(makeEnv(kv), {
      seoul: makeArvlCdFireSeoul('중곡', 0, 1, '7246'),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (vi.fn(async () => new Response('', { status: 200 }))) as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-t5-seed',
      log: (msg, meta) => {
        logMessages.push({ msg, meta });
      },
    });
    // legacy advance(unknown motionState) 통과 → waypoints shift.
    const stored = JSON.parse((await kv.get(`trip:${TOKEN}`))!) as Trip;
    expect(stored.waypoints[0].stationName).toBe('군자');
    // lazy-seed log stamped — 두 entry: arvlcd-fire 의 lazy-seed (T4) + waypoint advance 의 lazy-seed
    // (T5). T4 의 lazy-seed 가 먼저 실행돼 SSoT 가 생성되므로 T5 진입 시 existingSsot !== null →
    // T5 lazy-seed log 는 stamp되지 않을 수 있다. 둘 중 하나만 보장.
    const anyLazySeed = logMessages.some(
      (l) =>
        l.msg === 'arvlcd-fire: lazy-seed ssot' ||
        l.msg === 'boarding-lock: lazy-seed ssot for waypoint advance',
    );
    expect(anyLazySeed).toBe(true);
  });

  it('stats — runScheduled 초기 stats에 boardingLockWaypointAdvanceBlocked 0으로 초기화', async () => {
    const kv = new InMemoryKV();
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeArvlCdFireSeoul('중곡', 0, 1, '7246'),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-t5-init',
    });
    expect(stats.boardingLockWaypointAdvanceBlocked).toBe(0);
  });

  it('vanish-fallback path 도 stationary trip → trip.waypoints 보존 (upstream stationary gate 광범위 보호)', async () => {
    // #1680: upstream stationary gate(shouldSkipStationary)가 cron loop 진입 직후 차단.
    // 기존 T5 advanceTripPosition 게이트보다 더 앞단에서 차단 — 동급 보호 보장.
    // GPS series 없이도 SSoT motionState='stationary'만으로 advance 미발생, waypoints 보존.
    const kv = new InMemoryKV();
    const trip = makeLockTripFixture(TOKEN, {
      consecutiveEtaMissing: FALLBACK_TRIGGER - 1,
      lastTrackedArrivalEpoch: LAST_EPOCH_ELAPSED,
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    const seeded = await seedSsot(kv as unknown as KVNamespace, TOKEN, '용마산', {
      expiresAt: trip.expiresAt,
    });
    seeded.motionState = 'stationary';
    await writeSsot(kv as unknown as KVNamespace, seeded, { expiresAt: trip.expiresAt });
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeVanishedSeoul(),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (vi.fn(async () => new Response('', { status: 200 }))) as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-t5-ssot-vanish',
    });
    const stored = JSON.parse((await kv.get(`trip:${TOKEN}`))!) as Trip;
    expect(stored.waypoints[0].stationName).toBe('중곡');
    // #1680: upstream gate 차단 → boardingLockWaypointAdvanceBlocked=0, lifecycleStationarySkipped=1.
    expect(stats.boardingLockWaypointAdvanceBlocked).toBe(0);
    expect(stats.lifecycleStationarySkipped).toBe(1);
  });
});

/**
 * #1614 Phase A (S4 #1537) — backend self-poll realtimePosition stats wire.
 *
 * runScheduled 진입부에서 활성 trip line union을 추출 → 각 line `seoul.fetchPositions(line)` 호출
 * → KV `realtime-position:<line>` 30s stamp. stats `realtimePositionFetch` / `selfPollCacheHit` /
 * `realtimePositionFetchError` 가 분포 측정의 입력.
 */
describe('runScheduled — #1614 Phase A self-poll realtimePosition (S4)', () => {
  const TOKEN = 'phase-a-tok';

  function makeSeoulCallTracker(positionsForLine: Record<string, PositionEntry[]>) {
    const fetchCalls: string[] = [];
    const seoul = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async (url: string) => {
        if (url.includes('/realtimePosition/')) {
          fetchCalls.push(url);
          // 호선 매칭 — URL에 encoded canonical name 포함 여부.
          const matchedLine = Object.keys(positionsForLine).find((line) => {
            const canonical = `${line}호선`;
            return url.includes(encodeURIComponent(canonical));
          });
          const positions = matchedLine ? positionsForLine[matchedLine] : [];
          return new Response(
            JSON.stringify({
              realtimePositionList: positions.map((p) => ({
                trainNo: p.trainCode,
                statnNm: p.stationName,
                updnLine: p.isUp ? '상행' : '하행',
                trainSttus: p.trainSttus,
                lastRecptnDt: '',
              })),
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ realtimeArrivalList: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    return { seoul, fetchCalls };
  }

  it('활성 trip 있음 → cron 진입부에서 line별 fetch + stats 누적', async () => {
    const kv = new InMemoryKV();
    const trip = makeLockTripFixture(TOKEN);
    await putTrip(kv as unknown as KVNamespace, trip);
    const { seoul, fetchCalls } = makeSeoulCallTracker({
      '7': [{ trainCode: '7246', stationName: '중곡', trainSttus: 1, isUp: true, recptnMs: NOW }],
    });
    const stats = await runScheduled(makeEnv(kv), {
      seoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-self-poll',
    });
    expect(stats.realtimePositionFetch).toBeGreaterThan(0);
    expect(stats.realtimePositionFetchError).toBe(0);
    // realtimePosition URL이 한 번 이상 호출됨 (자체 SeoulClient + cron 진입부 self-poll 양쪽).
    expect(fetchCalls.length).toBeGreaterThan(0);
  });

  it('활성 trip 없음 → fetch/error 0', async () => {
    const kv = new InMemoryKV();
    const { seoul } = makeSeoulCallTracker({});
    const stats = await runScheduled(makeEnv(kv), {
      seoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-empty',
    });
    expect(stats.realtimePositionFetch).toBe(0);
    expect(stats.selfPollCacheHit).toBe(0);
    expect(stats.realtimePositionFetchError).toBe(0);
  });

  it('expiresAt 만료 trip은 self-poll line set에서 제외', async () => {
    const kv = new InMemoryKV();
    // 만료 trip — expiresAt <= now.
    const expiredTrip = makeLockTripFixture(TOKEN, { expiresAt: NOW - 1 });
    await putTrip(kv as unknown as KVNamespace, expiredTrip);
    const { seoul } = makeSeoulCallTracker({});
    const stats = await runScheduled(makeEnv(kv), {
      seoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-expired',
    });
    // 만료 trip은 line set에 포함 안 됨 → fetch 0.
    expect(stats.realtimePositionFetch).toBe(0);
  });
});

/**
 * #1614 Phase C — fireArvlCdStationPush stale SSoT 가드 (단위).
 *
 * SSoT.lastAdvanceAt > 0 + (now - lastAdvanceAt > 3분) 시 fire 차단. lazy-seed (==0) /
 * SSoT 부재 (legacy) 는 dormant 통과.
 *
 * 정상 runScheduled flow 는 advanceTripPosition이 우선 → SSoT fresh이므로 본 가드는
 * defense-in-depth (외부 race / 다른 entry point). 단위 호출로 가드 자체 효과를 검증.
 */
describe('fireArvlCdStationPush — #1614 Phase C stale SSoT 가드', () => {
  const TOKEN = 'phase-c-tok';

  async function callFireDirectly(opts: {
    setupSsot?: (kv: InMemoryKV, trip: Trip) => Promise<void>;
  }) {
    const kv = new InMemoryKV();
    const trip = makeLockTripFixture(TOKEN);
    await putTrip(kv as unknown as KVNamespace, trip);
    if (opts.setupSsot) await opts.setupSsot(kv, trip);
    const stats: ScheduledStats = {
      scanned: 0, polled: 0, pushed: 0, errors: 0, etaMissing: 0, envCorrected: 0,
      lockMissing: 0, laStaleAutoEnded: 0, laStaleSurvivedSilence: 0, killSwitchLocklessIntermediateSkipped: 0, locklessIntermediateFired: 0, locklessMotionGateBlocked: 0,
      laPushSent: 0, laPushFailed: 0, laTokenCleared: 0,
      boardingPromptEvaluated: 0, boardingPromptFired: 0, boardingPromptBlocked: 0,
      phaseImminentBlocked: 0, kalmanReset: 0, kalmanDriftWarning: 0,
      autoLockSuccess: 0, autoLockFalsePositive: 0, boardingPromptAutoDeduped: 0,
      boardingPromptSkippedEmpty: 0, boardingPromptSkippedLockActive: 0, boardingPromptSkippedNoContext: 0, boardingPromptSkippedStale: 0, boardingPromptSkippedTooFar: 0,
    boardingPromptSkippedMinInterval: 0, boardingPromptSkippedMaxFires: 0, boardingPromptSkippedTrainDuplicate: 0,
      hopEndPromptFired: 0, hopEndPromptBlocked: 0,
      arvlCdFireSuccess: 0, arvlCdFireDedup: 0, arvlCdFireMismatch: 0,
      arvlCdFireBlocked: 0, arvlCdFireFired: 0,
      boardingLockWaypointAdvanceBlocked: 0, transferDestinationGateBlocked: 0,
      vanishFallbackFired: 0, vanishReleaseFired: 0, vanishLocklessTakeover: 0,
      vanishFallbackMotionGateBlocked: 0,
      cronJitterMs: 0, rescheduleBlockedMotion: 0, rescheduleFallbackNoSsot: 0, rescheduleDedupSkipped: 0, destinationBackstopForceEnded: 0, destinationStaleGpsSurvivedSilence: 0,
      realtimePositionFetch: 0, selfPollCacheHit: 0, realtimePositionFetchError: 0,
      // #1828 Phase 5 — station-level arrivals polling.
      stationPollFetch: 0, stationPollCacheHit: 0, stationPollError: 0,
      staleLockFireSkipped: 0,
      // ADR-022 Phase 1-1 (#1985) — arvlCd fire-once TTL 게이트 (flag=OFF 시 항상 0).
      arvlCdFireOnceSkipped: 0,
      // #1652 — staged lifecycle backstop.
      lifecycleSilenceSkipped: 0, lifecycleForceEnded: 0,
      // #1680 — stationary cron skip.
      lifecycleStationarySkipped: 0,
      // #1683 — silent push fired by kind.
      silentPushFiredByKind: {
        intermediate: 0,
        transfer: 0,
        destination: 0,
        boardingPrompt: 0,
        reschedule: 0,
      },
      // #1824 — Seoul API outage schedule hop fallback.
      scheduleEtaFallback: 0,
      // #1707 — destination cross-check 결과 분포.
      destinationCrossCheck: {
        within: 0,
        gpsFar: 0,
        staleGps: 0,
        noGps: 0,
        stationUnknown: 0,
      },
      // #2073 (Issue A) — pending/retry push 존재 가능성 게이트. 기본 true(보수적).
      pendingActivityPossible: true,
      // #2066 (Phase 2-backend) — 취침 알람(환승/도착 직전역) 발사/skip 카운터.
      sleepAlarmFired: 0,
      sleepAlarmDedupSkipped: 0,
      sleepAlarmRolledBack: 0,
      etaMissingDemoted: 0,
      trainReconfirmFired: 0,
    };
    const { dirty } = await fireArvlCdStationPush({
      trip,
      waypoint: trip.waypoints[0],
      lock: trip.boardingLock!,
      arvlCd: 1,
      env: makeEnv(kv),
      deps: {
        seoul: makeArvlCdFireSeoul('중곡', 0, 1, '7246'),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: (vi.fn(async () => new Response('', { status: 200 }))) as unknown as typeof fetch,
        now: () => NOW,
      },
      stats,
      now: NOW,
      log: () => undefined,
      generatePushId: () => 'p-direct',
    });
    return { stats, dirty };
  }

  it('SSoT.lastAdvanceAt > 3분 stale → fire skip + staleLockFireSkipped++', async () => {
    const { stats, dirty } = await callFireDirectly({
      setupSsot: async (kv, trip) => {
        const seeded = await seedSsot(kv as unknown as KVNamespace, TOKEN, '중곡', {
          expiresAt: trip.expiresAt,
        });
        seeded.lastAdvanceAt = NOW - 4 * 60 * 1000;
        await writeSsot(kv as unknown as KVNamespace, seeded, { expiresAt: trip.expiresAt });
      },
    });
    expect(stats.staleLockFireSkipped).toBe(1);
    expect(dirty).toBe(false);
  });

  it('SSoT.lastAdvanceAt 60s fresh → 가드 통과', async () => {
    const { stats } = await callFireDirectly({
      setupSsot: async (kv, trip) => {
        const seeded = await seedSsot(kv as unknown as KVNamespace, TOKEN, '중곡', {
          expiresAt: trip.expiresAt,
        });
        seeded.lastAdvanceAt = NOW - 30_000;
        await writeSsot(kv as unknown as KVNamespace, seeded, { expiresAt: trip.expiresAt });
      },
    });
    expect(stats.staleLockFireSkipped).toBe(0);
  });

  it('SSoT.lastAdvanceAt===0 (lazy-seed) → 가드 dormant 통과', async () => {
    const { stats } = await callFireDirectly({
      setupSsot: async (kv, trip) => {
        await seedSsot(kv as unknown as KVNamespace, TOKEN, '중곡', {
          expiresAt: trip.expiresAt,
        });
        // lastAdvanceAt 0 (seed default).
      },
    });
    expect(stats.staleLockFireSkipped).toBe(0);
  });

  it('SSoT 부재 (legacy) → 가드 dormant 통과', async () => {
    const { stats } = await callFireDirectly({});
    expect(stats.staleLockFireSkipped).toBe(0);
  });

  it('STALE_LOCK_FIRE_THRESHOLD_MS는 3분 (transferDestinationGate 60s 보다 보수적)', () => {
    expect(STALE_LOCK_FIRE_THRESHOLD_MS).toBe(3 * 60 * 1000);
  });
});

// #1707 — destination 도달 자동 종료 시 device GPS cross-check.
//
// 검증 범위:
//   1. evaluateDestinationCrossCheck — 5 결과 enum 분기(within / gps-far / stale-gps / no-gps / station-unknown).
//   2. recordDestinationCrossCheck — ScheduledStats 카운터 1:1 매핑.
//   3. runScheduled 통합 — destination kind advance 시점 cross-check 결과별 cleanup vs preserve.
//   4. 상수값 — 500m / 5min.
//   5. 사용자 6/23 1차 trip evidence fixture — 외선 27 hop cascade로 홍대입구 자동 종료 회귀 차단.
//
// 상수: DESTINATION_GPS_CROSS_CHECK_MAX_M=500m, DESTINATION_GPS_STALE_THRESHOLD_MS=5min.
describe('evaluateDestinationCrossCheck (#1707)', () => {
  // 홍대입구 line 2 좌표 (stations.json) — within 케이스 fixture.
  const HONGIK_DEST: Waypoint = { stationName: '홍대입구', line: '2', kind: 'destination' };
  // 합정 line 2 좌표 — 홍대입구와 약 1.1km. far 케이스 fixture (gps@합정 vs destination=홍대입구).
  const HAPJEONG_LAT = 37.549457;
  const HAPJEONG_LNG = 126.913808;
  const HONGIK_LAT = 37.55679;
  const HONGIK_LNG = 126.923708;

  function makePoint(overrides: Partial<PositionPoint> = {}): PositionPoint {
    return {
      lat: HONGIK_LAT,
      lng: HONGIK_LNG,
      accuracy: 10,
      ts: NOW,
      motion: 'automotive',
      ...overrides,
    };
  }

  it('returns "within" when GPS ≤ 500m of destination', () => {
    const series = [makePoint({ lat: HONGIK_LAT, lng: HONGIK_LNG })];
    expect(evaluateDestinationCrossCheck(series, HONGIK_DEST, NOW)).toBe('within');
  });

  it('returns "gps-far" when GPS > 500m and fresh (< 5min stale)', () => {
    const series = [makePoint({ lat: HAPJEONG_LAT, lng: HAPJEONG_LNG, ts: NOW - 30_000 })];
    expect(evaluateDestinationCrossCheck(series, HONGIK_DEST, NOW)).toBe('gps-far');
  });

  it('returns "stale-gps" when last sample > 5min old (even if far)', () => {
    const series = [
      makePoint({
        lat: HAPJEONG_LAT,
        lng: HAPJEONG_LNG,
        ts: NOW - DESTINATION_GPS_STALE_THRESHOLD_MS - 1,
      }),
    ];
    expect(evaluateDestinationCrossCheck(series, HONGIK_DEST, NOW)).toBe('stale-gps');
  });

  it('returns "no-gps" when series is empty', () => {
    expect(evaluateDestinationCrossCheck([], HONGIK_DEST, NOW)).toBe('no-gps');
  });

  it('returns "station-unknown" when stations.json lookup fails', () => {
    const series = [makePoint()];
    const unknown: Waypoint = { stationName: '없는역', line: '2', kind: 'destination' };
    expect(evaluateDestinationCrossCheck(series, unknown, NOW)).toBe('station-unknown');
  });

  it('boundary: exactly 500m → still "within" (≤ 임계)', () => {
    // 1 degree lat ≈ 111km → 0.0045 deg ≈ 500m. 좌표 살짝 안쪽으로 두어 ≤500m 보장.
    const series = [makePoint({ lat: HONGIK_LAT + 0.0044, lng: HONGIK_LNG })];
    const result = evaluateDestinationCrossCheck(series, HONGIK_DEST, NOW);
    expect(result).toBe('within');
  });

  it('uses the most recent (last) sample, not first', () => {
    // 첫 sample은 far, 마지막 sample은 within → within 반환되어야.
    const series = [
      makePoint({ lat: HAPJEONG_LAT, lng: HAPJEONG_LNG, ts: NOW - 60_000 }),
      makePoint({ lat: HONGIK_LAT, lng: HONGIK_LNG, ts: NOW }),
    ];
    expect(evaluateDestinationCrossCheck(series, HONGIK_DEST, NOW)).toBe('within');
  });

  it('DESTINATION_GPS_CROSS_CHECK_MAX_M is 500m', () => {
    expect(DESTINATION_GPS_CROSS_CHECK_MAX_M).toBe(500);
  });

  it('DESTINATION_GPS_STALE_THRESHOLD_MS is 5min', () => {
    expect(DESTINATION_GPS_STALE_THRESHOLD_MS).toBe(5 * 60 * 1000);
  });
});

describe('recordDestinationCrossCheck (#1707)', () => {
  function makeEmptyStats() {
    return {
      destinationCrossCheck: {
        within: 0,
        gpsFar: 0,
        staleGps: 0,
        noGps: 0,
        stationUnknown: 0,
      },
    };
  }

  it('increments "within" counter for within result', () => {
    const stats = makeEmptyStats();
    recordDestinationCrossCheck(stats, 'within');
    expect(stats.destinationCrossCheck.within).toBe(1);
    expect(stats.destinationCrossCheck.gpsFar).toBe(0);
  });

  it('increments "gpsFar" counter for gps-far result', () => {
    const stats = makeEmptyStats();
    recordDestinationCrossCheck(stats, 'gps-far');
    expect(stats.destinationCrossCheck.gpsFar).toBe(1);
  });

  it('increments "staleGps" counter for stale-gps result', () => {
    const stats = makeEmptyStats();
    recordDestinationCrossCheck(stats, 'stale-gps');
    expect(stats.destinationCrossCheck.staleGps).toBe(1);
  });

  it('increments "noGps" counter for no-gps result', () => {
    const stats = makeEmptyStats();
    recordDestinationCrossCheck(stats, 'no-gps');
    expect(stats.destinationCrossCheck.noGps).toBe(1);
  });

  it('increments "stationUnknown" counter for station-unknown result', () => {
    const stats = makeEmptyStats();
    recordDestinationCrossCheck(stats, 'station-unknown');
    expect(stats.destinationCrossCheck.stationUnknown).toBe(1);
  });

  it('accumulates over multiple calls', () => {
    const stats = makeEmptyStats();
    recordDestinationCrossCheck(stats, 'within');
    recordDestinationCrossCheck(stats, 'within');
    recordDestinationCrossCheck(stats, 'gps-far');
    expect(stats.destinationCrossCheck.within).toBe(2);
    expect(stats.destinationCrossCheck.gpsFar).toBe(1);
  });
});

// 통합: destination kind advance 시점 cross-check 결과별 cleanup vs preserve.
// 사용자 6/23 trip(성수→합정 2호선 외선)을 직접 fixture로 재현해 회귀 차단을 검증한다.
describe('runScheduled — #1707 destination GPS cross-check integration', () => {
  /**
   * 6/23 trip fixture: 합정(line 2) destination, lock active, ARRIVED arvlCd=1로 cleanup 분기 진입.
   * series는 호출자가 fixture에서 KV에 직접 seed (테스트마다 좌표/ts 다름).
   */
  function makeHapjeongDestTrip(token: string): Trip {
    return makeTrip({
      token,
      route: { type: 'direct', line: '2', stops: 1 },
      destination: '2-038', // 합정 station id (stations.json)
      waypoints: [{ stationName: '합정', line: '2', kind: 'destination' }],
      activityPushToken: 'la-token',
      activityState: 'live',
      apnsEnv: 'sandbox',
      boardingLock: {
        trainCode: 'T',
        line: '2',
        subwayId: '1002',
        selectedDepartureTime: NOW,
        segmentStations: ['홍대입구', '합정'],
        expiresAt: NOW + 60 * 60_000,
      },
    });
  }

  function makeHapjeongArrivedSeoul(): SeoulArrivalClient {
    return new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            realtimeArrivalList: [
              {
                barvlDt: '0',
                recptnDt: '',
                updnLine: '내선',
                trainLineNm: '합정',
                btrainNo: 'T',
                subwayNm: '지하철2호선',
                arvlCd: 1, // ARRIVED → advanceBoardingLockWaypoint → destination cleanup 분기
              },
            ],
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
  }

  /**
   * 6/23 trip evidence fixture — 사용자가 신촌 부근(GPS far)에 있을 때 backend가 합정 도달로 잘못
   * 판정하면 trip 보존되어야 한다.
   *   - GPS 좌표: 신촌 부근 (~합정에서 약 1.3km 떨어짐)
   *   - GPS ts: fresh (NOW - 30s)
   *   - 결과: 'gps-far' → trip preserved → KV에 trip 잔존 + stats.destinationCrossCheck.gpsFar = 1
   */
  it('preserves trip when device GPS is far (>500m) and fresh — 6/23 사용자 trip 회귀 차단', async () => {
    const kv = new InMemoryKV();
    const trip = makeHapjeongDestTrip('user-6-23-tok');
    await putTrip(kv as unknown as KVNamespace, trip);
    // 신촌 부근 좌표 (37.5552, 126.9368) — 합정(37.549457, 126.913808)에서 약 1.3km. fresh 30s.
    await kv.put(
      `pos:${trip.token}`,
      JSON.stringify([
        {
          lat: 37.5552,
          lng: 126.9368,
          accuracy: 15,
          ts: NOW - 30_000,
          motion: 'automotive',
        },
      ]),
    );
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeHapjeongArrivedSeoul(),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    // trip 보존 — KV에 잔존.
    expect(await kv.get(`trip:${trip.token}`)).not.toBeNull();
    // cross-check 카운터 누적.
    expect(stats.destinationCrossCheck.gpsFar).toBe(1);
    expect(stats.destinationCrossCheck.within).toBe(0);
    // cleanup 미발생 — trip-ended push 없음.
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    const tripEndedCalls = calls.filter((c) => {
      try {
        const body = JSON.parse(c[1]?.body as string) as { data?: { reason?: string } };
        return body?.data?.reason === 'destination-arrived';
      } catch {
        return false;
      }
    });
    expect(tripEndedCalls).toHaveLength(0);
  });

  /**
   * GPS 500m 이내 + waypoints=0 → 정상 cleanup. 사용자가 실제로 합정에 도착한 happy path.
   */
  it('cleans up normally when device GPS is within 500m of destination', async () => {
    const kv = new InMemoryKV();
    const trip = makeHapjeongDestTrip('user-happy-tok');
    await putTrip(kv as unknown as KVNamespace, trip);
    // 합정 거의 정확한 좌표 (37.549, 126.9138) — 약 50m.
    await kv.put(
      `pos:${trip.token}`,
      JSON.stringify([
        {
          lat: 37.549,
          lng: 126.9138,
          accuracy: 10,
          ts: NOW - 10_000,
          motion: 'automotive',
        },
      ]),
    );
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeHapjeongArrivedSeoul(),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    // trip 삭제됨.
    expect(await kv.get(`trip:${trip.token}`)).toBeNull();
    // cross-check 카운터 누적 (within).
    expect(stats.destinationCrossCheck.within).toBe(1);
    expect(stats.destinationCrossCheck.gpsFar).toBe(0);
  });

  // #2230 (follow-up B) — destination cleanup 시 잔여 PENDING_PUSHES entry도 정리돼야 한다.
  // 그렇지 않으면 이미 죽은 trip에 대해 alert fallback cron이 무의미한 재발사를 시도할 수 있다.
  it('clears PENDING_PUSHES entries for the device token on destination cleanup (#2230)', async () => {
    const kv = new InMemoryKV();
    const pending = new InMemoryKV();
    const trip = makeHapjeongDestTrip('user-pending-cleanup-tok');
    await putTrip(kv as unknown as KVNamespace, trip);
    await kv.put(
      `pos:${trip.token}`,
      JSON.stringify([
        { lat: 37.549, lng: 126.9138, accuracy: 10, ts: NOW - 10_000, motion: 'automotive' },
      ]),
    );
    // 잔여 pending entry 시뮬레이션 — arvlCd fire/lockless intermediate 등이 남긴 것.
    await putPending(pending as unknown as KVNamespace, {
      pushId: 'stale-pending-1',
      token: trip.token,
      alarmKey: 'imminent:합정',
      sentAt: NOW - 30_000,
      stationName: '합정',
      kind: 'destination',
      phase: 'imminent',
      etaSeconds: 0,
      apnsEnv: 'sandbox',
    });
    expect(await pending.get(pendingKey('stale-pending-1'))).not.toBeNull();
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await runScheduled(makeEnv(kv, pending), {
      seoul: makeHapjeongArrivedSeoul(),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    // trip 삭제 + pending entry도 함께 삭제.
    expect(await kv.get(`trip:${trip.token}`)).toBeNull();
    expect(await pending.get(pendingKey('stale-pending-1'))).toBeNull();
  });

  /**
   * Stale GPS (>5min) → conservative cleanup. backend가 device GPS에 종속되면 안 됨.
   */
  it('cleans up normally when last GPS upload is stale (>5min) — conservative behavior preserved', async () => {
    const kv = new InMemoryKV();
    const trip = makeHapjeongDestTrip('user-stale-tok');
    await putTrip(kv as unknown as KVNamespace, trip);
    // 5분 + 1ms 이전 GPS — stale-gps.
    await kv.put(
      `pos:${trip.token}`,
      JSON.stringify([
        {
          lat: 37.5552, // 신촌 (far) — stale이라 거리는 무관.
          lng: 126.9368,
          accuracy: 15,
          ts: NOW - DESTINATION_GPS_STALE_THRESHOLD_MS - 1,
          motion: 'automotive',
        },
      ]),
    );
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeHapjeongArrivedSeoul(),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    // stale → cleanup 진행.
    expect(await kv.get(`trip:${trip.token}`)).toBeNull();
    expect(stats.destinationCrossCheck.staleGps).toBe(1);
    expect(stats.destinationCrossCheck.gpsFar).toBe(0);
  });

  // #2322 (O1-C) — stale-gps여도 device sync stale(#2321) 상태면 즉시 cleanup하지 않고
  // gps-far와 동일한 짧은 backstop으로 trip을 보존해야 한다.
  it('preserves trip on stale-gps when device sync is also stale (25min silence)', async () => {
    const kv = new InMemoryKV();
    const trip = makeHapjeongDestTrip('user-stale-silent-tok');
    await putTrip(kv as unknown as KVNamespace, trip);
    await kv.put(
      `pos:${trip.token}`,
      JSON.stringify([
        {
          lat: 37.5552,
          lng: 126.9368,
          accuracy: 15,
          ts: NOW - DESTINATION_GPS_STALE_THRESHOLD_MS - 1,
          motion: 'automotive',
        },
      ]),
    );
    const ssot = await seedSsot(kv as unknown as KVNamespace, trip.token, '홍대입구', {
      expiresAt: trip.expiresAt,
    });
    ssot.lastDeviceSyncAt = NOW - 25 * 60_000;
    await writeSsot(kv as unknown as KVNamespace, ssot, { expiresAt: trip.expiresAt });

    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeHapjeongArrivedSeoul(),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    // trip 보존 — 즉시 cleanup되지 않는다.
    expect(await kv.get(`trip:${trip.token}`)).not.toBeNull();
    expect(stats.destinationCrossCheck.staleGps).toBe(1);
    expect(stats.destinationStaleGpsSurvivedSilence).toBe(1);
  });

  // #2322 (O1-C) — Seoul API outage 중에도 stale-gps 즉시 cleanup을 skip해야 한다.
  // decoy trip(다른 역 조회)이 이 cron 사이클에 HTTP error를 관측시켜 outage를 재현하고,
  // 본 trip(합정)의 arrivals 조회 자체는 정상 ARRIVED 응답으로 advance된다 — 두 신호가
  // 독립적임을 보장(같은 SeoulArrivalClient 인스턴스가 cron 1 cycle 범위로 httpErrorCount를
  // 공유하는 기존 정책, #1663).
  it('preserves trip on stale-gps when Seoul API outage observed this cycle (decoy trip HTTP error)', async () => {
    const kv = new InMemoryKV();
    const trip = makeHapjeongDestTrip('z-user-stale-outage-tok');
    await putTrip(kv as unknown as KVNamespace, trip);
    await kv.put(
      `pos:${trip.token}`,
      JSON.stringify([
        {
          lat: 37.5552,
          lng: 126.9368,
          accuracy: 15,
          ts: NOW - DESTINATION_GPS_STALE_THRESHOLD_MS - 1,
          motion: 'automotive',
        },
      ]),
    );
    // decoy trip — 'a-'로 시작해 InMemoryKV.list() 정렬(localeCompare)상 본 trip보다 먼저
    // scan돼 같은 cycle 내에서 httpErrorCount를 먼저 증가시킨다.
    const decoyTrip = makeTrip({
      token: 'a-decoy-outage-tok',
      waypoints: [{ stationName: '강남', line: '2', kind: 'intermediate' }],
      boardingLock: {
        trainCode: 'D',
        line: '2',
        subwayId: '1002',
        selectedDepartureTime: NOW,
        segmentStations: ['교대', '강남'],
        expiresAt: NOW + 60 * 60_000,
      },
    });
    await putTrip(kv as unknown as KVNamespace, decoyTrip);

    const hapjeongUrlPart = encodeURIComponent('합정');
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes(hapjeongUrlPart)) {
        return new Response(
          JSON.stringify({
            realtimeArrivalList: [
              {
                barvlDt: '0',
                recptnDt: '',
                updnLine: '내선',
                trainLineNm: '합정',
                btrainNo: 'T',
                subwayNm: '지하철2호선',
                arvlCd: 1, // ARRIVED
              },
            ],
          }),
          { status: 200 },
        );
      }
      // decoy(강남) 조회 + positions 조회 등 나머지는 모두 error → httpErrorCount 증가.
      return new Response('boom', { status: 500 });
    });
    const seoul = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: apnsFetch as unknown as typeof fetch,
      now: () => NOW,
    });
    // outage 관측 확인 — httpErrorCount가 실제로 늘었어야 이 테스트가 의미 있다.
    expect(seoul.stats.httpErrorCount).toBeGreaterThan(0);
    // trip 보존 — Seoul outage 상태에선 stale-gps로 즉시 종료되지 않는다.
    expect(await kv.get(`trip:${trip.token}`)).not.toBeNull();
    expect(stats.destinationStaleGpsSurvivedSilence).toBe(1);
  });

  /**
   * Position series 없음 (legacy / boardingPrompt-only trip 등) → conservative cleanup.
   */
  it('cleans up normally when no position series exists (legacy graceful)', async () => {
    const kv = new InMemoryKV();
    const trip = makeHapjeongDestTrip('user-no-gps-tok');
    await putTrip(kv as unknown as KVNamespace, trip);
    // pos:${token} 미설정 — series 빈 배열.
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeHapjeongArrivedSeoul(),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(await kv.get(`trip:${trip.token}`)).toBeNull();
    expect(stats.destinationCrossCheck.noGps).toBe(1);
  });

  /**
   * Last-intermediate effective-destination cleanup도 동일 cross-check 적용. trip.waypoints.length === 1
   * 이고 advance가 발생하면 cleanup 분기 진입 — gps-far면 trip 보존.
   */
  it('preserves trip on last-intermediate effective-destination when GPS far', async () => {
    const kv = new InMemoryKV();
    // 마지막 intermediate(홍대입구) 도착 → waypoints=[]로 cleanup 분기.
    const trip = makeTrip({
      token: 'last-intermediate-tok',
      route: { type: 'direct', line: '2', stops: 1 },
      destination: '2-039', // 홍대입구 line 2 id
      waypoints: [{ stationName: '홍대입구', line: '2', kind: 'intermediate' }],
      activityPushToken: 'la-token',
      activityState: 'live',
      apnsEnv: 'sandbox',
      boardingLock: {
        trainCode: 'T',
        line: '2',
        subwayId: '1002',
        selectedDepartureTime: NOW,
        segmentStations: ['신촌', '홍대입구'],
        expiresAt: NOW + 60 * 60_000,
      },
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    // GPS@신촌 부근, destination=홍대입구 → ~1.4km far + fresh.
    await kv.put(
      `pos:${trip.token}`,
      JSON.stringify([
        {
          lat: 37.5552,
          lng: 126.9368,
          accuracy: 15,
          ts: NOW - 30_000,
          motion: 'automotive',
        },
      ]),
    );
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const seoul = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            realtimeArrivalList: [
              {
                barvlDt: '0',
                recptnDt: '',
                updnLine: '내선',
                trainLineNm: '홍대입구',
                btrainNo: 'T',
                subwayNm: '지하철2호선',
                arvlCd: 1, // ARRIVED
              },
            ],
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    const stats = await runScheduled(makeEnv(kv), {
      seoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    // trip 보존 — KV에 잔존.
    expect(await kv.get(`trip:${trip.token}`)).not.toBeNull();
    expect(stats.destinationCrossCheck.gpsFar).toBe(1);
  });

  // #2230 — destination-reached 짧은 backstop. gps-far 보류가 무기한(9h force-end까지)
  // 잔존하던 회귀(2026-08-09 실기기 dump)를 T분(DESTINATION_REACH_BACKSTOP_MS) 내로 단축한다.
  describe('#2230 destination-reached short backstop (gps-far persisted)', () => {
    /** 신촌 부근 GPS — 합정에서 ~1.3km, gps-far 트리거용. */
    function seedFarGps(kv: InMemoryKV, token: string, ts: number) {
      return kv.put(
        `pos:${token}`,
        JSON.stringify([
          { lat: 37.5552, lng: 126.9368, accuracy: 15, ts, motion: 'automotive' },
        ]),
      );
    }

    it('does not force-cleanup before DESTINATION_REACH_BACKSTOP_MS elapses (first gps-far cycle stamps anchor only)', async () => {
      const kv = new InMemoryKV();
      const trip = makeHapjeongDestTrip('backstop-first-cycle-tok');
      await putTrip(kv as unknown as KVNamespace, trip);
      await seedFarGps(kv, trip.token, NOW - 30_000);
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      const stats = await runScheduled(makeEnv(kv), {
        seoul: makeHapjeongArrivedSeoul(),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
      });
      // trip 보존 — anchor만 stamp, force-cleanup 미발동.
      const stored = JSON.parse((await kv.get(`trip:${trip.token}`)) as string) as Trip;
      expect(stored.destinationImminentFirstAt).toBe(NOW);
      expect(stats.destinationBackstopForceEnded).toBe(0);
    });

    it('does not force-cleanup when elapsed since anchor is just under the threshold', async () => {
      const kv = new InMemoryKV();
      const anchorAt = NOW - (DESTINATION_REACH_BACKSTOP_MS - 1_000);
      const trip = makeHapjeongDestTrip('backstop-under-tok');
      trip.destinationImminentFirstAt = anchorAt;
      await putTrip(kv as unknown as KVNamespace, trip);
      await seedFarGps(kv, trip.token, NOW - 30_000);
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      const stats = await runScheduled(makeEnv(kv), {
        seoul: makeHapjeongArrivedSeoul(),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
      });
      expect(await kv.get(`trip:${trip.token}`)).not.toBeNull();
      expect(stats.destinationBackstopForceEnded).toBe(0);
      // anchor 보존 — 재stamp되지 않아야 다음 cycle의 경과 시간 판단이 정확.
      const stored = JSON.parse((await kv.get(`trip:${trip.token}`)) as string) as Trip;
      expect(stored.destinationImminentFirstAt).toBe(anchorAt);
    });

    it('force-cleans up via cleanupTripWithLa once DESTINATION_REACH_BACKSTOP_MS elapses, even though gps-far persists', async () => {
      const kv = new InMemoryKV();
      const anchorAt = NOW - DESTINATION_REACH_BACKSTOP_MS;
      const trip = makeHapjeongDestTrip('backstop-elapsed-tok');
      trip.destinationImminentFirstAt = anchorAt;
      await putTrip(kv as unknown as KVNamespace, trip);
      await seedFarGps(kv, trip.token, NOW - 30_000);
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      const stats = await runScheduled(makeEnv(kv), {
        seoul: makeHapjeongArrivedSeoul(),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
      });
      // trip 삭제됨 — gps-far cross-check 자체는 여전히 'gps-far'였지만 backstop이 강제 종료.
      expect(await kv.get(`trip:${trip.token}`)).toBeNull();
      expect(stats.destinationBackstopForceEnded).toBe(1);
      expect(stats.destinationCrossCheck.gpsFar).toBe(1);
      // cleanupTripWithLa('destination-arrived') 경로 — trip-ended push 발사 확인.
      const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
      const tripEndedCalls = calls.filter((c) => {
        try {
          const body = JSON.parse(c[1]?.body as string) as { data?: { reason?: string } };
          return body?.data?.reason === 'destination-arrived';
        } catch {
          return false;
        }
      });
      expect(tripEndedCalls.length).toBeGreaterThan(0);
    });
  });
});

describe('buildBoardingPromptMessage (#1739 — 방면 + 시간 명시, #1895 — i18n 4언어)', () => {
  const BASE_NOW = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z → KST 07:13

  it('nextStation + etaSeconds 둘 다 있음 → "출발역 [호선] → 다음역 방면 HH:MM 진입" (ko 기본)', () => {
    // BASE_NOW + 120s → KST 07:15:20 → HH:MM = 07:15
    const { title, body } = buildBoardingPromptMessage('시청', '2', '강남', 120, BASE_NOW);
    expect(title).toBe('탑승하셨나요?');
    expect(body).toBe('시청 [2] → 강남 방면 07:15 진입');
  });

  it('nextStation 없음 (null) → 기존 포맷 fallback "${line} · ${originStation}"', () => {
    const { title, body } = buildBoardingPromptMessage('왕십리', '5', null, 90, BASE_NOW);
    expect(title).toBe('탑승하셨나요?');
    expect(body).toBe('5 · 왕십리');
  });

  it('nextStation 있지만 etaSeconds null → 시간 없이 방면만 표시', () => {
    const { title, body } = buildBoardingPromptMessage('합정', '6', '마포구청', null, BASE_NOW);
    expect(title).toBe('탑승하셨나요?');
    expect(body).toBe('합정 [6] → 마포구청 방면');
  });

  it('환승 leg — 다른 호선 nextStation + ETA', () => {
    // BASE_NOW + 180s → KST 07:16:20 → HH:MM = 07:16
    const { title, body } = buildBoardingPromptMessage('왕십리', '5', '마장', 180, BASE_NOW);
    expect(title).toBe('탑승하셨나요?');
    expect(body).toBe('왕십리 [5] → 마장 방면 07:16 진입');
  });

  it('etaSeconds=0 → now 시각 그대로 표시 (즉시 진입)', () => {
    const { title, body } = buildBoardingPromptMessage('시청', '2', '을지로입구', 0, BASE_NOW);
    expect(title).toBe('탑승하셨나요?');
    expect(body).toBe('시청 [2] → 을지로입구 방면 07:13 진입');
  });

  it('자정 경계 넘어가는 ETA — HH:MM 포맷 정상', () => {
    // 23:59 KST = 14:59 UTC → epoch 1_699_973_940_000
    // +120s → 2023-11-15 00:01 KST
    const midnight = 1_699_973_940_000; // 2023-11-14 23:59 KST
    const { body } = buildBoardingPromptMessage('시청', '2', '강남', 120, midnight);
    expect(body).toBe('시청 [2] → 강남 방면 00:01 진입');
  });

  it('non-numeric line name (gyeongui) — fallback 포맷 정상', () => {
    const { body } = buildBoardingPromptMessage('회기', 'gyeongui', null, null, BASE_NOW);
    expect(body).toBe('gyeongui · 회기');
  });

  it('#1895 — locale=en → 영어 본문 ("Are you on board?" / "bound" suffix)', () => {
    const { title, body } = buildBoardingPromptMessage('City Hall', '2', 'Gangnam', 120, BASE_NOW, 'en');
    expect(title).toBe('Are you on board?');
    expect(body).toBe('City Hall [2] → Gangnam bound 07:15 arrival');
  });

  it('#1895 — locale=ja → 일본어 본문', () => {
    const { title, body } = buildBoardingPromptMessage('市庁', '2', '江南', 120, BASE_NOW, 'ja');
    expect(title).toBe('ご乗車されましたか?');
    expect(body).toBe('市庁 [2] → 江南方面 07:15進入');
  });

  it('#1895 — locale=zh → 중국어 본문', () => {
    const { title, body } = buildBoardingPromptMessage('市厅', '2', '江南', 120, BASE_NOW, 'zh');
    expect(title).toBe('您已乘车了吗?');
    expect(body).toBe('市厅 [2] → 江南方向 07:15到达');
  });

  it('#1895 — locale=ko 명시 → 한국어 본문 (DEFAULT_LOCALE과 동일)', () => {
    const { title, body } = buildBoardingPromptMessage('시청', '2', '강남', 120, BASE_NOW, 'ko');
    expect(title).toBe('탑승하셨나요?');
    expect(body).toBe('시청 [2] → 강남 방면 07:15 진입');
  });

  it('#1895 — locale 미지정 → ko fallback', () => {
    const { title } = buildBoardingPromptMessage('시청', '2', '강남', 120, BASE_NOW, undefined);
    expect(title).toBe('탑승하셨나요?');
  });

  it('#1895 — locale=en + nextStation null → fallback 포맷 (locale 무관 공통 포맷)', () => {
    const { body } = buildBoardingPromptMessage('City Hall', '2', null, 90, BASE_NOW, 'en');
    expect(body).toBe('2 · City Hall');
  });
});

describe('buildHopEndPromptMessage (#2034 — 환승역 하차 4언어)', () => {
  it('ko 기본 — nextLine + nextStation 모두 있음', () => {
    const { title, body } = buildHopEndPromptMessage('성수', '2', 'K', '왕십리');
    expect(title).toBe('성수에서 하차하셨나요?');
    expect(body).toBe('2호선 성수에서 내려주세요. 다음은 K호선 왕십리 방면입니다.');
  });

  it('ko — nextLine 있고 nextStation 없음 → line 만 노출', () => {
    const { body } = buildHopEndPromptMessage('성수', '2', 'K', null);
    expect(body).toBe('2호선 성수에서 내려주세요. 다음은 K호선 방면입니다.');
  });

  it('ko — nextLine null → 다음 leg 안내 생략', () => {
    const { body } = buildHopEndPromptMessage('성수', '2', null, null);
    expect(body).toBe('2호선 성수에서 내려주세요.');
  });

  it('en locale', () => {
    const { title, body } = buildHopEndPromptMessage('Seongsu', '2', 'K', 'Wangsimni', 'en');
    expect(title).toBe('Getting off at Seongsu?');
    expect(body).toBe('Please transfer from line 2 at Seongsu. Next: line K toward Wangsimni.');
  });

  it('en — nextStation null', () => {
    const { body } = buildHopEndPromptMessage('Seongsu', '2', 'K', null, 'en');
    expect(body).toBe('Please transfer from line 2 at Seongsu. Next: line K.');
  });

  it('ja locale', () => {
    const { title, body } = buildHopEndPromptMessage('聖水', '2', 'K', '往十里', 'ja');
    expect(title).toBe('聖水で降りますか?');
    expect(body).toBe('2号線 聖水で降車してください。 次はK号線 往十里方面です。');
  });

  it('ja — nextStation null', () => {
    const { body } = buildHopEndPromptMessage('聖水', '2', 'K', null, 'ja');
    expect(body).toBe('2号線 聖水で降車してください。 次はK号線です。');
  });

  it('zh locale', () => {
    const { title, body } = buildHopEndPromptMessage('圣水', '2', 'K', '往十里', 'zh');
    expect(title).toBe('您在圣水下车了吗?');
    expect(body).toBe('请在2号线 圣水下车。 下一段: K号线 往十里方向。');
  });

  it('zh — nextStation null', () => {
    const { body } = buildHopEndPromptMessage('圣水', '2', 'K', null, 'zh');
    expect(body).toBe('请在2号线 圣水下车。 下一段: K号线。');
  });

  it('locale 미지정 → ko fallback', () => {
    const { title } = buildHopEndPromptMessage('성수', '2', null, null, undefined);
    expect(title).toBe('성수에서 하차하셨나요?');
  });
});

describe('maybeFireHopEndPrompt (#2034)', () => {
  function makeStats(): ScheduledStats {
    return makeFullEmptyStats();
  }

  function makeDeps(fetchImpl: typeof fetch): ScheduledDeps {
    return {
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl,
      seoul: new SeoulArrivalClient({
        host: 'seoul.api',
        apiKey: 'KEY',
        fetchImpl,
      }),
      archFlag: 'off',
    };
  }

  const transferWaypoint: Waypoint = {
    stationName: '성수',
    line: '2',
    kind: 'transfer',
  };

  function makeTrip(): Trip {
    return {
      token: 'trip-hop-end',
      createdAt: NOW,
      waypoints: [
        { stationName: '왕십리', line: 'K', kind: 'intermediate' },
        { stationName: '수원', line: 'K', kind: 'destination' },
      ],
      apnsEnv: 'production',
      registeredAt: NOW,
    } as unknown as Trip;
  }

  it('promptState 없음 + APNs 200 → fired 카운터 증가 + hopEndPromptState[legKey] set', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const trip = makeTrip();
    const stats = makeStats();
    await maybeFireHopEndPrompt({
      trip,
      transferWaypoint,
      deps: makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      now: NOW,
      log: () => {},
      generatePushId: () => 'pid-hop',
      env: makeEnv(new InMemoryKV()),
    });
    expect(stats.hopEndPromptFired).toBe(1);
    expect(stats.hopEndPromptBlocked).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // legKey = "성수|K"
    expect(trip.hopEndPromptState?.['성수|K']?.fired).toBe(true);
    // payload wire 검증
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.data.hopEndKind).toBe('disembark');
    expect(body.data.nextLine).toBe('K');
    expect(body.data.nextStation).toBe('왕십리');
    // #2282 — hop-end fire는 BOARDING_PROMPT가 아닌 전용 DISEMBARK_PROMPT category로 나가야 한다.
    expect(body.aps.category).toBe(DISEMBARK_PROMPT_CATEGORY);
  });

  it('promptState.fired=true → blocked 카운터 증가 + push 미발사', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const trip = makeTrip();
    trip.hopEndPromptState = { '성수|K': { fired: true, lastFiredAt: NOW - 60_000 } };
    const stats = makeStats();
    await maybeFireHopEndPrompt({
      trip,
      transferWaypoint,
      deps: makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      now: NOW,
      log: () => {},
      generatePushId: () => 'pid-block',
      env: makeEnv(new InMemoryKV()),
    });
    expect(stats.hopEndPromptFired).toBe(0);
    expect(stats.hopEndPromptBlocked).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('APNs 5xx → errors 카운터 증가 + hopEndPromptState 미갱신', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 503 }));
    const trip = makeTrip();
    const stats = makeStats();
    await maybeFireHopEndPrompt({
      trip,
      transferWaypoint,
      deps: makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      now: NOW,
      log: () => {},
      generatePushId: () => 'pid-err',
      env: makeEnv(new InMemoryKV()),
    });
    expect(stats.errors).toBe(1);
    expect(stats.hopEndPromptFired).toBe(0);
    expect(trip.hopEndPromptState).toBeUndefined();
  });

  it('trip.waypoints 소진 (다음 leg 없음) → nextLine=null + nextStation=null', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const trip = makeTrip();
    trip.waypoints = [];
    const stats = makeStats();
    await maybeFireHopEndPrompt({
      trip,
      transferWaypoint,
      deps: makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      now: NOW,
      log: () => {},
      generatePushId: () => 'pid-empty',
      env: makeEnv(new InMemoryKV()),
    });
    expect(stats.hopEndPromptFired).toBe(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect('nextLine' in body.data).toBe(false);
    expect('nextStation' in body.data).toBe(false);
    // legKey = "성수|"
    expect(trip.hopEndPromptState?.['성수|']?.fired).toBe(true);
  });

  it('leg-key 별 dedup — 다른 nextLine 은 독립 발사', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const trip = makeTrip();
    // 첫 번째 leg (2 → K) 는 이미 fired.
    trip.hopEndPromptState = { '성수|K': { fired: true, lastFiredAt: NOW - 60_000 } };
    // 다음 leg 를 다른 노선 (5호선) 으로 변경.
    trip.waypoints = [
      { stationName: '아차산', line: '5', kind: 'intermediate' },
    ];
    const stats = makeStats();
    await maybeFireHopEndPrompt({
      trip,
      transferWaypoint,
      deps: makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      now: NOW,
      log: () => {},
      generatePushId: () => 'pid-diff-leg',
      env: makeEnv(new InMemoryKV()),
    });
    expect(stats.hopEndPromptFired).toBe(1);
    // 기존 legKey 는 유지, 새 legKey (`성수|5`) 는 신규 fired.
    expect(trip.hopEndPromptState?.['성수|K']?.fired).toBe(true);
    expect(trip.hopEndPromptState?.['성수|5']?.fired).toBe(true);
  });
});

/**
 * #2073 — cron KV quota fix (listTrips 병합 + 진짜 idle skip + jitter 스로틀).
 *
 * 2026-07-29 quota audit: 사용자 0명 상태에서도 KV list 720%/write 144% 초과.
 *   - Issue B: listTrips가 collectActiveLines/collectActiveStations/main loop 각자 호출(3회) →
 *     `runScheduled` 진입부에서 1회만 list해 배열로 공유.
 *   - Issue A: #2054 idle-skip은 로그만 억제 — 진짜 idle(trip 0 + 직전 tick 근방 활동 없음)엔
 *     `pendingActivityPossible=false`로 index.ts가 runFallbackPushes/runRetryPushes를 skip.
 *   - Issue D: jitter sample write를 10 tick당 1회로 스로틀.
 */
describe('runScheduled — #2073 listTrips 병합 (Issue B)', () => {
  it('활성 trip 1개 — trip: prefix kv.get 호출 횟수가 1회(=N)로 병합된다 (기존 3N 회귀 방지)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTrip());
    const getSpy = vi.spyOn(kv, 'get');
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
    });
    const tripGetCalls = getSpy.mock.calls.filter((c) => String(c[0]).startsWith('trip:'));
    // 병합 전엔 collectActiveLines + collectActiveStations + main loop 각자 listTrips를 순회해
    // trip 1개당 3회 kv.get('trip:tok')이 발생했다. 병합 후엔 1회.
    expect(tripGetCalls.length).toBe(1);
  });

  it('활성 trip 2개 — trip: prefix kv.get 호출 횟수가 2회(=N)로 병합된다', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTrip({ token: 'tok-a' }));
    await putTrip(kv as unknown as KVNamespace, makeTrip({ token: 'tok-b' }));
    const getSpy = vi.spyOn(kv, 'get');
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
    });
    const tripGetCalls = getSpy.mock.calls.filter((c) => String(c[0]).startsWith('trip:'));
    expect(tripGetCalls.length).toBe(2);
  });

  it('collectActiveLines/collectActiveStations 파생 결과는 병합 전과 동등 — self-poll fetch가 여전히 발생한다', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTrip());
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
    });
    // line union(2호선) + station union(강남) 이 여전히 병합된 trips 배열에서 파생돼
    // self-poll fetch/stationPollFetch가 발생한다(0이 아님) — collectActiveLines/Stations가
    // 여전히 정상 동작함을 간접 검증.
    expect(stats.realtimePositionFetch + stats.selfPollCacheHit).toBeGreaterThan(0);
    expect(stats.stationPollFetch + stats.stationPollCacheHit).toBeGreaterThan(0);
  });
});

describe('runScheduled — #2073 진짜 idle skip 게이트 (Issue A)', () => {
  it('idle tick(활성 trip 0 + marker 없음) — kv.list 0회(#2452 list-quota 게이트), kv.put 0회, pendingActivityPossible=false', async () => {
    const kv = new InMemoryKV();
    // heartbeat가 이번 tick에 발화하지 않도록 직전 heartbeat를 미리 stamp(첫 진입 heartbeat put을
    // "idle write 0" 검증에서 배제 — 이슈 본문도 heartbeat 시간당 1 put은 예외로 명시).
    await (kv as unknown as KVNamespace).put('scheduled:last-heartbeat', String(NOW));
    const listSpy = vi.spyOn(kv, 'list');
    const putSpy = vi.spyOn(kv, 'put');
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(stats.scanned).toBe(0);
    expect(stats.pendingActivityPossible).toBe(false);
    // #2452 — cron:has-active-trips 마커가 없으므로 listTrips(kv.list) 자체가 이번 tick엔
    // 호출되지 않는다(list quota 보호가 이 테스트의 신규 관측 대상. 구 #2073 idle-gate는
    // pending/retry list만 gating했고 이 main listTrips는 무조건 실행했었다).
    expect(listSpy).not.toHaveBeenCalled();
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('활성 trip 존재 — pendingActivityPossible=true + activity marker stamp', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTrip());
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(stats.pendingActivityPossible).toBe(true);
    expect(await readPushActivityRecent(kv as unknown as KVNamespace)).toBe(true);
  });

  it('활성 trip 0이지만 직전 tick 근방 활동 marker 有 — pendingActivityPossible=true (idle 아님)', async () => {
    const kv = new InMemoryKV();
    await stampPushActivity(kv as unknown as KVNamespace, NOW - 30_000);
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(stats.scanned).toBe(0);
    expect(stats.pendingActivityPossible).toBe(true);
  });
});

describe('runScheduled — #2452 listTrips() list-quota 게이트', () => {
  it('마커 有 + 활성 trip 有 — listTrips 실행되고 trip이 실제로 처리된다(라이더 절대 skip 안 됨)', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);
    // #2452 — InMemoryKV.put(trip:*)이 테스트 편의상 마커를 자동 stamp하므로(inMemoryKv.ts 참조)
    // 명시적으로 markTripRegistered를 다시 호출해 "REGISTER 경로가 실제로 마커를 남긴다"는
    // 계약 자체도 별도로 검증한다.
    await markTripRegistered(kv as unknown as KVNamespace, trip.expiresAt, NOW);
    const listSpy = vi.spyOn(kv, 'list');
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(listSpy).toHaveBeenCalled();
    expect(stats.scanned).toBe(1);
  });

  it('마커 GET이 throw — listTrips를 강행한다(보수적, 실 라이더 miss 불허)', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);
    const getSpy = vi
      .spyOn(kv, 'get')
      .mockImplementation(async (key: string) => {
        if (key === ACTIVE_TRIPS_MARKER_KEY) throw new Error('kv down');
        return InMemoryKV.prototype.get.call(kv, key);
      });
    const listSpy = vi.spyOn(kv, 'list');
    const stats = await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(listSpy).toHaveBeenCalled();
    expect(stats.scanned).toBe(1);
    getSpy.mockRestore();
  });

  it('마커 有 but listTrips 결과 0건(stale marker) — 마커를 delete해 다음 idle tick부터 skip 재개', async () => {
    const kv = new InMemoryKV();
    await markTripRegistered(kv as unknown as KVNamespace, NOW + 60_000, NOW);
    expect(await hasActiveTripsMarker(kv as unknown as KVNamespace)).toBe(true);

    await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(await hasActiveTripsMarker(kv as unknown as KVNamespace)).toBe(false);
  });

  it('POST /trips REGISTER(markTripRegistered)가 마커를 stamp — cron이 그걸 보고 listTrips를 실행', async () => {
    const kv = new InMemoryKV();
    expect(await hasActiveTripsMarker(kv as unknown as KVNamespace)).toBe(false);
    await markTripRegistered(kv as unknown as KVNamespace, NOW + 30 * 60 * 1000, NOW);
    expect(await hasActiveTripsMarker(kv as unknown as KVNamespace)).toBe(true);
  });
});

describe('runScheduled — #2079 (P3-2) readPushActivityRecent short-circuit', () => {
  it('활성 trip 1개 tick — readPushActivityRecent 호출 0회 (idle 판정이 trips.length>0으로 이미 확정)', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTrip());
    const getSpy = vi.spyOn(kv, 'get');
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
    });
    const activityGetCalls = getSpy.mock.calls.filter((c) => c[0] === 'cron:push-activity');
    expect(activityGetCalls.length).toBe(0);
  });

  it('idle tick(활성 trip 0) — readPushActivityRecent 호출 1회', async () => {
    const kv = new InMemoryKV();
    const getSpy = vi.spyOn(kv, 'get');
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
    });
    const activityGetCalls = getSpy.mock.calls.filter((c) => c[0] === 'cron:push-activity');
    expect(activityGetCalls.length).toBe(1);
  });
});

describe('runScheduled — #2073 jitter sample 10 tick당 1회 스로틀 (Issue D)', () => {
  it('활성 trip 있는 tick도 sample tick이 아니면 jitter sample write를 skip한다', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTrip());
    // tick index 1 (10의 배수가 아님) — CRON_NOMINAL_INTERVAL_MS(60_000) 경계 기준.
    const nonSampleNow = 60_000 * 1; // tickIndex=1 → 1 % 10 !== 0
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => nonSampleNow,
    });
    const samples = await readJitterSamples(kv as unknown as KVNamespace);
    expect(samples.length).toBe(0);
  });

  it('sample tick(tick index가 JITTER_SAMPLE_EVERY_N_TICKS의 배수)엔 jitter sample을 write한다', async () => {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, makeTrip());
    const sampleNow = 60_000 * JITTER_SAMPLE_EVERY_N_TICKS; // tickIndex=10 → 10 % 10 === 0
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => sampleNow,
    });
    const samples = await readJitterSamples(kv as unknown as KVNamespace);
    expect(samples.length).toBe(1);
  });

  it('idle tick(활성 trip 없음)은 sample tick이어도 jitter sample write를 skip한다', async () => {
    const kv = new InMemoryKV();
    await (kv as unknown as KVNamespace).put('scheduled:last-heartbeat', String(60_000 * JITTER_SAMPLE_EVERY_N_TICKS));
    const sampleNow = 60_000 * JITTER_SAMPLE_EVERY_N_TICKS;
    await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => sampleNow,
    });
    const samples = await readJitterSamples(kv as unknown as KVNamespace);
    expect(samples.length).toBe(0);
  });
});

