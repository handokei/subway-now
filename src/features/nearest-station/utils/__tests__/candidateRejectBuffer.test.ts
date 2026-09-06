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
  CANDIDATE_REJECT_AGGREGATION_WINDOW_MS,
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

  it('#1934 G3 option B + #1936 G4 — candidate-env reject entry (env vote 카운터 가시화)', () => {
    pushCandidateRejectEntry({
      kind: 'candidate-reject',
      ts: 300,
      reason: 'candidate-env',
      stationName: '강남',
      line: '2',
      cascadeEnvironment: 'underground',
      candidateEnvironment: 'surface',
    });
    const entries = getCandidateRejectEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].reason).toBe('candidate-env');
    expect(entries[0].cascadeEnvironment).toBe('underground');
    expect(entries[0].candidateEnvironment).toBe('surface');
    expect(entries[0].stationName).toBe('강남');
    expect(entries[0].distanceKm).toBeUndefined();
    expect(entries[0].trainNo).toBeUndefined();
  });

  it('CAP=50 ring buffer — overwrite로 fusion log cap 점령 회귀 차단 (각 push가 서로 다른 집계 윈도우)', () => {
    expect(CANDIDATE_REJECT_BUFFER_CAPACITY).toBe(50);
    // #2093 (G) — 같은 윈도우 안의 반복 reject는 in-place 집계되어 새 slot을 쓰지 않으므로,
    // cap overwrite 자체(ring buffer 물리 동작)를 검증하려면 각 push를 별 윈도우로 분리한다.
    for (let i = 0; i < CANDIDATE_REJECT_BUFFER_CAPACITY + 5; i += 1) {
      pushCandidateRejectEntry(
        makeDistance({ ts: i * (CANDIDATE_REJECT_AGGREGATION_WINDOW_MS + 1), trainNo: `T-${i}` }),
      );
    }
    const entries = getCandidateRejectEntries();
    expect(entries).toHaveLength(CANDIDATE_REJECT_BUFFER_CAPACITY);
    // 가장 오래된 5건이 evict — 최신 cap건만 유지.
    expect(entries[0].trainNo).toBe('T-5');
    expect(entries[entries.length - 1].trainNo).toBe(`T-${CANDIDATE_REJECT_BUFFER_CAPACITY + 4}`);
  });

  describe('#2093 (G) — burst rate-limit + 집계화', () => {
    it('같은 윈도우 안 burst reject는 slot 1개로 집계 (count 누적)', () => {
      pushCandidateRejectEntry(makeDistance({ ts: 0, stationName: '먼역1', distanceKm: 10 }));
      pushCandidateRejectEntry(makeDistance({ ts: 100, stationName: '먼역2', distanceKm: 43 }));
      pushCandidateRejectEntry(makeDistance({ ts: 200, stationName: '먼역3', distanceKm: 20 }));
      const entries = getCandidateRejectEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].count).toBe(3);
      // 최대 거리(43km)가 보존 — "최대 dist" 진단 가시성.
      expect(entries[0].distanceKm).toBe(43);
      // 최신 reject의 station으로 갱신.
      expect(entries[0].stationName).toBe('먼역3');
    });

    it('윈도우 경과 후 재개 — 새 entry가 count=1부터 다시 push', () => {
      pushCandidateRejectEntry(makeDistance({ ts: 0 }));
      pushCandidateRejectEntry(makeDistance({ ts: 500 }));
      expect(getCandidateRejectEntries()).toHaveLength(1);
      expect(getCandidateRejectEntries()[0].count).toBe(2);

      pushCandidateRejectEntry(
        makeDistance({ ts: CANDIDATE_REJECT_AGGREGATION_WINDOW_MS + 1, stationName: '새윈도우역' }),
      );
      const entries = getCandidateRejectEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0].count).toBe(2);
      expect(entries[1].count).toBe(1);
      expect(entries[1].stationName).toBe('새윈도우역');
    });

    it('첫 reject에 distanceKm 없다가 후속 reject에 생기면 maxDistanceKm이 새 값으로 채워짐', () => {
      pushCandidateRejectEntry(makeLineReject({ ts: 0, distanceKm: undefined }));
      pushCandidateRejectEntry(makeLineReject({ ts: 100, distanceKm: 12 }));
      const entries = getCandidateRejectEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].count).toBe(2);
      expect(entries[0].distanceKm).toBe(12);
    });

    it('reason별 윈도우 독립 — candidate-distance burst가 candidate-line 집계에 영향 없음', () => {
      pushCandidateRejectEntry(makeDistance({ ts: 0 }));
      pushCandidateRejectEntry(makeDistance({ ts: 100 }));
      pushCandidateRejectEntry(makeLineReject({ ts: 150 }));
      const entries = getCandidateRejectEntries();
      expect(entries).toHaveLength(2);
      const distanceEntry = entries.find((e) => e.reason === 'candidate-distance');
      const lineEntry = entries.find((e) => e.reason === 'candidate-line');
      expect(distanceEntry?.count).toBe(2);
      expect(lineEntry?.count).toBe(1);
    });

    it('clearCandidateRejectEntries — 집계 윈도우도 리셋 (clear 후 push는 새 윈도우)', () => {
      pushCandidateRejectEntry(makeDistance({ ts: 0 }));
      pushCandidateRejectEntry(makeDistance({ ts: 100 }));
      clearCandidateRejectEntries();
      pushCandidateRejectEntry(makeDistance({ ts: 150 }));
      const entries = getCandidateRejectEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].count).toBe(1);
    });

    it('집계 entry는 첫 push에서만 listener 호출 — 후속 burst는 notify 없이 in-place 갱신', () => {
      const listener = jest.fn();
      subscribeCandidateReject(listener);
      pushCandidateRejectEntry(makeDistance({ ts: 0 }));
      expect(listener).toHaveBeenCalledTimes(1);
      pushCandidateRejectEntry(makeDistance({ ts: 100 }));
      pushCandidateRejectEntry(makeDistance({ ts: 200 }));
      expect(listener).toHaveBeenCalledTimes(1);
    });
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
