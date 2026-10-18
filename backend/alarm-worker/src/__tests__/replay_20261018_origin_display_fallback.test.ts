/**
 * #3038 — 2026-10-18 18:37 실라이드(군자→용마산) 실캡처 재생.
 *
 * fixture: `capture_20261018T0935Z_b00dd879`(`.fixture-staging/`, 레지스트리 미등록 — fs로
 * 직접 로드한다. #3036 issue 본문이 명시하는 대로 `src/__tests__/fixtures/replayLibrary/`로
 * 옮기지 않고 `replay_library.full.test.ts`에도 등록하지 않는다).
 *
 * #3036 issue 본문이 재생으로 확정한 사실: "실캡처의 조회 대상 = 중곡×8·용마산×8·7호선×8 —
 * 출발역(군자) 0회." 즉 **production은 8/8 cycle 동안 군자 arrivals를 단 한 번도 조회하지
 * 않았다** — `maybeFireOriginBoardingPromptGpsFree`의 `if (!display) return`(#3038의 결함)이
 * 매 cycle 그 이전에 침묵했기 때문이다.
 *
 * ## 이 재생이 증명하는 것 / 증명하지 못하는 것
 *
 * 증명: fix 전에는 `originGpsFreeDisplayDerived`가 전체 cycle에서 0(derivation 분기 자체에
 * 도달 못함 — #3038 fix 이전 `scheduled.ts`는 이 필드가 존재하지도 않는다). fix 후에는 1 이상
 * (display가 파생돼 후보 단계까지 진행) — "매 cycle 그 이전 게이트에서 차단"되던 사슬이
 * 실제로 풀렸다는 증거.
 *
 * 증명하지 못하는 것: 실제 `boarding-prompt` push 발사(`originGpsFreeBoardingPromptFired`).
 * 위 인용대로 실캡처는 군자 arrivals를 **한 번도 요청하지 않았다** — record-replay fixture는
 * 실제로 요청된 호출만 응답을 담는다. fix가 그 호출을 처음으로 시도하게 만들어도, 재생
 * 하네스(`makeCaptureFetch`)는 캡처되지 않은 target에 대해 항상 빈 Seoul 응답
 * (`{realtimeArrivalList:[]}`)을 돌려준다 — 이것은 fix의 결함이 아니라 **recording 자체의
 * 커버리지 갭**이다(실 프로덕션에서는 이제 Seoul이 실제로 호출되어 실 열차 데이터를
 * 받는다). 그래서 이 테스트는 "후보 단계 도달"(`originGpsFreeBoardingPromptBlocked`, reason
 * 무관 — 핵심은 **침묵이 아니라 관측 가능한 차단**이라는 것)까지만 assert한다 — #3038 이슈
 * 본문의 "후보 단계에 도달했다면 군자 arrivals를 조회했을 것"을 그대로 뒤집은 것이 이 테스트의
 * 성공 기준이다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { appendPositionPoint } from '../positionSeries';
import { parseReplayFixture, type ReplayFixture } from '../replayFixture';
import { maybeFireOriginBoardingPromptGpsFree, type ScheduledDeps, type ScheduledStats } from '../scheduled';
import { SeoulArrivalClient } from '../seoul';
import { findStationCoordsByNameAndLine } from '../stationsLookup';
import type { Env, PositionPoint, Trip } from '../types';
import { makeCaptureFetch } from './helpers/replayHarness';
import { InMemoryKV } from './inMemoryKv';

const FIXTURE_PATH = path.join(
  __dirname,
  '..',
  '..',
  '.fixture-staging',
  'capture_20261018T0935Z_b00dd879.fixture.json',
);

const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' } as const;

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

function loadFixture(): ReplayFixture {
  const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
  return parseReplayFixture(raw);
}

function makeEnv(kv: InMemoryKV): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
    APNS_HOST: APNS_HOSTS.production,
    APNS_HOST_SANDBOX: APNS_HOSTS.sandbox,
    SEOUL_API_HOST: 'seoul.api',
    SEOUL_API_KEY: 'KEY',
    APNS_KEY_ID: apnsConfig.keyId,
    APNS_TEAM_ID: apnsConfig.teamId,
    APNS_PRIVATE_KEY: apnsConfig.privateKeyPem,
    APNS_BUNDLE_ID: apnsConfig.bundleId,
  };
}

function makeEmptyStats(): ScheduledStats {
  // #3038 — 이 재생은 maybeFireOriginBoardingPromptGpsFree만 직접 호출하므로 ScheduledStats
  // 전체를 쓰지 않는다. 함수가 실제로 증가시키는 필드만 0으로 채우고 나머지는 사용되지
  // 않으므로 any로 캐스팅 — `createEmptyScheduledStats`(scheduled.ts) 전체를 그대로 import해
  // 쓰면 이 테스트가 그 함수의 내부 구현(필드 목록)에 결합된다.
  return {
    originGpsFreeBoardingPromptFired: 0,
    originGpsFreeBoardingPromptBlocked: 0,
    originGpsFreeSnapshotDistrusted: 0,
    trackingOptInProximityMissingBlocked: 0,
    originGpsFreeDisplayDerived: 0,
    originGpsFreeDisplayDerivationFailed: 0,
    promptDirectionUnknownBlocked: 0,
    errors: 0,
  } as unknown as ScheduledStats;
}

/** seed trip — 실측 그대로: origin=군자(능동), waypoints=중곡(intermediate)→용마산(destination), 둘 다 7호선. */
function makeSeedTrip(token: string, now: number, overrides?: { promptDisplay?: Trip['promptDisplay'] }): Trip {
  return {
    token,
    route: { type: 'direct', line: '7', stops: 2 },
    destination: '용마산',
    waypoints: [
      { stationName: '중곡', line: '7', kind: 'intermediate' },
      { stationName: '용마산', line: '7', kind: 'destination' },
    ],
    expiresAt: now + 60 * 60_000,
    createdAt: now,
    alarmAtEpochMs: now,
    promptOptIn: true,
    originStationName: '군자(능동)',
    // #3038 — 등록 race로 유실된 상태를 재현: promptDisplay/promptGeoContext 둘 다 없음.
    promptDisplay: overrides?.promptDisplay,
  } as unknown as Trip;
}

/** 실측 position 2건(18:39:55/18:40:05, 둘 다 acc19m) — #3036 issue 본문 그대로. */
function buildPositionSeries(): PositionPoint[] {
  const coords = findStationCoordsByNameAndLine('군자(능동)', '7');
  if (coords === null) throw new Error('fixture 전제 실패 — 군자(능동) 7호선 좌표 lookup 불가');
  return [
    { lat: coords.lat, lng: coords.lng, accuracy: 19, ts: 1_792_316_395_000, motion: 'stationary' },
    { lat: coords.lat, lng: coords.lng, accuracy: 19, ts: 1_792_316_405_000, motion: 'stationary' },
  ];
}

/**
 * fixture의 실제 cron tick(cycleStartsMs)을 그대로 걸으며 `maybeFireOriginBoardingPromptGpsFree`
 * 만 직접 재생한다(#2600 ceilingMs 보정 포함 — `runCaptureReplay`와 동일 정책). position
 * series는 각 point의 ts가 지난 tick에서부터 반영된다.
 */
async function replayOriginGate(
  fixture: ReplayFixture,
  trip: Trip,
  positionPoints: PositionPoint[],
): Promise<ScheduledStats[]> {
  const kv = new InMemoryKV(() => fixture.cycleStartsMs[0]);
  const env = makeEnv(kv);
  const queue = [...positionPoints].sort((a, b) => a.ts - b.ts);
  const results: ScheduledStats[] = [];

  for (let i = 0; i < fixture.cycleStartsMs.length; i += 1) {
    const tick = fixture.cycleStartsMs[i];
    while (queue.length > 0 && queue[0].ts <= tick) {
      const point = queue.shift();
      if (point) await appendPositionPoint(kv as unknown as KVNamespace, trip.token, point);
    }
    const ceilingMs = fixture.cycleStartsMs[i + 1] ?? fixture.window.toMs + 1;
    const seoul = new SeoulArrivalClient({
      apiKey: 'KEY',
      host: 'seoul.api',
      now: () => tick,
      fetchImpl: makeCaptureFetch(fixture, () => tick, { ceilingMs }),
    });
    const deps: ScheduledDeps = {
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      seoul,
      archFlag: 'off',
    } as unknown as ScheduledDeps;
    const stats = makeEmptyStats();
    await maybeFireOriginBoardingPromptGpsFree(trip, env, deps, stats, tick, () => {}, () => `replay-${tick}`);
    results.push(stats);
  }
  return results;
}

describe('#3038 replay — 2026-10-18 18:37 군자→용마산 (capture_20261018T0935Z_b00dd879)', () => {
  it('display가 originStationName+waypoint로 파생되어 후보 단계(Seoul arrivals 조회)에 도달한다', async () => {
    const fixture = loadFixture();
    const trip = makeSeedTrip('trip-20261018-origin-fallback', fixture.cycleStartsMs[0]);
    const positionPoints = buildPositionSeries();

    const cycles = await replayOriginGate(fixture, trip, positionPoints);

    const totalDerived = cycles.reduce((sum, s) => sum + s.originGpsFreeDisplayDerived, 0);
    const totalDerivationFailed = cycles.reduce((sum, s) => sum + s.originGpsFreeDisplayDerivationFailed, 0);
    const totalFired = cycles.reduce((sum, s) => sum + s.originGpsFreeBoardingPromptFired, 0);
    const totalBlocked = cycles.reduce((sum, s) => sum + s.originGpsFreeBoardingPromptBlocked, 0);

    // #3038 핵심 — display가 매 cycle 파생돼 더 이상 무카운터 silent return이 아니다.
    expect(totalDerived).toBeGreaterThanOrEqual(1);
    expect(totalDerivationFailed).toBe(0);

    // 후보 단계(Seoul arrivals 조회)까지 도달 — 이슈 본문 "후보 단계에 도달했다면 군자
    // arrivals를 조회했을 것"의 역: 도달했다는 것은 이제 관측 가능한 사유로 차단된다는 것.
    expect(totalBlocked).toBeGreaterThanOrEqual(1);

    // 실제 push 발사(0)는 fix의 결함이 아니다 — 위 파일 헤더 설명대로 실캡처가 군자 arrivals를
    // 한 번도 캡처하지 않았다(production이 8/8 cycle 동안 이 게이트 이전에 침묵했기 때문).
    // 이 assertion은 그 recording 갭을 명시적으로 고정해 향후 fixture 교체 시에만 갈아탄다.
    expect(totalFired).toBe(0);
  });
});
