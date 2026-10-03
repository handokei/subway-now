/**
 * 시나리오 (2026-09-23 환승 트립 매역 가치 검증, #2799) — 굳은 alarmAtEpochMs(#2794 조건)
 * 하에서 **환승 후 leg-2 구간의 station-passed(매역) 발사**가 실제로 되는지 코드로 못박는다.
 *
 * 실측 사용자 트립: 용마산(7) → 건대입구 환승 → 2호선 → 성수 → 뚝섬. 사용자는 leg-1(7호선)
 * 열차를 **한 번 탭**했고, 환승 후 재탭하지 않았다. #2794 fix는 굳은 alarmAtEpochMs가 트립을
 * 통째 스킵하지 않게 했지만, leg-2 매역이 실제로 뜨는지는 leg-2 lock 형성에 달려 있다
 * (`lesson_leg2_streak_excludes_boarded_train`, `lesson_transfer_trip_lock_fail_cron_leg2_gap`).
 *
 * 이 테스트는 그 가치 경계를 두 상태로 드러낸다:
 *   A) leg-2 lock-active — 재탭했거나 auto-lock이 이미 성공한 상태. #2794 fix가 leg-2까지
 *      커버하는지 증명(굳은 alarmAtEpochMs여도 매역 발사).
 *   B) leg-2 lockless(재탭 안 함) — Seoul positions ARRIVED→DEPARTED 전이로 auto-lock 승격 후
 *      다음 cycle에 매역이 뜨는지(전체 chain). 사용자의 실제 상황.
 *
 * fixture는 실측 트립 형태이고 통과시키려 조정하지 않는다 — leg-2가 침묵하면 RED로 남기고
 * 후속 이슈로 드러낸다.
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { runScheduled, isBoardingLockActive } from '../scheduled';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { getTrip, putTrip } from '../trips';
import { seedSsot } from '../tripPositionSsot';
import type { Env, Trip } from '../types';
import type { ArrivalEntry, PositionEntry, SeoulArrivalClient } from '../seoul';
import { InMemoryKV } from './inMemoryKv';

let apnsConfig: ApnsConfig;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsConfig = {
    keyId: 'K',
    teamId: 'T',
    privateKeyPem: await exportPKCS8(privateKey),
    bundleId: 'com.example.app',
  };
  resetApnsJwtCache();
});

const NOW = 1_700_000_000_000;
const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' };
const FUTURE = () => NOW + 2 * 60 * 60_000;
/** #2794 조건 — register 이후 갱신 안 돼 굳은 미래(폴링윈도우 밖). */
const FROZEN_ALARM_AT = NOW + 10 * 60_000;

/** cron-fire-attempt D1 로그를 캡처하는 mock. args[3]=station, args[5]=meta(json). */
function makeFireLogDb(): { db: D1Database; inserts: unknown[][] } {
  const inserts: unknown[][] = [];
  const db = {
    prepare: () => ({
      bind: (...args: unknown[]) => {
        inserts.push(args);
        return { run: async () => ({ success: true }), first: async () => null };
      },
    }),
  } as unknown as D1Database;
  return { db, inserts };
}

function makeEnv(kv: InMemoryKV, db?: D1Database): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
    DB: db,
    APNS_HOST: APNS_HOSTS.production,
    APNS_HOST_SANDBOX: APNS_HOSTS.sandbox,
    SEOUL_API_HOST: 's',
    SEOUL_API_KEY: 'K',
    APNS_KEY_ID: 'K',
    APNS_TEAM_ID: 'T',
    APNS_PRIVATE_KEY: apnsConfig.privateKeyPem,
    APNS_BUNDLE_ID: 'com.example.app',
  } as unknown as Env;
}

/** station-passed(cron-fire-attempt) 발사 역 이름 집합을 inserts에서 추출. */
function stationPassedFires(inserts: unknown[][]): string[] {
  const stations: string[] = [];
  for (const args of inserts) {
    if (args[2] !== 'cron-fire-attempt') continue;
    try {
      const meta = JSON.parse(args[5] as string) as { waypointKind?: string; outcome?: string };
      if (meta.waypointKind === 'station-passed' && meta.outcome === 'sent') {
        stations.push(String(args[3]));
      }
    } catch {
      /* ignore */
    }
  }
  return stations;
}

/** leg-2(2호선) intermediate 역에 lock trainCode의 arvlCd 도착을 내는 Seoul mock. */
function makeLeg2ArrivalSeoul(station: string, trainCode: string, arvlCd: number): SeoulArrivalClient {
  const client = {
    stats: { callCount: 0, cacheSize: 0, httpErrorCount: 0 },
    async fetchArrivals(stationName: string): Promise<ArrivalEntry[]> {
      client.stats.callCount += 1;
      if (stationName !== station) return [];
      return [
        {
          destination: '',
          arrivalSeconds: 0,
          trainCode,
          isUp: true,
          subwayNm: '',
          subwayId: '1002',
          arvlCd,
        } as unknown as ArrivalEntry,
      ];
    },
    async fetchPositions(): Promise<PositionEntry[]> {
      return [];
    },
  };
  return client as unknown as SeoulArrivalClient;
}

describe('#2799 — 환승 leg-2 매역 발사 시나리오 (굳은 alarmAtEpochMs)', () => {
  // ── A) leg-2 lock-active — #2794 fix가 leg-2까지 커버하는가 ─────────────────
  it('A) leg-2 lock-active + 굳은 alarmAtEpochMs → 성수(leg-2 intermediate) 매역이 발사된다', async () => {
    const kv = new InMemoryKV();
    const { db, inserts } = makeFireLogDb();
    const token = 'leg2-lock-active';
    // 환승 후 leg-2 상태를 직접 구성: 2호선 lock 부착 + currentLegAnchor + walk-gate 통과.
    const trip: Trip = {
      token,
      route: { type: 'transfer', fromLine: '7', toLine: '2', stopsToTransfer: 0 },
      destination: '뚝섬',
      waypoints: [
        { stationName: '성수', line: '2', kind: 'intermediate' },
        { stationName: '뚝섬', line: '2', kind: 'destination' },
      ],
      expiresAt: FUTURE(),
      createdAt: NOW - 10 * 60_000,
      alarmAtEpochMs: FROZEN_ALARM_AT,
      infoModeEnabled: true,
      currentLegAnchor: { boardingStation: '건대입구', line: '2' },
      legBoardingEligibleAt: NOW - 60_000,
      boardingLock: {
        trainCode: '2234',
        line: '2',
        subwayId: '1002',
        selectedDepartureTime: NOW - 60_000,
        segmentStations: ['건대입구', '성수', '뚝섬'],
        expiresAt: NOW + 60 * 60_000,
      },
    } as unknown as Trip;
    await putTrip(kv as unknown as KVNamespace, trip);
    await seedSsot(kv as unknown as KVNamespace, token, '성수', { line: '2' });

    await runScheduled(makeEnv(kv, db), {
      seoul: makeLeg2ArrivalSeoul('성수', '2234', 1),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-leg2-A',
    });

    // 굳은 alarmAtEpochMs여도 lock=intent라 #2794 게이트 통과 → 성수 매역 발사.
    expect(stationPassedFires(inserts)).toContain('성수');
  });

  // ── B) leg-2 lockless(재탭 안 함) — auto-lock 승격 후 매역까지 가는가 ──────────
  it('B) leg-2 lockless + ARRIVED→DEPARTED 전이 → auto-lock 승격 + 다음 cycle 성수 매역 발사', async () => {
    const kv = new InMemoryKV();
    const token = 'leg2-lockless';
    // leg-1만 탭했고 환승 후 재탭 안 한 상태: lock 없음 + infoMode + currentLegAnchor + walk-gate 통과.
    const trip: Trip = {
      token,
      route: { type: 'transfer', fromLine: '7', toLine: '2', stopsToTransfer: 0 },
      destination: '뚝섬',
      waypoints: [
        { stationName: '성수', line: '2', kind: 'intermediate' },
        { stationName: '뚝섬', line: '2', kind: 'destination' },
      ],
      expiresAt: FUTURE(),
      createdAt: NOW - 10 * 60_000,
      alarmAtEpochMs: FROZEN_ALARM_AT,
      infoModeEnabled: true,
      currentLegAnchor: { boardingStation: '건대입구', line: '2' },
      legBoardingEligibleAt: NOW - 60_000,
    } as unknown as Trip;
    await putTrip(kv as unknown as KVNamespace, trip);

    // Seoul: anchor(건대입구)에 line-2 TB2 1대 — cycle1 ARRIVED(1) → cycle2 DEPARTED(2, #2754 확증).
    // 승격 후 성수 도착(arvlCd 1)은 fetchArrivals로 상시 노출.
    let sttus = 1;
    const seoul = {
      stats: { callCount: 0, cacheSize: 0, httpErrorCount: 0 },
      async fetchArrivals(stationName: string): Promise<ArrivalEntry[]> {
        if (stationName !== '성수') return [];
        return [
          {
            destination: '',
            arrivalSeconds: 0,
            trainCode: 'TB2',
            isUp: true,
            subwayNm: '',
            subwayId: '1002',
            arvlCd: 1,
          } as unknown as ArrivalEntry,
        ];
      },
      async fetchPositions(line: string): Promise<PositionEntry[]> {
        if (line !== '2') return [];
        return [
          { trainCode: 'TB2', stationName: '건대입구', trainSttus: sttus, isUp: true, recptnMs: NOW } as unknown as PositionEntry,
        ];
      },
    } as unknown as SeoulArrivalClient;

    const allFires: string[] = [];
    async function tick(n: number, db: D1Database, inserts: unknown[][]): Promise<void> {
      await runScheduled(makeEnv(kv, db), {
        seoul,
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
        now: () => NOW + n * 60_000,
        generatePushId: () => `p-leg2-B-${n}`,
      });
      allFires.push(...stationPassedFires(inserts));
    }

    // cycle1: TB2 ARRIVED → pending. cycle2: TB2 DEPARTED → 승격. cycle3: 성수 매역.
    const t1 = makeFireLogDb();
    await tick(1, t1.db, t1.inserts);
    sttus = 2;
    const t2 = makeFireLogDb();
    await tick(2, t2.db, t2.inserts);
    const t3 = makeFireLogDb();
    await tick(3, t3.db, t3.inserts);

    const promoted = await getTrip(kv as unknown as KVNamespace, token);
    // 1) auto-lock 승격이 실제로 일어나는가 (leg-2 lock 형성).
    expect(promoted?.boardingLock?.trainCode).toBe('TB2');
    expect(isBoardingLockActive(promoted as Parameters<typeof isBoardingLockActive>[0], NOW + 3 * 60_000)).toBe(true);
    // 2) 승격 후 leg-2 매역(성수)이 실제로 발사되는가 — 전체 chain.
    expect(allFires).toContain('성수');
  });

  // ── C) 가치 경계 — 환승 직후 walk-gate 중이면 leg-2 매역은 침묵한다 (#2754 안전 설계) ──
  // 사용자가 환승 후 재탭하지 않았고, 아직 도보 이동 창(legBoardingEligibleAt > now)이라
  // backend가 leg-2 열차를 확증할 수 없다 → auto-lock 미형성 → leg-2 매역 침묵. 이는 버그가
  // 아니라 #2754 안전 설계(틀린 열차를 추측해 lock하지 않는다)의 결과다. 이 테스트는 "환승
  // 트립 매역이 언제 안 오는가"의 가치 경계를 명시적으로 문서화한다 — 제품 판단의 근거.
  it('C) leg-2 lockless + walk-gate 미만료(환승 직후) → 확증 전이가 있어도 침묵 (재탭/확증 전엔 매역 없음)', async () => {
    const kv = new InMemoryKV();
    const { db, inserts } = makeFireLogDb();
    const token = 'leg2-walkgated';
    const trip: Trip = {
      token,
      route: { type: 'transfer', fromLine: '7', toLine: '2', stopsToTransfer: 0 },
      destination: '뚝섬',
      waypoints: [
        { stationName: '성수', line: '2', kind: 'intermediate' },
        { stationName: '뚝섬', line: '2', kind: 'destination' },
      ],
      expiresAt: FUTURE(),
      createdAt: NOW - 10 * 60_000,
      alarmAtEpochMs: FROZEN_ALARM_AT,
      infoModeEnabled: true,
      currentLegAnchor: { boardingStation: '건대입구', line: '2' },
      legBoardingEligibleAt: NOW + 3 * 60_000, // 아직 도보 구간 — walk-gate 미만료
    } as unknown as Trip;
    await putTrip(kv as unknown as KVNamespace, trip);

    // 확증 전이(ARRIVED)가 positions에 있어도 walk-gate가 resolve를 막는다.
    const seoul = {
      stats: { callCount: 0, cacheSize: 0, httpErrorCount: 0 },
      async fetchArrivals(stationName: string): Promise<ArrivalEntry[]> {
        if (stationName !== '성수') return [];
        return [
          { destination: '', arrivalSeconds: 0, trainCode: 'TB2', isUp: true, subwayNm: '', subwayId: '1002', arvlCd: 1 } as unknown as ArrivalEntry,
        ];
      },
      async fetchPositions(line: string): Promise<PositionEntry[]> {
        if (line !== '2') return [];
        return [
          { trainCode: 'TB2', stationName: '건대입구', trainSttus: 1, isUp: true, recptnMs: NOW } as unknown as PositionEntry,
        ];
      },
    } as unknown as SeoulArrivalClient;

    await runScheduled(makeEnv(kv, db), {
      seoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
      generatePushId: () => 'p-leg2-C',
    });

    const trip2 = await getTrip(kv as unknown as KVNamespace, token);
    // 가치 경계: walk-gate 중엔 lock 미형성 + leg-2 매역 침묵. (#2754 안전 침묵 — 재탭/확증 필요)
    expect(trip2?.boardingLock).toBeUndefined();
    expect(stationPassedFires(inserts)).not.toContain('성수');
  });
});
