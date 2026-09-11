/**
 * #2564 (ADR-038 Phase 2) — 다중 환승(leg-2/3/4/5+) 아키텍처 검증.
 *
 * 사용자 요구(2026-09-11): "leg-2,3,4,5 등 다환승 경로도 아무 문제 없도록 아키텍처를."
 *
 * 확정 아키텍처의 leg 처리는 **leg 번호에 무관하게 균일**해야 한다:
 *   각 leg = 탭 → /boarding-lock/sync trainCode → #2560 lock 승격 → cron 추적 →
 *   transfer advance(isRealLineChange) → leg-N lock release → 다음 leg 반복.
 *
 * 본 테스트는 그 균일성의 핵심 불변식을 증명한다:
 *   (1) `buildLockFromKnownTrainCode`가 임의 leg의 segment를 그 leg 노선으로만 격리한다
 *       (다음 leg 노선으로 새지 않음 — line 경계 break). leg-1/2/3 동일 로직.
 *   (2) sync 엔드포인트가 leg-2/leg-3 상태(waypoints가 그 leg 선두)에서도 lock을 승격한다.
 *
 * 이게 pass면 leg 개수와 무관하게 #2560 승격이 동작함이 확정된다(leg-agnostic).
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../index';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { buildLockFromKnownTrainCode } from '../boardingAnchorResolver';
import { isBoardingLockActive } from '../scheduled';
import { getTrip, putTrip } from '../trips';
import type { Env, Trip, Waypoint } from '../types';
import { InMemoryKV } from './inMemoryKv';

let apnsConfig: ApnsConfig;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  const pem = await exportPKCS8(privateKey);
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: pem, bundleId: 'com.example.app' };
});
beforeEach(() => resetApnsJwtCache());

const NOW = Date.now();

function makeEnv(kv: InMemoryKV): Env {
  return {
    TRIPS: kv as unknown as Env['TRIPS'],
    APNS_HOST: 'api.push.apple.com',
    APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
    SEOUL_API_HOST: 'seoul.api',
    SEOUL_API_KEY: 'KEY',
    APNS_KEY_ID: 'K',
    APNS_TEAM_ID: 'T',
    APNS_PRIVATE_KEY: apnsConfig.privateKeyPem,
    APNS_BUNDLE_ID: 'com.example.app',
  };
}

// 합성 3-leg(2환승) trip: 7호선 → [환승1] → 2호선 → [환승2] → 5호선.
// transfer waypoint line = 그 시점 탑승 노선(fromLine) — buildTransfer 규약.
const FULL_WAYPOINTS: Waypoint[] = [
  { stationName: 'A1', line: '7', kind: 'intermediate' },
  { stationName: 'A2', line: '7', kind: 'intermediate' },
  { stationName: 'T1', line: '7', kind: 'transfer' },
  { stationName: 'B1', line: '2', kind: 'intermediate' },
  { stationName: 'T2', line: '2', kind: 'transfer' },
  { stationName: 'C1', line: '5', kind: 'intermediate' },
  { stationName: 'C2', line: '5', kind: 'destination' },
];

describe('#2564 다중 환승 아키텍처 — buildLockFromKnownTrainCode leg 격리 (leg-agnostic)', () => {
  it('leg-1(7호선): segment가 7호선 구간(A1..T1)으로만 격리, 2/5호선 미포함', () => {
    const lock = buildLockFromKnownTrainCode(FULL_WAYPOINTS, 'TA', '7', 'ORIGIN7', NOW);
    expect(lock).not.toBeNull();
    expect(lock?.line).toBe('7');
    // 관측역(ORIGIN7) prepend + 7호선 waypoints(transfer 포함, 그 뒤 break).
    expect(lock?.segmentStations).toEqual(['ORIGIN7', 'A1', 'A2', 'T1']);
  });

  it('leg-2(2호선): leg-1 소진 후 waypoints에서 2호선 구간(B1..T2)만 격리', () => {
    const leg2Waypoints = FULL_WAYPOINTS.slice(3); // [B1(2), T2(2,transfer), C1(5), C2(5,dest)]
    const lock = buildLockFromKnownTrainCode(leg2Waypoints, 'TB', '2', 'T1', NOW);
    expect(lock?.line).toBe('2');
    // 5호선(C1/C2)으로 새지 않음 — line 경계 break.
    expect(lock?.segmentStations).toEqual(['T1', 'B1', 'T2']);
  });

  it('leg-3(5호선): 마지막 leg segment(C1..C2 destination)만 격리', () => {
    const leg3Waypoints = FULL_WAYPOINTS.slice(5); // [C1(5), C2(5,dest)]
    const lock = buildLockFromKnownTrainCode(leg3Waypoints, 'TC', '5', 'T2', NOW);
    expect(lock?.line).toBe('5');
    expect(lock?.segmentStations).toEqual(['T2', 'C1', 'C2']);
  });

  it('leg 노선이 현재 waypoints 선두와 불일치(stale)면 null — 안전', () => {
    const leg3Waypoints = FULL_WAYPOINTS.slice(5); // line 5만
    // 이미 지나온 7호선 trainCode가 늦게 도착 → 선두 line(5)에 7호선 segment 없음 → null.
    const lock = buildLockFromKnownTrainCode(leg3Waypoints, 'STALE7', '7', 'X', NOW);
    expect(lock).toBeNull();
  });
});

describe('#2564 다중 환승 — sync 엔드포인트가 leg-2/leg-3 상태에서도 lock 승격', () => {
  function tripInLegState(token: string, waypoints: Waypoint[]): Trip {
    return {
      token,
      route: { type: 'multi-transfer', transfers: [] } as unknown as Trip['route'],
      destination: 'C2',
      waypoints,
      expiresAt: NOW + 60 * 60_000,
      createdAt: NOW - 10 * 60_000,
      alarmAtEpochMs: NOW,
      infoModeEnabled: true,
    };
  }

  async function syncPromote(
    env: Env,
    token: string,
    observedStation: string,
    trainCode: string,
    boardingLine: string,
  ): Promise<number> {
    const res = await app.fetch(
      new Request('http://example.com/boarding-lock/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token,
          observedStationName: observedStation,
          observedAtMs: NOW,
          accuracy: 20,
          trainCode,
          boardingLine,
        }),
      }),
      env,
    );
    return res.status;
  }

  it('leg-2 상태(2호선 선두) + sync trainCode(2) → leg-2 lock 승격 active', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    await putTrip(kv as unknown as KVNamespace, tripInLegState('ml-leg2', FULL_WAYPOINTS.slice(3)));
    expect(await syncPromote(env, 'ml-leg2', 'T1', 'TB', '2')).toBe(200);
    const t = await getTrip(env.TRIPS, 'ml-leg2');
    expect(t?.boardingLock?.trainCode).toBe('TB');
    expect(t?.boardingLock?.line).toBe('2');
    expect(isBoardingLockActive(t as Trip, NOW)).toBe(true);
  });

  it('leg-3 상태(5호선 선두) + sync trainCode(5) → leg-3 lock 승격 active', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    await putTrip(kv as unknown as KVNamespace, tripInLegState('ml-leg3', FULL_WAYPOINTS.slice(5)));
    expect(await syncPromote(env, 'ml-leg3', 'T2', 'TC', '5')).toBe(200);
    const t = await getTrip(env.TRIPS, 'ml-leg3');
    expect(t?.boardingLock?.trainCode).toBe('TC');
    expect(t?.boardingLock?.line).toBe('5');
    expect(isBoardingLockActive(t as Trip, NOW)).toBe(true);
  });
});
