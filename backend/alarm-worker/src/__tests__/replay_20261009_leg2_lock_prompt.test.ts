/**
 * #2939 (plan 2026-10-10 W1, P1/A1) — 10/9 실측 트립(D1 `trip_events`, 군자역 환승) replay.
 *
 * 실측 타임라인 (불변 — 통과시키려 조정 금지):
 *   11:37:24 leg-boarding-prompt 군자(능동) line=5 outcome=fired (gateDecision=approaching)
 *   11:37:39 · 11:37:43 boarding-confirm-result lockState=leg1 (사용자 응답 2회)
 *   11:37:51 sync-received 군자(능동) promotedLock=true trainCode=5559 (lock 부착 완료)
 *   11:38:24 leg-boarding-prompt 군자(능동) line=5 outcome=fired ← **회귀 본체**: 열차를 이미
 *     아는 상태에서 "탑승하셨나요?"를 또 물었다.
 *
 * 근본: `maybeFireLegBoardingPrompt`(scheduled.ts)는 lock 활성 여부와 무관하게 환승 leg마다
 * 평가된다 — "이 leg의 lock이 실 trainCode를 가지면 차단"하는 게이트가 없었다. #2898의 5분
 * soft-block(같은 열차 approaching→imminent 재확인 허용)이 11:38:24 재발사를 정상 통과시켰다
 * (현재 설계상 정상 동작 — 문제는 lock 존재를 보는 축 자체의 부재).
 *
 * fix 후 기대: 11:37:51 lock 부착 이후 같은 leg(line=5, 군자)의 `leg-boarding-prompt` 평가는
 * 11:38:24 상당 cycle에서 발사 0건이어야 한다(plan §3 AC1).
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { maybeFireLegBoardingPrompt, type ScheduledDeps, type ScheduledStats } from '../scheduled';
import app from '../index';
import { putTrip, getTrip } from '../trips';
import type { ArrivalEntry, SeoulArrivalClient } from '../seoul';
import type { Env, Trip } from '../types';
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
});

beforeEach(() => resetApnsJwtCache());

// D1 11:37:24 발사를 epoch 0으로 두고, 이후 오프셋은 실측 시:분:초 차이 그대로.
const BASE_AT = 1_700_000_000_000;
const offsetFromBase = (totalSec: number): number => BASE_AT + totalSec * 1000;

const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' } as const;

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
  } as unknown as Env;
}

function makeStats(): ScheduledStats {
  return {
    legBoardingPromptFired: 0,
    legBoardingPromptBlocked: 0,
    legBoardingPromptSkippedWalking: 0,
    legBoardingPromptSkippedNoOptIn: 0,
    silentPushFiredByKind: { boardingPrompt: 0 },
    envCorrected: 0,
    errors: 0,
  } as unknown as ScheduledStats;
}

function makeTrip(): Trip {
  return {
    token: 'trip-20261009-b00dd879',
    createdAt: offsetFromBase(0) - 20 * 60_000,
    // 환승 후 leg: 군자(5호선) → 광화문 방면.
    waypoints: [
      { stationName: '동대문역사문화공원', line: '5', kind: 'intermediate' },
      { stationName: '광화문', line: '5', kind: 'destination' },
    ],
    apnsEnv: 'production',
    registeredAt: offsetFromBase(0),
    currentLegAnchor: { boardingStation: '군자', line: '5' },
    promptOptIn: true,
  } as unknown as Trip;
}

function makeControllableSeoul(getPool: () => readonly ArrivalEntry[]): SeoulArrivalClient {
  return {
    stats: { callCount: 0, cacheSize: 0, httpErrorCount: 0 },
    async fetchArrivals(stationName: string): Promise<ArrivalEntry[]> {
      if (stationName !== '군자') return [];
      return [...getPool()];
    },
    async fetchPositions(): Promise<never[]> {
      return [];
    },
  } as unknown as SeoulArrivalClient;
}

function arrival(trainCode: string, isUp: boolean, arvlCd: number | null): ArrivalEntry {
  return {
    destination: '광화문',
    arrivalSeconds: 90,
    trainCode,
    isUp,
    subwayNm: '지하철5호선',
    subwayId: '1005',
    arvlCd,
  } as unknown as ArrivalEntry;
}

describe('#2939 replay — 10/9 b00dd879 군자 leg-2 lock 부착 후 재발사 회귀', () => {
  it('11:37:24 fired(approaching) → 11:37:51 lock 5559 부착 → 11:38:24 상당 재평가는 발사 0건', async () => {
    let simNow = offsetFromBase(0);
    const kv = new InMemoryKV(() => simNow);
    const env = makeEnv(kv);
    const trip = makeTrip();
    const stats = makeStats();

    // ── 11:37:24 — 최초 발사(approaching). 실측과 동일하게 fired 1건.
    let pool: readonly ArrivalEntry[] = [arrival('5559', true, 5)];
    const seoul = makeControllableSeoul(() => pool);
    const pushFetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const deps: ScheduledDeps = { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: pushFetch, seoul, archFlag: 'off' };

    await maybeFireLegBoardingPrompt(trip, env, deps, stats, simNow, () => {}, () => 'p-1137-24');
    expect(stats.legBoardingPromptFired).toBe(1);

    // ── 11:37:51 — 사용자 응답 처리(11:37:39/43)로 lock 부착(device sync-received promotedLock,
    // trainCode=5559, 현재 leg와 동일 line=5). 이 fix의 게이트가 보는 신호 그 자체.
    trip.boardingLock = {
      trainCode: '5559',
      line: '5',
      subwayId: '1005',
      selectedDepartureTime: offsetFromBase(27),
      segmentStations: ['군자', '동대문역사문화공원', '광화문'],
      expiresAt: offsetFromBase(27) + 30 * 60_000,
    };

    // ── 11:38:24 상당(+60s) — 열차를 이미 아는 상태에서 재평가. fix 전엔 #2898 soft-block
    // same-train bypass로 또 발사됐다(회귀 본체). fix 후엔 lock-already-attached로 차단돼야 한다.
    simNow = offsetFromBase(60);
    pool = [arrival('5559', true, 1)];
    await maybeFireLegBoardingPrompt(trip, env, deps, stats, simNow, () => {}, () => 'p-1138-24');

    expect(stats.legBoardingPromptFired).toBe(1);
    expect((pushFetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});

/**
 * #2987 — "발사된 열차 == lock된 열차" 신원 사슬.
 *
 * ## 왜 이 테스트가 필요한가 (mutation 측정 근거)
 *
 * 사슬의 세 구간은 각각 두껍게 덮여 있다(backend 4001개 대상 mutation 측정):
 *   - 프롬프트 발사 결정(`decideBoardingPromptFire`) 사망 → **74건** 실패
 *   - payload `trainCode` embed 제거/변조 → **4건** 실패(값까지 검증)
 *   - confirm → lock(`#2975`/`#2982`) → **3건**
 *
 * 그런데 **구간을 연결하는 테스트가 없다.** 위 describe(`#2939`)조차 `trip.boardingLock`에
 * `trainCode: '5559'`를 **손으로 박는다** — push가 실제로 어느 열차를 실었는지와 무관하다.
 * 그래서 "발사는 A를 제시했는데 lock은 B가 됐다"는 회귀가 **81건 전부 green인 채** 통과한다.
 *
 * 사용자 요구(2026-10-12): *"27분차를 30분에 탭하더라도 27분 열차를 락할 수 있어야 하는 거잖아"*
 * — 그 요구는 **구간이 아니라 사슬**에 대한 것이다.
 *
 * ## 이 테스트의 규율
 *
 * **trainCode를 하드코딩하지 않는다.** 발사된 push의 payload에서 **읽어서** confirm에 넣고,
 * lock이 그 값을 갖는지 본다. 그래서 어느 구간이 틀어져도(발사가 다른 열차를 고름 / embed가
 * 다른 값을 실음 / confirm이 거부함) 이 테스트가 깨진다.
 */
describe('#2987 발사된 열차 == lock된 열차 (신원 사슬)', () => {
  /** 27분차(ARRIVED)·30분차(운행중) 2대 pool — 사용자 시나리오 그대로. */
  const TRAIN_ARRIVED = '2701';
  const TRAIN_LATER = '3001';

  async function fireAndCapturePromptTrainCode(
    trip: Trip,
    env: Env,
    now: number,
  ): Promise<{ promptTrainCode: string; pushCount: number }> {
    const pool: readonly ArrivalEntry[] = [
      arrival(TRAIN_ARRIVED, true, 1), // ARRIVED — 우선순위 상위
      arrival(TRAIN_LATER, true, 99), // 운행중
    ];
    const bodies: unknown[] = [];
    const pushFetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const deps: ScheduledDeps = {
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: pushFetch,
      seoul: makeControllableSeoul(() => pool),
      archFlag: 'off',
    };

    await maybeFireLegBoardingPrompt(trip, env, deps, makeStats(), now, () => {}, () => 'p-id');

    // 프롬프트 push의 payload 키는 `body`다(station push의 `data`, LA push의 `aps.event`와
    // 다르다 — 실측으로 확인). 하드코딩 테스트는 이 차이를 드러내지 못한다.
    const prompt = bodies.find((b) => {
      const payload = (b as { body?: { kind?: string } }).body;
      return payload?.kind === 'boarding-prompt';
    }) as { body: { trainCode?: string } } | undefined;
    // payload에 trainCode가 아예 없으면 device가 보낼 것이 없다 — 사슬이 거기서 끊긴다.
    expect(prompt?.body.trainCode).toBeTypeOf('string');
    return { promptTrainCode: prompt!.body.trainCode as string, pushCount: bodies.length };
  }

  async function postConfirm(token: string, env: Env, now: number, trainCode: string) {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      return await app.fetch(
        new Request(`http://example.com/trips/${token}/boarding-confirm`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'boarded', station: '군자', line: '5', trainCode }),
        }),
        env,
      );
    } finally {
      spy.mockRestore();
    }
  }

  it('push가 실은 열차를 그대로 confirm하면 그 열차로 lock된다 (하드코딩 아님)', async () => {
    const now = offsetFromBase(0);
    const kv = new InMemoryKV(() => now);
    const env = makeEnv(kv);
    const trip = makeTrip();

    const { promptTrainCode } = await fireAndCapturePromptTrainCode(trip, env, now);
    // 발사 결정이 ARRIVED를 골랐는지 — 사슬 앞단 sanity. 아래 assert는 이 값이 아니라
    // promptTrainCode 변수를 쓴다(추출 규율).
    expect(promptTrainCode).toBe(TRAIN_ARRIVED);

    await putTrip(env.TRIPS, trip);
    const res = await postConfirm(trip.token, env, now + 30_000, promptTrainCode);
    expect(res.status).toBe(200);

    const stored = await getTrip(env.TRIPS, trip.token);
    // 사슬 전체: 발사가 제시한 열차 === lock된 열차.
    expect(stored?.boardingLock?.trainCode).toBe(promptTrainCode);
  });

  // 거부 — push가 제시하지 않은 외래 열차는 lock되지 않는다(#2824 무근거 승격 차단).
  it('[거부] push가 제시하지 않은 열차(9999)를 confirm해도 그 열차로 lock되지 않는다', async () => {
    const now = offsetFromBase(0);
    const kv = new InMemoryKV(() => now);
    const env = makeEnv(kv);
    const trip = makeTrip();

    const { promptTrainCode } = await fireAndCapturePromptTrainCode(trip, env, now);
    await putTrip(env.TRIPS, trip);

    const res = await postConfirm(trip.token, env, now + 30_000, '9999');
    expect(res.status).toBe(200);

    const stored = await getTrip(env.TRIPS, trip.token);
    expect(stored?.boardingLock?.trainCode).not.toBe('9999');
    // 외래 값이 거부된 뒤 제시된 열차로 조용히 바뀌어 있어도 안 된다 — 사용자가 탭한 것이
    // 아니기 때문이다. lock 미생성이 정답.
    expect(stored?.boardingLock?.trainCode).not.toBe(promptTrainCode);
  });
});
