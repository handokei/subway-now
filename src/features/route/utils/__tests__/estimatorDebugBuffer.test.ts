import {
  pushEstimatorEntry,
  getEstimatorEntries,
  clearEstimatorEntries,
  subscribeEstimatorDebug,
  ESTIMATOR_DEBUG_BUFFER_CAPACITY,
} from '../estimatorDebugBuffer';

function makeEntry(ts: number) {
  return {
    ts,
    strategy: 'live-position' as const,
    stationName: '강남',
    stationLine: '2',
    arcIndex: 1,
  };
}

describe('estimatorDebugBuffer', () => {
  beforeEach(() => {
    clearEstimatorEntries();
  });

  it('초기 상태는 빈 배열이다', () => {
    expect(getEstimatorEntries()).toHaveLength(0);
  });

  it('pushEstimatorEntry로 엔트리를 추가한다', () => {
    pushEstimatorEntry(makeEntry(1000));
    expect(getEstimatorEntries()).toHaveLength(1);
    expect(getEstimatorEntries()[0].stationName).toBe('강남');
  });

  it('clearEstimatorEntries로 버퍼를 비운다', () => {
    pushEstimatorEntry(makeEntry(1000));
    clearEstimatorEntries();
    expect(getEstimatorEntries()).toHaveLength(0);
  });

  it(`ESTIMATOR_DEBUG_BUFFER_CAPACITY(${ESTIMATOR_DEBUG_BUFFER_CAPACITY}) 초과 시 오래된 항목을 삭제한다`, () => {
    for (let i = 0; i < ESTIMATOR_DEBUG_BUFFER_CAPACITY + 5; i++) {
      pushEstimatorEntry(makeEntry(i));
    }
    const entries = getEstimatorEntries();
    expect(entries).toHaveLength(ESTIMATOR_DEBUG_BUFFER_CAPACITY);
    // 마지막 항목이 가장 최신이어야 함.
    expect(entries[entries.length - 1].ts).toBe(ESTIMATOR_DEBUG_BUFFER_CAPACITY + 4);
  });

  it('subscribeEstimatorDebug: 엔트리 push 시 콜백을 호출한다', () => {
    const cb = jest.fn();
    const unsubscribe = subscribeEstimatorDebug(cb);
    pushEstimatorEntry(makeEntry(1000));
    expect(cb).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('subscribeEstimatorDebug: unsubscribe 후 콜백을 호출하지 않는다', () => {
    const cb = jest.fn();
    const unsubscribe = subscribeEstimatorDebug(cb);
    unsubscribe();
    pushEstimatorEntry(makeEntry(2000));
    expect(cb).not.toHaveBeenCalled();
  });

  it('clearEstimatorEntries 시 구독자에게 알린다', () => {
    const cb = jest.fn();
    subscribeEstimatorDebug(cb);
    pushEstimatorEntry(makeEntry(999));
    cb.mockClear();
    clearEstimatorEntries();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('strategy null 엔트리도 정상 저장된다', () => {
    pushEstimatorEntry({
      ts: 999,
      strategy: null,
      stationName: null,
      stationLine: null,
      arcIndex: null,
    });
    const entries = getEstimatorEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].strategy).toBeNull();
  });
});
