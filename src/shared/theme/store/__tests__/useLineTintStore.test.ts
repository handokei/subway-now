import { useLineTintStore } from '../useLineTintStore';

describe('useLineTintStore', () => {
  beforeEach(() => {
    useLineTintStore.setState({ line: null });
  });

  it('초기 line은 null이다', () => {
    expect(useLineTintStore.getState().line).toBeNull();
  });

  it('setLine이 노선을 갱신한다', () => {
    useLineTintStore.getState().setLine('2');
    expect(useLineTintStore.getState().line).toBe('2');
  });

  it('같은 노선을 다시 set하면 state 참조가 유지된다(불필요한 리렌더 방지)', () => {
    useLineTintStore.getState().setLine('2');
    const before = useLineTintStore.getState();
    useLineTintStore.getState().setLine('2');
    expect(useLineTintStore.getState()).toBe(before);
  });

  it('null로 되돌릴 수 있다', () => {
    useLineTintStore.getState().setLine('5');
    useLineTintStore.getState().setLine(null);
    expect(useLineTintStore.getState().line).toBeNull();
  });
});
