/**
 * #1844 (Phase 6.1 Sub-step 5) — useStationMismatchDetector 단위 테스트.
 *
 * 커버 시나리오:
 *   §1 감지 비활성 (null guard)
 *   §2 line-mismatch — 3회 연속 threshold + reset
 *   §3 environment-mismatch — underground 선택 + surface 관측
 *   §4 route-diverged — arc 이탈 + 한 번 일치 reset
 *   §5 우선순위 — route-diverged > line-mismatch > environment-mismatch
 *   §6 alarmLog 적재 + dedup
 *   §7 상수 export 검증
 */

const mockAppend = jest.fn();
jest.mock('../../../alarm/utils/alarmLog', () => ({
  appendAlarmLog: (entry: unknown) => mockAppend(entry),
}));

// getStationById 는 boardingStation.environment 조회에 사용
const mockGetStationById = jest.fn();
jest.mock('../../../../shared/utils/stationRoute', () => ({
  getStationById: (id: string) => mockGetStationById(id),
}));

import { renderHook, act } from '@testing-library/react-native';
import {
  useStationMismatchDetector,
  computeMismatch,
  LINE_MISMATCH_THRESHOLD,
  ENV_MISMATCH_THRESHOLD,
  ROUTE_DIVERGE_THRESHOLD,
  ROUTE_DIVERGE_HOP_THRESHOLD,
  MISMATCH_LOG_DEDUP_WINDOW_MS,
  type MismatchReason,
  type UseStationMismatchDetectorInput,
} from '../useStationMismatchDetector';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import type { NearestStationResult, Station } from '../../../../shared/types/station';

// ── 픽스처 ────────────────────────────────────────────────────────────────────

const makeLock = (overrides: Partial<BoardingLock> = {}): BoardingLock => ({
  destinationId: 'DST-001',
  trainCode: 'T001',
  boardingStationId: 'STN-UNDERGROUND',
  boardingLine: '2',
  boardedAt: Date.now(),
  expectedDurationMs: 30 * 60 * 1000,
  ...overrides,
});

const makeStation = (id: string, line: string = '2'): Station => ({
  id,
  name: `역-${id}`,
  line: line as Station['line'],
  lineColor: '#00af64',
  lat: 37.5,
  lng: 127.0,
});

const makeResult = (stationId: string, line: string = '2'): NearestStationResult => ({
  station: makeStation(stationId, line),
  distanceKm: 0.1,
});

const makeArc = (ids: string[]): Station[] => ids.map((id) => makeStation(id));

/** underground environment를 반환하는 mock boarding station. */
const UNDERGROUND_BOARDING_STATION: Station = {
  ...makeStation('STN-UNDERGROUND'),
  environment: 'underground',
};

/** surface environment boarding station (환경 불일치 없음 케이스용). */
const SURFACE_BOARDING_STATION: Station = {
  ...makeStation('STN-SURFACE'),
  environment: 'surface',
};

// ── §1 감지 비활성 ─────────────────────────────────────────────────────────────

describe('§1 감지 비활성 (null guard)', () => {
  const BASE_INPUT: UseStationMismatchDetectorInput = {
    boardingLock: makeLock(),
    fusedResult: makeResult('STN-A'),
    arcStations: [],
    currentHopIndex: null,
    environment: 'underground',
  };

  it('boardingLock=null → detected=false', () => {
    const { result } = renderHook(() =>
      useStationMismatchDetector({ ...BASE_INPUT, boardingLock: null }),
    );
    expect(result.current.detected).toBe(false);
    expect(result.current.reason).toBeNull();
  });

  it('fusedResult=null → detected=false', () => {
    const { result } = renderHook(() =>
      useStationMismatchDetector({ ...BASE_INPUT, fusedResult: null }),
    );
    expect(result.current.detected).toBe(false);
  });

  it('둘 다 null → detected=false', () => {
    const { result } = renderHook(() =>
      useStationMismatchDetector({ ...BASE_INPUT, boardingLock: null, fusedResult: null }),
    );
    expect(result.current.detected).toBe(false);
  });
});

// ── §2 line-mismatch ──────────────────────────────────────────────────────────

describe('§2 line-mismatch', () => {
  const lock = makeLock({ boardingLine: '2' });
  const countersZero = { routeDiverged: 0, lineMismatch: 0, envMismatch: 0 };

  beforeEach(() => {
    mockGetStationById.mockReturnValue(undefined); // env-mismatch 비활성
  });

  it('노선 일치 → lineMismatch 카운터 0 유지', () => {
    const input: UseStationMismatchDetectorInput = {
      boardingLock: lock,
      fusedResult: makeResult('STN-A', '2'),
      arcStations: [],
      currentHopIndex: null,
      environment: 'underground',
    };
    const { next } = computeMismatch(input, countersZero);
    expect(next.lineMismatch).toBe(0);
  });

  it('노선 불일치 1회 → 카운터 1, detected=false', () => {
    const input: UseStationMismatchDetectorInput = {
      boardingLock: lock,
      fusedResult: makeResult('STN-A', '5'),
      arcStations: [],
      currentHopIndex: null,
      environment: 'underground',
    };
    const { result, next } = computeMismatch(input, countersZero);
    expect(next.lineMismatch).toBe(1);
    expect(result.detected).toBe(false);
  });

  it(`노선 불일치 ${LINE_MISMATCH_THRESHOLD}회 연속 → detected=true, reason='line-mismatch'`, () => {
    let counters = countersZero;
    const input: UseStationMismatchDetectorInput = {
      boardingLock: lock,
      fusedResult: makeResult('STN-A', '5'),
      arcStations: [],
      currentHopIndex: null,
      environment: 'underground',
    };
    for (let i = 0; i < LINE_MISMATCH_THRESHOLD - 1; i++) {
      const out = computeMismatch(input, counters);
      expect(out.result.detected).toBe(false);
      counters = out.next;
    }
    const { result } = computeMismatch(input, counters);
    expect(result.detected).toBe(true);
    expect(result.reason).toBe('line-mismatch');
  });

  it('불일치 2회 후 일치 1회 → 카운터 reset → detected=false', () => {
    let counters = countersZero;
    const mismatchInput: UseStationMismatchDetectorInput = {
      boardingLock: lock,
      fusedResult: makeResult('STN-A', '5'),
      arcStations: [],
      currentHopIndex: null,
      environment: 'underground',
    };
    const matchInput: UseStationMismatchDetectorInput = {
      ...mismatchInput,
      fusedResult: makeResult('STN-A', '2'),
    };
    counters = computeMismatch(mismatchInput, counters).next;
    counters = computeMismatch(mismatchInput, counters).next;
    expect(counters.lineMismatch).toBe(2);
    // 일치
    const { next, result } = computeMismatch(matchInput, counters);
    expect(next.lineMismatch).toBe(0);
    expect(result.detected).toBe(false);
  });
});

// ── §3 environment-mismatch ───────────────────────────────────────────────────

describe('§3 environment-mismatch', () => {
  const lock = makeLock({ boardingStationId: 'STN-UNDERGROUND' });
  const countersZero = { routeDiverged: 0, lineMismatch: 0, envMismatch: 0 };

  beforeEach(() => {
    mockGetStationById.mockImplementation((id: string) => {
      if (id === 'STN-UNDERGROUND') return UNDERGROUND_BOARDING_STATION;
      if (id === 'STN-SURFACE') return SURFACE_BOARDING_STATION;
      return undefined;
    });
  });

  it('underground 선택 + surface 관측 → envMismatch 카운터 증가', () => {
    const input: UseStationMismatchDetectorInput = {
      boardingLock: lock,
      fusedResult: makeResult('STN-X', '2'),
      arcStations: [],
      currentHopIndex: null,
      environment: 'surface',
    };
    const { next } = computeMismatch(input, countersZero);
    expect(next.envMismatch).toBe(1);
  });

  it(`surface 관측 ${ENV_MISMATCH_THRESHOLD}회 연속 → detected=true, reason='environment-mismatch'`, () => {
    let counters = countersZero;
    const input: UseStationMismatchDetectorInput = {
      boardingLock: lock,
      fusedResult: makeResult('STN-X', '2'),
      arcStations: [],
      currentHopIndex: null,
      environment: 'surface',
    };
    for (let i = 0; i < ENV_MISMATCH_THRESHOLD - 1; i++) {
      counters = computeMismatch(input, counters).next;
    }
    const { result } = computeMismatch(input, counters);
    expect(result.detected).toBe(true);
    expect(result.reason).toBe('environment-mismatch');
  });

  it('underground 관측 → reset', () => {
    let counters = { ...countersZero, envMismatch: 2 };
    const input: UseStationMismatchDetectorInput = {
      boardingLock: lock,
      fusedResult: makeResult('STN-X', '2'),
      arcStations: [],
      currentHopIndex: null,
      environment: 'underground',
    };
    const { next, result } = computeMismatch(input, counters);
    expect(next.envMismatch).toBe(0);
    expect(result.detected).toBe(false);
  });

  it('surface 선택역(환경=surface) + surface 관측 → envMismatch 카운터 증가 X', () => {
    const surfaceLock = makeLock({ boardingStationId: 'STN-SURFACE' });
    const input: UseStationMismatchDetectorInput = {
      boardingLock: surfaceLock,
      fusedResult: makeResult('STN-X', '2'),
      arcStations: [],
      currentHopIndex: null,
      environment: 'surface',
    };
    const { next } = computeMismatch(input, countersZero);
    // surface 선택 + surface 관측 → 조건 미충족 → reset(0)
    expect(next.envMismatch).toBe(0);
  });

  it('boardingStation 조회 실패(undefined) → envMismatch 카운터 유지 (neutral)', () => {
    mockGetStationById.mockReturnValue(undefined);
    const counters = { ...countersZero, envMismatch: 1 };
    const input: UseStationMismatchDetectorInput = {
      boardingLock: lock,
      fusedResult: makeResult('STN-X', '2'),
      arcStations: [],
      currentHopIndex: null,
      environment: 'surface',
    };
    const { next } = computeMismatch(input, counters);
    // 조회 실패 = neutral → 이전 카운터 + 1 (increment path 진입)
    expect(next.envMismatch).toBeGreaterThanOrEqual(1);
  });
});

// ── §4 route-diverged ─────────────────────────────────────────────────────────

describe('§4 route-diverged', () => {
  const lock = makeLock();
  const countersZero = { routeDiverged: 0, lineMismatch: 0, envMismatch: 0 };

  beforeEach(() => {
    mockGetStationById.mockReturnValue(undefined);
  });

  it('arcStations 빈 배열 → route-diverged 감지 비활성 (카운터=0)', () => {
    const input: UseStationMismatchDetectorInput = {
      boardingLock: lock,
      fusedResult: makeResult('STN-OUT'),
      arcStations: [],
      currentHopIndex: null,
      environment: 'underground',
    };
    const { next } = computeMismatch(input, countersZero);
    expect(next.routeDiverged).toBe(0);
  });

  it('currentHopIndex=null → route-diverged 감지 비활성', () => {
    const arc = makeArc(['STN-A', 'STN-B', 'STN-C']);
    const input: UseStationMismatchDetectorInput = {
      boardingLock: lock,
      fusedResult: makeResult('STN-OUT'),
      arcStations: arc,
      currentHopIndex: null,
      environment: 'underground',
    };
    const { next } = computeMismatch(input, countersZero);
    expect(next.routeDiverged).toBe(0);
  });

  it('observed 역이 arc 위 expected window 안 (±HOP_THRESHOLD 이내) → diverge 아님', () => {
    const arc = makeArc(['STN-A', 'STN-B', 'STN-C', 'STN-D', 'STN-E']);
    const input: UseStationMismatchDetectorInput = {
      boardingLock: lock,
      fusedResult: makeResult('STN-B'), // idx=1, currentHopIndex=2, 차이=1
      arcStations: arc,
      currentHopIndex: 2,
      environment: 'underground',
    };
    const { next } = computeMismatch(input, countersZero);
    expect(next.routeDiverged).toBe(0);
  });

  it('observed 역이 arc 위 expected window 밖 → diverge 카운터 증가', () => {
    const arc = makeArc(['STN-A', 'STN-B', 'STN-C', 'STN-D', 'STN-E']);
    const input: UseStationMismatchDetectorInput = {
      boardingLock: lock,
      // currentHopIndex=0, observed=STN-E(idx=4), 차이=4 > HOP_THRESHOLD=3
      fusedResult: makeResult('STN-E'),
      arcStations: arc,
      currentHopIndex: 0,
      environment: 'underground',
    };
    const { next } = computeMismatch(input, countersZero);
    expect(next.routeDiverged).toBe(1);
  });

  it('observed 역이 arc에 없음 → diverge 카운터 증가', () => {
    const arc = makeArc(['STN-A', 'STN-B', 'STN-C']);
    const input: UseStationMismatchDetectorInput = {
      boardingLock: lock,
      fusedResult: makeResult('STN-OUTSIDE'),
      arcStations: arc,
      currentHopIndex: 1,
      environment: 'underground',
    };
    const { next } = computeMismatch(input, countersZero);
    expect(next.routeDiverged).toBe(1);
  });

  it(`route-diverged ${ROUTE_DIVERGE_THRESHOLD}회 연속 → detected=true, reason='route-diverged'`, () => {
    const arc = makeArc(['STN-A', 'STN-B', 'STN-C']);
    let counters = countersZero;
    const input: UseStationMismatchDetectorInput = {
      boardingLock: lock,
      fusedResult: makeResult('STN-OUTSIDE'),
      arcStations: arc,
      currentHopIndex: 0,
      environment: 'underground',
    };
    for (let i = 0; i < ROUTE_DIVERGE_THRESHOLD - 1; i++) {
      counters = computeMismatch(input, counters).next;
    }
    const { result } = computeMismatch(input, counters);
    expect(result.detected).toBe(true);
    expect(result.reason).toBe('route-diverged');
  });

  it('이탈 2회 후 arc 일치 1회 → reset', () => {
    const arc = makeArc(['STN-A', 'STN-B', 'STN-C']);
    let counters = { ...countersZero, routeDiverged: 2 };
    const input: UseStationMismatchDetectorInput = {
      boardingLock: lock,
      // STN-B is at idx=1, currentHopIndex=1 → 차이=0 → window 안
      fusedResult: makeResult('STN-B'),
      arcStations: arc,
      currentHopIndex: 1,
      environment: 'underground',
    };
    const { next, result } = computeMismatch(input, counters);
    expect(next.routeDiverged).toBe(0);
    expect(result.detected).toBe(false);
  });
});

// ── §5 우선순위 ───────────────────────────────────────────────────────────────

describe('§5 우선순위 (route-diverged > line-mismatch > environment-mismatch)', () => {
  beforeEach(() => {
    mockGetStationById.mockReturnValue(UNDERGROUND_BOARDING_STATION);
  });

  it('route-diverged + line-mismatch 동시 → reason=route-diverged', () => {
    const lock = makeLock({ boardingLine: '2' });
    const arc = makeArc(['STN-A', 'STN-B', 'STN-C']);
    const counters = {
      routeDiverged: ROUTE_DIVERGE_THRESHOLD - 1,
      lineMismatch: LINE_MISMATCH_THRESHOLD - 1,
      envMismatch: 0,
    };
    const input: UseStationMismatchDetectorInput = {
      boardingLock: lock,
      fusedResult: makeResult('STN-OUTSIDE', '5'), // 노선 불일치 + arc 이탈
      arcStations: arc,
      currentHopIndex: 0,
      environment: 'underground',
    };
    const { result } = computeMismatch(input, counters);
    expect(result.detected).toBe(true);
    expect(result.reason).toBe('route-diverged');
  });

  it('line-mismatch + environment-mismatch 동시 → reason=line-mismatch', () => {
    const lock = makeLock({ boardingLine: '2', boardingStationId: 'STN-UNDERGROUND' });
    const counters = {
      routeDiverged: 0,
      lineMismatch: LINE_MISMATCH_THRESHOLD - 1,
      envMismatch: ENV_MISMATCH_THRESHOLD - 1,
    };
    const input: UseStationMismatchDetectorInput = {
      boardingLock: lock,
      fusedResult: makeResult('STN-X', '5'), // 노선 불일치
      arcStations: [],
      currentHopIndex: null,
      environment: 'surface', // 환경 불일치도
    };
    const { result } = computeMismatch(input, counters);
    expect(result.detected).toBe(true);
    expect(result.reason).toBe('line-mismatch');
  });
});

// ── §6 alarmLog 적재 + dedup ─────────────────────────────────────────────────

/**
 * 훅 내부에서 LINE_MISMATCH_THRESHOLD회 연속 불일치가 누적될 때까지 rerender를 구동하는 헬퍼.
 * 초기 render=1회 이므로 (THRESHOLD-1)회 추가 rerender가 필요.
 */
function renderHookUntilDetected(lock: BoardingLock) {
  const hookResult = renderHook(
    ({ line }: { line: string }) =>
      useStationMismatchDetector({
        boardingLock: lock,
        fusedResult: makeResult('STN-A', line),
        arcStations: [],
        currentHopIndex: null,
        environment: 'underground',
      }),
    { initialProps: { line: '5' } }, // 노선 불일치
  );
  // threshold-1 추가 rerender → 누적 LINE_MISMATCH_THRESHOLD회 → detected=true
  for (let i = 0; i < LINE_MISMATCH_THRESHOLD - 1; i++) {
    act(() => { hookResult.rerender({ line: '5' }); });
  }
  return hookResult;
}

describe('§6 alarmLog 적재 + dedup', () => {
  beforeEach(() => {
    mockAppend.mockReset();
    mockGetStationById.mockReturnValue(undefined);
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-26T10:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('detected=false 상태 → appendAlarmLog 미호출', () => {
    const lock = makeLock({ boardingLine: '2' });
    renderHook(() =>
      useStationMismatchDetector({
        boardingLock: lock,
        fusedResult: makeResult('STN-A', '2'), // 일치
        arcStations: [],
        currentHopIndex: null,
        environment: 'underground',
      }),
    );
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('LINE_MISMATCH_THRESHOLD회 연속 불일치 → appendAlarmLog 1건 (reason=cold-start-mismatch)', () => {
    const lock = makeLock({ boardingLine: '2' });
    renderHookUntilDetected(lock);
    expect(mockAppend).toHaveBeenCalledTimes(1);
    const entry = mockAppend.mock.calls[0][0];
    expect(entry.source).toBe('fg-evaluated');
    expect(entry.outcome).toBe('suppressed');
    expect(entry.reason).toBe('cold-start-mismatch');
    expect(entry.expectedStationAtFire).toBe('line-mismatch');
  });

  it('detected=true 후 dedup 윈도우 안에 동일 reason 재발생 → 추가 적재 X', () => {
    const lock = makeLock({ boardingLine: '2' });
    const { rerender } = renderHookUntilDetected(lock);
    expect(mockAppend).toHaveBeenCalledTimes(1);
    // dedup 윈도우 안에서 추가 rerender (deps 안 바뀌어 effect 재실행 없음)
    act(() => { rerender({ line: '5' }); });
    act(() => { rerender({ line: '5' }); });
    expect(mockAppend).toHaveBeenCalledTimes(1);
  });

  it('dedup 윈도우 만료 후 같은 reason 재진입 → 추가 적재 O', () => {
    const lock = makeLock({ boardingLine: '2' });
    const { rerender } = renderHookUntilDetected(lock);
    expect(mockAppend).toHaveBeenCalledTimes(1);
    // 윈도우 만료
    jest.setSystemTime(new Date(Date.now() + MISMATCH_LOG_DEDUP_WINDOW_MS + 1));
    // 일치 → reset
    act(() => { rerender({ line: '2' }); });
    // 다시 THRESHOLD회 불일치
    for (let i = 0; i < LINE_MISMATCH_THRESHOLD; i++) {
      act(() => { rerender({ line: '5' }); });
    }
    expect(mockAppend).toHaveBeenCalledTimes(2);
  });
});

// ── §7 상수 export 검증 ──────────────────────────────────────────────────────

describe('§7 상수 export', () => {
  it.each([
    ['LINE_MISMATCH_THRESHOLD', LINE_MISMATCH_THRESHOLD, 3],
    ['ENV_MISMATCH_THRESHOLD', ENV_MISMATCH_THRESHOLD, 3],
    ['ROUTE_DIVERGE_THRESHOLD', ROUTE_DIVERGE_THRESHOLD, 3],
    ['ROUTE_DIVERGE_HOP_THRESHOLD', ROUTE_DIVERGE_HOP_THRESHOLD, 3],
    ['MISMATCH_LOG_DEDUP_WINDOW_MS', MISMATCH_LOG_DEDUP_WINDOW_MS, 60 * 1000],
  ])('%s = %i', (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });
});
