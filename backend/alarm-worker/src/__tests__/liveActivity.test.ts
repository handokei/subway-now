import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import {
  LA_STALE_DURATION_SEC,
  buildLiveActivityContentState,
  cleanupTripWithLa,
  fireLiveActivityDismissal,
  fireLiveActivityUpdate,
  isApnsTokenInvalid,
  staleDurationSecForKind,
  type LiveActivityDeps,
  type LiveActivityStats,
} from '../liveActivity';
import { readSsot, seedSsot } from '../tripPositionSsot';
import type { ApnsEnv, Env, Trip, TripEndedReason, Waypoint } from '../types';
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
const APNS_HOSTS: Record<ApnsEnv, string> = {
  production: 'api.push.apple.com',
  sandbox: 'api.sandbox.push.apple.com',
};

function makeStats(): LiveActivityStats {
  return { laPushSent: 0, laPushFailed: 0, laTokenCleared: 0 };
}

function makeDeps(fetchImpl: typeof fetch): LiveActivityDeps {
  return { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl };
}

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'devtoken',
    route: { type: 'direct', line: '2', stops: 3 },
    destination: 'dst',
    waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
    expiresAt: NOW + 3_600_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW + 60_000,
    activityPushToken: 'la-token',
    activityState: 'live',
    apnsEnv: 'sandbox',
    ...overrides,
  };
}

const WAYPOINT: Waypoint = { stationName: '강남', line: '2', kind: 'destination' };

describe('buildLiveActivityContentState (#613)', () => {
  it('emits widget-aligned schema (stationName/lineName/lineColorHex/stopsRemaining/etaMinutes)', () => {
    const cs = buildLiveActivityContentState(WAYPOINT, 90, 3);
    expect(cs).toEqual({
      stationName: '강남',
      lineName: '2호선',
      lineColorHex: '#009D3E',
      stopsRemaining: 3,
      etaMinutes: 2, // round(90/60) = 2
    });
  });

  it('rounds etaSeconds to minutes and clamps negative to 0', () => {
    expect(buildLiveActivityContentState(WAYPOINT, 29, 1).etaMinutes).toBe(0);
    expect(buildLiveActivityContentState(WAYPOINT, 30, 1).etaMinutes).toBe(1);
    expect(buildLiveActivityContentState(WAYPOINT, -5, 1).etaMinutes).toBe(0);
  });

  it('maps known line code to canonical name and color', () => {
    const wp: Waypoint = { stationName: '서울', line: '1', kind: 'transfer' };
    const cs = buildLiveActivityContentState(wp, 60, 2);
    expect(cs.lineName).toBe('1호선');
    expect(cs.lineColorHex).toBe('#0052A4');
  });

  it('falls back to raw line code and neutral color for unknown line', () => {
    const wp: Waypoint = { stationName: '미지역', line: 'unknown', kind: 'intermediate' };
    const cs = buildLiveActivityContentState(wp, 60, 2);
    expect(cs.lineName).toBe('unknown');
    expect(cs.lineColorHex).toBe('#888888');
  });

  it('does not include phase / etaSeconds / arrivalAtSec / alarmType (omitted to avoid forcing widget urgent UI)', () => {
    const cs = buildLiveActivityContentState(WAYPOINT, 90, 3);
    expect(cs).not.toHaveProperty('phase');
    expect(cs).not.toHaveProperty('etaSeconds');
    expect(cs).not.toHaveProperty('kind');
    expect(cs).not.toHaveProperty('arrivalAtSec');
    expect(cs).not.toHaveProperty('alarmType');
    expect(cs).not.toHaveProperty('alarmStationName');
  });

  // #1654 / #1658 — 환승역 waypoint 추적 시 다음 leg의 line을 LA에 즉시 반영 (60s lag 차단).
  describe('transfer waypoint → new leg line forward (#1654 / #1658)', () => {
    /** 경의중앙선(K) → 2호선 환승 trip: 홍대입구(transfer, K) → 신촌(intermediate, 2) → 강남(dest, 2). */
    function makeTransferTrip(): Trip {
      return makeTrip({
        waypoints: [
          { stationName: '홍대입구', line: 'K', kind: 'transfer' },
          { stationName: '신촌', line: '2', kind: 'intermediate' },
          { stationName: '강남', line: '2', kind: 'destination' },
        ],
        route: { type: 'transfer', fromLine: 'K', toLine: '2', transferName: '홍대입구', stopsToTransfer: 1, stopsFromTransfer: 2 },
      });
    }

    it('환승 waypoint + trip 전달 시 다음 leg line(2호선)을 lineName/lineColorHex에 사용', () => {
      const transferWp: Waypoint = { stationName: '홍대입구', line: 'K', kind: 'transfer' };
      const trip = makeTransferTrip();
      const cs = buildLiveActivityContentState(transferWp, 30, 3, trip);
      // 2호선 meta 사용 — waypoint.line='K' 아니라 trip.waypoints[1].line='2'를 기준으로 해야 함
      expect(cs.lineName).toBe('2호선');
      expect(cs.lineColorHex).toBe('#009D3E');
      // stationName은 transfer station 이름 그대로 유지
      expect(cs.stationName).toBe('홍대입구');
    });

    it('환승 waypoint이더라도 trip 미전달이면 waypoint.line으로 fallback (legacy 호환)', () => {
      const transferWp: Waypoint = { stationName: '홍대입구', line: 'K', kind: 'transfer' };
      const cs = buildLiveActivityContentState(transferWp, 30, 3);
      // trip 없음 → waypoint.line='K' 사용, LINE_META['K'] 없으면 raw 코드 fallback
      expect(cs.lineName).toBe('K');
      expect(cs.lineColorHex).toBe('#888888');
    });

    it('환승 waypoint + trip.waypoints[1] 없음(마지막 waypoint)이면 waypoint.line fallback', () => {
      const transferWp: Waypoint = { stationName: '홍대입구', line: 'K', kind: 'transfer' };
      // waypoints에 transfer만 있고 그 다음이 없는 edge case
      const trip = makeTrip({ waypoints: [transferWp] });
      const cs = buildLiveActivityContentState(transferWp, 30, 1, trip);
      // trip.waypoints.length === 1 (> 1 조건 불충족) → fallback to waypoint.line='K'
      expect(cs.lineName).toBe('K');
    });

    it('non-transfer waypoint(intermediate/destination)는 영향 없음 (회귀 가드)', () => {
      // intermediate: waypoint.line='2' 그대로 사용
      const intermediateWp: Waypoint = { stationName: '신촌', line: '2', kind: 'intermediate' };
      const trip = makeTransferTrip();
      const cs = buildLiveActivityContentState(intermediateWp, 60, 2, trip);
      expect(cs.lineName).toBe('2호선');
      expect(cs.lineColorHex).toBe('#009D3E');
    });
  });
});

// #1618 R9-b — backend buildLiveActivityContentState multi-hop 필드 wipe 차단.
// ActivityKit content-state는 update 시 전체 교체 → backend가 multi-hop 필드를 누락하면
// JS init이 stamp한 transfer/destination chain이 첫 backend push에 wipe된다.
// `trip` 인자가 전달되면 multi-hop context를 함께 emit해 LA 화면 "전체 여정" 유지.
describe('buildLiveActivityContentState multi-hop (#1618 R9-b)', () => {
  /** Trip factory — multi-hop test 케이스 dedup. waypoints만 override해 케이스 표현. */
  const makeTripForMultiHop = (waypoints: Waypoint[]): Trip =>
    makeTrip({ waypoints, route: { type: 'direct', line: '2', stops: waypoints.length } });

  /**
   * direct trip: destination 한 개만. transferStationName / stopsToTransfer /
   * secondTransferStationName / stopsAfterLastTransfer / stopsToSecondTransfer /
   * stopsFromTransfer 모두 undefined.
   */
  it('direct trip — destinationName 채움, transfer 필드 모두 undefined', () => {
    const trip = makeTripForMultiHop([
      { stationName: '중곡', line: '2', kind: 'intermediate' },
      { stationName: '강남', line: '2', kind: 'destination' },
    ]);
    const cs = buildLiveActivityContentState(WAYPOINT, 60, 2, trip);
    expect(cs.destinationName).toBe('강남');
    expect(cs.transferStationName).toBeUndefined();
    expect(cs.stopsToTransfer).toBeUndefined();
    expect(cs.secondTransferStationName).toBeUndefined();
    expect(cs.stopsAfterLastTransfer).toBeUndefined();
    expect(cs.stopsToSecondTransfer).toBeUndefined();
    expect(cs.stopsFromTransfer).toBeUndefined();
  });

  /**
   * single-transfer trip: transfer 1개. stopsToTransfer = first transfer index + 1,
   * stopsFromTransfer = remaining after transfer. secondTransfer 필드는 undefined.
   */
  it('transfer 1회 — transferStationName + stopsToTransfer + stopsFromTransfer 채움', () => {
    // 진행: [A(int), 시청(t1), C(int), 강남(dest)]
    //   - transfer 위치 idx=1 → stopsToTransfer = 2 (A 지나서 시청 도착)
    //   - 환승 이후 남은 stop = 2 (C 지나 강남)
    const trip = makeTripForMultiHop([
      { stationName: 'A', line: '2', kind: 'intermediate' },
      { stationName: '시청', line: '2', kind: 'transfer' },
      { stationName: 'C', line: '1', kind: 'intermediate' },
      { stationName: '강남', line: '1', kind: 'destination' },
    ]);
    const cs = buildLiveActivityContentState(WAYPOINT, 60, 4, trip);
    expect(cs.destinationName).toBe('강남');
    expect(cs.transferStationName).toBe('시청');
    expect(cs.stopsToTransfer).toBe(2);
    expect(cs.stopsFromTransfer).toBe(2);
    expect(cs.secondTransferStationName).toBeUndefined();
    expect(cs.stopsToSecondTransfer).toBeUndefined();
    expect(cs.stopsAfterLastTransfer).toBeUndefined();
  });

  /**
   * multi-transfer trip: transfer 2개 이상. secondTransfer 필드 + stopsAfterLastTransfer 채움,
   * stopsFromTransfer는 undefined (multi-transfer schema는 stopsAfterLastTransfer로만 표현).
   */
  it('transfer 2회 — second transfer 필드 + stopsAfterLastTransfer 채움', () => {
    // 진행: [A(int), 시청(t1), C(int), 동대문(t2), E(int), F(int), 강남(dest)]
    //   - first transfer idx=1 → stopsToTransfer = 2
    //   - second transfer idx=3 → stopsToSecondTransfer = 2 (3 - 1)
    //   - 마지막 transfer 이후 남은 stop = 3 (E, F 지나 강남) = (7 - 1 - 3)
    const trip = makeTripForMultiHop([
      { stationName: 'A', line: '2', kind: 'intermediate' },
      { stationName: '시청', line: '2', kind: 'transfer' },
      { stationName: 'C', line: '1', kind: 'intermediate' },
      { stationName: '동대문', line: '1', kind: 'transfer' },
      { stationName: 'E', line: '4', kind: 'intermediate' },
      { stationName: 'F', line: '4', kind: 'intermediate' },
      { stationName: '강남', line: '4', kind: 'destination' },
    ]);
    const cs = buildLiveActivityContentState(WAYPOINT, 60, 7, trip);
    expect(cs.destinationName).toBe('강남');
    expect(cs.transferStationName).toBe('시청');
    expect(cs.stopsToTransfer).toBe(2);
    expect(cs.secondTransferStationName).toBe('동대문');
    expect(cs.stopsToSecondTransfer).toBe(2);
    expect(cs.stopsAfterLastTransfer).toBe(3);
    expect(cs.stopsFromTransfer).toBeUndefined();
  });

  /**
   * transfer가 next waypoint 인 경우 — stopsToTransfer는 최소 1 (next stop이 transfer)
   * 이어야 한다. 0이 아닌 1.
   */
  it('next waypoint가 transfer일 때 stopsToTransfer = 1 (off-by-one 회귀 가드)', () => {
    const trip = makeTripForMultiHop([
      { stationName: '시청', line: '2', kind: 'transfer' },
      { stationName: '강남', line: '1', kind: 'destination' },
    ]);
    const cs = buildLiveActivityContentState(WAYPOINT, 60, 2, trip);
    expect(cs.stopsToTransfer).toBe(1);
    expect(cs.stopsFromTransfer).toBe(1);
  });

  /**
   * 빈 waypoints — 사용자 도착 직후 (advance 후 호출). multi-hop 필드 모두 undefined.
   * base 5 필드는 그대로 유지.
   */
  it('빈 waypoints — multi-hop 필드 전부 omit, base 5 필드만 emit', () => {
    const trip = makeTrip({ waypoints: [] });
    const cs = buildLiveActivityContentState(WAYPOINT, 0, 0, trip);
    expect(cs).toEqual({
      stationName: '강남',
      lineName: '2호선',
      lineColorHex: '#009D3E',
      stopsRemaining: 0,
      etaMinutes: 0,
    });
  });

  /**
   * destination만 있고 transfer가 한 개도 없으면, 마지막에 destination이 와도 정상 추출.
   * (단, 마지막이 destination이 아닌 비정상 경우도 가장 마지막 destination을 추출 — defensive.)
   */
  it('마지막이 intermediate 인 비정상 waypoints에서도 destination 정상 추출', () => {
    const trip = makeTripForMultiHop([
      { stationName: '강남', line: '2', kind: 'destination' },
      // 비정상: destination 뒤 추가 intermediate (예: 미래 변경 또는 schema drift).
      { stationName: '잘못된역', line: '2', kind: 'intermediate' },
    ]);
    const cs = buildLiveActivityContentState(WAYPOINT, 60, 2, trip);
    expect(cs.destinationName).toBe('강남');
  });

  /**
   * trip 미전달 시 (legacy 호출자) — base 5 필드만 emit, multi-hop 필드 0개. backward-compat.
   * 기존 테스트(line 65-74)와 동일 결과지만 명시 회귀 가드.
   */
  it('trip 미전달 — base 5 필드만 emit (backward-compat)', () => {
    const cs = buildLiveActivityContentState(WAYPOINT, 60, 3);
    expect(cs).not.toHaveProperty('destinationName');
    expect(cs).not.toHaveProperty('transferStationName');
    expect(cs).not.toHaveProperty('stopsToTransfer');
    expect(cs).not.toHaveProperty('secondTransferStationName');
    expect(cs).not.toHaveProperty('stopsAfterLastTransfer');
    expect(cs).not.toHaveProperty('stopsFromTransfer');
  });
});

describe('fireLiveActivityUpdate', () => {
  it('no-ops when activityPushToken is missing', async () => {
    const fetchImpl = vi.fn();
    const stats = makeStats();
    const trip = makeTrip({ activityPushToken: undefined });
    const r = await fireLiveActivityUpdate(
      trip,
      { etaSeconds: 1 },
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(r.dirty).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(stats.laPushSent).toBe(0);
  });

  it('no-ops when activityState is not live (ended)', async () => {
    const fetchImpl = vi.fn();
    const stats = makeStats();
    const trip = makeTrip({ activityState: 'ended' });
    const r = await fireLiveActivityUpdate(
      trip,
      {},
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(r.dirty).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts to LA endpoint with staleDate = now/1000 + 90 and increments laPushSent on success', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const stats = makeStats();
    const trip = makeTrip();
    await fireLiveActivityUpdate(
      trip,
      { etaSeconds: 30 },
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://${APNS_HOSTS.sandbox}/3/device/la-token`);
    const body = JSON.parse(init.body as string);
    expect(body.aps.event).toBe('update');
    expect(body.aps['stale-date']).toBe(Math.floor(NOW / 1000) + LA_STALE_DURATION_SEC);
    expect(stats.laPushSent).toBe(1);
    expect(stats.laPushFailed).toBe(0);
  });

  // #1402 — waypoint kind별 staleDate 정합. destination은 짧고(45s) transfer 중간(75s)
  // intermediate 기본(90s). undefined는 legacy 기본값 90s 유지 — 기존 호출자 무영향.
  it.each<[Waypoint['kind'], number]>([
    ['destination', 45],
    ['transfer', 75],
    ['intermediate', 90],
  ])('#1402 staleDate = now + %s-specific seconds (%i)', (kind, expectedSec) => {
    expect(staleDurationSecForKind(kind)).toBe(expectedSec);
  });

  it('#1402 staleDurationSecForKind(undefined) falls back to legacy default', () => {
    expect(staleDurationSecForKind(undefined)).toBe(LA_STALE_DURATION_SEC);
  });

  // #1402 — waypoint kind가 APNs stale-date에 반영되는지 e2e 검증 (helper로 dedup).
  it.each<[Waypoint['kind'], number]>([
    ['destination', 45],
    ['transfer', 75],
  ])('#1402 passes waypoint kind=%s → APNs stale-date = now + %i', async (kind, expectedSec) => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await fireLiveActivityUpdate(
      makeTrip(),
      {},
      makeDeps(fetchImpl as unknown as typeof fetch),
      makeStats(),
      NOW,
      () => undefined,
      kind,
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.aps['stale-date']).toBe(Math.floor(NOW / 1000) + expectedSec);
  });

  it('uses production host when apnsEnv=production', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const trip = makeTrip({ apnsEnv: 'production' });
    await fireLiveActivityUpdate(
      trip,
      {},
      makeDeps(fetchImpl as unknown as typeof fetch),
      makeStats(),
      NOW,
      () => undefined,
    );
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://${APNS_HOSTS.production}/3/device/la-token`);
  });

  it('clears token + sets ended on 410 (dirty=true)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 410 }),
    );
    const stats = makeStats();
    const trip = makeTrip();
    const r = await fireLiveActivityUpdate(
      trip,
      {},
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(r.dirty).toBe(true);
    expect(trip.activityPushToken).toBeUndefined();
    expect(trip.activityState).toBe('ended');
    expect(stats.laPushFailed).toBe(1);
    expect(stats.laTokenCleared).toBe(1);
  });

  it('does not clear on non-token-invalid failure (dirty=false)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'InternalServerError' }), { status: 500 }),
    );
    const stats = makeStats();
    const trip = makeTrip();
    const r = await fireLiveActivityUpdate(
      trip,
      {},
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(r.dirty).toBe(false);
    expect(trip.activityPushToken).toBe('la-token');
    expect(stats.laPushFailed).toBe(1);
    expect(stats.laTokenCleared).toBe(0);
  });

  // #1899 — trip 경계 rotation race에서 짧은 window 동안 옛 token이 400 BadDeviceToken으로
  // 응답되는 패턴. 410으로 전환되기 전 cron이 stale token 재시도하면 BadDeviceToken 폭증 →
  // 즉시 clear로 해결.
  it('clears token + sets ended on 400 BadDeviceToken (dirty=true) (#1899)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
    );
    const stats = makeStats();
    const trip = makeTrip();
    const r = await fireLiveActivityUpdate(
      trip,
      {},
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(r.dirty).toBe(true);
    expect(trip.activityPushToken).toBeUndefined();
    expect(trip.activityState).toBe('ended');
    expect(stats.laPushFailed).toBe(1);
    expect(stats.laTokenCleared).toBe(1);
  });

  // 400 reason이 token error가 아니면(예: BadTopic — 백엔드 코드/구성 문제) clear하지 않는다.
  // token 자체가 멀쩡한데 clear하면 정상 trip의 LA가 silent dead가 되어 회귀.
  it('does not clear on 400 with non-BadDeviceToken reason (dirty=false) (#1899)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadTopic' }), { status: 400 }),
    );
    const stats = makeStats();
    const trip = makeTrip();
    const r = await fireLiveActivityUpdate(
      trip,
      {},
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(r.dirty).toBe(false);
    expect(trip.activityPushToken).toBe('la-token');
    expect(stats.laTokenCleared).toBe(0);
  });
});

describe('fireLiveActivityDismissal', () => {
  it('no-ops when no token', async () => {
    const fetchImpl = vi.fn();
    const trip = makeTrip({ activityPushToken: undefined });
    await fireLiveActivityDismissal(
      trip,
      makeDeps(fetchImpl as unknown as typeof fetch),
      makeStats(),
      NOW,
      () => undefined,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('no-ops when state is already ended', async () => {
    const fetchImpl = vi.fn();
    const trip = makeTrip({ activityState: 'ended' });
    await fireLiveActivityDismissal(
      trip,
      makeDeps(fetchImpl as unknown as typeof fetch),
      makeStats(),
      NOW,
      () => undefined,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends end event with dismissalDate=now/1000 and transitions trip to ended on success', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const stats = makeStats();
    const trip = makeTrip();
    await fireLiveActivityDismissal(
      trip,
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.aps.event).toBe('end');
    expect(body.aps['dismissal-date']).toBe(Math.floor(NOW / 1000));
    expect(trip.activityPushToken).toBeUndefined();
    expect(trip.activityState).toBe('ended');
    expect(stats.laPushSent).toBe(1);
  });

  it('still transitions to ended even when push fails (best-effort)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 410 }),
    );
    const stats = makeStats();
    const trip = makeTrip();
    await fireLiveActivityDismissal(
      trip,
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(trip.activityPushToken).toBeUndefined();
    expect(trip.activityState).toBe('ended');
    expect(stats.laPushFailed).toBe(1);
    expect(stats.laTokenCleared).toBe(1);
  });

  it('increments laPushFailed but not laTokenCleared on non-token-invalid failure', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'ServerUnavailable' }), { status: 503 }),
    );
    const stats = makeStats();
    const trip = makeTrip();
    await fireLiveActivityDismissal(
      trip,
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(stats.laPushFailed).toBe(1);
    expect(stats.laTokenCleared).toBe(0);
  });

  // #1899 — dismissal 시 400 BadDeviceToken도 token-invalid 카운팅. update와 정렬.
  it('counts laTokenCleared on 400 BadDeviceToken (#1899)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
    );
    const stats = makeStats();
    const trip = makeTrip();
    await fireLiveActivityDismissal(
      trip,
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(stats.laPushFailed).toBe(1);
    expect(stats.laTokenCleared).toBe(1);
  });
});

// #1899 — APNs token-invalid 판정 단위 테스트. fireLiveActivityUpdate/Dismissal의
// clear 분기 SSoT라 케이스가 분기 매트릭스 전부 커버되도록 한다.
describe('isApnsTokenInvalid (#1899)', () => {
  it('returns true for 410 regardless of reason', () => {
    expect(isApnsTokenInvalid(410, 'Unregistered')).toBe(true);
    expect(isApnsTokenInvalid(410, undefined)).toBe(true);
  });

  it('returns true for 400 + BadDeviceToken', () => {
    expect(isApnsTokenInvalid(400, 'BadDeviceToken')).toBe(true);
  });

  it('returns false for 400 with other reasons (config error, not token error)', () => {
    expect(isApnsTokenInvalid(400, 'BadTopic')).toBe(false);
    expect(isApnsTokenInvalid(400, 'MissingTopic')).toBe(false);
    expect(isApnsTokenInvalid(400, undefined)).toBe(false);
  });

  it('returns false for non-error / unrelated status codes', () => {
    expect(isApnsTokenInvalid(200, undefined)).toBe(false);
    expect(isApnsTokenInvalid(500, 'InternalServerError')).toBe(false);
    expect(isApnsTokenInvalid(503, 'ServerUnavailable')).toBe(false);
    expect(isApnsTokenInvalid(undefined, undefined)).toBe(false);
  });
});

describe('cleanupTripWithLa', () => {
  it('fires dismissal then deletes trip from KV', async () => {
    const kv = new InMemoryKV();
    await kv.put('trip:devtoken', JSON.stringify(makeTrip()));
    const env = { TRIPS: kv as unknown as KVNamespace } as Env;
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const stats = makeStats();
    await cleanupTripWithLa(
      makeTrip(),
      env,
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(stats.laPushSent).toBe(1);
    expect(await kv.get('trip:devtoken')).toBeNull();
  });

  it('still deletes trip when no LA token (no push fired)', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({ activityPushToken: undefined });
    await kv.put('trip:devtoken', JSON.stringify(trip));
    const env = { TRIPS: kv as unknown as KVNamespace } as Env;
    const fetchImpl = vi.fn();
    await cleanupTripWithLa(
      trip,
      env,
      makeDeps(fetchImpl as unknown as typeof fetch),
      makeStats(),
      NOW,
      () => undefined,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await kv.get('trip:devtoken')).toBeNull();
  });

  // #1283 — trip-ended push도 다른 push 경로와 동일하게 env-heal 적용.
  it('trip-ended push self-heals on BadDeviceToken (opposite-host retry)', async () => {
    const kv = new InMemoryKV();
    // activityPushToken 없음 → dismissal skip, trip-ended push만 발사돼 호출을 격리.
    const trip = makeTrip({ activityPushToken: undefined, apnsEnv: 'sandbox' });
    await kv.put('trip:devtoken', JSON.stringify(trip));
    const env = { TRIPS: kv as unknown as KVNamespace } as Env;
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      // 1차 sandbox host → BadDeviceToken, 2차 production host → 성공.
      if (url.includes(APNS_HOSTS.sandbox)) {
        return new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 });
      }
      return new Response('', { status: 200 });
    });
    await cleanupTripWithLa(
      trip,
      env,
      makeDeps(fetchImpl as unknown as typeof fetch),
      makeStats(),
      NOW,
      () => undefined,
      'eta-missing',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(calls[0]).toContain(APNS_HOSTS.sandbox);
    expect(calls[1]).toContain(APNS_HOSTS.production);
    expect(await kv.get('trip:devtoken')).toBeNull();
  });

  // #2120 (#2114 근본 수리 Phase 2) — trip.corrId가 trip-ended push payload에 echo된다.
  it('trip.corrId 보유 시 trip-ended push data.corrId로 echo된다', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({ activityPushToken: undefined, corrId: 'corr-live-1' });
    await kv.put('trip:devtoken', JSON.stringify(trip));
    const env = { TRIPS: kv as unknown as KVNamespace } as Env;
    let capturedBody: string | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return new Response('', { status: 200 });
    });
    await cleanupTripWithLa(
      trip,
      env,
      makeDeps(fetchImpl as unknown as typeof fetch),
      makeStats(),
      NOW,
      () => undefined,
      'eta-missing',
    );
    expect(JSON.parse(capturedBody ?? '{}').data.corrId).toBe('corr-live-1');
  });

  it('trip.corrId 미보유(구 레코드) 시 trip-ended push data에 corrId 필드가 없다', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({ activityPushToken: undefined, corrId: undefined });
    await kv.put('trip:devtoken', JSON.stringify(trip));
    const env = { TRIPS: kv as unknown as KVNamespace } as Env;
    let capturedBody: string | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return new Response('', { status: 200 });
    });
    await cleanupTripWithLa(
      trip,
      env,
      makeDeps(fetchImpl as unknown as typeof fetch),
      makeStats(),
      NOW,
      () => undefined,
      'eta-missing',
    );
    expect('corrId' in JSON.parse(capturedBody ?? '{}').data).toBe(false);
  });

  it('trip-ended push logs failure when both hosts reject (env mismatch exhausted)', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({ activityPushToken: undefined, apnsEnv: 'sandbox' });
    await kv.put('trip:devtoken', JSON.stringify(trip));
    const env = { TRIPS: kv as unknown as KVNamespace } as Env;
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
    );
    const logs: string[] = [];
    await cleanupTripWithLa(
      trip,
      env,
      makeDeps(fetchImpl as unknown as typeof fetch),
      makeStats(),
      NOW,
      (msg) => logs.push(msg),
      'eta-missing',
    );
    // 1차 + retry 모두 호출, 둘 다 실패 → 'trip-ended push failed' 로그.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(logs).toContain('trip-ended push failed');
    expect(await kv.get('trip:devtoken')).toBeNull();
  });

  // #1337 — KV `tripEndedAlert:{tripToken}:{createdAt}` set-if-absent gate. 같은 trip의 cleanup이 race로
  // 두 번 호출돼도 alert가 1회만 발사된다. 실패 push는 stamp X → 다음 cycle 재시도 허용.
  describe('trip-ended alert KV dedup gate (#1337)', () => {
    type FetchFn = ReturnType<typeof vi.fn>;
    const arrange = async (fetchImpl: FetchFn, tripOverrides: Partial<Trip> = {}) => {
      const kv = new InMemoryKV();
      const trip = makeTrip({ activityPushToken: undefined, ...tripOverrides });
      await kv.put('trip:devtoken', JSON.stringify(trip));
      const env = { TRIPS: kv as unknown as KVNamespace } as Env;
      return { kv, trip, env, fetchImpl };
    };
    const runCleanup = (
      ctx: { trip: Trip; env: Env; fetchImpl: FetchFn },
      reason: TripEndedReason,
      log: (message: string, meta?: Record<string, unknown>) => void = () => undefined,
      atNow: number = NOW,
    ) =>
      cleanupTripWithLa(
        ctx.trip,
        ctx.env,
        makeDeps(ctx.fetchImpl as unknown as typeof fetch),
        makeStats(),
        atNow,
        log,
        reason,
      );

    it('success 시 dedup stamp 저장 → 동일 trip 재 cleanup 호출 시 alert push skip', async () => {
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      const ctx = await arrange(fetchImpl);
      await runCleanup(ctx, 'eta-missing');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(await ctx.kv.get(`tripEndedAlert:devtoken:${NOW}`)).toBe('1');

      // 2차 cleanup (동일 cron 사이클 내 race) — dedup으로 push skip
      const trip2 = makeTrip({ activityPushToken: undefined });
      await ctx.kv.put('trip:devtoken', JSON.stringify(trip2));
      const logs: string[] = [];
      await runCleanup({ ...ctx, trip: trip2 }, 'destination-arrived', (m) => logs.push(m));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(logs).toContain('trip-ended alert: dedup skip');
    });

    it('실패 push (양쪽 host 모두 reject) 시 dedup stamp 저장 X → 다음 사이클 재시도 허용', async () => {
      const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
      );
      const ctx = await arrange(fetchImpl);
      await runCleanup(ctx, 'eta-missing');
      // env-heal 1차+retry 둘 다 호출되지만 둘 다 실패.
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(await ctx.kv.get(`tripEndedAlert:devtoken:${NOW}`)).toBeNull();
    });

    it('throw 발생 시 dedup stamp 저장 X', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error('network down');
      });
      const ctx = await arrange(fetchImpl);
      await runCleanup(ctx, 'expired');
      expect(await ctx.kv.get(`tripEndedAlert:devtoken:${NOW}`)).toBeNull();
      // throw 흡수 후 cleanup 흐름 계속 → trip 삭제됨
      expect(await ctx.kv.get('trip:devtoken')).toBeNull();
    });

    // 회귀 가드: trip.token = device APNs token 이라 같은 디바이스의 후속 trip이 동일 token을
    // 재사용한다. dedup key가 token만으로 구성되면 trip A 종료 후 곧이어 시작한 trip B의 종료
    // alert가 stale stamp에 막혀 사라진다(#1337 acceptance 회귀). (token, createdAt) 페어로
    // trip-instance 단위 격리하는지 검증.
    it('동일 device(token)의 다른 trip-instance(createdAt) 는 dedup 안 됨 (각자 alert 발사)', async () => {
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      // Trip A: createdAt=NOW
      const ctxA = await arrange(fetchImpl, { createdAt: NOW });
      await runCleanup(ctxA, 'destination-arrived');
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // Trip B: same token, 다른 createdAt (예: 1분 뒤 새 trip 등록)
      const tripB = makeTrip({ activityPushToken: undefined, createdAt: NOW + 60_000 });
      await ctxA.kv.put('trip:devtoken', JSON.stringify(tripB));
      await runCleanup({ ...ctxA, trip: tripB }, 'eta-missing', undefined, NOW + 60_000);
      // Trip B의 alert도 발사돼야 함 (총 2회)
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(await ctxA.kv.get(`tripEndedAlert:devtoken:${NOW}`)).toBe('1');
      expect(await ctxA.kv.get(`tripEndedAlert:devtoken:${NOW + 60_000}`)).toBe('1');
    });
  });

  // #1339 — launch reconciliation 백스톱. cleanupTripWithLa가 reason과 함께 호출되면
  // 모든 trip-ended 경로(scheduled.ts의 4 발사 지점)가 자동으로 status marker를 KV에 적재한다.
  describe('writes trip-ended status marker for launch reconciliation (#1339)', () => {
    const reasonMatrix = [
      { reason: 'expired' as const, expected: 'expired' },
      { reason: 'eta-missing' as const, expected: 'eta-missing' },
      { reason: 'destination-arrived' as const, expected: 'destination' },
      { reason: 'push-unrecoverable' as const, expected: 'push-unrecoverable' },
      // #1933 — la-stale-backstop은 외부 contract `'expired'`로 매핑 (backward-compat).
      { reason: 'la-stale-backstop' as const, expected: 'expired' },
    ];

    for (const { reason, expected } of reasonMatrix) {
      it(`writes status=${expected} when cleanup called with reason ${reason}`, async () => {
        const kv = new InMemoryKV();
        const trip = makeTrip({ activityPushToken: undefined });
        await kv.put('trip:devtoken', JSON.stringify(trip));
        const env = { TRIPS: kv as unknown as KVNamespace } as Env;
        const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
        await cleanupTripWithLa(
          trip,
          env,
          makeDeps(fetchImpl as unknown as typeof fetch),
          makeStats(),
          NOW,
          () => undefined,
          reason,
        );
        const raw = kv.store.get('tripStatus:devtoken');
        expect(raw).toBeDefined();
        expect(JSON.parse(raw!.value)).toEqual({ endedAt: NOW, endReason: expected });
        // trip 자체는 여전히 삭제됨.
        expect(await kv.get('trip:devtoken')).toBeNull();
      });
    }

    it('does not write a marker when reason is omitted (HTTP DELETE path)', async () => {
      const kv = new InMemoryKV();
      const trip = makeTrip({ activityPushToken: undefined });
      await kv.put('trip:devtoken', JSON.stringify(trip));
      const env = { TRIPS: kv as unknown as KVNamespace } as Env;
      await cleanupTripWithLa(
        trip,
        env,
        makeDeps(vi.fn() as unknown as typeof fetch),
        makeStats(),
        NOW,
        () => undefined,
      );
      expect(kv.store.has('tripStatus:devtoken')).toBe(false);
    });

    // #1933 — alert push payload의 reason 필드도 외부 contract 매핑이 적용된다. 내부 식별자
    // `'la-stale-backstop'`을 그대로 송신하면 client mirror enum이 `'unknown'`으로 normalize되어
    // user-facing 알림 메시지가 generic해진다. force-end 패턴과 동일하게 `'expired'`로 매핑해
    // client 기존 graceful handler가 그대로 동작하도록 한다.
    it('la-stale-backstop 호출 시 alert push payload reason은 expired로 송신', async () => {
      const kv = new InMemoryKV();
      const trip = makeTrip({ activityPushToken: undefined });
      await kv.put('trip:devtoken', JSON.stringify(trip));
      const env = { TRIPS: kv as unknown as KVNamespace } as Env;
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      await cleanupTripWithLa(
        trip,
        env,
        makeDeps(fetchImpl as unknown as typeof fetch),
        makeStats(),
        NOW,
        () => undefined,
        'la-stale-backstop',
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const call = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
      const body = JSON.parse(call[1].body) as { data: { reason: string } };
      expect(body.data.reason).toBe('expired');
    });

    // 기존 reason은 그대로 송신되는지 회귀 가드 — la-stale-backstop 매핑이 다른 reason에 leak되면 회귀.
    it('expired/eta-missing 등 기존 reason은 alert push payload에 그대로 송신 (회귀 가드)', async () => {
      const cases: Array<TripEndedReason> = [
        'expired',
        'eta-missing',
        'destination-arrived',
        'push-unrecoverable',
        'seoul-outage',
      ];
      for (const reason of cases) {
        const kv = new InMemoryKV();
        const trip = makeTrip({ activityPushToken: undefined });
        await kv.put('trip:devtoken', JSON.stringify(trip));
        const env = { TRIPS: kv as unknown as KVNamespace } as Env;
        const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
        await cleanupTripWithLa(
          trip,
          env,
          makeDeps(fetchImpl as unknown as typeof fetch),
          makeStats(),
          NOW,
          () => undefined,
          reason,
        );
        const call = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
        const body = JSON.parse(call[1].body) as { data: { reason: string } };
        expect(body.data.reason).toBe(reason);
      }
    });

    it('logs but does not throw when status write fails (cleanup continues)', async () => {
      // KV.put이 throw하는 broken 환경. cleanup 흐름은 끝까지 진행돼야 한다.
      const kv = new InMemoryKV();
      const trip = makeTrip({ activityPushToken: undefined });
      await kv.put('trip:devtoken', JSON.stringify(trip));
      const brokenKv = {
        get: kv.get.bind(kv),
        put: vi.fn(async (key: string) => {
          if (key.startsWith('tripStatus:')) throw new Error('kv down');
          return undefined;
        }),
        delete: kv.delete.bind(kv),
        list: kv.list.bind(kv),
      };
      const env = { TRIPS: brokenKv as unknown as KVNamespace } as Env;
      const logs: string[] = [];
      await cleanupTripWithLa(
        trip,
        env,
        makeDeps(vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch),
        makeStats(),
        NOW,
        (msg) => logs.push(msg),
        'expired',
      );
      expect(logs).toContain('trip-status write failed');
    });
  });

  // #1701 — SSoT mirror row(`ssot:<token>`) cleanup. 모든 종료 경로(cleanupTripWithLa 호출자)가
  // SSoT를 함께 정리해 같은 token으로 새 trip 등록 시 lazy-seed가 빈 stationName으로 정착하도록.
  // evidence: device가 옛 trip stationName(7-018 어린이대공원, 6-038 봉화산)을 stale mirror로 받아
  // 잘못된 알림 발사. fix는 deleteTrip 직후 deleteSsot도 함께 호출하는 것.
  describe('SSoT mirror cleanup (#1701)', () => {
    const reasonMatrix: TripEndedReason[] = [
      'destination-arrived',
      'expired',
      'eta-missing',
      'seoul-outage',
      'push-unrecoverable',
    ];

    for (const reason of reasonMatrix) {
      it(`removes SSoT row when cleanup called with reason ${reason}`, async () => {
        const kv = new InMemoryKV();
        const trip = makeTrip({ activityPushToken: undefined });
        await kv.put('trip:devtoken', JSON.stringify(trip));
        // SSoT row 사전 seed — 옛 trip의 stationName이 mirror로 남은 상태.
        await seedSsot(kv as unknown as KVNamespace, 'devtoken', '봉화산(서울의료원)');
        expect(await readSsot(kv as unknown as KVNamespace, 'devtoken')).not.toBeNull();
        const env = { TRIPS: kv as unknown as KVNamespace } as Env;
        await cleanupTripWithLa(
          trip,
          env,
          makeDeps(vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch),
          makeStats(),
          NOW,
          () => undefined,
          reason,
        );
        // trip + SSoT 모두 KV에서 제거됨.
        expect(await kv.get('trip:devtoken')).toBeNull();
        expect(await readSsot(kv as unknown as KVNamespace, 'devtoken')).toBeNull();
      });
    }

    it('removes SSoT row even when reason is omitted (HTTP DELETE /trips/:token path)', async () => {
      // HTTP DELETE 경로는 reason 없이 cleanupTripWithLa를 호출 — SSoT는 동등하게 정리돼야 한다.
      const kv = new InMemoryKV();
      const trip = makeTrip({ activityPushToken: undefined });
      await kv.put('trip:devtoken', JSON.stringify(trip));
      await seedSsot(kv as unknown as KVNamespace, 'devtoken', '용마산');
      const env = { TRIPS: kv as unknown as KVNamespace } as Env;
      await cleanupTripWithLa(
        trip,
        env,
        makeDeps(vi.fn() as unknown as typeof fetch),
        makeStats(),
        NOW,
        () => undefined,
      );
      expect(await readSsot(kv as unknown as KVNamespace, 'devtoken')).toBeNull();
    });

    it('logs but does not throw when SSoT delete fails (cleanup continues)', async () => {
      // KV.delete가 ssot:* 키에서 throw하는 broken 환경. cleanup 흐름은 끝까지 진행돼야 한다.
      const kv = new InMemoryKV();
      const trip = makeTrip({ activityPushToken: undefined });
      await kv.put('trip:devtoken', JSON.stringify(trip));
      const brokenKv = {
        get: kv.get.bind(kv),
        put: kv.put.bind(kv),
        delete: vi.fn(async (key: string) => {
          if (key.startsWith('ssot:')) throw new Error('ssot kv down');
          return kv.delete(key);
        }),
        list: kv.list.bind(kv),
      };
      const env = { TRIPS: brokenKv as unknown as KVNamespace } as Env;
      const logs: string[] = [];
      await cleanupTripWithLa(
        trip,
        env,
        makeDeps(vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch),
        makeStats(),
        NOW,
        (msg) => logs.push(msg),
        'expired',
      );
      // ssot delete 실패 로그가 남고, trip 정리는 정상 완료.
      expect(logs).toContain('ssot delete failed');
      expect(await kv.get('trip:devtoken')).toBeNull();
    });
  });
});
