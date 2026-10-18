/**
 * #3027 (Task 0) — 합성 whole-ride **등뼈**: 사용자 실사용 패턴("목적지만 설정, 지하 출발,
 * 환승 1회")의 가치 사슬 전체를 fake clock + 합성 Seoul API fixture로 재생해 등록→출발
 * 프롬프트→응답→lock→매역 fire→환승 하차 프롬프트→leg-2 lock→destination→종료를 한 재생에서
 * 완주시킨다. spec SSoT: `tasks/plan-2026-10-18-task0-whole-ride-spine.md`(v2).
 *
 * 프로덕션 코드 diff 0줄 — 이 테스트는 현 동작을 고정하고 red를 드러낼 뿐 고치지 않는다
 * (plan "금지" 절). 이후 Task 1~4(#3025 / D 재바인딩 #3028 / #2782)의 완료 조건은 "이
 * 테스트의 세그먼트 N이 red→green"이다.
 *
 * ## fixture 계보
 *
 * `capture_synth_whole_ride_spine.fixture.json`은 실캡처
 * `capture_20260913T1249Z_b00dd879`(2026-09-13, #2600 — 7호선·2호선 arrival을 한 재생에서
 * 서빙한 선례, U1 해소)를 베이스로 두 군데만 합성 보강했다(그 외 entries는 **전부 실측
 * 그대로**, tMs/arvlCd/간격 무변경):
 *   1. **prepend** — 실캡처는 "이미 탑승해 lock이 있는" 상태로 시작한다(용마산 승차 자체가
 *      윈도우 밖). 이 등뼈는 S-B/S-A가 **lockless 등록**(응답 전)부터 시작해야 하므로, 윈도우
 *      150초 앞에 용마산 도착(arvlCd=1) 1개 cycle을 합성 prepend했다 — 실캡처에 용마산 데이터가
 *      전혀 없어(desk20260913Trip이 이미 탑승 상태로 seed) 대체할 실측이 없다.
 *   2. **append** — 실캡처는 leg-2 프롬프트가 뜬 직후(+約652s)에 창이 끝난다(원 라이드가
 *      13:02Z user-delete로 종료돼 뚝섬 도착을 실측하지 못했다, `desk20260913Trip.ts` 헤더).
 *      윈도우 끝에 성수 ARRIVED(+60s)·뚝섬 ARRIVED(+180s, 역간 소요 120s — plan 금지 조항의
 *      90~150s 범위 안) 2개 cycle을 합성 append했다.
 *   3. **rename** — 실캡처의 leg-1 탑승 열차 `btrainNo/trainNo` **"7301"**을 **"7269"**로
 *      전수 치환했다(식별자 rename, 시계열/arvlCd 무변경 — plan 금지 "fixture 시계열 조정"은
 *      타이밍 조정을 금지한 것이고 식별자는 임의성이 전제된 값이라 범위 밖).
 *
 * 생성 스크립트는 `/tmp/gen_fixture.py`(1회성, repo에 커밋하지 않음 — 산출물 JSON만 커밋).
 *
 * S-C(조기 발사→오열차 lock)는 이 whole-ride 사슬과 무관한 별도 좁은 시나리오(용마산 2개
 * 열차 pool만 필요, 환승/목적지 불필요)라 별도 작은 합성 fixture
 * (`capture_synth_early_fire_wrong_lock.fixture.json`)를 쓴다 — plan "U1"은 S-B(whole-ride)의
 * 2노선 서빙 가능성에 대한 것이었고 S-C에는 적용되지 않는다.
 */
import { describe, expect, it, vi } from 'vitest';
import app from '../index';
import { runCaptureReplay, makeCaptureFetch, type CapturedPush } from './helpers/replayHarness';
import { makeWholeRideSpineTrip } from './helpers/wholeRideSpineTrip';
import { injectPrevDepartedTrainArrived } from './helpers/injectArrivalConfirmation';
import { firedStationOccurrences } from './helpers/pushAssertions';
import { parseReplayFixture } from '../replayFixture';
import { getTrip } from '../trips';
import type { Env, Trip } from '../types';
import wholeRideFixtureJson from './fixtures/spine/capture_synth_whole_ride_spine.fixture.json';
import earlyFireFixtureJson from './fixtures/spine/capture_synth_early_fire_wrong_lock.fixture.json';

const wholeRideFixture = parseReplayFixture(wholeRideFixtureJson);
const earlyFireFixture = parseReplayFixture(earlyFireFixtureJson);

/** 프롬프트 push의 payload — 키는 `body`(station push의 `data`와 다르다, #2989 선례). */
function promptPayload(push: CapturedPush): Record<string, unknown> | undefined {
  const payload = push.body.body as Record<string, unknown> | undefined;
  return payload?.kind === 'boarding-prompt' ? payload : undefined;
}

/** leg-1(origin) "탑승했냐?" 프롬프트 — line='7', hopEndKind 없음, candidateTrains 보유. */
function findOriginPrompt(pushes: readonly CapturedPush[]): Record<string, unknown> | undefined {
  return pushes
    .map(promptPayload)
    .find((p) => p !== undefined && p.hopEndKind === undefined && p.line === '7' && Array.isArray(p.candidateTrains));
}

/** 환승역 "하차했나요?" hop-end 프롬프트 — `hopEndKind:'disembark'`(#2034). */
function findHopEndPrompt(pushes: readonly CapturedPush[]): Record<string, unknown> | undefined {
  return pushes.map(promptPayload).find((p) => p?.hopEndKind === 'disembark');
}

/** leg-2(환승 후) "탑승하셨나요?" 프롬프트 — line=leg2Line, candidateTrains 보유, hopEndKind 없음. */
function findLegPrompt(pushes: readonly CapturedPush[], leg2Line: string): Record<string, unknown> | undefined {
  return pushes
    .map(promptPayload)
    .find((p) => p !== undefined && p.hopEndKind === undefined && p.line === leg2Line && Array.isArray(p.candidateTrains));
}

/** station push(alert) payload — `data`. */
function stationPushData(push: CapturedPush): Record<string, unknown> | undefined {
  if (push.headers.pushType !== 'alert') return undefined;
  return push.body.data as Record<string, unknown> | undefined;
}

async function postBoardingConfirmAt(
  tick: number,
  env: Env,
  token: string,
  station: string,
  line: string,
  trainCode: string,
): Promise<Response> {
  const spy = vi.spyOn(Date, 'now').mockReturnValue(tick);
  try {
    return await app.fetch(
      new Request(`http://example.com/trips/${token}/boarding-confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'boarded', station, line, trainCode }),
      }),
      env,
    );
  } finally {
    spy.mockRestore();
  }
}

describe('#3027 Task 0 — 합성 whole-ride 등뼈 (S-B 본선: 목적지만 설정 + 프롬프트 응답)', () => {
  it('B0~B7: 등록→출발 프롬프트→응답→lock→매역 fire→환승 하차 프롬프트→leg-2 lock→destination→종료가 한 재생에서 이어진다', async () => {
    const token = 'spine-sb';
    const seedTrip = makeWholeRideSpineTrip(token, wholeRideFixture.window.fromMs + 5_000);
    const transferWaypoint = seedTrip.waypoints.find((w) => w.kind === 'transfer');
    const leg2Waypoint = seedTrip.waypoints[seedTrip.waypoints.findIndex((w) => w.kind === 'transfer') + 1];
    expect(transferWaypoint, 'seed trip에 transfer waypoint가 있어야 한다').toBeDefined();
    expect(leg2Waypoint, 'transfer 다음 leg waypoint가 있어야 한다').toBeDefined();
    const leg2Line = leg2Waypoint!.line;

    let originPromptTrainCode: string | undefined;
    let originConfirmed = false;
    let legPromptTrainCode: string | undefined;
    let legConfirmed = false;
    let capturedEnv: Env | undefined;
    let lockTrainCodeRightAfterOriginConfirm: string | undefined;
    let legAnchorLineRightAfterLegConfirm: string | undefined;
    let lockTrainCodeRightAfterLegConfirm: string | undefined;

    const result = await runCaptureReplay({
      fixture: wholeRideFixture,
      seedTrips: [seedTrip],
      apns: 'capture',
      seedPositionSeries: {
        [token]: [
          {
            lat: 37.5664,
            lng: 127.0837,
            accuracy: 20,
            ts: wholeRideFixture.window.fromMs,
            motion: 'stationary',
          },
        ],
      },
      beforeTick: async ({ tick, env, pushes }) => {
        capturedEnv = env;

        // ── B1/B2 — origin 프롬프트가 떴으면 그 embed 열차로 즉시 confirm한다(하드코딩 금지).
        if (!originConfirmed) {
          const prompt = findOriginPrompt(pushes);
          if (prompt !== undefined) {
            const trainCode = prompt.trainCode;
            expect(trainCode, 'origin 프롬프트 payload에 trainCode가 실려야 한다').toBeTypeOf('string');
            originPromptTrainCode = trainCode as string;
            await postBoardingConfirmAt(tick, env, token, '용마산', '7', originPromptTrainCode);
            originConfirmed = true;
            const justConfirmed = await getTrip(env.TRIPS, token);
            lockTrainCodeRightAfterOriginConfirm = justConfirmed?.boardingLock?.trainCode;
          }
        }

        // #3057 — 프롬프트가 도착 확정 때만 발사되도록 바뀌어, 이 fixture(9/13 실캡처 계보 — 환승역
        // 도착 직전 8371 arvlCd=3에서 끝나고 append는 성수/뚝섬뿐)에는 leg-2 도착 확정이 없다.
        // 캡처가 보여준 그 arvlCd=3 열차의 도착 position만 주입한다(helper 주석 참고).
        if (originConfirmed && !legConfirmed) {
          await injectPrevDepartedTrainArrived(wholeRideFixture, env, tick, transferWaypoint!.stationName, leg2Line);
        }

        // ── B5/B6 — leg-2 프롬프트가 떴으면 그 embed 열차로 confirm한다(#2989와 동일 기법,
        // 중복 재검증 없이 재사용만).
        if (originConfirmed && !legConfirmed) {
          const prompt = findLegPrompt(pushes, leg2Line);
          if (prompt !== undefined) {
            const trainCode = prompt.trainCode;
            expect(trainCode, 'leg-2 프롬프트 payload에 trainCode가 실려야 한다').toBeTypeOf('string');
            legPromptTrainCode = trainCode as string;
            await postBoardingConfirmAt(tick, env, token, transferWaypoint!.stationName, leg2Line, legPromptTrainCode);
            legConfirmed = true;
            const justConfirmed = await getTrip(env.TRIPS, token);
            lockTrainCodeRightAfterLegConfirm = justConfirmed?.boardingLock?.trainCode;
            legAnchorLineRightAfterLegConfirm = justConfirmed?.currentLegAnchor?.line;
          }
        }
      },
    });

    expect(capturedEnv, '재생이 최소 1 tick은 실행돼야 한다').toBeDefined();

    // ── B0 (생존) — 재생 전 구간 trip-end reason=expired 0건.
    const expiredCount = result.pushes.filter((push) => {
      const data = stationPushData(push);
      return data?.kind === 'trip-ended' && data?.reason === 'expired';
    }).length;
    expect(expiredCount).toBe(0);

    // ── B1 — 출발 프롬프트 발사.
    expect(originPromptTrainCode).toBeTypeOf('string');

    // ── B2 — lock.trainCode가 origin 프롬프트가 제시한 그 열차(confirm 직후 시점 — 이후
    // leg-2 환승을 거치며 lock이 release/재생성되므로 재생 **종료 시점** 상태로 판정하면 안 된다).
    expect(lockTrainCodeRightAfterOriginConfirm).toBe(originPromptTrainCode);

    // ── B3 — 매역 fire ≥3 (CapturedPush 기준, v2 — DB 바인딩 없는 하네스라 D1 cron-fire-attempt
    // 은 이 테스트로 관측 불가. station-passed 채널 occurrences 집계).
    const stationOccurrences = firedStationOccurrences(result.pushes);
    const leg1IntermediateStations = seedTrip.waypoints
      .filter((w) => w.kind === 'intermediate' && w.line === '7')
      .map((w) => w.stationName);
    const leg1FireCount = stationOccurrences.filter((s) => leg1IntermediateStations.includes(s)).length;
    expect(leg1FireCount).toBeGreaterThanOrEqual(3);

    // ── B4 — 하차(hop-end) 프롬프트 발사(연결만 — 순서/거부/payload 세부는 #2989가 고정, 중복 금지).
    expect(findHopEndPrompt(result.pushes)).toBeDefined();

    // ── B5 — leg-2 탑승 프롬프트가 발사되고 trainCode를 실었다(연결만).
    expect(legPromptTrainCode).toBeTypeOf('string');

    // ── B6 — leg-2 lock이 그 열차로 생겼다(confirm 직후 시점 — 이후 destination 도착으로 trip이
    // KV에서 삭제되므로(#2991 cleanup 계약) 재생 **종료 시점** 상태로 판정하면 안 된다).
    // ambiguity/거부 세부는 #2989가 고정 — 여기선 연결만.
    expect(lockTrainCodeRightAfterLegConfirm).toBe(legPromptTrainCode);
    // leg-2 lock이 되면 currentLegAnchor가 이미 stamp된 상태(leg-2 line)이어야 한다 — release가
    // 안 일어난 채 confirm만 형식상 통과하는 경로를 배제(사슬 **연결** 확인).
    expect(legAnchorLineRightAfterLegConfirm).toBe(leg2Line);

    // ── B7 — destination 알림 + trip-end(reason≠expired). 순서/1회성/KV cleanup은 #2991이
    // 고정 — 여기선 연결만(준비→도착→종료가 실제로 일어났는지).
    const tripEndedNonExpired = result.pushes.filter((push) => {
      const data = stationPushData(push);
      return data?.kind === 'trip-ended' && data?.reason !== 'expired';
    });
    expect(tripEndedNonExpired.length).toBeGreaterThanOrEqual(1);
    const destinationArrival = result.pushes.find((push) => stationPushData(push)?.kind === 'destination');
    expect(destinationArrival).toBeDefined();
  }, 60_000);
});

describe('#3027 Task 0 — S-A(무응답): 설계된 트레이드오프의 문서화', () => {
  it('A1: 출발 프롬프트는 발사 / A2: lock 0 → advance 0 → 매역 0', async () => {
    const token = 'spine-sa';
    const seedTrip = makeWholeRideSpineTrip(token, wholeRideFixture.window.fromMs + 5_000);

    let capturedEnv: Env | undefined;
    const result = await runCaptureReplay({
      fixture: wholeRideFixture,
      seedTrips: [seedTrip],
      apns: 'capture',
      seedPositionSeries: {
        [token]: [
          {
            lat: 37.5664,
            lng: 127.0837,
            accuracy: 20,
            ts: wholeRideFixture.window.fromMs,
            motion: 'stationary',
          },
        ],
      },
      // beforeTick 미지정 — 무응답(no-op).
      beforeTick: async ({ env }) => {
        capturedEnv = env;
      },
    });

    expect(capturedEnv, '재생이 최소 1 tick은 실행돼야 한다').toBeDefined();

    // A1 — 출발 프롬프트는 발사된다(무응답이어도 발사 자체는 정상).
    expect(findOriginPrompt(result.pushes)).toBeDefined();

    // A2 — 응답이 없으니 lock은 생기지 않고, advance/매역 fire도 0이다(확정 아키텍처상 의도된
    // 동작 — ADR-010/#2900 "탑승 증거 없이 자동 lock 금지").
    const finalTrip = await getTrip(capturedEnv!.TRIPS, token);
    expect(finalTrip?.boardingLock).toBeUndefined();
    expect(firedStationOccurrences(result.pushes)).toEqual([]);
  }, 60_000);
});

describe('#3027 Task 0 — S-C(조기 발사 → 오열차 lock): red 정적 확정, Task D(#3028)의 완료 조건', () => {
  const TOKEN_C1 = 'spine-sc-c1';
  const TOKEN_C1_PRIME = 'spine-sc-c1-prime';
  const TOKEN_C2 = 'spine-sc-c2';

  function makeEarlyFireSeedTrip(token: string): Trip {
    return {
      token,
      route: { type: 'direct', stops: 1, line: '7' },
      destination: '중곡',
      waypoints: [{ stationName: '중곡', line: '7', kind: 'destination' }],
      expiresAt: earlyFireFixture.window.toMs + 60 * 60_000,
      createdAt: earlyFireFixture.window.fromMs,
      alarmAtEpochMs: earlyFireFixture.window.fromMs,
      promptDisplay: { originStation: '용마산', line: '7' },
      promptGeoContext: {
        origin: { lat: 37.5664, lng: 127.0837 },
        nextStation: { lat: 37.5571, lng: 127.0796 },
        direction: 'down',
        originDistanceM: 80,
        originAccuracyM: 20,
      },
      trackingOptIn: true,
      promptOptIn: false,
      infoModeEnabled: false,
    };
  }

  // 리드-7267이 먼저 진입(프롬프트 발사) → 7267 출발 후 리얼 탑승 열차 7269가 도착 → body에
  // stale 값(7267, 앞차)이 실려 오면 backend는 body-first(#2961)로 그대로 lock한다.
  //
  // 추적처 교정(2026-10-18): 오염의 1차 근원(device가 fire-시점 embed를 그대로 전송하던
  // `useBoardingPromptResponder.ts` 비대칭)은 #3028/PR #3030으로 **해소됐다** — fresh 재조회
  // 성공 시 그 값을 전송한다. 그러나 이 테스트가 고정하는 것은 **backend 쪽 잔여 설계 질문**:
  // 어떤 이유로든 stale trainCode가 body에 실려 도착하면(재조회 실패 fallback 포함) backend는
  // 그 열차가 이미 떠났는지 검증하지 않고 lock한다(`resolveBodyTrainCodeLock` — corroboration은
  // fire-시점 pool 소속만 확인, liveness 무검증). 추적: **#2696**(탑승 열차 식별 단일화, OPEN).
  // 아래 C1′가 증명하듯 live 재조회 경로는 올바른 차(7269)를 잡으므로, backend가 stale body를
  // 거부하고 live로 떨어뜨리는 선택지가 실측으로 뒷받침된다 — 결정은 #2696 소관.
  it.fails('C1: lock.trainCode는 실제 탄 차(7269)여야 하지만 — stale body를 liveness 무검증 신뢰해 앞차(7267)가 lock된다 (#2696, 근원 채널은 #3028 해소)', async () => {
    const seedTrip = makeEarlyFireSeedTrip(TOKEN_C1);

    let capturedEnv: Env | undefined;
    await runCaptureReplay({
      fixture: earlyFireFixture,
      seedTrips: [seedTrip],
      apns: 'capture',
      beforeTick: async ({ tick, env, tickIndex }) => {
        capturedEnv = env;
        // cycle1(tickIndex===1) — 7269 도착 시각. 이 시점에 body.trainCode=7267(앞차 embed
        // 값, 실사용 충실)을 동봉해 boarding-confirm을 1회 주입한다.
        if (tickIndex === 1) {
          await postBoardingConfirmAt(tick, env, TOKEN_C1, '용마산', '7', '7267');
        }
      },
    });

    const trip = await getTrip(capturedEnv!.TRIPS, TOKEN_C1);
    expect(trip?.boardingLock?.trainCode).toBe('7269');
  }, 60_000);

  it("C1′(관측): body.trainCode 미동봉(LA 버튼 모양) 응답 — live 재조회가 실제 탄 차를 잡는지", async () => {
    const seedTrip = makeEarlyFireSeedTrip(TOKEN_C1_PRIME);

    let capturedEnv: Env | undefined;
    await runCaptureReplay({
      fixture: earlyFireFixture,
      seedTrips: [seedTrip],
      apns: 'capture',
      beforeTick: async ({ tick, env, tickIndex }) => {
        capturedEnv = env;
        if (tickIndex === 1) {
          const spy = vi.spyOn(Date, 'now').mockReturnValue(tick);
          // body에 trainCode가 없으면 핸들러가 live 재조회(attemptBoardingAnchorResolution →
          // SeoulArrivalClient)를 타는데, 그 클라이언트는 전역 fetch를 쓴다(fetchImpl 미주입,
          // `index.ts` boarding-confirm — #2734/replay_20260918_boarding_confirm.test.ts:148 선례).
          // 스텁 없이는 네트워크 예외가 삼켜져 lock=undefined가 "live 경로 결함"이 아니라
          // "테스트 인프라 공백"을 기록하게 된다 — 관측값 오염 방지를 위해 fixture로 라우팅.
          vi.stubGlobal('fetch', makeCaptureFetch(earlyFireFixture, () => tick));
          try {
            await app.fetch(
              new Request(`http://example.com/trips/${TOKEN_C1_PRIME}/boarding-confirm`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                // LA AppIntent 실제 body(`BoardingIntents.swift:59`) — trainCode 없음.
                body: JSON.stringify({ action: 'boarded', station: '용마산', line: '7' }),
              }),
              env,
            );
          } finally {
            spy.mockRestore();
            vi.unstubAllGlobals();
          }
        }
      },
    });

    // 관측 기록 — 이 값이 '7269'(green, "LA 버튼 응답은 이미 안전")이든 다른 값/undefined(red,
    // "live 경로도 결함")이든 둘 다 Task D(#3028) 스펙의 입력이다(plan v2 §S-C 4). 이 테스트는
    // 어느 쪽도 사전에 강제하지 않고 현재 실측을 그대로 기록한다.
    const trip = await getTrip(capturedEnv!.TRIPS, TOKEN_C1_PRIME);
    expect(['7269', undefined]).toContain(trip?.boardingLock?.trainCode);
  }, 60_000);

  it('C2(거부): 응답 시각에 도착 직후 열차가 모호(2대 동시)하면 fail-closed(lock 생기지 않음)', async () => {
    const seedTrip = makeEarlyFireSeedTrip(TOKEN_C2);

    let capturedEnv: Env | undefined;
    await runCaptureReplay({
      fixture: earlyFireFixture,
      seedTrips: [seedTrip],
      apns: 'capture',
      beforeTick: async ({ tick, env, tickIndex }) => {
        capturedEnv = env;
        // cycle2(tickIndex===2) — 두 열차(9101/9103)가 동시에 ARRIVED인 모호 시점. body에
        // trainCode를 싣지 않아(LA 버튼 모양) live 재조회 경로를 타게 한다 — 그 경로가
        // ambiguity를 만나 fail-closed하는지 본다.
        if (tickIndex === 2) {
          const spy = vi.spyOn(Date, 'now').mockReturnValue(tick);
          // C1′과 동일 — live 재조회 경로가 전역 fetch를 쓰므로 fixture로 라우팅(위 주석 참고).
          vi.stubGlobal('fetch', makeCaptureFetch(earlyFireFixture, () => tick));
          try {
            await app.fetch(
              new Request(`http://example.com/trips/${TOKEN_C2}/boarding-confirm`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'boarded', station: '용마산', line: '7' }),
              }),
              env,
            );
          } finally {
            spy.mockRestore();
            vi.unstubAllGlobals();
          }
        }
      },
    });

    const trip = await getTrip(capturedEnv!.TRIPS, TOKEN_C2);
    expect(trip?.boardingLock).toBeUndefined();
  }, 60_000);
});
