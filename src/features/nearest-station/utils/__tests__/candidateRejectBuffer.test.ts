/**
 * #1902 (RC-18) — candidate-reject 별 buffer 단위 테스트.
 *
 * 검증:
 *   1. distance reject entry append (`candidate-distance` reason).
 *   2. line filter reject entry append (`candidate-line` reason, 옵셔널 필드 graceful).
 *   3. cap=50 ring buffer overwrite — 점령 회귀 차단(fusionDebugBuffer 200 cap과 독립).
 *   4. subscribe + clear가 fusionDebugBuffer와 분리된 채로 동작.
 */
import {
  CANDIDATE_REJECT_BUFFER_CAPACITY,
  clearCandidateRejectEntries,
  getCandidateRejectEntries,
  pushCandidateRejectEntry,
  subscribeCandidateReject,
  type CandidateRejectEntry,
} from '../candidateRejectBuffer';

describe('candidateRejectBuffer (#1902 RC-18)', () => {
  beforeEach(() => {
    clearCandidateRejectEntries();
  });

  function makeDistance(overrides: Partial<CandidateRejectEntry> = {}): CandidateRejectEntry {
    return {
      kind: 'candidate-reject',
      ts: 100,
      reason: 'candidate-distance',
      trainNo: 'T-9001',
      stationName: '강변',
      line: '2',
      distanceKm: 5.4,
      ...overrides,
    };
  }

  function makeLineReject(overrides: Partial<CandidateRejectEntry> = {}): CandidateRejectEntry {
    return {
      kind: 'candidate-reject',
      ts: 200,
      reason: 'candidate-line',
      line: '6',
      ...overrides,
    };
  }

  it('#1616 (R12-a) candidate-distance reject entry — trainNo/station/거리 필수 컨텍스트 보존', () => {
    pushCandidateRejectEntry(makeDistance());
    const entries = getCandidateRejectEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].reason).toBe('candidate-distance');
    expect(entries[0].trainNo).toBe('T-9001');
    expect(entries[0].distanceKm).toBe(5.4);
    expect(entries[0].line).toBe('2');
  });

  it('candidate-line reject entry — trip route 외 line 후보 enumerate 차단 (옵셔널 필드 graceful)', () => {
    pushCandidateRejectEntry(makeLineReject());
    const entries = getCandidateRejectEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].reason).toBe('candidate-line');
    expect(entries[0].line).toBe('6');
    // candidate-line은 enumerate 단계라 trainNo/stationName/distanceKm 모두 옵셔널.
    expect(entries[0].trainNo).toBeUndefined();
    expect(entries[0].stationName).toBeUndefined();
    expect(entries[0].distanceKm).toBeUndefined();
  });

  it('CAP=50 ring buffer — overwrite로 fusion log cap 점령 회귀 차단', () => {
    expect(CANDIDATE_REJECT_BUFFER_CAPACITY).toBe(50);
    for (let i = 0; i < CANDIDATE_REJECT_BUFFER_CAPACITY + 5; i += 1) {
      pushCandidateRejectEntry(makeDistance({ ts: i, trainNo: `T-${i}` }));
    }
    const entries = getCandidateRejectEntries();
    expect(entries).toHaveLength(CANDIDATE_REJECT_BUFFER_CAPACITY);
    // 가장 오래된 5건이 evict — 최신 cap건만 유지.
    expect(entries[0].trainNo).toBe('T-5');
    expect(entries[entries.length - 1].trainNo).toBe(`T-${CANDIDATE_REJECT_BUFFER_CAPACITY + 4}`);
  });

  it('subscribe — push/clear 모두 listener 호출', () => {
    const listener = jest.fn();
    const unsub = subscribeCandidateReject(listener);
    pushCandidateRejectEntry(makeDistance());
    expect(listener).toHaveBeenCalledTimes(1);
    pushCandidateRejectEntry(makeLineReject());
    expect(listener).toHaveBeenCalledTimes(2);
    clearCandidateRejectEntries();
    expect(listener).toHaveBeenCalledTimes(3);
    unsub();
    pushCandidateRejectEntry(makeDistance());
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('clearCandidateRejectEntries — 비어있어도 graceful (listener 호출 없음)', () => {
    const listener = jest.fn();
    subscribeCandidateReject(listener);
    clearCandidateRejectEntries();
    expect(listener).not.toHaveBeenCalled();
  });
});
