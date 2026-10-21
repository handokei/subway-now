/**
 * WHOLE 다중환승 E2E (2026-09-13) — part 아닌 whole 검증.
 *
 * 사용자 요구: "part로 보지말고 whole로 안되는 지점 없는지." 개별 링크 테스트(register #585,
 * 발사 #2571, segment #2564, anchor #2568)를 넘어, **하나의 연속 cron 구동**으로 전 여정을 태운다:
 *   POST /trips(leg-1 lock) → leg-1 매 역 발사 → 환승역 advance(lock release + anchor)
 *   → /boarding-lock/sync(leg-2 trainCode) #2560 승격 → leg-2 매 역 발사 → 목적지 cleanup.
 *
 * 실 Seoul 샘플링(#2571)은 #2573이 실데이터로 증명 — 본 테스트는 **상태기계 연속성**(leg 전환·
 * 재부착·매역 발사가 끊김 없이 이어지는지)을 검증한다. 7호선(용마산→건대입구)→환승→2호선(성수→뚝섬).
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../index';
import { runScheduled } from '../scheduled';
import { isBoardingLockActive } from '../scheduled';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { getTrip } from '../trips';
import type { Env } from '../types';
import type { ArrivalEntry, PositionEntry, SeoulArrivalClient } from '../seoul';
import { InMemoryKV } from './inMemoryKv';

let apnsConfig: ApnsConfig;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: await exportPKCS8(privateKey), bundleId: 'com.example.app' };
  resetApnsJwtCache();
});

const NOW = 1_700_000_000_000;
const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' };
const FUTURE = () => Date.now() + 2 * 60 * 60_000;

const LEG1 = ['용마산', '중곡', '군자(능동)', '어린이대공원(세종대)', '건대입구'];

function makeEnv(kv: InMemoryKV): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
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

// 제어형 Seoul stub: 지정한 (station, trainCode)에 arvlCd=1(도착)을 반환. 그 외 역은 빈 배열.
// 테스트가 cron tick마다 "지금 열차가 도착한 역"을 지정해 열차 진행을 시뮬레이션한다.
function makeControlledSeoul(state: { arrivedStation: string; trainCode: string }): SeoulArrivalClient {
  const client = {
    stats: { callCount: 0, cacheSize: 0, httpErrorCount: 0 },
    async fetchArrivals(stationName: string): Promise<ArrivalEntry[]> {
      client.stats.callCount += 1;
      if (stationName !== state.arrivedStation) return [];
      return [
        {
          destination: '',
          arrivalSeconds: 0,
          trainCode: state.trainCode,
          isUp: true,
          subwayNm: '',
          subwayId: '1007',
          arvlCd: 1,
        },
      ];
    },
    async fetchPositions(_line: string): Promise<PositionEntry[]> {
      return [];
    },
  };
  return client as unknown as SeoulArrivalClient;
}

describe('WHOLE 다중환승 E2E — leg-1 발사 → 환승 → leg-2 발사 → 목적지 (연속 구동)', () => {
  it('전 여정에서 매 intermediate 발사 + 환승 handoff + leg-2 재부착, 끊기는 역 0', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    const token = 'whole-e2e';

    // 1) 목적지 설정 → 탭 → register (leg-1 7호선 lock). waypoints = leg-1 intermediates + 환승 + leg-2.
    const registerRes = await app.fetch(
      new Request('http://example.com/trips', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token,
          route: { type: 'transfer', fromLine: '7', toLine: '2', stopsToTransfer: 4 },
          destination: '뚝섬',
          waypoints: [
            { stationName: '중곡', line: '7', kind: 'intermediate' },
            { stationName: '군자(능동)', line: '7', kind: 'intermediate' },
            { stationName: '어린이대공원(세종대)', line: '7', kind: 'intermediate' },
            { stationName: '건대입구', line: '7', kind: 'transfer' },
            { stationName: '성수', line: '2', kind: 'intermediate' },
            { stationName: '뚝섬', line: '2', kind: 'destination' },
          ],
          expiresAt: FUTURE(),
          alarmAtEpochMs: NOW,
          boardingLock: {
            trainCode: 'TA7',
            line: '7',
            subwayId: '1007',
            selectedDepartureTime: NOW,
            segmentStations: LEG1,
            expiresAt: FUTURE(),
          },
        }),
      }),
      env,
    );
    expect(registerRes.status).toBe(200);
    const registered = await getTrip(env.TRIPS, token);
    expect(isBoardingLockActive(registered as Parameters<typeof isBoardingLockActive>[0], NOW)).toBe(true);

    const fired = new Set<string>();
    const seoulState = { arrivedStation: '', trainCode: 'TA7' };
    const seoul = makeControlledSeoul(seoulState);
    let tick = 0;
    async function cronArrivingAt(station: string, trainCode: string): Promise<void> {
      seoulState.arrivedStation = station;
      seoulState.trainCode = trainCode;
      tick += 1;
      const simNow = NOW + tick * 60_000;
      await runScheduled(env, {
        seoul,
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
        now: () => simNow,
        generatePushId: () => `p-${tick}`,
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

    // 2) leg-1: 열차가 중곡→군자→어린이대공원→건대입구 순으로 도착. 매 역 발사 + advance.
    await cronArrivingAt('중곡', 'TA7');
    await cronArrivingAt('군자(능동)', 'TA7');
    await cronArrivingAt('어린이대공원(세종대)', 'TA7');
    // 3) 환승역(건대입구) 도착 → advance 시 lock release(7→2 실노선변경) + currentLegAnchor stamp.
    await cronArrivingAt('건대입구', 'TA7');

    const afterTransfer = await getTrip(env.TRIPS, token);
    // 환승 후 leg-1 lock 해제 + leg-2 anchor stamp 확인.
    expect(afterTransfer?.boardingLock).toBeUndefined();
    expect(afterTransfer?.currentLegAnchor).toEqual({ boardingStation: '건대입구', line: '2' });

    // 4) 사용자가 leg-2 열차 탭 → device가 /boarding-lock/sync로 leg-2 trainCode 전송 → #2560 승격.
    const syncRes = await app.fetch(
      new Request('http://example.com/boarding-lock/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token,
          observedStationName: '건대입구',
          observedAtMs: NOW + tick * 60_000,
          accuracy: 20,
          trainCode: 'TB2',
          boardingLine: '2',
        }),
      }),
      env,
    );
    expect(syncRes.status).toBe(200);
    const afterSync = await getTrip(env.TRIPS, token);
    expect(afterSync?.boardingLock?.trainCode).toBe('TB2');
    expect(afterSync?.boardingLock?.line).toBe('2');
    expect(isBoardingLockActive(afterSync as Parameters<typeof isBoardingLockActive>[0], NOW)).toBe(true);

    // 5) leg-2: 열차가 성수 도착 → 발사 + advance → 뚝섬(목적지) 도착 → cleanup.
    await cronArrivingAt('성수', 'TB2');
    await cronArrivingAt('뚝섬', 'TB2');

    // WHOLE 검증: leg-1 + leg-2 모든 intermediate가 발사됨(끊기는 역 0).
    for (const st of ['중곡', '군자(능동)', '어린이대공원(세종대)', '성수']) {
      expect(fired.has(st)).toBe(true);
    }
    // 목적지 도착 → trip cleanup(삭제).
    const final = await getTrip(env.TRIPS, token);
    expect(final).toBeNull();
  });
});
