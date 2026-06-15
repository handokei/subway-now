import {
  pushEstimatorEntry,
  getEstimatorEntries,
  clearEstimatorEntries,
  subscribeEstimatorDebug,
  ESTIMATOR_DEBUG_BUFFER_CAPACITY,
  formatEstimatorLine,
} from '../estimatorDebugBuffer';
import { getRegisteredDebugBuffers } from '../../../../shared/utils/debugBufferRegistry';

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

  // #1348 — formatter SSOT (DebugModal UI + share dump 양쪽에서 공유).
  describe('formatEstimatorLine (#1348)', () => {
    it('strategy + station + arcIndex 포함', () => {
      const line = formatEstimatorLine({
        ts: new Date('2026-06-16T12:00:00Z').getTime(),
        strategy: 'live-position',
        stationName: '강남',
        stationLine: '2',
        arcIndex: 3,
      });
      expect(line).toMatch(/live-position/);
      expect(line).toMatch(/강남\(2\)/);
      expect(line).toMatch(/idx=3/);
    });

    it('strategy null이면 none으로 표기', () => {
      const line = formatEstimatorLine({
        ts: 0,
        strategy: null,
        stationName: null,
        stationLine: null,
        arcIndex: null,
      });
      expect(line).toMatch(/\| none \| - idx=-/);
    });

    it('stationLine null이면 - 표기', () => {
      const line = formatEstimatorLine({
        ts: 0,
        strategy: 'live-position',
        stationName: '강남',
        stationLine: null,
        arcIndex: 0,
      });
      expect(line).toMatch(/강남\(-\)/);
      expect(line).toMatch(/idx=0/);
    });
  });

  describe('registerDebugBuffer wiring (#1348)', () => {
    it('module import 시 share dump registry에 등록된다', () => {
      const sources = getRegisteredDebugBuffers();
      const est = sources.find((s) => s.key === 'Estimator State');
      expect(est).toBeDefined();
    });

    it('등록된 dumpLines가 현재 buffer 엔트리들을 포맷한다', () => {
      pushEstimatorEntry({
        ts: 0,
        strategy: 'live-position',
        stationName: '잠실',
        stationLine: '2',
        arcIndex: 2,
      });
      const sources = getRegisteredDebugBuffers();
      const est = sources.find((s) => s.key === 'Estimator State');
      const lines = est?.dumpLines() ?? [];
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/잠실\(2\)/);
      expect(lines[0]).toMatch(/idx=2/);
    });
  });
});
