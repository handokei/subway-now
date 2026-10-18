/**
 * #2989 — 환승 경계 **사슬** 축 게이트: leg-1 lock → transfer advance → leg-2 프롬프트 → leg-2 lock.
 *
 * ## 왜 이 테스트가 필요한가 (mutation 측정 근거)
 *
 * 사슬의 각 구간은 두껍게 덮여 있다(2026-10-14, backend 4001개 대상 실측):
 *   - `advanceBoardingLockWaypoint`(waypoint advance) 사망 → **120건** 실패
 *   - `decideBoardingPromptFire`(프롬프트 발사 결정) 사망 → **74건** 실패
 *
 * 그런데 **구간을 연결하는 테스트가 없었다.** 사용자 신고 4건이 전부 "함수가 틀렸다"가 아니라
 * **"함수에 안 갔다"**였고(`#2976` 복원 시 3건만 깨짐 / `#2988` stamp 제거 시 1건만 깨짐),
 * 환승 경계는 10/9·10/13 사고의 공통 무대다.
 *
 * 기존 환승 커버리지가 이 축을 타지 않는 이유:
 *   - `replay_library.full.test.ts`의 이 fixture 엔트리 — leg-1 4역 발사 + 건대입구 hop-end
 *     프롬프트까지만 assert. **lock이 release되는지 / leg-2 프롬프트가 발사되는지 / 그 열차로
 *     leg-2 lock이 되는지는 어느 엔트리도 보지 않는다.**
 *   - `replay_20261009_leg2_lock_prompt.test.ts`(#2939) — `trip.boardingLock`을 **손으로 박고**
 *     시작한다. 환승 경계를 실제로 통과하지 않는다.
 *   - `replay_20260918_leg2_wrong_lock.test.ts` — leg-2 lock이 **끝내 생기지 않는** 경로의
 *     anchor다(안전 결과 쪽). "환승을 통과해 leg-2 lock이 **생기는**" 정상 경로가 없었다.
 *
 * ## 재생 타임라인 (기존 fixture 실측 — 새 캡처 불필요)
 *
 * `capture_20260913T1249Z_b00dd879`(2026-09-13 실캡처)는 7호선·2호선 arrival을 모두 담아
 * 사슬 전 구간이 재생된다. `beforeTick` 주입으로 측정한 값:
 *
 *   +465s  leg-1 lock(7호선) 활성, wp0=건대입구 → transfer advance(`kind=transfer` push +
 *          hop-end 프롬프트 `hopEndKind:'disembark'`)
 *   +525s  `lock=NONE`, `currentLegAnchor=건대입구/2`, wp0=성수 — leg-1 release + leg-2 anchor stamp
 *   +585s  **leg-2 프롬프트 발사** — `line:'2'`, `candidateTrains:[8371,2373]`, `trainCode:'8371'`
 *   +652s  이 tick에 boarding-confirm을 주입해 사슬을 닫는다
 *
 * ## 이 테스트의 규율
 *
 * 1. **`trainCode`를 하드코딩하지 않는다.** leg-2 프롬프트 push payload에서 **꺼내서** confirm에
 *    넣고, lock이 그 값을 갖는지 본다. 그래서 어느 구간이 틀어져도(release가 안 일어남 /
 *    프롬프트가 leg-1 열차를 고름 / embed가 다른 값을 실음 / confirm이 거부함) 깨진다.
 *    payload 키는 경로마다 다르다 — station push=`data`, LA push=`aps.event`, **프롬프트=`body`**.
 * 2. **재생을 두 번 돌려 1회차 값을 2회차에 하드코딩하는 우회를 쓰지 않는다** — payload가 다른
 *    열차로 변조돼도 2회차가 그 변조값을 그대로 confirm해 lock이 일치해버려 사슬이 끊긴다.
 *    `beforeTick` ctx의 `pushes`(#2989에서 추가)로 **같은 재생 안에서** 꺼낸다.
 * 3. **역명/노선/열차를 상수로 쓰지 않는다** — 전부 seed trip의 `waypoints`/`boardingLock`에서
 *    파생한다(환승이 한 번 더 늘어도 코드를 고치지 않는다).
 */
import { describe, expect, it, vi } from 'vitest';
import app from '../index';
import { runCaptureReplay, type CapturedPush } from './helpers/replayHarness';
import { makeDesk20260913LockTrip } from './helpers/desk20260913Trip';
import { parseReplayFixture } from '../replayFixture';
import { injectPrevDepartedTrainArrived } from './helpers/injectArrivalConfirmation';
import fixtureJson from './fixtures/replayLibrary/capture_20260913T1249Z_b00dd879.fixture.json';
import { getTrip } from '../trips';
import type { Env, Trip } from '../types';

const fixture = parseReplayFixture(fixtureJson);

/**
 * seed trip의 waypoints에서 환승 경계를 파생한다 — 역명/노선 하드코딩 금지(글로벌 룰 3).
 * `transfer` kind waypoint가 leg 경계이고, 그 **다음** waypoint의 line이 leg-2의 line이다
 * (transfer waypoint 자신의 line은 "방금 통과한 leg"의 것 — `completeWaypointAdvance`의
 * `isRealLineChange` 판정과 같은 근거, scheduled.ts).
 */
function resolveTransferBoundary(trip: Trip): {
  transferStation: string;
  leg2Line: string;
  leg1TrainCode: string;
} {
  const transferIndex = trip.waypoints.findIndex((waypoint) => waypoint.kind === 'transfer');
  const transferWaypoint = trip.waypoints[transferIndex];
  const nextLegWaypoint = trip.waypoints[transferIndex + 1];
  const { boardingLock } = trip;
  // 전제가 깨지면(fixture/helper가 바뀌어 환승이 없어짐) 조용히 통과하지 않고 여기서 멈춘다 —
  // 아래 사슬 assert가 "다른 이유로" 실패하는 것을 막는다.
  expect(transferWaypoint, 'seed trip에 transfer waypoint가 있어야 한다').toBeDefined();
  expect(nextLegWaypoint, 'transfer 다음 leg waypoint가 있어야 한다').toBeDefined();
  expect(boardingLock, 'seed trip은 leg-1 lock을 갖고 시작해야 한다').toBeDefined();
  return {
    transferStation: transferWaypoint.stationName,
    leg2Line: nextLegWaypoint.line,
    leg1TrainCode: boardingLock!.trainCode,
  };
}

/** 프롬프트 push의 payload(키는 `body` — station push의 `data`와 다르다). */
function promptPayload(push: CapturedPush): Record<string, unknown> | undefined {
  const payload = push.body.body as Record<string, unknown> | undefined;
  return payload?.kind === 'boarding-prompt' ? payload : undefined;
}

/**
 * leg-2 "탑승하셨나요?" 프롬프트만 골라낸다.
 *
 * 같은 환승역에서 **두 개**의 `boarding-prompt`가 발사된다(실측, 위 타임라인):
 *   - hop-end "하차했나요?" — `hopEndKind:'disembark'`, line은 **leg-1**, 열차 개념 없음
 *     (`trainCode`/`candidateTrains` 부재 — 하차에 열차가 없다, HANDOFF §6)
 *   - leg-2 "탑승하셨나요?" — line은 **leg-2**, `candidateTrains` + `trainCode` 보유
 * 둘을 구분하지 않으면 "프롬프트가 떴다"가 하차 프롬프트로도 green이 된다.
 */
function findLegBoardingPrompt(
  pushes: readonly CapturedPush[],
  leg2Line: string,
): Record<string, unknown> | undefined {
  return pushes
    .map(promptPayload)
    .find(
      (payload) =>
        payload !== undefined &&
        payload.line === leg2Line &&
        Array.isArray(payload.candidateTrains),
    );
}

/**
 * 재생 시각(tick)으로 `Date.now`를 고정한 채 boarding-confirm을 POST한다 — HTTP 핸들러가
 * `Date.now()`를 직접 쓰므로 고정하지 않으면 실 벽시계가 들어가 stamp 신선도/TTL 판정이
 * 재생 시각과 어긋난다(#2981과 동일 패턴).
 */
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

/**
 * backend → device lock release sync push(#1438 E5) — 환승 waypoint 통과로 backend가 lock을
 * release한 **그 순간** 발사된다. `origin:'transfer-release'` + `lockReleasedReason:'transfer'`로
 * 자기 식별하고, `trainCode`에 **release된 그 lock**(=leg-1 열차)을 실어 보낸다.
 *
 * station push 계열이므로 payload 키는 `data`다(프롬프트의 `body`와 다르다).
 */
function findTransferReleasePush(pushes: readonly CapturedPush[]): Record<string, unknown> | undefined {
  return pushes
    .map((push) => push.body.data as Record<string, unknown> | undefined)
    .find(
      (payload) =>
        payload?.origin === 'transfer-release' && payload?.lockReleasedReason === 'transfer',
    );
}

/** leg-2 진입 **첫 tick**(transfer waypoint가 소비된 직후)에 관측한 lock/anchor 상태. */
interface Leg2EntrySnapshot {
  /** 그 시점 lock의 trainCode — release됐다면 undefined여야 한다. */
  lockTrainCode: string | undefined;
  /** leg-2 anchor(환승역 + leg-2 line)가 stamp됐는가. */
  anchorMatches: boolean;
}

interface ChainRun {
  /** leg-1 lock이 활성인 채로 관측된 tick이 있었는가(사슬 1단 — 재생 전제). */
  leg1LockObserved: boolean;
  /**
   * 2단 — leg-2 진입 첫 tick의 상태. "결국 lock이 사라졌다"로는 부족하다: transfer release를
   * 막아도 잘못된 line에서 etaMissing이 쌓여 **한 cycle 뒤** lock이 자연사하므로(실측), 그
   * 상태를 통과시키면 사슬이 끊겨도 green이 된다. 그래서 **환승 경계 그 tick에서** 본다.
   */
  leg2Entry: Leg2EntrySnapshot | undefined;
  /** 2단 보강 — release 순간 device로 나간 sync push의 payload. */
  transferReleasePush: Record<string, unknown> | undefined;
  /** leg-2 프롬프트가 실은 trainCode(3단) — 하드코딩이 아니라 payload에서 추출. */
  promptTrainCode: string | undefined;
  /** leg-2 프롬프트가 제시한 후보 목록 — "제시된 적 없음"을 판정하는 기준. */
  promptCandidateTrainCodes: string[];
  confirmStatus: number | undefined;
  confirmLockState: string | undefined;
  finalTrip: Trip | undefined;
}

/**
 * 사슬 전체를 한 번의 재생으로 걷는다. `pickConfirmTrainCode`는 "leg-2 프롬프트가 제시한 열차"와
 * "제시된 후보 전체"를 받아 실제로 confirm할 값을 고르는 함수 — 정상 케이스는 제시된 값을
 * 그대로, 거부 케이스는 외래 열차를 돌려준다(두 케이스가 같은 사슬을 공유하도록).
 */
async function runTransferChain(
  token: string,
  pickConfirmTrainCode: (promptTrainCode: string, candidateTrainCodes: string[]) => string,
): Promise<ChainRun> {
  const anchorMs = fixture.window.fromMs;
  const seedTrip = makeDesk20260913LockTrip(token, anchorMs);
  const { transferStation, leg2Line } = resolveTransferBoundary(seedTrip);

  let capturedEnv: Env | undefined;
  let leg1LockObserved = false;
  let leg2Entry: Leg2EntrySnapshot | undefined;
  let promptTrainCode: string | undefined;
  let promptCandidateTrainCodes: string[] = [];
  let confirmStatus: number | undefined;
  let confirmLockState: string | undefined;

  const result = await runCaptureReplay({
    fixture,
    seedTrips: [seedTrip],
    apns: 'capture',
    // seedPositionSeries 의도적 미제공 — lock이 있으면 position 없이도 leg-1이 전진해 환승에
    // 도달해야 한다(#2981과 동일 규율). 주면 "lock이 position 의존을 없앴다"를 증명하지 못한다.
    beforeTick: async ({ tick, env, pushes }) => {
      capturedEnv = env;
      const trip = await getTrip(env.TRIPS, token);
      if (trip === null) return;

      // ── 1단 — leg-1 lock이 실제로 활성인 채 재생이 시작됐다.
      if (trip.boardingLock !== undefined) leg1LockObserved = true;

      // ── 2단 — 환승 waypoint가 소비된 **첫 tick**의 상태를 1회만 캡처한다. "결국 lock이
      // 사라졌다"로 보면 안 된다: transfer release를 막아도 잘못된 line(leg-1 열차를 leg-2
      // 노선에서 조회)에서 etaMissing이 쌓여 한 cycle 뒤 lock이 자연사하므로(#864 주석의
      // 바로 그 기전), 그 상태를 통과시키면 release가 죽어도 green이 된다 — 실측으로 확인.
      // 또 anchor만 보면 lock이 잔존한 채 stamp된 10/9 상태(#2957)가 통과한다.
      const { currentLegAnchor, waypoints } = trip;
      if (leg2Entry === undefined && waypoints[0]?.line === leg2Line) {
        leg2Entry = {
          lockTrainCode: trip.boardingLock?.trainCode,
          anchorMatches:
            currentLegAnchor?.boardingStation === transferStation &&
            currentLegAnchor?.line === leg2Line,
        };
      }

      // #3057 — `helpers/injectArrivalConfirmation.ts` 주석 참고(실캡처 arvlCd=3 열차의 도착 position만 합성 주입). leg-2 anchor가 선 뒤 lock이 아직
      // 없는 tick에서만 주입한다(lock 부착 후엔 프롬프트가 lock-already-attached로 막힌다).
      if (
        confirmStatus === undefined &&
        currentLegAnchor?.boardingStation === transferStation &&
        currentLegAnchor.line === leg2Line &&
        trip.boardingLock === undefined
      ) {
        await injectPrevDepartedTrainArrived(fixture, env, tick, transferStation, leg2Line);
      }

      // ── 3·4단 — leg-2 프롬프트가 떴으면 그 payload의 열차를 꺼내 바로 confirm한다.
      if (confirmStatus !== undefined) return;
      const prompt = findLegBoardingPrompt(pushes, leg2Line);
      if (prompt === undefined) return;
      const promptTrain = prompt.trainCode;
      // payload에 trainCode가 없으면 device가 되돌려보낼 것이 없다 — 사슬이 거기서 끊긴다.
      expect(promptTrain, 'leg-2 프롬프트 payload에 trainCode가 실려야 한다').toBeTypeOf('string');
      promptTrainCode = promptTrain as string;
      promptCandidateTrainCodes = (prompt.candidateTrains as { trainCode: string }[]).map(
        (candidate) => candidate.trainCode,
      );
      const res = await postBoardingConfirmAt(
        tick,
        env,
        token,
        transferStation,
        leg2Line,
        pickConfirmTrainCode(promptTrainCode, promptCandidateTrainCodes),
      );
      confirmStatus = res.status;
      confirmLockState = ((await res.json()) as { lockState?: string }).lockState;
    },
  });

  return {
    leg1LockObserved,
    leg2Entry,
    transferReleasePush: findTransferReleasePush(result.pushes),
    promptTrainCode,
    promptCandidateTrainCodes,
    confirmStatus,
    confirmLockState,
    finalTrip: capturedEnv ? ((await getTrip(capturedEnv.TRIPS, token)) ?? undefined) : undefined,
  };
}

describe('#2989 환승 경계 사슬 — leg-1 lock → advance → leg-2 프롬프트 → leg-2 lock', () => {
  it('프롬프트가 제시한 leg-2 열차를 그대로 confirm하면 그 열차로 leg-2 lock이 된다', async () => {
    const token = 'transfer-chain-axis';
    const seedTrip = makeDesk20260913LockTrip(token, fixture.window.fromMs);
    const { leg2Line, leg1TrainCode } = resolveTransferBoundary(seedTrip);

    const run = await runTransferChain(token, (promptTrainCode) => promptTrainCode);

    // 1단 — 재생 전제(leg-1 lock 활성)가 실제로 성립했다.
    expect(run.leg1LockObserved).toBe(true);
    // 2단 — 환승 waypoint가 소비된 **그 tick에** leg-1 lock이 이미 없고 leg-2 anchor가 있다.
    expect(run.leg2Entry).toBeDefined();
    expect(run.leg2Entry?.lockTrainCode).toBeUndefined();
    expect(run.leg2Entry?.anchorMatches).toBe(true);
    // 2단 보강 — release 순간 device로 lock 해제가 통지됐고, 그 payload가 실은 열차는
    // **release된 leg-1 열차**다(엉뚱한 lock을 release한 것이 아님).
    expect(run.transferReleasePush?.trainCode).toBe(leg1TrainCode);
    // 3단 — leg-2 프롬프트가 발사되고 **leg-2 열차**를 실었다. leg-1 열차를 그대로 다시
    // 제시하면(= 환승을 인지하지 못한 상태) 사슬은 형식상 닫히지만 사용자는 떠난 열차를
    // lock하게 된다 — 그 경로를 명시 배제한다.
    expect(run.promptTrainCode).toBeTypeOf('string');
    expect(run.promptTrainCode).not.toBe(leg1TrainCode);
    // 4단 — 탭이 성공하고, 제시된 그 열차로 leg-2 lock이 만들어졌다.
    expect(run.confirmStatus).toBe(200);
    expect(run.confirmLockState).toBe('leg2');
    expect(run.finalTrip?.boardingLock?.trainCode).toBe(run.promptTrainCode);
    expect(run.finalTrip?.boardingLock?.line).toBe(leg2Line);
  }, 60_000);

  // 거부 — 프롬프트가 제시하지 않은 외래 열차(여기서는 **leg-1에서 타고 온 열차**)는 leg-2에서
  // lock되지 않아야 한다. #2824가 막은 "backend가 한 번도 제시한 적 없는 trainCode 승격"의
  // 환승 경계판 — 노선 자체가 다르므로(leg-1 line ≠ leg-2 line) 승격되면 그 즉시 오탑승이다.
  it('[거부] leg-1에서 타고 온 열차를 leg-2에서 confirm해도 그 열차로 lock되지 않는다', async () => {
    const token = 'transfer-chain-axis-reject';
    const seedTrip = makeDesk20260913LockTrip(token, fixture.window.fromMs);
    const { leg1TrainCode } = resolveTransferBoundary(seedTrip);

    const run = await runTransferChain(token, () => leg1TrainCode);

    // 사슬 2·3단은 정상 케이스와 동일하게 성립해야 한다 — 그래야 아래 거부가 "프롬프트가 아예
    // 안 떠서" 통과한 것이 아님을 보증한다.
    expect(run.leg2Entry?.lockTrainCode).toBeUndefined();
    expect(run.leg2Entry?.anchorMatches).toBe(true);
    expect(run.promptTrainCode).toBeTypeOf('string');
    expect(run.confirmStatus).toBe(200);
    expect(run.finalTrip?.boardingLock?.trainCode).not.toBe(leg1TrainCode);
  }, 60_000);

  /**
   * 거부 ② — 프롬프트가 제시한 적 없는 **합성** 열차(제시 후보에서 파생해 확실히 그 집합 밖).
   *
   * ①과 같은 게이트를 탄다(실측 — 둘 다 `line=leg2Line`으로 보내 **trainCode만** 다르므로,
   * 공유 stamp 제거/`isPromotionCorroborated` 무력화 두 mutation에서 **둘이 함께** red가 된다).
   * ①과 분리해 두는 이유는 커버리지가 아니라 시나리오다 — ①은 "방금 내린 그 열차"(실존하는
   * leg-1 열차), ②는 "backend가 한 번도 본 적 없는 값"(`#2824`가 막는 그 모양)이다.
   *
   * 측정으로 확인한 이 사슬의 방어선(둘 다 끊으면 이 케이스가 red):
   *   - 공유 후보 stamp `fireBoardingPromptForAnchor`의 `recentPromptCandidates`(`#2988` 계보)
   *   - `isPromotionCorroborated`(`index.ts`) — stamp/streak 둘 다 부재면 backward-safe로
   *     **무조건 승격**하므로, stamp가 이 경로에 배선돼 있어야만 방어가 선다.
   * (`maybeFireOriginBoardingPromptGpsFree`의 stamp는 **leg-1 전용**이라 이 사슬과 무관 —
   *  그쪽만 제거해도 이 테스트는 green이다. 두 stamp를 같은 것으로 보지 말 것.)
   */
  it('[거부] leg-2 노선이지만 프롬프트가 제시하지 않은 열차는 lock되지 않는다', async () => {
    const token = 'transfer-chain-axis-reject-uncorroborated';

    // 제시된 후보 집합에서 **파생**해 확실히 그 안에 없는 코드를 만든다(상수 '9999' 같은
    // 하드코딩을 쓰면 fixture가 바뀌어 그 코드가 실제 후보에 들어오는 날 조용히 무력해진다).
    const foreignTrainCodeOf = (candidateTrainCodes: string[]): string => {
      let candidate = candidateTrainCodes[0] ?? '1';
      while (candidateTrainCodes.includes(candidate)) {
        candidate = String(Number(candidate) + 10_000);
      }
      return candidate;
    };

    const run = await runTransferChain(token, (_promptTrainCode, candidateTrainCodes) =>
      foreignTrainCodeOf(candidateTrainCodes),
    );

    expect(run.leg2Entry?.lockTrainCode).toBeUndefined();
    expect(run.promptTrainCode).toBeTypeOf('string');
    expect(run.confirmStatus).toBe(200);

    const foreignTrainCode = foreignTrainCodeOf(run.promptCandidateTrainCodes);
    // 전제 — 이 코드가 정말 "제시된 적 없는" 값이다(아니면 아래 거부 assert가 무의미하다).
    expect(run.promptCandidateTrainCodes).not.toContain(foreignTrainCode);
    expect(run.promptCandidateTrainCodes.length).toBeGreaterThan(0);
    // 거부 — 그 열차로 lock되지 않는다. 제시된 열차로 조용히 바뀌어 있어도 안 된다(사용자가
    // 탭한 것이 아니므로) — lock 미생성이 정답(#2987과 동일 판정).
    expect(run.finalTrip?.boardingLock?.trainCode).not.toBe(foreignTrainCode);
    expect(run.finalTrip?.boardingLock?.trainCode).not.toBe(run.promptTrainCode);
  }, 60_000);
});
