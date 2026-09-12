/**
 * #2247 (Epic #2239 Phase 1, ADR-030 §Replay harness backbone/§CI 비용) — replay 라이브러리
 * **데이터 주도** 재생 엔진. `../index.ts`(`REPLAY_FIXTURE_LIBRARY`)를 SSOT로 순회하며 각
 * entry의 `expectations`(불변식별 기대 위반 여부)를 단언한다.
 *
 * ## 2단 게이팅 (ADR-030 §CI 비용/게이팅 하드룰)
 * - **PR 게이트**(`npm test` → CI `Type Check & Test`): `tier: 'core'` entry만 재생·단언.
 *   빠른 앵커 세트를 매 PR에서 회귀 ratchet으로 쓴다.
 * - **nightly 전량**(`e2e.yml` 계열, `REPLAY_FULL_LIBRARY=1` 환경변수로 활성화): `tier`
 *   무관 라이브러리 전량을 재생. 라이브러리가 수백+ 로 커져도 PR CI 비용은 core 세트 크기로
 *   고정된다 — `extended` entry가 늘어도 이 파일의 PR 실행 시간은 불변.
 * - `extended` entry라도 `index.ts`가 무조건 import하므로(파일 헤더 참고) **coverage
 *   100%는 PR에서도 항상 만족** — import 자체는 trivial(순수 문자열 상수)이라 비용이 없고,
 *   비싼 것은 `replayFusionCycles` 재생 호출인데 그것만 nightly로 미룬다.
 *
 * fake timer 강제(ADR-030 §CI 비용/게이팅) — real timer 사용 금지. `fusionReplayDriver.ts`가
 * 호출 전 `jest.useFakeTimers()` 활성을 요구한다(파일 헤더 참고).
 */
import { REPLAY_FIXTURE_LIBRARY, type ReplayInvariant } from '../index';
import { parseRawSignalCycles } from '../../../rawSignalCycleParser';
import {
  replayFusionCycles,
  findSurfaceInUndergroundViolations,
  findOffRouteJumpViolations,
  findStaleGpsUndergroundViolations,
  type ReplayCycleResult,
} from '../../../fusionReplayDriver';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

const VIOLATION_FINDERS: Record<
  ReplayInvariant,
  (results: readonly ReplayCycleResult[]) => readonly unknown[]
> = {
  surfaceInUnderground: findSurfaceInUndergroundViolations,
  offRouteJump: findOffRouteJumpViolations,
  staleGpsUnderground: findStaleGpsUndergroundViolations,
};

// nightly(`e2e.yml` 계열)만 이 플래그를 세팅해 extended tier까지 전량 재생한다. PR 게이트는
// 미설정 상태로 core만 재생 — ADR-030 §CI 비용/게이팅.
const RUN_EXTENDED = process.env.REPLAY_FULL_LIBRARY === '1';

const entriesToReplay = REPLAY_FIXTURE_LIBRARY.filter((entry) => entry.tier === 'core' || RUN_EXTENDED);

// 라이브러리가 비게 필터링되면(예: extended만 있는 상태에서 RUN_EXTENDED=false) 조용히
// 0-test로 통과하는 회귀를 막는다 — core 앵커는 항상 최소 1개 이상 있어야 한다.
if (entriesToReplay.length === 0) {
  throw new Error(
    'replayLibrary.full.test.ts: 재생할 fixture가 0건이다 — REPLAY_FIXTURE_LIBRARY에 core tier entry가 최소 1개 있어야 한다.',
  );
}

for (const entry of entriesToReplay) {
  describe(`replay library — ${entry.id} (tier=${entry.tier}, provenance=${entry.provenance})`, () => {
    // entry당 parse+replay는 정확히 1회만 수행한다 — expectation마다 재실행하면 ADR-030 §CI
    // 비용 고정 목표(라이브러리가 커져도 재생 비용은 선형에 그쳐야 함)와 상충한다(코드 리뷰
    // 지적 반영). fake timer는 이 it 내부(각 beforeEach 이후)에서만 소비되므로 안전하다.
    it(`전체 불변식(${entry.expectations.map((e) => e.invariant).join(', ')})`, () => {
      const cycles = parseRawSignalCycles(entry.dumpText);
      expect(cycles.length).toBeGreaterThan(0);

      const results = replayFusionCycles(cycles);

      for (const expectation of entry.expectations) {
        const violations = VIOLATION_FINDERS[expectation.invariant](results);
        if (expectation.expectViolations) {
          expect(violations.length).toBeGreaterThan(0);
        } else {
          expect(violations).toEqual([]);
        }
      }
    });
  });
}
