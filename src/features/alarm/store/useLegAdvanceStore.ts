import { create } from 'zustand';
import type { LineNumber } from '../../../shared/types/station';
import {
  clearLegAdvance as clearLegAdvanceStorage,
  getLegAdvance,
  setLegAdvance,
} from '../utils/legAdvanceStorage';

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
 *    응답에서 payload.nextLine이 유효한 LineNumber일 때 호출. memory + AsyncStorage 동시 반영.
 *  - hydrate: `useStateRehydration`(cold start / FG 복귀 공통 진입점)이 `loadLegAdvance`를
 *    호출해 storage → memory 재수화.
 *  - clear: `tripBoundCleanups.clearTripBoundStoreMemory`가 trip 종료 4개 진입점 공통 경로에서
 *    호출 — 이전 trip의 stamp가 새 trip에 leak되는 것을 방지 (memory + storage 모두 제거).
 *
 * #2278 (PR #2287 리뷰 P1-2) — 최초 구현은 AsyncStorage 영속화 없이 in-memory only였다.
 * "cold start 시 GPS/route가 fresh 재계산되므로 안전"이라는 전제는 지하에서는 거짓이다 —
 * 지하는 정확히 이 stamp가 메우려는 gap(backend SSoT 왕복 실패)이 발생하는 환경이고, 그 상태에서
 * 앱이 kill되면 stamp만 사라지고 route.stopsToTransfer는 여전히 frozen이라 원 버그(#2278 가설 1)가
 * 재기동 후에도 재현된다. 따라서 stamp는 trip-scoped로 storage에 영속화하고, `stampedAt`을 함께
 * 저장해 `useBoardingLockController`의 stale-suggestion 가드(P1-1)에도 재사용한다.
 */
export interface LegAdvanceState {
  /** 사용자가 마지막으로 확인한 다음 leg 노선. 미확인/이미 소비 완료 시 null. */
  nextLine: LineNumber | null;
  /**
   * #2278 (PR #2287 리뷰 P1-1) — stamp 시각(epoch ms). `useBoardingLockController`의
   * lockSuggestion 자동 hydrate effect가 이 stamp보다 이전에 backend가 결정한(stale)
   * suggestion으로 lock을 재생성해 stamp를 무력화하지 않도록 하는 staleness 가드에 사용.
   */
  stampedAt: number | null;
  /** 사용자 명시 하차 응답/버튼 시점에 다음 leg 노선을 stamp한다 (memory + storage 동시 반영). */
  stampLegAdvance: (line: LineNumber) => Promise<void>;
  /** trip 종료 등으로 stamp를 무효화한다 (memory + storage 동시 반영). */
  clearLegAdvance: () => Promise<void>;
  /** cold start / FG 복귀 시 storage에서 재수화 (`useStateRehydration` 공통 진입점). */
  loadLegAdvance: () => Promise<void>;
}

export const useLegAdvanceStore = create<LegAdvanceState>((set) => ({
  nextLine: null,
  stampedAt: null,

  stampLegAdvance: async (line: LineNumber) => {
    const stampedAt = Date.now();
    set({ nextLine: line, stampedAt });
    await setLegAdvance({ nextLine: line, stampedAt });
  },

  clearLegAdvance: async () => {
    set({ nextLine: null, stampedAt: null });
    await clearLegAdvanceStorage();
  },

  loadLegAdvance: async () => {
    const stored = await getLegAdvance();
    set({ nextLine: stored?.nextLine ?? null, stampedAt: stored?.stampedAt ?? null });
  },
}));
