/**
 * #2801 — leg-2 "탑승하셨나요?" 프롬프트(`maybeFireLegBoardingPrompt`)가 walk-gate
 * (`legBoardingEligibleAt = arrivedAt + transferWalkSeconds`, 건대입구 278s)에 막혀 사용자
 * 실열차(7256)가 후보에서 사라진 뒤(+6분)에야 발사되는 회귀를 9/18 실캡처
 * (`REPLAY_LIBRARY`의 `capture_20260918_line7_yongmasan_overshoot`)로 고정한다.
 *
 * 프롬프트는 **회고형**("탑승하셨나요?")이라 walk-time(예측형 게이트)은 원천적으로 잘못된
 * 질문이다 — auto-resolve(`boardingAnchorResolver.ts`)의 walk-gate와 달리, 프롬프트는
 * 오탑승을 자동으로 확정하지 않고 사용자가 후보 중에서 직접 골라야 하므로 도보 중에 떠도
 * 안전하다.
 *
 * RED(fix 전): walk-gate가 7256의 건대입구 ARRIVED(17:40:31)~DEPARTED(17:41:32) 창보다
 * 늦게(17:43:07) 열려 프롬프트가 이때야 발사되고, candidateTrains에는 이미 그 역을 떠난
 * 7256이 빠진 채 후행 7258/7260만 실린다 — replayLibrary.ts:346-347 주석이 이 실측을 이미
 * 기록해뒀다("leg-2 boarding-prompt(candidateTrains에 7258/7260 노출)").
 *
 * GREEN(fix 후): walk-gate 제거로 프롬프트가 훨씬 이른 cycle에 평가되어, 7256이 아직
 * 건대입구에 있는 동안(또는 그 열차가 후보 pool에 남아있는 tick에) candidateTrains에
 * 7256이 포함된 push가 최소 1건 존재해야 한다.
 */
import { describe, expect, it } from 'vitest';
import { REPLAY_LIBRARY } from './replayLibrary';
import { runCaptureReplay, type CapturedPush } from './helpers/replayHarness';

const ENTRY = REPLAY_LIBRARY.find(
  (entry) => entry.slug === 'capture_20260918_line7_yongmasan_overshoot',
);
if (!ENTRY) {
  throw new Error('capture_20260918_line7_yongmasan_overshoot entry missing from REPLAY_LIBRARY');
}

/** leg-2 "탑승하셨나요?" alert push만 골라 candidateTrains의 trainCode 전부를 모은다.
 * 회고형 alert push는 `sendBoardingPromptPush`가 `body: data`로 감싸 전송하므로(apns.ts:966),
 * 캡처된 JSON에서는 `push.body.body`가 그 data payload다 — kind/candidateTrains은 거기 있다. */
function boardingPromptCandidateTrainCodes(pushes: CapturedPush[]): string[] {
  const codes: string[] = [];
  for (const push of pushes) {
    const data = push.body.body as Record<string, unknown> | undefined;
    if (data?.kind !== 'boarding-prompt') continue;
    const candidateTrains = data.candidateTrains;
    if (!Array.isArray(candidateTrains)) continue;
    for (const candidate of candidateTrains) {
      const trainCode = (candidate as Record<string, unknown> | undefined)?.trainCode;
      if (typeof trainCode === 'string') codes.push(trainCode);
    }
  }
  return codes;
}

describe('#2801 — leg-2 boarding-prompt walk-gate가 사용자 실열차(7256)를 후보 창에서 배제', () => {
  it('사용자 실열차(7256)가 아직 후보에 남아있는 tick에 leg-2 prompt가 발사된다', async () => {
    const fixture = ENTRY!.loadFixture();
    const result = await runCaptureReplay({
      fixture,
      seedTrips: ENTRY!.seedTrips(),
      cronIntervalMs: ENTRY!.cronIntervalMs === 'recorded' ? undefined : ENTRY!.cronIntervalMs,
      phaseOffsetMs: 0,
      apns: 'capture',
      seedPositionSeries: ENTRY!.seedPositionSeries?.(),
    });

    const candidateTrainCodes = boardingPromptCandidateTrainCodes(result.pushes);

    // 이 assertion이 GREEN(fix 후) 목표다 — walk-gate가 제거되면 프롬프트가 환승 감지 직후부터
    // 평가되므로, 7256이 아직 건대입구 후보 풀에 있는 cycle에서 candidateTrains에 포함된 push가
    // 최소 1건 나와야 한다. fix 전에는 이 테스트도 실패한다(동일 RED, 이중 고정).
    expect(candidateTrainCodes).toContain('7256');
  });

  // #3057 회귀 고정 — 9/18 건대입구 단배차: 7254가 position으로 도착 확정되어 먼저 발사된 뒤 약 120초 후
  // 사용자 실열차 7256이 도착 확정(arvlCd=2)된다. 열차당 상한이 2였을 때는 5분 게이트가 7256 프롬프트를
  // 막아 7256이 어떤 후보에도 안 들어갔다(#2824 corroboration이 탭을 거부). 상한 1이면 #2898 ④ bypass가
  // 열려 두 번째 프롬프트에 7256이 후보로 실린다.
  it('7254 도착 확정 프롬프트 직후(5분 이내) 7256 도착 확정 프롬프트가 별도로 발사된다 (단배차 bypass)', async () => {
    const fixture = ENTRY!.loadFixture();
    const result = await runCaptureReplay({
      fixture,
      seedTrips: ENTRY!.seedTrips(),
      cronIntervalMs: ENTRY!.cronIntervalMs === 'recorded' ? undefined : ENTRY!.cronIntervalMs,
      phaseOffsetMs: 0,
      apns: 'capture',
      seedPositionSeries: ENTRY!.seedPositionSeries?.(),
    });
    const prompts = result.pushes
      .map((push) => ({ push, data: push.body.body as Record<string, unknown> | undefined }))
      .filter(({ data }) => data?.kind === 'boarding-prompt' && Array.isArray(data.candidateTrains));
    const codesOf = (data: Record<string, unknown> | undefined): string[] =>
      (data?.candidateTrains as { trainCode: string }[]).map((c) => c.trainCode);
    const first = prompts.find(({ data }) => codesOf(data).includes('7254'));
    const second = prompts.find(({ data }) => codesOf(data).includes('7256'));
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second!.push.simNowMs - first!.push.simNowMs).toBeLessThan(5 * 60_000);
    expect(second!.data?.trainCode).toBe('7256');
  });
});
