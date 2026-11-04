/**
 * #3200 — [안 탔어요]/닫기 응답 무음(`silencedUntil`)은 응답한 열차(trainCode)에만 적용된다.
 *
 * 사용자 결정(2026-10-23): "응 당연히 다시 물어봐야해 5분은 매역알림이 문제가 있었을 때 만든 거였어".
 * 23분 열차(A)에 [안 탔어요] 후 25분 열차(B)가 도착 확정되면 즉시 다시 묻는다 — #3057("도착 확정된
 * 새 열차마다 즉시 1회, 같은 열차 재발사 금지, leg당 상한 3")과 정합. trainCode를 모르는
 * (null-token) 프롬프트에 대한 응답이면 기존 5분 leg 단위 무음 유지.
 *
 * writer(`markPromptSilenced`, index.ts dismiss·boarding-confirm not-boarded)와 reader(leg-1 origin
 * GPS-free · leg-2 `maybeFireLegBoardingPrompt`)를 실제 `runScheduled`/실제 HTTP endpoint로 관통한다.
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { markPromptFired, markPromptSilenced, isPromptSilencedForTrain } from '../boardingPrompt';
import { selfPollKey } from '../selfPollPosition';
import { runScheduled, type ScheduledDeps } from '../scheduled';
import { SeoulArrivalClient, type ArrivalEntry } from '../seoul';
import { getTrip, putTrip } from '../trips';
import { seedSsot } from '../tripPositionSsot';
import type { BoardingPromptState, Env, Trip } from '../types';
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

const NOW = Date.now();
const MIN = 60_000;
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

function train(trainCode: string, arvlCd: number | null = 1): ArrivalEntry {
  return {
    destination: '성수',
    arrivalSeconds: 0,
    trainCode,
    isUp: false,
    subwayNm: '2호선',
    subwayId: '1002',
    arvlCd,
  } as unknown as ArrivalEntry;
}

/** 요청 station이 origin일 때만 arrivals 반환(그 외 = destination 조회 → 빈 배열). */
function makeSeoul(originStation: string, arrivals: ArrivalEntry[]): SeoulArrivalClient {
  const encodedOrigin = encodeURIComponent(originStation);
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => NOW,
    fetchImpl: (async (input: unknown) => {
      const matchesOrigin = String(input).endsWith(`/${encodedOrigin}`);
      return new Response(
        JSON.stringify({
          realtimeArrivalList: matchesOrigin
            ? arrivals.map((a) => ({
                barvlDt: String(a.arrivalSeconds),
                recptnDt: '',
                updnLine: a.isUp ? '상행' : '하행',
                trainLineNm: a.destination,
                btrainNo: a.trainCode,
                subwayNm: a.subwayNm,
                arvlCd: a.arvlCd,
              }))
            : [],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch,
  });
}

interface Path {
  name: string;
  token: string;
  stateKey: 'boardingPromptState' | 'legBoardingPromptState';
  firedStat: 'originGpsFreeBoardingPromptFired' | 'legBoardingPromptFired';
  makeTrip: () => Trip;
}

const PATHS: Path[] = [
  {
    name: 'leg-1 (origin GPS-free)',
    token: 'tok-3200-origin',
    stateKey: 'boardingPromptState',
    firedStat: 'originGpsFreeBoardingPromptFired',
    makeTrip: () =>
      ({
        token: 'tok-3200-origin',
        route: { type: 'direct', line: '2', stops: 5 },
        waypoints: [{ stationName: '역삼', line: '2', kind: 'destination' }],
        apnsEnv: 'production',
        registeredAt: NOW - MIN,
        createdAt: NOW,
        expiresAt: NOW + 60 * MIN,
        alarmAtEpochMs: NOW + MIN,
        promptGeoContext: {
          origin: { lat: 0, lng: 0 },
          nextStation: { lat: 0, lng: 0.01 },
          direction: 'up',
          originDistanceM: 50,
          originAccuracyM: 10,
        },
        promptDisplay: { originStation: '강남', line: '2' },
        promptOptIn: true,
      }) as unknown as Trip,
  },
  {
    name: 'leg-2 (maybeFireLegBoardingPrompt)',
    token: 'tok-3200-leg2',
    stateKey: 'legBoardingPromptState',
    firedStat: 'legBoardingPromptFired',
    makeTrip: () =>
      ({
        token: 'tok-3200-leg2',
        route: { type: 'transfer', firstLine: '7', secondLine: '2', transfers: [{ station: '강남' }] },
        waypoints: [
          { stationName: '역삼', line: '2', kind: 'intermediate' },
          { stationName: '선릉', line: '2', kind: 'destination' },
        ],
        apnsEnv: 'production',
        registeredAt: NOW - 20 * MIN,
        createdAt: NOW - 20 * MIN,
        expiresAt: NOW + 60 * MIN,
        alarmAtEpochMs: NOW - MIN,
        currentLegAnchor: { boardingStation: '강남', line: '2' },
        promptOptIn: true,
      }) as unknown as Trip,
  },
];

describe.each(PATHS)('#3200 — $name: 무음은 응답한 열차에만', (path) => {
  const { token, stateKey, firedStat } = path;

  async function setup() {
    const kv = new InMemoryKV();
    await putTrip(kv as unknown as KVNamespace, path.makeTrip());
    return { kv, env: makeEnv(kv) };
  }

  async function cycle(
    env: Env,
    at: number,
    trainCode: string,
    arvlCd: number | null = 1,
  ): Promise<number> {
    const deps: ScheduledDeps = {
      seoul: makeSeoul('강남', [train(trainCode, arvlCd)]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => at,
      fetchImpl: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      generatePushId: () => `push-${at}`,
      archFlag: 'on',
    };
    const stats = await runScheduled(env, deps);
    return stats[firedStat];
  }

  /** 실제 writer(`markPromptSilenced`)로 [안 탔어요]/닫기 응답을 재현한다. */
  async function respondNotBoarded(kv: InMemoryKV, at: number): Promise<void> {
    const trip = (await getTrip(kv as unknown as KVNamespace, token)) as Trip;
    await putTrip(kv as unknown as KVNamespace, {
      ...trip,
      [stateKey]: markPromptSilenced(trip[stateKey], at),
    });
  }

  it('A 프롬프트 -> [안 탔어요] -> 2분 뒤 B 도착 확정 -> 즉시 1회 발사', async () => {
    const { kv, env } = await setup();
    expect(await cycle(env, NOW, 'TR-A')).toBe(1);
    await respondNotBoarded(kv, NOW + 30_000);
    expect(await cycle(env, NOW + 2 * MIN, 'TR-B')).toBe(1);
  });

  it('거부: 응답한 같은 A가 다시 도착 확정돼도 발사 0', async () => {
    const { kv, env } = await setup();
    await cycle(env, NOW, 'TR-A');
    await respondNotBoarded(kv, NOW + 30_000);
    expect(await cycle(env, NOW + 2 * MIN, 'TR-A')).toBe(0);
  });

  it('거부: trainCode 불명(null-token) 프롬프트에 응답하면 5분 내 새 열차는 기존대로 발사 0', async () => {
    const { kv, env } = await setup();
    const trip = (await getTrip(kv as unknown as KVNamespace, token)) as Trip;
    const nullTokenState: BoardingPromptState = {
      fired: true,
      lastFiredAt: NOW,
      fireCount: 1,
      firedTrainCodes: ['null-trainCode:imminent'],
    };
    await putTrip(kv as unknown as KVNamespace, {
      ...trip,
      [stateKey]: markPromptSilenced(nullTokenState, NOW + 30_000),
    });
    expect(await cycle(env, NOW + 2 * MIN, 'TR-B')).toBe(0);
  });

  it('무음이 끝난 뒤(5분+)에는 통상 정책만 적용 — 새 열차는 발사된다', async () => {
    const { kv, env } = await setup();
    await cycle(env, NOW, 'TR-A');
    await respondNotBoarded(kv, NOW + 30_000);
    expect(await cycle(env, NOW + 6 * MIN, 'TR-B')).toBe(1);
  });

  it('거부: A·B·C 각각 응답 후 4번째 열차 D는 leg 상한 3으로 0', async () => {
    const { kv, env } = await setup();
    const fires: number[] = [];
    for (const [i, code] of ['TR-A', 'TR-B', 'TR-C'].entries()) {
      const at = NOW + i * 2 * MIN;
      fires.push(await cycle(env, at, code));
      await respondNotBoarded(kv, at + 30_000);
    }
    expect(fires).toEqual([1, 1, 1]);
    expect(await cycle(env, NOW + 7 * MIN, 'TR-D')).toBe(0);
  });
});

describe('#3200 — writer: markPromptSilenced / isPromptSilencedForTrain', () => {
  it('마지막 발사 열차의 trainCode를 silencedTrainCode로 기록한다', () => {
    const prev: BoardingPromptState = { fired: true, fireCount: 2, firedTrainCodes: ['A:imminent', 'B:imminent'] };
    const next = markPromptSilenced(prev, 1000);
    expect(next.silencedTrainCode).toBe('B');
    expect(next.silencedUntil).toBeGreaterThan(1000);
  });

  it('마지막 발사가 null-token이면 silencedTrainCode 없음(leg 단위 5분 무음 유지)', () => {
    const next = markPromptSilenced({ firedTrainCodes: ['A:imminent', 'null-trainCode:imminent'] }, 1000);
    expect(next.silencedTrainCode).toBeUndefined();
  });

  it('발사 이력이 없으면 silencedTrainCode 없음', () => {
    expect(markPromptSilenced(undefined, 1000).silencedTrainCode).toBeUndefined();
  });

  it('이전 응답의 silencedTrainCode는 null-token 응답으로 덮여 제거된다(stale 잔존 금지)', () => {
    const first = markPromptSilenced({ firedTrainCodes: ['A:imminent'] }, 1000);
    const second = markPromptSilenced({ ...first, firedTrainCodes: ['A:imminent', 'null-trainCode:imminent'] }, 2000);
    expect(second.silencedTrainCode).toBeUndefined();
  });

  it('isPromptSilencedForTrain: 같은 열차/불명(null) 선택은 무음, 다른 열차는 아님', () => {
    const state: BoardingPromptState = { silencedUntil: 10_000, silencedTrainCode: 'A' };
    expect(isPromptSilencedForTrain(state, 'A', 5000)).toBe(true);
    expect(isPromptSilencedForTrain(state, null, 5000)).toBe(true);
    expect(isPromptSilencedForTrain(state, 'B', 5000)).toBe(false);
    expect(isPromptSilencedForTrain(state, 'A', 10_000)).toBe(false);
    expect(isPromptSilencedForTrain(undefined, 'A', 5000)).toBe(false);
    expect(isPromptSilencedForTrain({ silencedUntil: 10_000 }, 'B', 5000)).toBe(false);
  });
});

describe('#3200 — writer 경로 전수 (HTTP): dismiss · boarding-confirm not-boarded', () => {
  async function post(path: string, body: unknown, env: Env): Promise<Response> {
    return app.fetch(
      new Request(`http://example.com${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
    );
  }

  async function seeded(): Promise<{ env: Env; kv: InMemoryKV }> {
    const kv = new InMemoryKV();
    const base = PATHS[0].makeTrip();
    await putTrip(kv as unknown as KVNamespace, {
      ...base,
      expiresAt: Date.now() + 60 * MIN,
      boardingPromptState: {
        fired: true,
        lastFiredAt: Date.now(),
        fireCount: 1,
        firedTrainCodes: ['TR-A:imminent'],
      },
    });
    return { env: makeEnv(kv), kv };
  }

  it('POST /boarding-prompt/dismiss -> silencedTrainCode=TR-A', async () => {
    const { env, kv } = await seeded();
    await post('/boarding-prompt/dismiss', { token: PATHS[0].token }, env);
    const stored = await getTrip(kv as unknown as KVNamespace, PATHS[0].token);
    expect(stored?.boardingPromptState?.silencedTrainCode).toBe('TR-A');
  });

  it('POST /trips/:token/boarding-confirm not-boarded -> silencedTrainCode=TR-A', async () => {
    const { env, kv } = await seeded();
    await post(
      `/trips/${PATHS[0].token}/boarding-confirm`,
      { action: 'not-boarded', station: '강남', line: '2' },
      env,
    );
    const stored = await getTrip(kv as unknown as KVNamespace, PATHS[0].token);
    expect(stored?.boardingPromptState?.silencedTrainCode).toBe('TR-A');
  });
});

// ---------------------------------------------------------------------------
// 리뷰 반영 — (1) 비용: 무음 창의 추가 KV read 금지 (2) D1 transition 'silenced-train' (3) 새 발사가 무음 해제
// ---------------------------------------------------------------------------

function captureEventInserts(): { db: Env['DB']; inserts: unknown[][] } {
  const inserts: unknown[][] = [];
  const run = vi.fn().mockResolvedValue({ success: true });
  const prepare = vi.fn().mockImplementation((sql: string) => ({
    bind: (...args: unknown[]) => {
      if (sql.includes('trip_events')) inserts.push(args);
      return { run };
    },
  }));
  return { db: { prepare } as unknown as Env['DB'], inserts };
}

class CountingKV extends InMemoryKV {
  gets: string[] = [];
  override async get(key: string, ...rest: unknown[]): Promise<never> {
    this.gets.push(key);
    return (super.get as unknown as (k: string, ...r: unknown[]) => Promise<never>)(key, ...rest);
  }
}

describe.each(PATHS)('#3200 리뷰 — $name: 비용·관측', (path) => {
  const { token, stateKey } = path;

  async function runCycle(env: Env, at: number, ...trainCodes: string[]): Promise<void> {
    await runScheduled(env, {
      seoul: makeSeoul('강남', trainCodes.map((code) => train(code, 1))),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => at,
      fetchImpl: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      generatePushId: () => `push-${at}`,
      archFlag: 'on',
    });
  }

  it('무음 창에서 도착 열차를 특정 못 하면(ambiguity) 차단하고 D1 transition(outcome=silenced-train)을 남긴다', async () => {
    const { db, inserts } = captureEventInserts();
    const kv = new InMemoryKV();
    const env = { ...makeEnv(kv), DB: db } as Env;
    const seeded = path.makeTrip();
    await putTrip(kv as unknown as KVNamespace, seeded);
    // transition 기록은 SSoT 마커 비교 기반 — SSoT가 있어야 D1 append가 일어난다.
    await seedSsot(kv as unknown as KVNamespace, token, '강남', { expiresAt: seeded.expiresAt });
    await runCycle(env, NOW, 'TR-A');
    const trip = (await getTrip(kv as unknown as KVNamespace, token)) as Trip;
    await putTrip(kv as unknown as KVNamespace, {
      ...trip,
      [stateKey]: markPromptSilenced(trip[stateKey], NOW + 30_000),
    });
    // 서로 다른 두 신규 열차가 동시에 도착 확정 -> pickAutoTrainCode ambiguity(null) -> 무음 창이므로 차단.
    await runCycle(env, NOW + 2 * MIN, 'TR-B', 'TR-C');
    const outcomes = inserts
      .filter((a) => a[2] === 'leg-boarding-prompt')
      .map((a) => (JSON.parse(a[5] as string) as { outcome?: string }).outcome);
    expect(outcomes).toContain('silenced-train');
  });

  it('열차 단위 무음 창에서도 position 확정 경로를 끄지 않는다 — KV read는 통상 cycle과 동일(증가 상한 0, miss 방지)', async () => {
    async function readsDuringBlockedCycle(withSilence: boolean): Promise<number> {
      const kv = new CountingKV();
      const env = makeEnv(kv);
      await putTrip(kv as unknown as KVNamespace, path.makeTrip());
      await runCycle(env, NOW, 'TR-A');
      const trip = (await getTrip(kv as unknown as KVNamespace, token)) as Trip;
      await putTrip(kv as unknown as KVNamespace, {
        ...trip,
        [stateKey]: withSilence ? markPromptSilenced(trip[stateKey], NOW + 30_000) : trip[stateKey],
      });
      kv.gets = [];
      await runCycle(env, NOW + 2 * MIN, 'TR-A'); // A는 소진 -> 두 경우 모두 발사 0
      return kv.gets.filter((k) => k.startsWith(selfPollKey('2' as never).split('2')[0])).length;
    }
    const control = await readsDuringBlockedCycle(false);
    const silenced = await readsDuringBlockedCycle(true);
    // position 확정 경로를 끄면 다음 열차를 놓친다(miss = FP 동급, ADR-010). read는 무음 창에서도 통상과 동일.
    expect(silenced).toBe(control);
  });
});

describe('#3200 리뷰 — 새 발사는 이전 무음을 해제한다', () => {
  it('markPromptFired는 silencedUntil/silencedTrainCode를 승계하지 않는다', () => {
    const silenced: BoardingPromptState = {
      fired: true,
      fireCount: 1,
      firedTrainCodes: ['A:imminent'],
      silencedUntil: 99_999,
      silencedTrainCode: 'A',
    };
    const next = markPromptFired(2000, silenced, 'B:imminent');
    expect(next.silencedUntil).toBeUndefined();
    expect(next.silencedTrainCode).toBeUndefined();
    expect(next.firedTrainCodes).toEqual(['A:imminent', 'B:imminent']);
  });
});
