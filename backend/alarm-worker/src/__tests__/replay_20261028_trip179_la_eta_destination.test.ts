/**
 * #2747 PR-6 (C1') — LA "약 N분" = 목적지(하차역)까지 남은 시간. 10/28 아침 trip 179 실측 replay.
 *
 * 증상: 06:29:46 잠금화면 "약 2분 · 5정거장 남음". 실제 뚝섬 도착은 약 15분 뒤(06:45). backend LA push의
 * etaMinutes가 다음 waypoint(군자, barvlDt=120)까지의 시간이라 목적지 의미(device mirror writer)와 충돌했다.
 *
 * fixture(`fixtures/capture_20261028_trip179/*.arrival.json`)는 R2 `seoul-capture/2026-10-27`
 * (UTC 키, 06:29 KST cycle 1793136585084 / 06:44 KST cycle 1793137485817)의 서울 열린데이터
 * `realtimeStationArrival` 원본 응답 body다(API 키 없음). **불변** — 통과시키려고 조정 금지.
 *
 * 계약: device `routeToWaypoints`가 stamp한 `remainingSecToDest` → backend `validateTrip` 통과 →
 * LA push `etaMinutes` = (다음 waypoint ETA + 그 waypoint의 remainingSecToDest). 양쪽 모두 optional이라
 * 필드 없는 구 trip·추론 경로는 etaMinutes를 생략한다(위젯은 `if let`으로 블록을 숨김).
 */
import fs from 'node:fs';
import path from 'node:path';
import { exportPKCS8, generateKeyPair } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApnsConfig } from '../apns';
import { resetApnsJwtCache } from '../apns';
import { validateTrip } from '../index';
import { SeoulArrivalClient } from '../seoul';
import { createEmptyScheduledStats, maybeFireLiveActivityUpdate, type ScheduledDeps } from '../scheduled';
import type { Trip } from '../types';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'capture_20261028_trip179');
const KST_OFFSET_MS = 9 * 60 * 60_000;
/** 06:29:46 KST — 스크린샷(IMG_9693) 시각. 군자 cycle(06:29:45) 직후 push. */
const PUSH_AT = Date.UTC(2026, 9, 28, 6, 29, 46) - KST_OFFSET_MS;
const TOLERANCE_MIN = 2;

interface RawRow {
  recptnDt: string;
  btrainNo: string;
  barvlDt: string;
}

function loadRows(file: string): RawRow[] {
  const body = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8')) as {
    realtimeArrivalList: RawRow[];
  };
  return body.realtimeArrivalList;
}

function kstEpoch(recptnDt: string): number {
  const [d, t] = recptnDt.split(' ');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi, s] = t.split(':').map(Number);
  return Date.UTC(y, mo - 1, da, h, mi, s) - KST_OFFSET_MS;
}

let apnsConfig: ApnsConfig;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: await exportPKCS8(privateKey), bundleId: 'com.example.app' };
});
beforeEach(() => resetApnsJwtCache());

/** 실측 도착 시각 = 열차 3013(1호선 환승 후 2호선 외선)의 뚝섬 마지막 관측 recptn + barvlDt. */
function actualDestinationArrival(): number {
  const row = loadRows('뚝섬.arrival.json').find((r) => r.btrainNo === '3013');
  if (!row) throw new Error('fixture: 열차 3013 뚝섬 행 없음');
  return kstEpoch(row.recptnDt) + Number(row.barvlDt) * 1000;
}

function nextWaypointEtaSec(): number {
  const row = loadRows('군자.arrival.json').find((r) => r.btrainNo === '7035');
  if (!row) throw new Error('fixture: 열차 7035 군자 행 없음');
  return Number(row.barvlDt);
}

/**
 * device 등록 payload 계약 fixture(device 테스트가 `routeToWaypoints` 출력과 같은 파일로 대조)
 * -> backend validateTrip -> wp0=군자 상태. (backend는 device stationRoute를 import하지 않는다.)
 */
function tripAtGunja(stripRemaining = false): Trip {
  const contract = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'device_waypoints.contract.json'), 'utf8')) as {
    route: unknown;
    waypoints: Record<string, unknown>[];
  };
  const registered = contract.waypoints.map((wp) => {
    if (!stripRemaining) return wp;
    const { remainingSecToDest: _omit, ...rest } = wp;
    return rest;
  });
  const trip = validateTrip({
    token: 'trip179',
    destination: '뚝섬',
    route: contract.route,
    waypoints: registered,
    expiresAt: Date.now() + 3_600_000, // validateTrip은 실시계 기준으로 만료 검사
    alarmAtEpochMs: PUSH_AT + 60_000,
  });
  if (!trip) throw new Error('validateTrip rejected the device payload');
  return {
    ...trip,
    activityPushToken: 'la-token',
    activityState: 'live',
    apnsEnv: 'sandbox',
    originStationName: '중곡',
  };
}

async function fireAndReadEtaMinutes(trip: Trip, etaToWaypointKnown?: boolean): Promise<unknown> {
  const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
  const deps = {
    apnsConfig,
    apnsHosts: { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' },
    fetchImpl: fetchImpl as unknown as typeof fetch,
    seoul: new SeoulArrivalClient({ host: 'h', apiKey: 'K', fetchImpl: fetchImpl as unknown as typeof fetch }),
  } as ScheduledDeps;
  const stats = createEmptyScheduledStats(PUSH_AT);
  const args = [
    trip,
    trip.waypoints[0],
    PUSH_AT + nextWaypointEtaSec() * 1000,
    deps,
    stats,
    PUSH_AT,
    () => {},
    null,
  ] as const;
  const fired = await (etaToWaypointKnown === undefined
    ? maybeFireLiveActivityUpdate(...args)
    : maybeFireLiveActivityUpdate(...args, etaToWaypointKnown));
  expect(fired).toBe(true);
  const calls = (fetchImpl.mock.calls as unknown as [string, RequestInit][]).filter(([, init]) =>
    String(init?.body).includes('content-state'),
  );
  expect(calls).toHaveLength(1);
  const body = JSON.parse(calls[0][1].body as string) as { aps: { 'content-state': Record<string, unknown> } };
  return body.aps['content-state'].etaMinutes;
}

describe('#2747 PR-6 — trip 179 06:29:46 LA etaMinutes = 목적지(뚝섬)까지', () => {
  it('device stamp 필드가 validateTrip을 통과해 waypoint마다 보존된다 (device payload <-> backend validate 계약)', () => {
    const trip = tripAtGunja();
    expect(trip.waypoints.map((w) => w.stationName)).toEqual(['군자(능동)', '어린이대공원(세종대)', '건대입구', '성수', '뚝섬']);
    for (const wp of trip.waypoints) {
      expect(typeof wp.remainingSecToDest).toBe('number');
    }
    expect(trip.waypoints[trip.waypoints.length - 1].remainingSecToDest).toBe(0);
  });

  it('acceptance: etaMinutes == (실측 뚝섬 도착 − push 시각) ±2분 (약 15분, 예전 2분)', async () => {
    const actualMin = (actualDestinationArrival() - PUSH_AT) / 60_000;
    expect(actualMin).toBeGreaterThan(14); // 실측 sanity: 약 15.4분
    const etaMinutes = await fireAndReadEtaMinutes(tripAtGunja());
    expect(typeof etaMinutes).toBe('number');
    expect(Math.abs((etaMinutes as number) - actualMin)).toBeLessThanOrEqual(TOLERANCE_MIN);
  });

  it('거부: remainingSecToDest 없는 구 trip(추론 경로 포함)은 etaMinutes를 생략한다 (wp0 ETA "2분"을 목적지 값으로 내보내지 않는다)', async () => {
    const etaMinutes = await fireAndReadEtaMinutes(tripAtGunja(true));
    expect(etaMinutes).toBeUndefined();
  });

  it('거부: wp0 ETA를 모르는 lock-missing heartbeat(newArrivalEpoch=now)는 필드가 있어도 etaMinutes를 생략한다', async () => {
    const etaMinutes = await fireAndReadEtaMinutes(tripAtGunja(), false);
    expect(etaMinutes).toBeUndefined();
  });
});

describe('#2747 PR-6 — validateTrip remainingSecToDest 검증', () => {
  const base = (remainingSecToDest: unknown) => ({
    token: 'tok',
    destination: '뚝섬',
    route: { type: 'direct', line: '2', stops: 1 },
    waypoints: [{ stationName: '뚝섬', line: '2', kind: 'destination', remainingSecToDest }],
    expiresAt: Date.now() + 3_600_000, // validateTrip은 실시계 기준으로 만료 검사
    alarmAtEpochMs: PUSH_AT + 60_000,
  });

  it('유한 비음수 숫자는 그대로 보존', () => {
    expect(validateTrip(base(0))?.waypoints[0].remainingSecToDest).toBe(0);
    expect(validateTrip(base(780))?.waypoints[0].remainingSecToDest).toBe(780);
  });

  it.each([['문자열', '780'], ['음수', -1], ['null', null], ['객체', {}], ['Infinity는 JSON 불가라 문자열 취급', 'Infinity']])(
    '거부: %s -> 필드 제거(등록 자체는 성공)',
    (_label, bad) => {
      const trip = validateTrip(base(bad));
      expect(trip).not.toBeNull();
      expect(trip?.waypoints[0]).not.toHaveProperty('remainingSecToDest');
    },
  );
});
