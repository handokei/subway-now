/**
 * #2926 (추적처, 알려진 결함, lessons.md L18) — 9/18 실캡처(뚝섬→건대입구 환승→용마산)에서
 * #2920의 "목적지 하차 확인" 프롬프트가 억제된다.
 *
 * ## ground truth (`replay_20260918_leg2_wrong_lock.test.ts`, `replayLibrary.ts` entry 참고)
 * - **7256** — 사용자가 실제로 탄 열차. 건대입구 ARRIVED(17:40:31) → DEPARTED(17:41:32).
 *   walk-gate(`legBoardingEligibleAt`, 17:43:07)가 이 창보다 **늦게** 열려 leg-resolve에
 *   애초에 도달하지 못한다.
 * - **7260** — #2754가 "오탑승 lock"으로 등록한 열차(9분 뒤 플랫폼 진입, 구 설계가 한 번 lock
 *   했었다). #2754 fix 후에는 전이 확증(ARRIVED→DEPARTED) 미충족으로 lock되지 않는다.
 * - **7258** — leg-2 boarding-prompt의 candidateTrains에 노출되는 후보 중 하나일 뿐, 사용자의
 *   열차가 아니다.
 *
 * 요구사항 4(#2754)가 명시한 안전 결과는 "7256이 잡히거나(정답) 아무것도 안 잡힘(안전)" 둘
 * 뿐이고, 이 재생은 후자다(`boardingAnchorResolved` 0회 유지) — **lock은 정상적으로 형성되지
 * 않는다.**
 *
 * ## 이 테스트가 잡는 결함
 * #2894(confirm 후보창 1-hop 확장, PR #2894)가 merge된 뒤로, walk-gate가 열린 이후 건대입구에
 * 관측되는 7258이 leg-2 leg-resolve에서 2 cycle 연속 관측되어 `trip.legResolveStreak`가
 * **pending**(미확정) 상태로 채워진다. `hasBoardingEvidence()`(scheduled.ts, #2900 docstring —
 * 과차단 방지 목적으로 pending streak도 "증거"로 인정하도록 설계됨)가 이 미확정 후보를 "탑승
 * 증거 있음"으로 인정해버려, #2920의 "증거 없음 → 하차 확인 프롬프트" 분기를 더 이상 타지
 * 않는다 — **용마산 disembark 프롬프트가 발사되지 않는다.**
 *
 * ADR-010 첫 줄: "두 실패 모드(false positive / miss)는 비대칭이 아니라 동급." 7258의 pending
 * streak는 사용자가 실제로 탄 증거가 아닌 false positive이고, 그 false positive가 사용자에게
 * 보여야 할 하차 확인 프롬프트를 억제하는 miss를 낳았다.
 *
 * ## 왜 지금 고치지 않는가 (`replayLibrary.ts` entry 주석, `#2926` 본문 참고)
 * `legResolveStreak` pending을 증거에서 제외하면(#2900 설계 자체를 좁히면) 과차단(거부 케이스
 * ⓐ) 회귀 — 정당하게 재탑승 중인 사용자의 leg-2 추적이 끊긴다. 좁히려면 "pending 후보가 정말
 * 사용자의 열차인지"를 구분하는 별도 신호(탑승 시각 창/연속성 요구 강화/프롬프트 응답 연계 —
 * #2926 본문의 검토 방향)가 선행돼야 한다. 이 PR(#2922) 범위를 넘는 별도 설계 작업이다.
 *
 * CLAUDE.md 불변식 승격 룰(L18) — 결함을 주석에만 남기지 않는다. 결함이 해소되면 이 `it.fails`가
 * 역으로 실패해 승격(일반 `it`)을 강제한다.
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

/** hop-end-prompt(#2920 destination disembark 포함) 채널로 발사된 origin station 전부. */
function firedHopEndPromptStations(pushes: CapturedPush[]): string[] {
  const occurrences: string[] = [];
  for (const push of pushes) {
    if (push.headers.pushType !== 'alert') continue;
    const promptBody = push.body.body as Record<string, unknown> | undefined;
    if (promptBody?.hopEndKind !== 'disembark') continue;
    const originStation = promptBody?.originStation;
    if (typeof originStation === 'string' && originStation.length > 0) occurrences.push(originStation);
  }
  return occurrences;
}

describe('#2926 (알려진 결함, 추적처) — 9/18 실캡처 용마산 목적지 하차 확인 프롬프트 억제', () => {
  it.fails(
    '용마산(목적지) 도착 시 #2920 하차 확인 프롬프트가 발사돼야 한다 — #2894 이후 7258 pending streak가 false positive 증거가 되어 억제된다',
    async () => {
      const fixture = ENTRY!.loadFixture();
      const result = await runCaptureReplay({
        fixture,
        seedTrips: ENTRY!.seedTrips(),
        cronIntervalMs: ENTRY!.cronIntervalMs === 'recorded' ? undefined : ENTRY!.cronIntervalMs,
        phaseOffsetMs: 0,
        apns: 'capture',
        seedPositionSeries: ENTRY!.seedPositionSeries?.(),
      });

      const stations = firedHopEndPromptStations(result.pushes);
      expect(stations).toContain('용마산');
    },
  );
});
