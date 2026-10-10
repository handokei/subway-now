import { useDebugStore } from '../useDebugStore';

describe('useDebugStore', () => {
  beforeEach(() => {
    useDebugStore.setState({ debugVisible: false });
  });

  it('초기 debugVisible은 false이다', () => {
    expect(useDebugStore.getState().debugVisible).toBe(false);
  });

  it('setDebugVisible: 상태를 토글한다', () => {
    useDebugStore.getState().setDebugVisible(true);
    expect(useDebugStore.getState().debugVisible).toBe(true);
    useDebugStore.getState().setDebugVisible(false);
    expect(useDebugStore.getState().debugVisible).toBe(false);
  });
});
