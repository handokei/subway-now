import { create } from 'zustand';

/**
 * 앱 실행/FG 복귀 시 trip 재수화·종료 판정(`useStateRehydration`)이 끝났는지.
 *
 * **왜 필요한가 (#2972)**: 2026-10-13 실측 — 사용자 조작 0회로 앱을 열었을 때 13시간 전에
 * 끝난 트립이 `POST /trips` 2건으로 backend에 **새로 생성**됐고, 16분 30초 뒤 다음 실행에서
 * 그 트립 목적지의 하차 프롬프트가 쏟아졌다. 기전: hydration이 storage의 stale route/
 * destination을 store로 복원하면 register effect가 **즉시** POST를 쏘는데, 같은 틱에서
 * 진행되는 force-end 판정(`runLifecycleBackstop`)은 비동기라 늦게 끝난다.
 *
 * **왜 storage 키로 판정할 수 없는가**: 백스톱이 종료 시 `runTripBoundCleanups`로
 * `TRIP_STARTED_AT_KEY`를 지운다(`tripBoundCleanups.ts:112`). 그리고 정상 신규 트립에서도
 * `useDestinationStore.ts:142`의 `set({ destination })`은 **동기**인데 `setTripStartedAt`은
 * `:214` async chain(recall 업로드 → cleanup → prompt → `DESTINATION_KEY` write) **맨
 * 마지막**이다. 즉 "키 없음 + destination 있음"이 **유령 상태와 정상 신규 트립 창 양쪽에
 * 해당**해 구별이 불가능하다. 그래서 "판정이 끝났다"는 **양성 신호**가 필요하다.
 *
 * `useUserIntentStore.promptOptInHydrated`(#2651 — 그 주석이 이 문제를 *"#2673과 동일 클래스
 * race"*로 명시했다)와 **동일한 패턴**이며, 소비 지점도 같다: register 발사의 단일 chokepoint
 * `registerFromLatestInputs`.
 *
 * **동시 사이클**: `useStateRehydration`은 mount와 AppState 'active'에서 각각 돌아 한 실행에
 * 2회 겹칠 수 있다(실측 — 덤프에 hydration 전체 사이클이 2번). 그래서 boolean이 아니라
 * `pending` 카운터로 집계한다 — 먼저 끝난 사이클이 아직 도는 사이클을 "끝났다"로 만들지
 * 않는다.
 *
 * **실패 안전**: `end()`는 재수화가 throw해도 반드시 호출돼야 한다(`finally`). 누락되면
 * register가 **영구 억제**돼 트립이 아예 등록되지 않는 전면 침묵이 된다
 * (`useUserIntentStore.ts:183`가 같은 이유로 catch에서도 flag를 stamp한다).
 */
interface LaunchReconciliationState {
  /** 진행 중인 재수화 사이클 수. */
  pending: number;
  /** 재수화 판정이 끝났는가 — `pending === 0`이고 최소 1회 완료됐을 때만 true. */
  settled: boolean;
  /** 사이클 시작 — 진행 중에는 register를 억제한다. */
  begin: () => void;
  /** 사이클 종료 (반드시 `finally`에서 호출). */
  end: () => void;
}

export const useLaunchReconciliationStore = create<LaunchReconciliationState>((set) => ({
  pending: 0,
  // 초기값 false — 앱이 뜬 직후(재수화 시작 전)가 정확히 유령 재등록이 일어나는 창이다.
  settled: false,
  begin: () => set((s) => ({ pending: s.pending + 1, settled: false })),
  end: () =>
    set((s) => {
      // 0 하한 — begin 없이 end가 불리는 경로는 없지만, 음수가 되면 settled 판정이
      // 영구히 깨져 전면 침묵이 되므로 방어한다.
      const pending = s.pending > 0 ? s.pending - 1 : 0;
      return { pending, settled: pending === 0 };
    }),
}));
