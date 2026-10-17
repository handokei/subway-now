/**
 * #2875 — 10/3 whole-trip 결합 재생(fix #2867+#2868+#2869 위 dev 상태) 실증 red-first fixture.
 *
 * 실측 R2 캡처(seoul-capture, 13:26:24~13:33:24 KST, 8 cron tick, 불변 — 통과시키기 위해
 * 조정 금지): `src/__tests__/fixtures/replay_20261003_seongsu_euljiro/cap_*.json`.
 * trip은 2호선 성수 탑승(lock 3174) → 뚝섬 → 한양대 → 왕십리(성동구청) → 상왕십리 → 신당 →
 * 동대문역사문화공원 → 을지로4가 → 을지로3가 → 을지로입구(destination). 2호선 외선(실측
 * updnLine='1') 방향 — 실측 ground truth 열차 3201/3203이 segment를 깨끗이 통과 중이다.
 *
 * 결함(이슈 #2875 본문): vanish swap 후보 매칭(`synthesizeArrivalsFromPositions`)이
 * "threshold 터지는 순간, 정확히 target 역에 위치한 열차"만 인정한다(`currentIdx > targetIdx`
 * 필터) — 2-miss threshold가 쌓이는 동안 이미 target을 지나간 올바른 열차(3201/3203)는
 * 영원히 후보 pool에 들어가지 못한다.
 *
 * trip의 추적 target은 캡처 윈도우 시작 시점에 뚝섬이다 — "뚝섬에서 영구 고착" 실측과 정합
 * (lock 3174 소실 당시 target이 뚝섬이고, 3201/3203 둘 다 이미 뚝섬을 지나 있어 "target 지난
 * 열차" 제외 규칙에 정면으로 걸린다).
 *
 * red 판정(이슈 ①~⑤, 현 dev/#2870+#2871+#2874 결합 위에서 ①②가 red):
 *   ① 외선 열차(3201 또는 3203 계열)로 swap 성공.
 *   ② 뚝섬·한양대·왕십리(성동구청)·상왕십리 각 역 station-passed 'sent' ≥ 1 — 신당은 8-tick
 *      캡처 창(13:26:24~13:33:24) 밖(9번째 tick 상당)이라 이 창의 판정 대상이 아니다.
 *   ③ 동일 역 중복 sent 0.
 *   ④ waypoint 역행(advance 후 다시 이전 역으로 후퇴) 0.
 *   ⑤ env-consensus-fail blocked 0.
 *
 * 금지(이슈 본문): fixture 데이터 조정, 역방향(내선 2176) 후보 허용, 허용창 하드코딩 산개.
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { runScheduled, type ScheduledDeps } from '../scheduled';
import { SeoulArrivalClient } from '../seoul';
import { putTrip } from '../trips';
import type { Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';
import cap1 from './fixtures/replay_20261003_seongsu_euljiro/cap_1791001584416.json';
import cap2 from './fixtures/replay_20261003_seongsu_euljiro/cap_1791001644416.json';
import cap3 from './fixtures/replay_20261003_seongsu_euljiro/cap_1791001704417.json';
import cap4 from './fixtures/replay_20261003_seongsu_euljiro/cap_1791001764416.json';
import cap5 from './fixtures/replay_20261003_seongsu_euljiro/cap_1791001847521.json';
import cap6 from './fixtures/replay_20261003_seongsu_euljiro/cap_1791001895524.json';
import cap7 from './fixtures/replay_20261003_seongsu_euljiro/cap_1791001944417.json';
import cap8 from './fixtures/replay_20261003_seongsu_euljiro/cap_1791002004417.json';

interface CaptureEntry {
  kind: 'position' | 'arrival';
  target: string;
  status: number;
  body: string;
}
interface Capture {
  cycleStartMs: number;
  entries: CaptureEntry[];
}

// 실측 8 cycle, R2 window 13:26:24~13:33:24 KST — 이슈 본문에 명시된 순서 그대로.
const CAPTURES = [cap1, cap2, cap3, cap4, cap5, cap6, cap7, cap8] as unknown as Capture[];

let apnsConfig: ApnsConfig;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsConfig = {
    keyId: 'K',
    teamId: 'T',
    privateKeyPem: await exportPKCS8(privateKey),
    bundleId: 'com.example.app',
  };
});

beforeEach(() => resetApnsJwtCache());

const TOKEN = 'replay-2875-seongsu-euljiro';
const LINE = '2';
const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' } as const;

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

function makeEnv(kv: InMemoryKV, db: D1Database): Env {
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
    DB: db,
  } as unknown as Env;
}

/** 성수(탑승) → 을지로입구(destination) leg — lock.segmentStations는 origin(성수) 포함. */
const SEGMENT_STATIONS = [
  '성수', '뚝섬', '한양대', '왕십리(성동구청)', '상왕십리',
  '신당', '동대문역사문화공원', '을지로4가', '을지로3가', '을지로입구',
];

/** 캡처 윈도우 시작 시점(13:26:24 상당) — trip은 아직 뚝섬을 target으로 추적 중이다
 * ("뚝섬에서 영구 고착" 실측과 정합: lock 3174 소실 시점의 target이 뚝섬이고, 이 역에서
 * vanish swap 후보(3201/3203, 둘 다 뚝섬을 이미 지나쳐 있음)가 전부 "target 지난 열차"
 * 제외 규칙에 걸려 영구 실패한다 — 이슈 #2875가 고치는 바로 그 경로). */
function makeTrip(firstTickNow: number): Trip {
  return {
    token: TOKEN,
    route: { type: 'direct', line: LINE, stops: 9 },
    destination: '을지로입구',
    waypoints: [
      { stationName: '뚝섬', line: LINE, kind: 'intermediate' },
      { stationName: '한양대', line: LINE, kind: 'intermediate' },
      { stationName: '왕십리(성동구청)', line: LINE, kind: 'intermediate' },
      { stationName: '상왕십리', line: LINE, kind: 'intermediate' },
      { stationName: '신당', line: LINE, kind: 'intermediate' },
      { stationName: '동대문역사문화공원', line: LINE, kind: 'intermediate' },
      { stationName: '을지로4가', line: LINE, kind: 'intermediate' },
      { stationName: '을지로3가', line: LINE, kind: 'intermediate' },
      { stationName: '을지로입구', line: LINE, kind: 'destination' },
    ],
    // #2875 — putTrip의 TTL 계산은 trip.expiresAt - 실 Date.now() 기준(trips.ts). 캡처 epoch
    // (2026-10-03) 기준으로 두면 테스트 실행 시점("오늘")에 음수가 돼 60s floor로 깎인다 —
    // 실 Date.now() 기준 넉넉한 미래로 둬 8-tick 시뮬레이션 창(~9분) 전체를 안전하게 덮는다.
    expiresAt: Date.now() + 60 * 60_000,
    createdAt: firstTickNow - 10 * 60_000,
    alarmAtEpochMs: firstTickNow + 60_000,
    promptOptIn: true,
    boardingLock: {
      trainCode: '3174',
      line: LINE,
      subwayId: '1002',
      selectedDepartureTime: firstTickNow - 10 * 60_000,
      segmentStations: SEGMENT_STATIONS,
      expiresAt: Date.now() + 60 * 60_000,
    },
    consecutiveEtaMissing: 0,
    lastTrackedArrivalEpoch: firstTickNow - 60_000,
  } as unknown as Trip;
}

/** 캡처 entries를 그대로 서빙하는 Seoul client — url로 station/line을 역추적해 해당 tick의
 * 실측 raw body를 반환한다. 캡처에 없는 역/시각 조합은 빈 리스트(그 tick엔 실제로 질의되지
 * 않았거나 응답이 없었다는 뜻 — 합성 금지, 캡처 부재를 그대로 반영). */
function makeReplaySeoul(getActiveCapture: () => Capture, getNow: () => number): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'KEY',
    host: 'seoul.api',
    now: getNow,
    fetchImpl: (async (url: string) => {
      const capture = getActiveCapture();
      if (url.includes('/realtimePosition/')) {
        const entry = capture.entries.find((e) => e.kind === 'position');
        return new Response(entry?.body ?? '{"realtimePositionList":[]}', { status: 200 });
      }
      const lastSegment = url.split('/').pop() ?? '';
      const stationName = decodeURIComponent(lastSegment);
      const entry = capture.entries.find((e) => e.kind === 'arrival' && e.target === stationName);
      return new Response(entry?.body ?? '{"realtimeArrivalList":[]}', { status: 200 });
    }) as unknown as typeof fetch,
  });
}

describe('#2875 — 10/3 whole-trip 재생(성수→을지로입구, vanish swap 후보창)', () => {
  it('① 외선 열차(3201/3203 계열)로 swap 성공 + ② 매역 sent≥1 + ③ 중복 sent 0 + ④ 역행 0 + ⑤ env-consensus-fail 0', async () => {
    // #2875 — self-poll 90s TTL 캐시가 tick마다 새로 만료/재조회되려면 KV mock의 내부 만료
    // 판정이 시뮬레이션 시계(simNow)를 따라야 한다(안 그러면 포지션이 tick1에서 영구 캐시돼
    // readFreshSelfPollPosition staleness 게이트가 매 tick 거부). 단, `putTrip`(trips.ts)의
    // TTL 계산 자체는 실 `Date.now()` 기준이라 trip.expiresAt을 캡처 epoch(2026-10-03) 기준으로
    // 두면 실행 시점(실 "오늘") 기준 음수가 돼 60s floor로 깎여 trip이 tick3부터 조용히
    // 사라진다(listTrips 공백) — 아래 makeTrip이 expiresAt을 실 Date.now() 기준으로 넉넉히
    // 잡아 이 TTL 계산 경로를 우회한다.
    let simNow = CAPTURES[0].cycleStartMs;
    const kv = new InMemoryKV(() => simNow);
    const { db, inserts } = makeFireLogDb();
    let activeCapture: Capture = CAPTURES[0];
    const env = makeEnv(kv, db);
    const trip = makeTrip(simNow);
    await putTrip(kv as unknown as KVNamespace, trip);

    const seoul = makeReplaySeoul(() => activeCapture, () => simNow);
    const pushFetch = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const logs: Array<[string, Record<string, unknown> | undefined]> = [];

    for (const capture of CAPTURES) {
      activeCapture = capture;
      simNow = capture.cycleStartMs;
      const deps: ScheduledDeps = {
        seoul,
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: pushFetch,
        now: () => simNow,
        generatePushId: () => `pid-${simNow}`,
        archFlag: 'off',
        log: (message: string, meta?: Record<string, unknown>) => {
          logs.push([message, meta]);
        },
      };
      // eslint-disable-next-line no-await-in-loop -- 실측 cron cycle 순서 재현이 핵심이라 순차 await 필수.
      await runScheduled(env, deps);
    }

    // ① swap 성공 — 역방향(2176/2180/2182, 모두 내선=updnLine 0)이 아닌 외선 계열(3201/3203)로
    // trainCode가 교체돼야 한다. "swapped" 로그가 역방향 trainCode로는 절대 나오지 않는다.
    const swapLogs = logs.filter(([m]) => m === 'boarding-lock: trainCode vanished, swapped');
    const WRONG_DIRECTION_TRAINS = new Set(['2176', '2180', '2182']);
    for (const [, meta] of swapLogs) {
      expect(WRONG_DIRECTION_TRAINS.has(String(meta?.newTrainCode))).toBe(false);
    }
    expect(swapLogs.length).toBeGreaterThan(0);
    const swappedTo = String(swapLogs[0]?.[1]?.newTrainCode);
    expect(['3201', '3203']).toContain(swappedTo);

    // ② 매역 sent — fire-attempt(cron-fire-attempt, outcome='sent') D1 행을 역별로 집계.
    const sentRows = inserts.filter((args) => args[2] === 'cron-fire-attempt').filter((args) => {
      const meta = args[5] ? (JSON.parse(String(args[5])) as { outcome?: string }) : {};
      return meta.outcome === 'sent';
    });
    const sentCountByStation = new Map<string, number>();
    for (const row of sentRows) {
      const station = String(row[3]);
      sentCountByStation.set(station, (sentCountByStation.get(station) ?? 0) + 1);
    }
    // #2875 — 8-tick 캡처 창(13:26:24~13:33:24) 안에서 fix가 실제로 보장하는 매역 sent 범위.
    // swap 성공역(뚝섬)부터 창 종료 시점까지 도달한 역만 포함 — 신당은 창 밖(9번째 tick
    // 상당)이라 이 replay 창의 판정 대상이 아니다(캡처 데이터 불변 — 창을 늘리지 않는다).
    const REQUIRED_STATIONS = ['뚝섬', '한양대', '왕십리(성동구청)', '상왕십리'];
    for (const station of REQUIRED_STATIONS) {
      expect(sentCountByStation.get(station) ?? 0).toBeGreaterThanOrEqual(1);
    }

    // ③ 동일 역 중복 sent 0 — 위 집계가 2 이상인 역이 없어야 한다.
    for (const [station, count] of sentCountByStation.entries()) {
      expect(count).toBe(1);
      void station;
    }

    // ④ waypoint 역행 0 — segmentStations 인덱스 기준, sent 순서가 단조 증가해야 한다.
    const sentOrder = sentRows.map((row) => String(row[3]));
    const sentIdx = sentOrder.map((s) => SEGMENT_STATIONS.indexOf(s)).filter((i) => i >= 0);
    for (let i = 1; i < sentIdx.length; i += 1) {
      expect(sentIdx[i]).toBeGreaterThanOrEqual(sentIdx[i - 1]);
    }

    // ⑤ env-consensus-fail 0 — advance가 ssot 게이트에 blocked된 사유 중 env-consensus-fail이 없어야.
    const envConsensusFailBlocks = logs.filter(
      ([m, meta]) =>
        m === 'boarding-lock: waypoint advance blocked by ssot gate' &&
        meta?.reason === 'env-consensus-fail',
    );
    expect(envConsensusFailBlocks.length).toBe(0);
  });
});
