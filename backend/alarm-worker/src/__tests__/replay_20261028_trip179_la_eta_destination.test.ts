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

async function fireAndReadEtaMinutes(
  trip: Trip,
  etaToWaypointKnown?: boolean,
  /** wp0(군자)까지 lock 열차 실시간 ETA(초) — 미지정이면 실측 fixture 값(7035, 120초). */
  etaSec: number = nextWaypointEtaSec(),
): Promise<unknown> {
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
    PUSH_AT + etaSec * 1000,
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

/**
 * #1480 PR-E (B2) — 환승 대기를 push마다 재선택.
 *
 * device는 건대입구(환승) waypoint에 "2호선 해당 방향 시간표 다음 출발 K=6개 / 도보+buffer / 대기 제외 주행"을 stamp한다
 * (값은 device `routeWaypoints.transferReselect.test.ts`가 같은 실측 등록 시각으로 고정). backend는 lock 열차(7035)의
 * 실시간 건대입구 도착 추정 + 도보 이후의 첫 출발을 매 push 다시 고른다 -> 열차가 늦으면 다음 출발로 밀려 etaMinutes가 늘어난다.
 */
describe('#1480 PR-E — LA etaMinutes가 환승 대기를 push마다 재선택한다', () => {
  const DEPARTURES_EPOCH_SEC = [1793137260, 1793137620, 1793138160, 1793138400, 1793138760, 1793139060]; // 06:41 06:47 06:56 07:00 07:06 07:11
  const TRANSFER_FIELDS = { nextLegDeparturesEpochSec: DEPARTURES_EPOCH_SEC, transferWalkSec: 308, rideSecToDest: 210 };
  const pushEpochSec = PUSH_AT / 1000;

  /** 건대입구 waypoint에 재선택 재료를 얹은 등록 payload -> validateTrip. */
  function tripWithTransferFields(extra: Record<string, unknown> = TRANSFER_FIELDS): Trip {
    const contract = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'device_waypoints.contract.json'), 'utf8')) as {
      route: unknown;
      waypoints: Record<string, unknown>[];
    };
    const waypoints = contract.waypoints.map((wp) =>
      wp.kind === 'transfer' ? { ...wp, ...extra } : wp,
    );
    const trip = validateTrip({
      token: 'trip179',
      destination: '뚝섬',
      route: contract.route,
      waypoints,
      expiresAt: Date.now() + 3_600_000,
      alarmAtEpochMs: PUSH_AT + 60_000,
    });
    if (!trip) throw new Error('validateTrip rejected the payload');
    return { ...trip, activityPushToken: 'la-token', activityState: 'live', apnsEnv: 'sandbox', originStationName: '중곡' };
  }
  const minutesOf = (seconds: number) => Math.max(0, Math.round(seconds / 60));
  /** 새 필드를 모르는 구 trip이 같은 입력에서 내는 값(기존 동작: eta + remainingSecToDest). */
  const legacyMinutes = (etaSec: number) => minutesOf(etaSec + 840);

  it('제시간: lock 열차가 예상대로 도착하면 0641을 고른다 -> (0641 − push) + 주행 210s ≈ 15분, 실측(15.4분) ±2분', async () => {
    const etaMinutes = await fireAndReadEtaMinutes(tripWithTransferFields());
    expect(etaMinutes).toBe(minutesOf(DEPARTURES_EPOCH_SEC[0] - pushEpochSec + 210));
    const actualMin = (actualDestinationArrival() - PUSH_AT) / 60_000;
    expect(Math.abs((etaMinutes as number) - actualMin)).toBeLessThanOrEqual(TOLERANCE_MIN);
  });

  it('지연: 7035의 건대입구 도착이 9분 늦어지면 다음 출발(0656)로 밀려 etaMinutes가 늘어난다 (구 동작보다 크다)', async () => {
    const lateEtaSec = nextWaypointEtaSec() + 9 * 60;
    // cursor = push + lateEta + 군자→건대입구 240s + 도보 308s = 06:49:54 -> 첫 출발 ≥ cursor = 06:56
    const expected = minutesOf(DEPARTURES_EPOCH_SEC[2] - pushEpochSec + 210);
    const etaMinutes = await fireAndReadEtaMinutes(tripWithTransferFields(), undefined, lateEtaSec);
    expect(etaMinutes).toBe(expected);
    expect(etaMinutes as number).toBeGreaterThan(legacyMinutes(lateEtaSec));
  });

  it('경계: 도보 이후 시각이 출발과 정확히 같으면 그 열차를 탄다 (같은 분 boardable)', async () => {
    // cursor == 0647 이 되도록: 0647 − push − 240 − 308
    const etaSec = DEPARTURES_EPOCH_SEC[1] - pushEpochSec - 240 - 308;
    const etaMinutes = await fireAndReadEtaMinutes(tripWithTransferFields(), undefined, etaSec);
    expect(etaMinutes).toBe(minutesOf(DEPARTURES_EPOCH_SEC[1] - pushEpochSec + 210));
  });

  it('K 소진: 모든 출발이 지난 뒤면 재선택을 포기하고 구 동작(eta + remainingSecToDest)으로 폴백한다', async () => {
    const etaSec = 4000;
    const etaMinutes = await fireAndReadEtaMinutes(tripWithTransferFields(), undefined, etaSec);
    expect(etaMinutes).toBe(legacyMinutes(etaSec));
  });

  it('구 trip(새 필드 없음)은 무변경: 지연 입력에서도 eta + remainingSecToDest', async () => {
    const lateEtaSec = nextWaypointEtaSec() + 9 * 60;
    const etaMinutes = await fireAndReadEtaMinutes(tripAtGunja(), undefined, lateEtaSec);
    expect(etaMinutes).toBe(legacyMinutes(lateEtaSec));
  });

  it('wp0 ETA를 모르는 heartbeat(etaToWaypointKnown=false)는 새 필드가 있어도 etaMinutes를 생략한다', async () => {
    expect(await fireAndReadEtaMinutes(tripWithTransferFields(), false)).toBeUndefined();
  });

  it('KV 쓰기 +0: 재선택은 trip 상태를 바꾸지 않는다 (waypoints 불변, 등록 payload에 얹힌 값만 읽음)', async () => {
    const trip = tripWithTransferFields();
    const before = JSON.stringify(trip.waypoints);
    await fireAndReadEtaMinutes(trip, undefined, nextWaypointEtaSec() + 9 * 60);
    expect(JSON.stringify(trip.waypoints)).toBe(before);
  });

  describe('validateTrip — 새 optional 필드 검증 (잘못된 값은 제거, 등록은 거부 안 함)', () => {
    const transferOf = (trip: Trip) => trip.waypoints.find((w) => w.kind === 'transfer')!;

    it('유효한 값은 그대로 보존 (구 remainingSecToDest 포함)', () => {
      const wp = transferOf(tripWithTransferFields());
      expect(wp.nextLegDeparturesEpochSec).toEqual(DEPARTURES_EPOCH_SEC);
      expect(wp.transferWalkSec).toBe(308);
      expect(wp.rideSecToDest).toBe(210);
      expect(wp.remainingSecToDest).toBe(600);
    });

    it.each([
      ['배열이 아닌 값', { ...TRANSFER_FIELDS, nextLegDeparturesEpochSec: '1793137260' }],
      ['비유한 원소 포함', { ...TRANSFER_FIELDS, nextLegDeparturesEpochSec: [1793137260, null] }],
      ['음수 원소 포함', { ...TRANSFER_FIELDS, nextLegDeparturesEpochSec: [-1] }],
      ['빈 배열', { ...TRANSFER_FIELDS, nextLegDeparturesEpochSec: [] }],
    ])('거부: %s -> 새 필드 묶음 전체 제거(재선택 불가 = 구 동작), 등록은 성공', (_label, bad) => {
      const wp = transferOf(tripWithTransferFields(bad));
      expect(wp).not.toHaveProperty('nextLegDeparturesEpochSec');
      expect(wp).not.toHaveProperty('transferWalkSec');
      expect(wp).not.toHaveProperty('rideSecToDest');
      expect(wp.remainingSecToDest).toBe(600);
    });

    it.each([
      ['transferWalkSec 음수', { ...TRANSFER_FIELDS, transferWalkSec: -1 }],
      ['transferWalkSec 문자열', { ...TRANSFER_FIELDS, transferWalkSec: '308' }],
      ['rideSecToDest 음수', { ...TRANSFER_FIELDS, rideSecToDest: -5 }],
      ['rideSecToDest null', { ...TRANSFER_FIELDS, rideSecToDest: null }],
    ])('거부: %s -> 새 필드 묶음 전체 제거', (_label, bad) => {
      const wp = transferOf(tripWithTransferFields(bad));
      expect(wp).not.toHaveProperty('nextLegDeparturesEpochSec');
      expect(wp).not.toHaveProperty('transferWalkSec');
      expect(wp).not.toHaveProperty('rideSecToDest');
    });

    it('일부만 있으면(셋 중 하나라도 빠지면) 묶음 전체 제거 — 반쪽 재선택 금지', () => {
      const wp = transferOf(tripWithTransferFields({ nextLegDeparturesEpochSec: DEPARTURES_EPOCH_SEC }));
      expect(wp).not.toHaveProperty('nextLegDeparturesEpochSec');
    });

    it('상한 초과 길이(K 상한 12)는 묶음 제거 — payload 무한 증가 방지', () => {
      const tooMany = Array.from({ length: 13 }, (_, i) => 1793137260 + i * 600);
      const wp = transferOf(tripWithTransferFields({ ...TRANSFER_FIELDS, nextLegDeparturesEpochSec: tooMany }));
      expect(wp).not.toHaveProperty('nextLegDeparturesEpochSec');
    });
  });
});
