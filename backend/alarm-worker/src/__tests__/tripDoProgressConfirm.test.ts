/**
 * #3055 / #3300 옵션 D PR-4b — boarding-confirm 탭 전진(`userTapAdvance`)은 앞으로만 간다.
 *
 * 입력은 9/18 실측(replay_20260918_boarding_confirm): 건대입구/7호선 탭(17:40:32)이 leg 2 경유로 채택되면 waypoints가 환승 직후
 * (어린이대공원)부터 다시 시작한다(#2739 tapAdvance). 진행 셀 단계에서는 이 전진이 셀 op(`userTapAdvance`)로만 영속되고,
 * 탭 시야(base)가 낡아 셀이 이미 더 앞서 있으면 되감지 않는다(반증 6).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index';
import { parseReplayFixture } from '../replayFixture';
import { putTrip, waypointSignatureKey } from '../trips';
import { fetchCells, resetCellStageCache, runProgressOp } from '../tripDoCells';
import { setTripDoFlag } from '../tripDoFlag';
import type { Env } from '../types';
import { InMemoryKV } from './inMemoryKv';
import { makeCaptureFetch } from './helpers/replayHarness';
import { makeFakeTripDoNamespace } from './helpers/fakeTripDoNamespace';
import { makeRide20260918LocklessTrip, RIDE_20260918_CREATED_AT_MS } from './helpers/ride20260918Trip';
import fixtureJson from './fixtures/replayLibrary/capture_20260918_line7_yongmasan_overshoot.fixture.json';

const fixture = parseReplayFixture(fixtureJson);
const TOKEN = 'ride-20260918-progress-cell';
/** 실측: 사용자가 건대입구에서 7256을 직접 탭한 시각(2026-09-18 17:40:32 KST). */
const TAP_MS = RIDE_20260918_CREATED_AT_MS + (17 * 3600 + 40 * 60 + 32 - (17 * 3600 + 26 * 60 + 1)) * 1000;

function makeEnv(kv: InMemoryKV, ns?: DurableObjectNamespace): Env {
  return {
    TRIPS: kv as unknown as Env['TRIPS'],
    ...(ns ? { TRIP_DO: ns } : {}),
    APNS_HOST: 'api.push.apple.com',
    APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
    SEOUL_API_HOST: 'seoul.api',
    SEOUL_API_KEY: 'KEY',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: 'p',
    APNS_BUNDLE_ID: 'b',
  };
}

/** 지정한 진행 셀 op가 DO로 들어가기 직전에 한 번 콜백을 실행하는 래퍼(읽기-쓰기 사이 끼어들기). */
function hookBeforeProgressOp(ns: DurableObjectNamespace, opType: string, before: () => Promise<void>): DurableObjectNamespace {
  let fired = false;
  return {
    idFromName: (name: string) => ns.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = ns.get(id);
      return {
        fetch: async (request: Request): Promise<Response> => {
          if (!fired && request.method === 'POST' && new URL(request.url).pathname === '/progress/op') {
            const { op } = (await request.clone().json()) as { op: { type: string } };
            if (op.type === opType) {
              fired = true;
              await before();
            }
          }
          return stub.fetch(request);
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

const confirmBoarded = (env: Env) =>
  app.fetch(
    new Request(`http://example.com/trips/${TOKEN}/boarding-confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'boarded', station: '건대입구', line: '7' }),
    }),
    env,
  );

async function setup(flag: 'off' | 'progress@1') {
  const kv = new InMemoryKV(() => TAP_MS);
  const doNs = makeFakeTripDoNamespace();
  await putTrip(kv as unknown as Env['TRIPS'], makeRide20260918LocklessTrip(TOKEN));
  await setTripDoFlag(kv as unknown as KVNamespace, flag);
  resetCellStageCache(kv);
  vi.stubGlobal('fetch', makeCaptureFetch(fixture, () => TAP_MS));
  return { kv, doNs };
}

const names = (waypoints: Array<{ stationName: string }> | undefined): string[] => (waypoints ?? []).map((w) => w.stationName);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TAP_MS);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('#3055 PR-4b — boarding-confirm tapAdvance(9/18 건대입구 탭)', () => {
  it('전제(flag off): 탭이 leg 2로 채택돼 waypoints가 환승 직후부터 시작하고 anchor가 stamp된다', async () => {
    const { kv } = await setup('off');
    const res = await confirmBoarded(makeEnv(kv));
    expect(((await res.json()) as { lockState: string }).lockState).toBe('leg2');
    const stored = JSON.parse((kv as unknown as { store: Map<string, { value: string }> }).store.get(`trip:${TOKEN}`)!.value);
    expect(names(stored.waypoints)[0]).toBe('어린이대공원(세종대)');
    expect(stored.currentLegAnchor).toEqual({ boardingStation: '건대입구', line: '7' });
  });

  it('progress@1: 같은 탭 결과가 진행 셀에 영속된다(셀 head = 환승 직후, anchor stamp, 도보 게이트 즉시 통과)', async () => {
    const { kv, doNs } = await setup('progress@1');
    const env = makeEnv(kv, doNs.ns);
    const res = await confirmBoarded(env);
    expect(((await res.json()) as { lockState: string }).lockState).toBe('leg2');
    const { progress } = await fetchCells(env, TOKEN);
    expect(names(progress?.waypoints)[0]).toBe('어린이대공원(세종대)');
    expect(progress?.currentLegAnchor).toEqual({ boardingStation: '건대입구', line: '7' });
    expect(progress?.legBoardingEligibleAt).toBe(TAP_MS);
  });

  it('progress@1: 탭 시야가 낡아(그 사이 셀이 두 칸 더 전진) 되감길 상황이면 셀을 되감지 않는다', async () => {
    const { kv, doNs } = await setup('progress@1');
    const env = makeEnv(kv, doNs.ns);
    // 탭 op 직전에 cron이 건대입구·어린이대공원을 소비해 셀 head가 군자(능동)로 앞선다. 탭이 요구하는 head(어린이대공원)는 이미 지났다.
    const hooked = hookBeforeProgressOp(doNs.ns, 'userTapAdvance', async () => {
      for (let i = 0; i < 2; i += 1) {
        const { progress } = await fetchCells(env, TOKEN);
        const [first] = progress?.waypoints ?? [];
        await runProgressOp(
          env,
          TOKEN,
          { type: 'advanceHead', source: 'test-cron', expectedHeadKey: waypointSignatureKey(first), count: 1 },
          TAP_MS,
        );
      }
    });
    const res = await confirmBoarded(makeEnv(kv, hooked));
    expect(res.status).toBe(200);
    const { progress } = await fetchCells(env, TOKEN);
    expect(names(progress?.waypoints)[0]).toBe('군자(능동)');
    // KV blob도 같은 진행 — 탭의 통째 쓰기가 되감지 않는다.
    const stored = JSON.parse((kv as unknown as { store: Map<string, { value: string }> }).store.get(`trip:${TOKEN}`)!.value);
    expect(names(stored.waypoints)[0]).toBe('군자(능동)');
  });
});
