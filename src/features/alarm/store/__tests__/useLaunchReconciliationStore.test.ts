import { useLaunchReconciliationStore } from '../useLaunchReconciliationStore';

/**
 * #2972 — 유령 트립 재등록 차단 게이트의 신호원. `register` 억제가 이 값 하나에 달려 있어
 * 두 방향 모두 치명적이다: true로 못 가면 **전면 침묵**(트립이 아예 등록되지 않음),
 * false로 못 가면 **유령 재등록**(13시간 전 끝난 트립이 backend에 생성).
 */
describe('useLaunchReconciliationStore (#2972)', () => {
  beforeEach(() => {
    useLaunchReconciliationStore.setState({ pending: 0, settled: false });
  });

  it('초기값은 settled=false — 앱이 뜬 직후가 유령 재등록이 일어나는 창이다', () => {
    const { pending, settled } = useLaunchReconciliationStore.getState();
    expect(pending).toBe(0);
    expect(settled).toBe(false);
  });

  it('begin → settled=false 유지, end → settled=true', () => {
    useLaunchReconciliationStore.getState().begin();
    expect(useLaunchReconciliationStore.getState().settled).toBe(false);
    expect(useLaunchReconciliationStore.getState().pending).toBe(1);

    useLaunchReconciliationStore.getState().end();
    expect(useLaunchReconciliationStore.getState().settled).toBe(true);
    expect(useLaunchReconciliationStore.getState().pending).toBe(0);
  });

  // 실측: useStateRehydration은 mount와 AppState 'active'에서 각각 돌아 한 실행에 2회 겹친다
  // (덤프에 hydration 전체 사이클이 2번). 먼저 끝난 사이클이 아직 도는 사이클을 "끝났다"로
  // 만들면 그 틈에 register가 나가 유령 트립이 생긴다.
  it('동시 사이클 — 먼저 끝난 쪽이 settled를 열지 않는다', () => {
    const { begin, end } = useLaunchReconciliationStore.getState();
    begin();
    begin();
    expect(useLaunchReconciliationStore.getState().pending).toBe(2);

    end();
    expect(useLaunchReconciliationStore.getState().settled).toBe(false);
    expect(useLaunchReconciliationStore.getState().pending).toBe(1);

    end();
    expect(useLaunchReconciliationStore.getState().settled).toBe(true);
  });

  it('settled 이후 새 사이클이 시작되면 다시 억제된다 (FG 복귀)', () => {
    const { begin, end } = useLaunchReconciliationStore.getState();
    begin();
    end();
    expect(useLaunchReconciliationStore.getState().settled).toBe(true);

    begin();
    expect(useLaunchReconciliationStore.getState().settled).toBe(false);
  });

  // begin 없이 end가 불리는 생산 경로는 없지만, pending이 음수가 되면 settled 판정이
  // 영구히 깨져 전면 침묵이 된다 — 0 하한을 계약으로 고정한다.
  it('begin 없이 end — pending이 음수로 내려가지 않는다', () => {
    useLaunchReconciliationStore.getState().end();
    expect(useLaunchReconciliationStore.getState().pending).toBe(0);
    expect(useLaunchReconciliationStore.getState().settled).toBe(true);
  });
});
