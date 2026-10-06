/**
 * #2880 (replay, 파생 fixture) — `replay_20261002_leg2_prompt_miss.test.ts`의 8-cycle 실측
 * 타임라인을 **그대로** 재사용하되, 후보 전원의 `isUp`을 전부 반전시킨 **파생** 변형이다
 * (원본 파일/원본 데이터는 무변경 — 이 파일은 별도 파생 fixture).
 *
 * 왜 이 변형이 `selectedTrainCode=null`을 만드는가: `fireBoardingPromptForAnchor`는
 * line+direction directional 필터가 0건이면 line-only fallback pool로 발사 여부(gate)를
 * 판정하지만(§1 fallback, #2532 취지), `pickAutoTrainCode`는 **자신의** direction 필터를
 * 다시 적용한다 — 모든 후보의 `isUp`이 (실제 leg 진행방향과) 반대로 뒤집히면 이 두 번째
 * 필터가 항상 0건이 되어 trainCode 선택이 영구적으로 null이 된다. 즉 "임박 판정은 pool
 * 그대로 통과하는데 trainCode만 특정 불가"인 실경로(#2880 이슈 본문 ①후보 전원 방향 필터
 * 탈락)를 그대로 재현한다.
 *
 * #2880 결론 — `selectedTrainCode=null`인 동안 `shouldProceedToSend`의 trainCode dedup
 * (`firedTrainCodes.includes(selectedTrainCode)`)이 `selectedTrainCode !== null` 전제로
 * 전혀 작동하지 않아, 5분 repeat gate만 지나면 "같은 상황"(여기서는 동일 gate
 * decision='approaching')에 재발사된다 — index 7(469s, repeat gate는 경과했으나 이 창에선
 * 동일 phase)에서 재발사가 일어나면 fix 전(RED) / 일어나지 않으면 fix 후(GREEN).
 *
 * 과차단 회귀 가드: index 2(153s)·index 7(469s) 둘 다 동일 phase('approaching', arvlCd
 * 5/3 모두 APPROACHING_BOARDING_ARVLCD)이므로 fallback dedup이 막아야 하지만, 다른
 * leg/station의 정당 발사(이 fixture와 무관한 별도 trip/state)는 이 fix로 전혀 영향받지
 * 않는다 — fallback dedup 키는 이 trip의 `trip.legBoardingPromptState.firedTrainCodes`
 * 배열에만 append되고, 다른 trip 객체와 공유되지 않는 구조적 보장(별도 trip 인스턴스는
 * 별도 state 객체).
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { maybeFireLegBoardingPrompt, type ScheduledDeps, type ScheduledStats } from '../scheduled';
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

// D1 첫 observed cycle(06:43:38)을 epoch 0으로 두고, 이후 오프셋은 실측 시:분:초 차이 그대로
// (원본 `replay_20261002_leg2_prompt_miss.test.ts`와 동일 — 파생 fixture는 시각만 공유).
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
    token: 'trip-20261002-leg2-null-traincode',
    createdAt: offsetFromBase(0) - 20 * 60_000,
    waypoints: [
      { stationName: '성수', line: '2', kind: 'intermediate' },
      { stationName: '뚝섬', line: '2', kind: 'destination' },
    ],
    apnsEnv: 'production',
    registeredAt: offsetFromBase(0),
    currentLegAnchor: { boardingStation: '건대입구', line: '2' },
    promptOptIn: true,
  } as unknown as Trip;
}

function makeControllableSeoul(getPool: () => readonly ArrivalEntry[]): SeoulArrivalClient {
  return {
    stats: { callCount: 0, cacheSize: 0, httpErrorCount: 0 },
    async fetchArrivals(stationName: string): Promise<ArrivalEntry[]> {
      if (stationName !== '건대입구') return [];
      return [...getPool()];
    },
    async fetchPositions(): Promise<never[]> {
      return [];
    },
  } as unknown as SeoulArrivalClient;
}

function arrival(trainCode: string, isUp: boolean, arvlCd: number | null): ArrivalEntry {
  return {
    destination: '뚝섬',
    arrivalSeconds: 90,
    trainCode,
    isUp,
    subwayNm: '지하철2호선',
    subwayId: '1002',
    arvlCd,
  } as unknown as ArrivalEntry;
}

// 원본 `replay_20261002_leg2_prompt_miss.test.ts`의 CYCLES와 완전히 동일한 offsetSec/u1ArvlCd —
// 이 파일이 바꾸는 건 isUp(아래 호출부에서 `true`로 반전, 원본은 `false`)뿐이다.
const CYCLES: ReadonlyArray<{ offsetSec: number; u1ArvlCd: number }> = [
  { offsetSec: 0, u1ArvlCd: 99 }, // 06:43:38
  { offsetSec: 50, u1ArvlCd: 99 }, // 06:44:28
  { offsetSec: 153, u1ArvlCd: 5 }, // 06:46:11 — approaching, selectedTrainCode=null로도 발사 기대(fallback이 하드 필터가 아님)
  { offsetSec: 181, u1ArvlCd: 3 }, // 06:46:39 — 5분 repeat gate 내
  { offsetSec: 291, u1ArvlCd: 99 }, // 06:48:29
  { offsetSec: 346, u1ArvlCd: 5 }, // 06:49:24 — 5분 repeat gate 내
  { offsetSec: 437, u1ArvlCd: 5 }, // 06:50:55 — 5분 repeat gate 내
  { offsetSec: 469, u1ArvlCd: 3 }, // 06:51:27 — repeat gate는 경과. 동일 phase('approaching')
  // 재발사이므로 fallback dedup이 막아야 한다(fix 전: selectedTrainCode=null이라
  // trainCode dedup이 무력화돼 재발사 — 이 지점이 RED).
];

describe('#2880 (파생 replay) — selectedTrainCode=null dedup fail-open', () => {
  it(
    '후보 전원의 isUp이 반전돼 selectedTrainCode가 매 cycle null이어도, ' +
      '동일 phase(approaching) 재발사(index 7, 469s)는 fallback dedup으로 차단되고 ' +
      '전체 창에서 발사는 정확히 1회만 일어난다',
    async () => {
      const kv = new InMemoryKV(() => simNow);
      let simNow = offsetFromBase(0);
      const env = makeEnv(kv);
      const trip = makeTrip();
      const stats = makeStats();
      const log = vi.fn();

      let pool: readonly ArrivalEntry[] = [];
      const seoul = makeControllableSeoul(() => pool);
      const pushFetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
      const deps: ScheduledDeps = {
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: pushFetch,
        seoul,
        archFlag: 'off',
      };

      let pushId = 0;
      for (const [index, cycle] of CYCLES.entries()) {
        // 파생 — isUp을 전부 `true`로 반전(원본은 `false`). 건대입구→뚝섬 leg의 실제 진행방향은
        // down이므로, 반전된 isUp=true는 direction 필터에 전부 탈락해 selectedTrainCode가
        // null이 된다(위 파일 헤더 설명).
        pool = [arrival('U1', true, cycle.u1ArvlCd), arrival('U2', true, 99)];
        simNow = offsetFromBase(cycle.offsetSec);
        // eslint-disable-next-line no-await-in-loop -- replay는 cron cycle 순서 재현이 핵심이라 순차 await 필수.
        await maybeFireLegBoardingPrompt(trip, env, deps, stats, simNow, log, () => `p-${pushId++}`);

        if (index === 2) {
          expect(stats.legBoardingPromptFired).toBe(1);
        }
      }

      // 핵심 assert — index 7(469s)에서 재발사가 일어나면(구현 버그) 2가 되어 FAIL한다.
      expect(stats.legBoardingPromptFired).toBe(1);
      expect((pushFetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

      // 발사 2건 모두(최초 1건만 존재해야 하지만) gateDecision이 'approaching'이어야 — "다른
      // phase라 정당하게 재발사됐다"는 반박을 배제한다(동일 phase 재발사였음을 증명).
      const firedLogs = log.mock.calls.filter(([message]) => String(message).endsWith(': fired'));
      expect(firedLogs.length).toBe(1);
      const [, firstFiredMeta] = firedLogs[0];
      expect((firstFiredMeta as { gateDecision?: string }).gateDecision).toBe('approaching');
    },
  );
});
