/**
 * #3177 — backend가 만드는 실 알림 본문에 "왼쪽/오른쪽 문으로 하차하세요" 줄이 붙는다.
 * 스펙만 보고 작성한 test-first 케이스(구현 코드를 보며 기대값을 맞추지 않는다).
 *
 * 규칙: transfer/destination waypoint만(intermediate 제외), waypoint.stationId로 판정,
 *       근거 없으면(stationId 없음 / 데이터 없는 역) 줄을 생략한다(ADR-010: 틀린 줄보다 없는 줄).
 * 데이터(고정 id): 2-026 사당(2호선)=right / 4-025 사당(4호선)=left / 7-015 용마산=right / 2-012 건대입구=right / 9-002 김포공항=데이터 없음(#3177 PR-1 이후에도 not-two-tracks라 null).
 */
import { exportPKCS8, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAlertContent } from '../alertContent';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { sleepAlarmContent } from '../i18n';
import { putTrip } from '../trips';
import { buildStationNotifContent, runScheduled } from '../scheduled';
import { SeoulArrivalClient } from '../seoul';
import type { Env, Trip, Waypoint } from '../types';
import { InMemoryKV } from './inMemoryKv';
import koLocale from '../../../../src/shared/i18n/locales/ko.json';
import enLocale from '../../../../src/shared/i18n/locales/en.json';
import jaLocale from '../../../../src/shared/i18n/locales/ja.json';
import zhLocale from '../../../../src/shared/i18n/locales/zh.json';

const LEFT_KO = '왼쪽 문으로 하차하세요';
const RIGHT_KO = '오른쪽 문으로 하차하세요';

const wp = (stationName: string, line: string, kind: Waypoint['kind'], stationId?: string): Waypoint =>
  ({ stationName, line, kind, ...(stationId ? { stationId } : {}) }) as Waypoint;
const tripOf = (waypoints: Waypoint[]): Trip => ({ waypoints }) as unknown as Trip;

describe('매역 알림(buildStationNotifContent) — transfer/destination 본문 끝에 하차문 줄', () => {
  it('사당 2호선 환승(2-026=right): 환승 본문 + "\\n오른쪽 문으로 하차하세요"', () => {
    const transfer = wp('사당', '2', 'transfer', '2-026');
    const next = wp('사당', '4', 'intermediate');
    expect(buildStationNotifContent(tripOf([transfer, next]), transfer, 'ko')).toEqual({
      title: '사당 환승',
      body: `이번 역에서 내려 4호선 사당 방면으로 갈아타세요\n${RIGHT_KO}`,
    });
  });

  it('4호선 사당(4-025=left) 환승: 왼쪽 줄', () => {
    const transfer = wp('사당', '4', 'transfer', '4-025');
    expect(buildStationNotifContent(tripOf([transfer]), transfer, 'ko').body).toBe(
      `이번 역에서 내려 갈아타세요\n${LEFT_KO}`,
    );
  });

  it('목적지(7-015 용마산=right): "이번 역에서 내리세요\\n오른쪽 ..."', () => {
    const dest = wp('용마산', '7', 'destination', '7-015');
    expect(buildStationNotifContent(tripOf([dest]), dest, 'ko')).toEqual({
      title: '용마산 도착',
      body: `이번 역에서 내리세요\n${RIGHT_KO}`,
    });
  });

  it.each([
    ['en', 'Exit on the right'],
    ['ja', '右側のドアから降りてください'],
    ['zh', '请从右侧车门下车'],
  ] as const)('%s: trip.locale을 따른다', (lc, line) => {
    const dest = wp('용마산', '7', 'destination', '7-015');
    expect(buildStationNotifContent(tripOf([dest]), dest, lc).body.endsWith(`\n${line}`)).toBe(true);
  });

  it('intermediate에는 줄이 붙지 않는다(stationId가 있어도)', () => {
    const mid = wp('건대입구', '2', 'intermediate', '2-012');
    const dest = wp('용마산', '7', 'destination', '7-015');
    expect(buildStationNotifContent(tripOf([mid, dest]), mid, 'ko').body).not.toContain('문으로 하차하세요');
  });

  it('stationId가 없으면 줄 생략(기존 본문 그대로)', () => {
    const dest = wp('용마산', '7', 'destination');
    expect(buildStationNotifContent(tripOf([dest]), dest, 'ko').body).toBe('이번 역에서 내리세요');
  });

  it('데이터 없는 역(9-002 김포공항, 다층 복합) 이면 줄 생략', () => {
    const dest = wp('김포공항', '9', 'destination', '9-002');
    expect(buildStationNotifContent(tripOf([dest]), dest, 'ko').body).toBe('이번 역에서 내리세요');
  });

  it('stations.json에 없는 stationId면 줄 생략', () => {
    const dest = wp('용마산', '7', 'destination', 'zz-999');
    expect(buildStationNotifContent(tripOf([dest]), dest, 'ko').body).toBe('이번 역에서 내리세요');
  });

  // 10/28 trip180 실제 경로(replay_20261028_trip180 waypoints): 건대입구(2) 환승 -> 용마산(7) 도착. stationId만 stations.json 기준으로 부착.
  it('trip180 경로(건대입구 환승 -> 용마산 도착) 두 알림 모두 오른쪽 줄', () => {
    const transfer = wp('건대입구', '2', 'transfer', '2-012');
    const dest = wp('용마산', '7', 'destination', '7-015');
    const trip = tripOf([transfer, wp('어린이대공원(세종대)', '7', 'intermediate'), dest]);
    expect(buildStationNotifContent(trip, transfer, 'ko').body.endsWith(`\n${RIGHT_KO}`)).toBe(true);
    expect(buildStationNotifContent(trip, dest, 'ko').body).toBe(`이번 역에서 내리세요\n${RIGHT_KO}`);
  });
});

describe('fallback resend alert(buildAlertContent) — 한국어 고정', () => {
  it('transfer/destination + exitSide → 본문 끝에 줄', () => {
    expect(buildAlertContent({ kind: 'destination', phase: 'imminent', stationName: '용마산', exitSide: 'right' }).body).toBe(
      `이번 역에서 내리세요\n${RIGHT_KO}`,
    );
    expect(buildAlertContent({ kind: 'transfer', phase: 'early', stationName: '사당', exitSide: 'left' }).body).toBe(
      `다음 역 사당에서 환승하세요!\n${LEFT_KO}`,
    );
  });

  it('exitSide 없으면 기존 본문', () => {
    expect(buildAlertContent({ kind: 'destination', phase: 'imminent', stationName: '용마산' }).body).toBe('이번 역에서 내리세요');
  });
});

describe('취침 알람(sleepAlarmContent) — alert/companion이 공유하는 본문에 줄', () => {
  it('1역 전 기본 칸: 본문 끝에 줄', () => {
    expect(sleepAlarmContent('ko', 'destination', '용마산', 1, 'right').body).toBe(`다음 역 용마산에서 하차하세요!\n${RIGHT_KO}`);
  });
  it('N역 전 칸: 본문 끝에 줄', () => {
    expect(sleepAlarmContent('ko', 'transfer', '사당', 3, 'left').body).toBe(`일어나서 환승 준비하세요\n${LEFT_KO}`);
  });
  it('exitSide 없으면 불변', () => {
    expect(sleepAlarmContent('ko', 'destination', '용마산', 1).body).toBe('다음 역 용마산에서 하차하세요!');
  });
});

describe('문구 byte-parity — device locale JSON과 동일', () => {
  const locales = { ko: koLocale, en: enLocale, ja: jaLocale, zh: zhLocale } as const;
  for (const [lc, json] of Object.entries(locales)) {
    it(`${lc}: alarms.exitSideLeft/Right`, () => {
      const left = sleepAlarmContent(lc as 'ko', 'destination', 'X', 3, 'left').body;
      const right = sleepAlarmContent(lc as 'ko', 'destination', 'X', 3, 'right').body;
      expect(left.endsWith(`\n${json.alarms.exitSideLeft}`)).toBe(true);
      expect(right.endsWith(`\n${json.alarms.exitSideRight}`)).toBe(true);
    });
  }
});

// ── 취침 알람 wire-level: 실제 runScheduled cron walk에서 alert + companion 본문 ──
let apnsConfig: ApnsConfig;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: await exportPKCS8(privateKey), bundleId: 'com.example.app' };
});
beforeEach(() => resetApnsJwtCache());
afterEach(() => vi.unstubAllGlobals());

const NOW = 1_700_000_000_000;
const HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' } as const;

async function walkSleepTrip(waypoints: Waypoint[]) {
  const kv = new InMemoryKV(() => NOW);
  const env = {
    TRIPS: kv as unknown as KVNamespace,
    APNS_HOST: HOSTS.production,
    APNS_HOST_SANDBOX: HOSTS.sandbox,
    SEOUL_API_HOST: 'seoul.api',
    SEOUL_API_KEY: 'KEY',
    APNS_KEY_ID: apnsConfig.keyId,
    APNS_TEAM_ID: apnsConfig.teamId,
    APNS_PRIVATE_KEY: apnsConfig.privateKeyPem,
    APNS_BUNDLE_ID: apnsConfig.bundleId,
  } as Env;
  const line = waypoints[0].line;
  const trip: Trip = {
    token: 'exit-side-tok',
    route: { type: 'direct', line, stops: waypoints.length },
    destination: waypoints[waypoints.length - 1].stationName,
    waypoints,
    expiresAt: NOW + 3 * 3_600_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW - 60_000,
    sleepModeEnabled: true,
    boardingLock: {
      trainCode: '7246',
      line,
      subwayId: '1007',
      selectedDepartureTime: NOW,
      segmentStations: waypoints.map((w) => w.stationName),
      expiresAt: NOW + 3 * 3_600_000,
    },
  };
  await putTrip(kv as unknown as KVNamespace, trip);
  const bodies: string[] = [];
  const fetchImpl = (async (_u: unknown, init?: { body?: string }) => {
    bodies.push(String(init?.body ?? ''));
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
  for (let i = 0; i < waypoints.length; i++) {
    const { stationName } = waypoints[i];
    await runScheduled(env, {
      seoul: new SeoulArrivalClient({
        apiKey: 'K',
        host: 'h',
        now: () => NOW,
        fetchImpl: (async (url: string) => {
          if (url.includes('/realtimePosition/')) return new Response(JSON.stringify({ realtimePositionList: [] }), { status: 200 });
          return new Response(
            JSON.stringify({
              realtimeArrivalList: [
                { barvlDt: '0', recptnDt: '', updnLine: '상행', trainLineNm: stationName, btrainNo: '7246', subwayNm: '지하철7호선', arvlCd: '1' },
              ],
            }),
            { status: 200 },
          );
        }) as unknown as typeof fetch,
      }),
      apnsConfig,
      apnsHosts: HOSTS,
      fetchImpl,
      now: () => NOW + i * 60_000,
      generatePushId: () => `p-${i}`,
    });
  }
  return bodies;
}

describe('취침 알람 push wire — alert와 companion 모두 줄 포함', () => {
  it('목적지 용마산(7-015) 1역 전: "…하차하세요!\\n오른쪽 문으로 하차하세요"가 alert와 companion 양쪽에', async () => {
    const bodies = await walkSleepTrip([
      wp('군자(능동)', '7', 'intermediate', '7-017'),
      wp('중곡', '7', 'intermediate', '7-016'),
      wp('용마산', '7', 'destination', '7-015'),
    ]);
    const hits = bodies.filter((b) => b.includes('다음 역 용마산에서 하차하세요!'));
    expect(hits.length).toBeGreaterThanOrEqual(2);
    for (const b of hits) expect(b).toContain(`다음 역 용마산에서 하차하세요!\\n${RIGHT_KO}`);
  });

  it('stationId 없는 목적지: 줄 없음', async () => {
    const bodies = await walkSleepTrip([
      wp('군자(능동)', '7', 'intermediate'),
      wp('중곡', '7', 'intermediate'),
      wp('용마산', '7', 'destination'),
    ]);
    const hits = bodies.filter((b) => b.includes('다음 역 용마산에서 하차하세요!'));
    expect(hits.length).toBeGreaterThanOrEqual(2);
    for (const b of hits) expect(b).not.toContain('문으로 하차하세요');
  });
});

describe('resolveWaypointExitSide — direction 전달', () => {
  it('direction이 있으면 SSoT(resolveExitSideForStation)에 그대로 전달(terminus=unknown)', async () => {
    const { resolveWaypointExitSide } = await import('../exitSide');
    const { resolveExitSideForStation } = await import('../../../../src/shared/utils/resolveExitSideForStation');
    const dest = wp('성수', '2', 'destination', '2-011');
    for (const direction of ['up', 'down'] as const) {
      expect(resolveWaypointExitSide(dest, direction)).toBe(
        resolveExitSideForStation({ stationId: '2-011', direction, terminus: 'unknown' }).side,
      );
    }
  });
});
