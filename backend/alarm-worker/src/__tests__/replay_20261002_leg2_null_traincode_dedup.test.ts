/**
 * #2880 (replay, 파생 fixture) — `replay_20261002_leg2_prompt_miss.test.ts`의 8-cycle 실측
 * 타임라인을 **그대로** 재사용하되, 후보 전원의 `isUp`을 전부 반전시킨 **파생** 변형이다
 * (원본 파일/원본 데이터는 무변경 — 이 파일은 별도 파생 fixture).
 *
 * #2944 (H-6) 이후 — 이 파일이 재현하던 `selectedTrainCode=null` dedup 무력화 버그는 **구조적
 * 전제 자체가 사라졌다**. 구 아키텍처는 `fireBoardingPromptForAnchor`의 gate-판정 pool과
 * `pickAutoTrainCode`가 **서로 다른** direction 필터를 각자 적용했다 — gate-pool은
 * directional 0건이면 line-only로 fallback(§1 fallback, #2532 취지)해 "방향 무관 전체"가
 * 됐지만, `pickAutoTrainCode`는 그 line-only pool에 **자신의** direction 필터를 다시 걸어
 * 후보 전원이 틀린 방향이면 trainCode 선택만 null이 되는 불일치가 있었다 — "게이트는 통과,
 * trainCode만 미특정"인 상태가 가능했던 이유.
 *
 * H-6의 pool 분리(판정용 `pool`=`decisionPool` 단일 소스를 gate/candidateTrains/
 * `pickAutoTrainCode` 전부가 공유)가 이 불일치를 원천 제거했다 — 이제 방향이 known인데
 * 후보 전원이 틀린 방향이면 `decisionPool` 자체가 0건이라 gate 평가 전에 `onEmptyCandidates`
 * 로 종료된다. 즉 이 파생 fixture가 만들던 "임박 판정은 통과하는데 trainCode만 null" 상태가
 * 더 이상 존재하지 않는다 — #2880의 dedup 우회 버그 class 자체가 구조적으로 닫혔다(해당
 * 불일치 경로에 대해서만; ambiguity 등 다른 null-trainCode 원인의 dedup은 별도 유지).
 *
 * 따라서 이 테스트는 "1회 발사 후 재발사 차단"이 아니라 "방향 전원 불일치 → 매 cycle 0건
 * (gate 자체 미도달)"을 확인하는 것으로 갱신한다 — 이것이 새 아키텍처에서 올바른 동작이다.
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

describe('#2880 (파생 replay) — selectedTrainCode=null dedup fail-open (#2944 H-6 이후: 구조적으로 재현 불가 확인)', () => {
  it(
    '후보 전원의 isUp이 반전(실제 진행방향과 불일치)되면 decisionPool이 fail-closed로 매 cycle ' +
      '0건이 돼 gate 자체에 도달하지 못한다 — 구 "게이트 통과 + trainCode만 null" 상태가 더 ' +
      '이상 발생하지 않음을 확인(발사 0회, blocked 전량)',
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
      for (const cycle of CYCLES) {
        // 파생 — isUp을 전부 `true`로 반전(원본은 `false`). 건대입구→뚝섬 leg의 실제 진행방향은
        // down이므로, 반전된 isUp=true는 decisionPool 구성에서 전부 탈락한다(위 파일 헤더 설명,
        // #2944 H-6 갱신) — line-only fallback이 더 이상 candidateTrains/gate를 먹이지 않는다.
        pool = [arrival('U1', true, cycle.u1ArvlCd), arrival('U2', true, 99)];
        simNow = offsetFromBase(cycle.offsetSec);
        // eslint-disable-next-line no-await-in-loop -- replay는 cron cycle 순서 재현이 핵심이라 순차 await 필수.
        await maybeFireLegBoardingPrompt(trip, env, deps, stats, simNow, log, () => `p-${pushId++}`);
      }

      // 핵심 assert — 전체 8 cycle 동안 단 한 번도 발사되지 않는다(구 버그의 전제인 "게이트는
      // 통과, trainCode만 미특정" 상태가 decisionPool fail-closed로 원천 제거됐기 때문).
      expect(stats.legBoardingPromptFired).toBe(0);
      expect(stats.legBoardingPromptBlocked).toBe(CYCLES.length);
      expect((pushFetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
      const firedLogs = log.mock.calls.filter(([message]) => String(message).endsWith(': fired'));
      expect(firedLogs.length).toBe(0);
    },
  );
});
