import { useLegAdvanceStore } from '../useLegAdvanceStore';

describe('useLegAdvanceStore (#2278)', () => {
  beforeEach(() => {
    useLegAdvanceStore.setState({ nextLine: null });
  });

  it('초기 상태는 nextLine=null', () => {
    expect(useLegAdvanceStore.getState().nextLine).toBeNull();
  });

  it('stampLegAdvance — nextLine을 세팅한다', () => {
    useLegAdvanceStore.getState().stampLegAdvance('2');
    expect(useLegAdvanceStore.getState().nextLine).toBe('2');
  });

  it('clearLegAdvance — nextLine을 null로 되돌린다', () => {
    useLegAdvanceStore.getState().stampLegAdvance('2');
    useLegAdvanceStore.getState().clearLegAdvance();
    expect(useLegAdvanceStore.getState().nextLine).toBeNull();
  });

  it('재-stamp — 이전 값을 덮어쓴다 (다음 leg로 갱신)', () => {
    useLegAdvanceStore.getState().stampLegAdvance('2');
    useLegAdvanceStore.getState().stampLegAdvance('8');
    expect(useLegAdvanceStore.getState().nextLine).toBe('8');
  });
});
