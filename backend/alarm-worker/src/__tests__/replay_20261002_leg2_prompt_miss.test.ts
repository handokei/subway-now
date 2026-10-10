/**
 * #2801 (3차 reopen, replay) — 10/2 실측 트립(용마산 → 건대입구 환승 → 2호선 → 뚝섬) leg-2에서
 * "탑승하셨나요?" 프롬프트 시도 9회가 전부 `suppressed-not-imminent`로 억제돼 miss가 발생한
 * 회귀를 `maybeFireLegBoardingPrompt` whole-cycle replay로 고정한다.
 *
 * 실측 D1 타임라인 (trip_events, KST 06:28~06:53 전수 조회, 불변 — 통과시키려 조정 금지):
 *   06:43:38 leg-boarding-prompt candidateArvlCds=[99,99] suppressed-not-imminent
 *   06:44:28 leg-boarding-prompt candidateArvlCds=[99,99] suppressed-not-imminent
 *   06:46:11 leg-boarding-prompt candidateArvlCds=[5,99]  suppressed-not-imminent
 *   06:46:39 leg-boarding-prompt candidateArvlCds=[3,99]  suppressed-not-imminent
 *   06:48:29 leg-boarding-prompt candidateArvlCds=[99,99] suppressed-not-imminent
 *   06:49:24 leg-boarding-prompt candidateArvlCds=[5,99]  suppressed-not-imminent
 *   06:50:55 leg-boarding-prompt candidateArvlCds=[5,99]  suppressed-not-imminent
 *   06:51:27 leg-boarding-prompt candidateArvlCds=[3,99]  suppressed-not-imminent
 * 사용자는 06:49:30경 실제 탑승(덤프 GPS 21.9m/s @06:49:54). arvlCd∈{0,1,2}(imminent)가 cron
 * 60s 샘플에 한 번도 걸리지 않았다 — 가장 근접한 관측은 5(전역도착)/3(전역출발).
 *
 * 정직한 재구성 표기: trainCode는 D1에 로깅되지 않았다(candidateArvlCds 계측(#2834/#2853)에
 * trainCode 필드가 없음) — 사용자 열차 1개(아래 trainCode 'U1'로 명명, arvlCd가 5→3→...로
 * 실측 시퀀스를 따름) + 항상 99(운행중)인 후행 열차 1개로 재구성했다(재구성 선례:
 * `replay_20260930_leg2_prompt.test.ts` L21~24). 나머지(시각 순서, candidateArvlCds 값, 전부
 * suppressed-not-imminent)는 D1 실측.
 *
 * #2879 (판정 교정, 메인 세션 코멘트 "판정 교정" 2026-10-06) — U1/U2의 `isUp` 재구성값을
 * `true`→`false`로 교정한다(재구성 라벨 교정 — D1 실측 조정 아님, isUp 자체가 D1 미로깅
 * 재구성 필드임은 위 문단에서 이미 고지). 근거:
 *   ① 이 leg(건대입구→뚝섬, 2호선)의 물리 진행방향은 `inferLegDirection`의 pure-loop arc
 *      비교(건대입구 mainIdRange idx11 → 뚝섬 idx9, idx 감소=backward arc)로 **외선(down)**이다
 *      — 실측 52쌍(#2692) + 10/3 13:24 캡처(#2867)로 확정된 ground truth와 정합.
 *   ② 본 파일의 `isUp`은 D1에 로깅되지 않는 재구성 필드임을 위 문단이 이미 고지한다 — "실측
 *      조정 금지" 제약은 D1에서 그대로 가져온 필드(시각/candidateArvlCds/suppressed 라벨)에만
 *      적용되고, 재구성 필드의 라벨 오류 교정에는 적용되지 않는다.
 *   ③ `isUp:true`는 작성 시점(#2867/#2871 이전, 2호선 방향이 반대로 반환되던 구 코드)에
 *      `pickAutoTrainCode`의 방향 필터를 통과시키려고 작성자가 고른 값이다 — 방향 역전이
 *      수정된 지금은 외선 방향이 `isUp:false`이므로, 같은 "방향 필터를 통과하는 사용자
 *      열차"라는 재구성 의도를 유지하려면 `false`로 교정해야 한다.
 *
 * 스코프: leg-1 매역 발사는 다른 함수(`maybeFireStationEvents` 계열)가 담당 — 이 replay는
 * leg-2 boarding-prompt 게이트(`decideBoardingPromptFire`) 단일 관심사로 제한한다
 * (`replay_20260930_leg2_prompt.test.ts`와 동일 스코프 결정).
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

// D1 첫 observed cycle(06:43:38)를 epoch 0으로 두고, 이후 오프셋은 실측 시:분:초 차이 그대로.
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
    token: 'trip-20261002-leg2',
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

// 실측 8 cycle의 시:분:초(06:43:38 기준 상대 오프셋, 초 단위)와 사용자 열차(U1)의 candidateArvlCds.
// 후행 열차(U2)는 전 cycle 99(운행중) — D1 실측 pair 값([.,99])과 정합.
const CYCLES: ReadonlyArray<{ offsetSec: number; u1ArvlCd: number }> = [
  { offsetSec: 0, u1ArvlCd: 99 }, // 06:43:38
  { offsetSec: 50, u1ArvlCd: 99 }, // 06:44:28
  { offsetSec: 153, u1ArvlCd: 5 }, // 06:46:11 — 최초 approaching 발사 기대
  { offsetSec: 181, u1ArvlCd: 3 }, // 06:46:39 — 5분 repeat gate 내, 발사 0 기대
  { offsetSec: 291, u1ArvlCd: 99 }, // 06:48:29
  { offsetSec: 346, u1ArvlCd: 5 }, // 06:49:24 — 5분 repeat gate 내
  { offsetSec: 437, u1ArvlCd: 5 }, // 06:50:55 — 5분 repeat gate 내
  { offsetSec: 469, u1ArvlCd: 3 }, // 06:51:27 — repeat gate는 경과했으나 trainCode dup로 재차단
];

describe('#2801 (3차 reopen) replay — 10/2 leg-2 boarding-prompt approaching miss', () => {
  it('9회 전부 suppressed였던 cron 샘플을 approaching 게이트로 재생하면 06:46:11 상당 cycle(index=2)에서 정확히 1회 발사하고, 이후(5분 repeat gate + trainCode dedup) 전체 창 종료까지 추가 발사는 0이다', async () => {
    const kv = new InMemoryKV(() => simNow);
    let simNow = offsetFromBase(0);
    const env = makeEnv(kv);
    const trip = makeTrip();
    const stats = makeStats();
    const log = vi.fn();

    let pool: readonly ArrivalEntry[] = [];
    const seoul = makeControllableSeoul(() => pool);
    const pushFetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const deps: ScheduledDeps = { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: pushFetch, seoul, archFlag: 'off' };

    let pushId = 0;
    for (const [index, cycle] of CYCLES.entries()) {
      // #2879 — isUp:false로 교정(건대입구→뚝섬 leg는 외선/down, 위 헤더 주석 근거 ①~③).
      pool = [arrival('U1', false, cycle.u1ArvlCd), arrival('U2', false, 99)];
      simNow = offsetFromBase(cycle.offsetSec);
      // eslint-disable-next-line no-await-in-loop -- replay는 cron cycle 순서 재현이 핵심이라 순차 await 필수.
      await maybeFireLegBoardingPrompt(trip, env, deps, stats, simNow, log, () => `p-${pushId++}`);

      // code-review(medium) — fixture가 결정적이므로 느슨한 범위(≤2) 대신 정확한 시점을 단언한다.
      // 최초 발사가 cycle index 2(06:46:11 상당, approaching arvlCd=5) **직후** 정확히 1이어야
      // 한다 — 뒤로 밀리면(예: 다음 cycle에서야 발사) 사용자 실탑승(06:49:30)보다 늦어 miss가
      // 재발하는데, ≤2 범위 assert는 이를 green으로 통과시켜 버린다.
      if (index === 2) {
        expect(stats.legBoardingPromptFired).toBe(1);
      }
    }

    // 전체 창 종료 후에도 정확히 1 — 469s cycle(repeat gate는 경과하지만 trainCode dedup으로
    // 재차단)에서 추가 발사가 나오면 사용자 탑승 후 스팸인데, 느슨한 ≤2 assert는 이를 놓친다.
    expect(stats.legBoardingPromptFired).toBe(1);
    expect((pushFetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    // 최초 발사가 06:46:11 상당 cycle(approaching, arvlCd=5)에서 일어났는지 — fired 로그에
    // gateDecision='approaching'이 기록돼야 한다(D1 meta로 나가는 것과 동일 라벨).
    const firedLogs = log.mock.calls.filter(([message]) => String(message).endsWith(': fired'));
    expect(firedLogs.length).toBe(1);
    const [, firstFiredMeta] = firedLogs[0];
    expect((firstFiredMeta as { gateDecision?: string }).gateDecision).toBe('approaching');

    // 5분 내 후속 cycle(06:46:39/06:48:29/06:49:24/06:50:55)은 발사 0 — repeat gate가 스팸을
    // 막는다(반복 방어 로직 무변경 회귀 안전).
    expect(trip.legBoardingPromptState?.fireCount ?? 0).toBe(1);
  });
});
