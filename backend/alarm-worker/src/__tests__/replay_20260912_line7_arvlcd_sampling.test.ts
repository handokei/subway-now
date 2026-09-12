/**
 * 실측 재생 하네스 (2026-09-12) — 라이드 없이 "매역 침묵" 재현 + fix 검증.
 *
 * 사용자 요구: "실제로 측정이 가능한 수준이 되어야 실측 의미가 있다."
 * 라이브 Seoul realtimeStationArrival + realtimePosition을 15초 주기로 8분 캡처(7호선 상행 열차
 * 7204가 건대입구→어린이대공원→군자 통과)해 fixture로 저장하고, 실제 `runScheduled`에 60초 cron
 * 간격으로 재생한다. cron 위상(0/15/30/45초 오프셋)을 바꿔가며 매역 발사율을 측정.
 *
 * 관찰(실측): 한 역의 arvlCd∈{진입0,도착1} 창은 ~30초로 60초 cron이 위상에 따라 통째로 놓친다.
 * 그러나 realtimePosition의 sttus=ARRIVED 창은 ~50-64초 + 역 체류 ~80초로 훨씬 넓고 GPS무관·매cycle
 * 존재한다. #2571 fix는 position 확증 도착(arvlCd=null)에도 station-passed push를 발사한다 →
 * arvlCd 창을 놓쳐도 position으로 매역 발사 보장. 이 테스트가 그 보장을 코드로 증명한다.
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { runScheduled } from '../scheduled';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { putTrip, getTrip } from '../trips';
import { isBoardingLockActive } from '../scheduled';
import app from '../index';
import type { Env, Trip } from '../types';
import type { ArrivalEntry, PositionEntry, SeoulArrivalClient } from '../seoul';
import { InMemoryKV } from './inMemoryKv';
import fixture from './fixtures/seoul_line7_pos_20260912.json';

let apnsConfig: ApnsConfig;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  const pem = await exportPKCS8(privateKey);
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: pem, bundleId: 'com.example.app' };
  resetApnsJwtCache();
});

const NOW = 1_700_000_000_000;
const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' };
const FRESH_MS = 20_000; // Seoul 갱신 주기 근사 — 이 창 안의 최신 관측만 유효

interface ArrEntry {
  t: number;
  train: string;
  arvlCd: number | null;
  isUp: boolean;
}
interface PosEntry {
  t: number;
  train: string;
  st: string;
  sttus: number | null;
  isUp: boolean;
}
const byStation = fixture.byStation as Record<string, ArrEntry[]>;
const positions = fixture.positions as PosEntry[];
const LOCK_TRAIN = fixture.train; // '7204'
const SEGMENT = fixture.segmentStations as string[];

function makeEnv(kv: InMemoryKV): Env {
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
  };
}

// 캡처 스트림을 sim-now 기준으로 재생하는 Seoul 클라이언트 (arrivals + positions 둘 다).
function makeReplayClient(getNow: () => number): SeoulArrivalClient {
  const client = {
    stats: { callCount: 0, cacheSize: 0, httpErrorCount: 0 },
    async fetchArrivals(stationName: string): Promise<ArrivalEntry[]> {
      client.stats.callCount += 1;
      const tSec = (getNow() - NOW) / 1000;
      const entries = byStation[stationName] ?? [];
      const recent = new Map<string, ArrEntry>();
      for (const e of entries) {
        if (e.t <= tSec && (tSec - e.t) * 1000 < FRESH_MS) recent.set(e.train, e);
      }
      return [...recent.values()].map((e) => ({
        destination: '',
        arrivalSeconds: e.arvlCd === 1 ? 0 : 60,
        trainCode: e.train,
        isUp: e.isUp,
        subwayNm: '',
        subwayId: '1007',
        arvlCd: e.arvlCd,
      }));
    },
    async fetchPositions(_line: string): Promise<PositionEntry[]> {
      const tSec = (getNow() - NOW) / 1000;
      const recent = new Map<string, PosEntry>();
      for (const p of positions) {
        if (p.t <= tSec && (tSec - p.t) * 1000 < FRESH_MS) recent.set(p.train, p);
      }
      return [...recent.values()].map((p) => ({
        trainCode: p.train,
        stationName: p.st,
        trainSttus: p.sttus,
        isUp: p.isUp,
        recptnMs: getNow(),
      }));
    },
  };
  return client as unknown as SeoulArrivalClient;
}

// 상행 7204: 건대입구(원점, 탑승) → 어린이대공원(세종대) → 군자(능동) → 중곡(목적지).
function makeLockTrip(): Trip {
  return {
    token: 'replay-pos-7204',
    route: { type: 'direct', line: '7', stops: 3 } as unknown as Trip['route'],
    destination: '중곡',
    waypoints: [
      { stationName: '어린이대공원(세종대)', line: '7', kind: 'intermediate' },
      { stationName: '군자(능동)', line: '7', kind: 'intermediate' },
      { stationName: '중곡', line: '7', kind: 'destination' },
    ],
    boardingLock: {
      trainCode: LOCK_TRAIN,
      line: '7',
      subwayId: '1007',
      selectedDepartureTime: NOW,
      segmentStations: SEGMENT,
      expiresAt: NOW + 60 * 60_000,
    },
    expiresAt: NOW + 60 * 60_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW,
  };
}

async function replayAtPhase(phaseOffsetSec: number): Promise<Set<string>> {
  const kv = new InMemoryKV();
  await putTrip(kv as unknown as KVNamespace, makeLockTrip());
  const fired = new Set<string>();
  let simNow = NOW;
  const client = makeReplayClient(() => simNow);
  const durationSec = fixture.durationSec as number;
  for (let t = phaseOffsetSec; t <= durationSec; t += 60) {
    simNow = NOW + t * 1000;
    await runScheduled(makeEnv(kv), {
      seoul: client,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      now: () => simNow,
      generatePushId: () => `p-${t}`,
      log: (msg: string, ctx?: Record<string, unknown>) => {
        // arvlCd 경로 + vanish-fallback(position 확증) 경로 둘 다 station-passed 발사로 집계.
        if (
          (msg === 'arvlcd-fire: station-passed push' ||
            msg === 'vanish-fallback-fire: station-passed push') &&
          ctx?.station
        ) {
          fired.add(String(ctx.station));
        }
      },
    });
  }
  return fired;
}

describe('실측 재생 — 7호선 매역 발사 (position 확증 fix 검증)', () => {
  const INTERMEDIATES = ['어린이대공원(세종대)', '군자(능동)'];
  const PHASES = [0, 15, 30, 45];

  it('#2571 — 모든 cron 위상에서 매 intermediate 역이 발사된다 (침묵 0)', async () => {
    const results: Record<number, string[]> = {};
    for (const phase of PHASES) {
      const fired = await replayAtPhase(phase);
      results[phase] = INTERMEDIATES.filter((s) => fired.has(s));
    }
    // eslint-disable-next-line no-console
    console.log('발사된 intermediate 역 (위상별):', JSON.stringify(results, null, 2));
    // 모든 위상에서 모든 intermediate 역이 발사돼야 한다 — 위상 무관 침묵 0.
    for (const phase of PHASES) {
      expect(results[phase].sort()).toEqual([...INTERMEDIATES].sort());
    }
  });
});

// 전 체인 E2E — 탭 → device register(POST /trips) → backend lock 부착 → cron(실 Seoul 재생) → 매역 알림.
// 라이드 없이 "디바이스에서 탭하면 백엔드까지 가서 알림 온다"를 실제 엔드포인트+실제 데이터로 증명한다.
// (APNs→물리 폰 배달만 제외 — 그것만이 진짜 실기기 의존 링크.)
describe('전 체인 E2E — 탭→register→lock부착→매역 알림 (라이드 0)', () => {
  const INTERMEDIATES = ['어린이대공원(세종대)', '군자(능동)'];

  // validateTrip은 expiresAt > 실제 Date.now()를 요구(POST 시점 검증). cron sim은 NOW(고정 anchor)
  // 기반이라 lock.expiresAt는 NOW보다 크기만 하면 active — 둘 다 실제-미래로 두면 양쪽 만족.
  const FUTURE = Date.now() + 2 * 60 * 60_000;

  // device가 BoardingTrainList 탭 후 registerActiveTrip으로 보내는 POST /trips 본문.
  function registerBody(token: string) {
    return {
      token,
      route: { type: 'direct', line: '7', stops: 3 },
      destination: '중곡',
      waypoints: [
        { stationName: '어린이대공원(세종대)', line: '7', kind: 'intermediate' },
        { stationName: '군자(능동)', line: '7', kind: 'intermediate' },
        { stationName: '중곡', line: '7', kind: 'destination' },
      ],
      expiresAt: FUTURE,
      alarmAtEpochMs: NOW,
      // 사용자가 탭한 실 열차(7204) → device buildBoardingLockMeta가 실 trainCode로 구성.
      boardingLock: {
        trainCode: LOCK_TRAIN,
        line: '7',
        subwayId: '1007',
        selectedDepartureTime: NOW,
        segmentStations: SEGMENT,
        expiresAt: FUTURE,
      },
    };
  }

  it('탭한 lock이 register(POST /trips)로 즉시 backend에 부착(active)된다 (B 링크)', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    const token = 'e2e-register';
    const res = await app.fetch(
      new Request('http://example.com/trips', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(registerBody(token)),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const trip = await getTrip(env.TRIPS, token);
    // B 확정: 탭 → register 즉시 lock 부착(늦게 아님). 실 trainCode라 buildBoardingLockMeta 성공 전제.
    expect(trip?.boardingLock?.trainCode).toBe(LOCK_TRAIN);
    expect(isBoardingLockActive(trip as Trip, NOW)).toBe(true);
  });

  it('register된 trip이 실 Seoul 재생 cron에서 매역 알림 발사 (B→C 전 체인)', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    const token = 'e2e-fullchain';
    // 1) 탭 → device register.
    await app.fetch(
      new Request('http://example.com/trips', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(registerBody(token)),
      }),
      env,
    );
    const registered = await getTrip(env.TRIPS, token);
    expect(isBoardingLockActive(registered as Trip, NOW)).toBe(true);

    // 2) cron(실 Seoul 7204 재생) — 위상 0으로 전 구간.
    const fired = new Set<string>();
    let simNow = NOW;
    const client = makeReplayClient(() => simNow);
    for (let t = 0; t <= (fixture.durationSec as number); t += 60) {
      simNow = NOW + t * 1000;
      await runScheduled(env, {
        seoul: client,
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
        now: () => simNow,
        generatePushId: () => `p-${t}`,
        log: (msg: string, ctx?: Record<string, unknown>) => {
          if (
            (msg === 'arvlcd-fire: station-passed push' ||
              msg === 'vanish-fallback-fire: station-passed push') &&
            ctx?.station
          ) {
            fired.add(String(ctx.station));
          }
        },
      });
    }
    // 전 체인 증명: 탭→register→부착→cron→매 intermediate 알림 발사.
    for (const s of INTERMEDIATES) expect(fired.has(s)).toBe(true);
  });
});
