/**
 * WHOLE 3-leg (2환승) E2E (2026-09-13) — leg-N 부착 가능 검증.
 *
 * 사용자 요구: "leg-n 부착이여도 가능하게 되어야해." leg-2뿐 아니라 임의 leg-N(leg-3+)도 부착+
 * 발사돼야 한다. currentLegAnchor는 매 환승마다 덮어써 항상 "지금" leg를 가리키고(scheduled.ts:4913),
 * attemptBoardingAnchorResolution/sync 승격(#2560)은 그 anchor를 쓰므로 leg 번호 무관(leg-agnostic).
 * 본 테스트는 그 leg-agnostic성을 **한 번의 연속 cron 구동**으로 leg-3까지 증명한다:
 *   7호선(leg-1) → 건대입구 환승 → 2호선(leg-2) → 왕십리 환승 → 5호선(leg-3) → 목적지.
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../index';
import { runScheduled, isBoardingLockActive } from '../scheduled';
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

function makeControlledSeoul(state: { arrivedStation: string; trainCode: string }): SeoulArrivalClient {
  const client = {
    stats: { callCount: 0, cacheSize: 0, httpErrorCount: 0 },
    async fetchArrivals(stationName: string): Promise<ArrivalEntry[]> {
      client.stats.callCount += 1;
      if (stationName !== state.arrivedStation) return [];
      return [{ destination: '', arrivalSeconds: 0, trainCode: state.trainCode, isUp: true, subwayNm: '', subwayId: '1007', arvlCd: 1 }];
    },
    async fetchPositions(_line: string): Promise<PositionEntry[]> {
      return [];
    },
  };
  return client as unknown as SeoulArrivalClient;
}

describe('WHOLE 3-leg E2E — leg-1→환승→leg-2→환승→leg-3→목적지 (leg-N 부착)', () => {
  it('2환승 전 여정에서 매 leg 부착+매역 발사, currentLegAnchor 2회 전진, 끊기는 역 0', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    const token = 'whole-3leg';

    // register: 7호선 leg-1(군자→어린이대공원→건대입구 환승) + 2호선 leg-2(성수→왕십리 환승) + 5호선 leg-3(마장→답십리).
    const res = await app.fetch(
      new Request('http://example.com/trips', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token,
          route: { type: 'multi-transfer', transfers: [
            { fromLine: '7', toLine: '2', stopsToTransfer: 2, transferStation: '건대입구' },
            { fromLine: '2', toLine: '5', stopsToTransfer: 1, transferStation: '왕십리(성동구청)' },
          ] },
          destination: '답십리',
          waypoints: [
            { stationName: '어린이대공원(세종대)', line: '7', kind: 'intermediate' },
            { stationName: '건대입구', line: '7', kind: 'transfer' },
            { stationName: '성수', line: '2', kind: 'intermediate' },
            { stationName: '왕십리(성동구청)', line: '2', kind: 'transfer' },
            { stationName: '마장', line: '5', kind: 'intermediate' },
            { stationName: '답십리', line: '5', kind: 'destination' },
          ],
          expiresAt: FUTURE(),
          alarmAtEpochMs: NOW,
          boardingLock: {
            trainCode: 'TA7', line: '7', subwayId: '1007', selectedDepartureTime: NOW,
            segmentStations: ['군자(능동)', '어린이대공원(세종대)', '건대입구'], expiresAt: FUTURE(),
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(isBoardingLockActive((await getTrip(env.TRIPS, token)) as Parameters<typeof isBoardingLockActive>[0], NOW)).toBe(true);

    const fired = new Set<string>();
    const seoulState = { arrivedStation: '', trainCode: 'TA7' };
    const seoul = makeControlledSeoul(seoulState);
    let tick = 0;
    async function cronAt(station: string, trainCode: string): Promise<void> {
      seoulState.arrivedStation = station;
      seoulState.trainCode = trainCode;
      tick += 1;
      const simNow = NOW + tick * 60_000;
      await runScheduled(env, {
        seoul, apnsConfig, apnsHosts: APNS_HOSTS,
        fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
        now: () => simNow, generatePushId: () => `p-${tick}`,
        log: (msg: string, ctx?: Record<string, unknown>) => {
          if ((msg === 'arvlcd-fire: station-passed push' || msg === 'vanish-fallback-fire: station-passed push') && ctx?.station) {
            fired.add(String(ctx.station));
          }
        },
      });
    }
    async function syncLeg(observedStation: string, trainCode: string, boardingLine: string): Promise<void> {
      await app.fetch(
        new Request('http://example.com/boarding-lock/sync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token, observedStationName: observedStation, observedAtMs: NOW + tick * 60_000, accuracy: 20, trainCode, boardingLine }),
        }),
        env,
      );
    }

    // leg-1: 어린이대공원 발사 → 건대입구 환승(release + anchor{건대입구,2}).
    await cronAt('어린이대공원(세종대)', 'TA7');
    await cronAt('건대입구', 'TA7');
    const t1 = await getTrip(env.TRIPS, token);
    expect(t1?.boardingLock).toBeUndefined();
    expect(t1?.currentLegAnchor).toEqual({ boardingStation: '건대입구', line: '2' });

    // leg-2 재부착(sync) → 성수 발사 → 왕십리 환승(release + anchor{왕십리,5}).
    await syncLeg('건대입구', 'TB2', '2');
    expect((await getTrip(env.TRIPS, token))?.boardingLock?.trainCode).toBe('TB2');
    await cronAt('성수', 'TB2');
    await cronAt('왕십리(성동구청)', 'TB2');
    const t2 = await getTrip(env.TRIPS, token);
    expect(t2?.boardingLock).toBeUndefined();
    expect(t2?.currentLegAnchor).toEqual({ boardingStation: '왕십리(성동구청)', line: '5' });

    // leg-3 재부착(sync) → 마장 발사 → 답십리 목적지 cleanup. (leg-N=3 부착 증명)
    await syncLeg('왕십리(성동구청)', 'TC5', '5');
    const t3 = await getTrip(env.TRIPS, token);
    expect(t3?.boardingLock?.trainCode).toBe('TC5');
    expect(t3?.boardingLock?.line).toBe('5');
    expect(isBoardingLockActive(t3 as Parameters<typeof isBoardingLockActive>[0], NOW)).toBe(true);
    await cronAt('마장', 'TC5');
    await cronAt('답십리', 'TC5');

    // WHOLE: leg-1/2/3 모든 intermediate 발사(끊기는 역 0) + 목적지 cleanup.
    for (const st of ['어린이대공원(세종대)', '성수', '마장']) expect(fired.has(st)).toBe(true);
    expect(await getTrip(env.TRIPS, token)).toBeNull();
  });

  // 3번 강화 — device sync/재탭 없이 backend가 realtimePosition streak만으로 leg-N lock 부착.
  // currentLegAnchor(leg-agnostic) + attemptBoardingAnchorResolution + LEG_RESOLVE_STREAK_THRESHOLD=2.
  it('device-독립: 환승 후 sync 없이 Seoul positions streak(2회)만으로 leg-2 lock 자동 부착', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    const token = 'streak-leg2';
    // leg-2 상태를 직접 구성: lock 해제됨 + currentLegAnchor{건대입구,2} + walk-gate 이미 통과 + infoMode.
    await kv.put(
      `trip:${token}`,
      JSON.stringify({
        token,
        route: { type: 'transfer', fromLine: '7', toLine: '2', stopsToTransfer: 0 },
        destination: '왕십리(성동구청)',
        waypoints: [
          { stationName: '성수', line: '2', kind: 'intermediate' },
          { stationName: '왕십리(성동구청)', line: '2', kind: 'destination' },
        ],
        expiresAt: FUTURE(),
        createdAt: NOW - 10 * 60_000,
        alarmAtEpochMs: NOW,
        infoModeEnabled: true,
        currentLegAnchor: { boardingStation: '건대입구', line: '2' },
        legBoardingEligibleAt: NOW - 60_000, // walk-gate 이미 통과
      }),
    );

    // Seoul positions: 건대입구(anchor)에 line-2 열차 TB2 정확히 1대(unambiguous). 양방향 모두 제공해도
    // resolveTrainCodeFromPositions는 direction 필터 후 1대면 resolved — 여기선 direction 무관하게
    // 1대만 두어 확실히 resolved.
    const posClient = {
      stats: { callCount: 0, cacheSize: 0, httpErrorCount: 0 },
      async fetchArrivals(): Promise<ArrivalEntry[]> {
        return [];
      },
      async fetchPositions(line: string): Promise<PositionEntry[]> {
        if (line !== '2') return [];
        return [{ trainCode: 'TB2', stationName: '건대입구', trainSttus: 1, isUp: true, recptnMs: NOW }];
      },
    } as unknown as SeoulArrivalClient;

    async function tick(n: number): Promise<void> {
      await runScheduled(env, {
        seoul: posClient, apnsConfig, apnsHosts: APNS_HOSTS,
        fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
        now: () => NOW + n * 60_000, generatePushId: () => `s-${n}`,
      });
    }

    // cycle 1: streak pending(1). cycle 2: streak=2 → 승격.
    await tick(1);
    await tick(2);
    const promoted = await getTrip(env.TRIPS, token);
    expect(promoted?.boardingLock?.trainCode).toBe('TB2');
    expect(promoted?.boardingLock?.line).toBe('2');
    expect(isBoardingLockActive(promoted as Parameters<typeof isBoardingLockActive>[0], NOW)).toBe(true);
  });
});
