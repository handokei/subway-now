/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: boarding-prompt 로컬 게이트는 alarm(발사/dedup) + route(방향 유틸
 * 경유 context 빌더) + shared 타입을 가로지르는 본질적 cross-feature 게이트다. 선례:
 * `boardingPromptContext.ts` 헤더와 동일 rationale.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * #2422 (방향 A) — boarding prompt device FG 로컬 단일권위.
 *
 * backend remote alert push(주 채널)의 SPOF(미발송/전달실패 시 client 대비책 0)를 제거하기 위해,
 * device가 FG 상태에서 같은 gate 입력(`buildBoardingPromptContext`)을 로컬로 재평가해 통과하면
 * `fireLocalBoardingPromptNotification`으로 직접 발사한다. ADR-033(station-passed FG 보조 발사,
 * `useStationAlarm.dispatchStationPassed`)과 동일 패턴 계승.
 *
 * 게이트 자체(근접 + 방향/도착열차 존재)는 `localBoardingPromptGate.ts`가 순수 함수로 담당—
 * 이 훅은 입력 조립(route/currentStation/destination/lock/gpsFix → context, arrival)과 부수효과
 * (발사 호출 + in-flight 가드)만 담당한다.
 *
 * lock이 이미 활성이면 게이트 평가 자체를 스킵한다(backend #1 F2 defense와 동형 — boarding-prompt는
 * 탑승 "이전" 게이트라 이미 탑승 확정된 trip에는 의미 없음).
 */
import { useEffect, useRef } from 'react';
import type { Route } from '../../../shared/utils/stationRoute';
import type { Station } from '../../../shared/types/station';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { StationArrival } from '../../../shared/types/arrival';
import { buildBoardingPromptContext, type GpsFix } from '../utils/boardingPromptContext';
import { evaluateLocalBoardingPromptGate } from '../utils/localBoardingPromptGate';
import { fireLocalBoardingPromptNotification } from '../utils/stationNotification';
import { createLogger } from '../../../shared/utils/logger';
import { addDomainBreadcrumb } from '../../../shared/infra/monitoring/breadcrumb';

const log = createLogger('localBoardingPromptGate');

export interface UseLocalBoardingPromptGateParams {
  route: Route;
  currentStation: Station | null;
  destination: Station | null;
  /** 활성 BoardingLock — non-null이면 이미 탑승 확정 상태라 게이트를 스킵한다. */
  lock: BoardingLock | null;
  gpsFix: GpsFix | null;
  arrival: StationArrival | null;
}

export function useLocalBoardingPromptGate(params: UseLocalBoardingPromptGateParams): void {
  const { route, currentStation, destination, lock, gpsFix, arrival } = params;
  // 같은 cycle에서 발사 Promise가 아직 안 끝났는데 다음 렌더가 재평가하는 걸 막는 in-flight 가드.
  // TTL dedup(`recentLocalStationFires`)와 별개로, await 경계 안에서의 중복 스케줄 호출을 차단한다.
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (lock != null) return; // #1921/#1921류 F2 defense와 동형 — 탑승 확정 trip은 스킵.
    if (!arrival) return;
    if (inFlightRef.current) return;

    const context = buildBoardingPromptContext({ route, currentStation, destination, gpsFix });
    if (!context) return;

    const outcome = evaluateLocalBoardingPromptGate({ context, arrival });
    if (!outcome.pass) return;

    inFlightRef.current = true;
    const { originStation, line } = context.promptDisplay;
    const { direction } = context.promptGeoContext;
    void fireLocalBoardingPromptNotification(originStation, line, direction)
      .then((fired) => {
        if (fired) {
          addDomainBreadcrumb('boarding', 'local_boarding_prompt_fired', {
            originStation,
            line,
          });
        }
      })
      .catch((e) => {
        log.error('로컬 boarding-prompt 발사 실패:', e as Error);
      })
      .finally(() => {
        inFlightRef.current = false;
      });
  }, [route, currentStation, destination, lock, gpsFix, arrival]);
}
