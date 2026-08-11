import { create } from 'zustand';
import type { LineNumber } from '../../../shared/types/station';

/**
 * #2278 — 환승역 하차 응답/버튼 leg-advance stamp SSoT.
 *
 * RCA(2026-08-11 건대입구 7→2 환승 실기기 dump): `useBoardingPromptResponder`의
 * hop-end 응답(`handleHopEndResponse`)이 `releaseLock('user')`만 수행하고 leg advance를
 * 로컬에 stamp하지 않아, `getApproachLine`이 그 다음으로 route의 `stopsToTransfer` 진행도에
 * 의존했다. 그 진행도는 backend `/boarding-lock/sync` 왕복(SSoT)로만 갱신되는데 지하 실패 시
 * frozen 상태로 남아 BoardingTrainList가 계속 이전 노선(7호선) 열차만 노출했다(가설 1 확정).
 *
 * 사용자의 명시 하차 응답/버튼 = ground truth(ADR-032) → 이 store가 그 사실을 로컬에서 즉시
 * 반영해 `getApproachLine`이 backend 왕복과 무관하게 다음 leg 노선을 반환하도록 한다.
 *
 * lifecycle:
 *  - stamp: `useBoardingPromptResponder.handleHopEndResponse`가 hop-end BOARDED/$default
 *    응답에서 payload.nextLine이 유효한 LineNumber일 때 호출.
 *  - clear: `tripBoundCleanups.clearTripBoundStoreMemory`가 trip 종료 4개 진입점 공통 경로에서
 *    호출 — 이전 trip의 stamp가 새 trip에 leak되는 것을 방지.
 *  - 의도적으로 AsyncStorage 영속화하지 않는다 — 이 stamp는 backend SSoT가 따라올 때까지의
 *    임시 bridge이며, cold start 시에는 route/lock 기반 기존 우선순위로 자연 복귀해도 안전하다
 *    (앱 재시작 시점엔 GPS/route가 다시 fresh하게 계산되므로).
 */
export interface LegAdvanceState {
  /** 사용자가 마지막으로 확인한 다음 leg 노선. 미확인/이미 소비 완료 시 null. */
  nextLine: LineNumber | null;
  /** 사용자 명시 하차 응답/버튼 시점에 다음 leg 노선을 stamp한다. */
  stampLegAdvance: (line: LineNumber) => void;
  /** trip 종료 등으로 stamp를 무효화한다. */
  clearLegAdvance: () => void;
}

export const useLegAdvanceStore = create<LegAdvanceState>((set) => ({
  nextLine: null,
  stampLegAdvance: (line: LineNumber) => set({ nextLine: line }),
  clearLegAdvance: () => set({ nextLine: null }),
}));
