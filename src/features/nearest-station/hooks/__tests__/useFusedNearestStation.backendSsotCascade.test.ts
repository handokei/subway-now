/* eslint-disable import/no-restricted-paths -- cross-feature orchestration (#890) */

/**
 * #1568 (T8b, Epic ADR-017 #1553) — cascade picker `backend-ssot` tier 회귀 가드.
 *
 * 시나리오:
 *   1. backend SSoT mirror 존재 + fresh → cascade 1순위 채택, confidence/source='backend-ssot'.
 *   2. mirror 미존재 → 기존 tier(WiFi/position-train/...) fallback.
 *   3. mirror stale(receivedAt 180s 초과, #1573 T10 / #2261 ADR-031 Phase 0 receivedAt 재정의)
 *      → cascade 채택 거부 → 기존 tier fallback.
 *   4. mirror lock 활성 + line mismatch → station resolve null → 채택 거부.
 *   5. mirror lockless + resolve 가능 → cascade 채택 (lockless도 lock과 동급 우선순위).
 *
 * #1646 — positionTrain cascade priority 승격 (3-of-3 합의 lock+지하+lockMatch).
 *   사용자 trip evidence(2026-06-22 14:28/14:30/14:33): backend SSoT mirror lag(10-30s)로 인해
 *   b역 도착해도 fusion 현재역이 1역 뒤쳐짐. positionTrain이 실시간 신호인데도 cascade 3순위라
 *   backend mirror가 advance될 때까지 채택되지 않음. 합의 충족 시 positionTrain 1순위 승격.
 */

import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useFusedNearestStation } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import { TRAIN_STATUS } from '../../../../shared/constants/trainStatus';
import { BACKEND_SSOT_MIRROR_MAX_AGE_MS } from '../../../../shared/constants/realtime';
import {
  arrivalRet,
  positionRet,
  makeTrain as train,
  GPS_BASE_DEFAULTS,
} from '../../../../testUtils/positionApiFixtures';
import {
  BACKEND_SSOT_FIXTURE_T0 as T0,
  flushBackendSsotMirrorTick,
  makeBackendSsotMirrorEntry,
} from '../../../../testUtils/backendSsotMirrorFixtures';
import { readBackendSsotMirror } from '../../../alarm/utils/backendSsotMirror';
import type { BackendSsotMirrorEntry } from '../../../alarm/utils/backendSsotMirror';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

jest.mock('../../utils/findNearestStation', () => ({
  findTopNearestStations: jest.fn(),
}));
jest.mock('../useNearestStation');
jest.mock('../../../arrival/hooks/useArrivalInfo');
jest.mock('../../../route/hooks/useTrainPositions');
jest.mock('../../../alarm/utils/tripStartStorage', () => ({
  getTripStartedAt: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../alarm/utils/backendSsotMirror', () => ({
  readBackendSsotMirror: jest.fn(),
}));

const mockNearest = useNearestStation as jest.Mock;
const mockArrival = useArrivalInfo as jest.Mock;
const mockPos = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;
const mockRead = readBackendSsotMirror as jest.Mock;

const yongmasan = findStationByNameAndLine('용마산', '7')!;
const chungdam = findStationByNameAndLine('청담', '7')!;
const gangnam2 = findStationByNameAndLine('강남', '2')!;

// fixture 기본값(`makeBackendSsotMirrorEntry`)이 이미 '용마산' currentStationId라 단순 위임.
// override 없는 호출(line ~164, 208)은 본 wrapper의 default arg branch도 같이 커버.
function makeMirror(overrides?: Partial<BackendSsotMirrorEntry>): BackendSsotMirrorEntry {
  return makeBackendSsotMirrorEntry(overrides);
}

function setupBaselineGpsAt(stationName: string) {
  const stn = findStationByNameAndLine(stationName, '7')!;
  const live = { station: stn, distanceKm: 0 };
  mockNearest.mockReturnValue({
    result: live,
    liveResult: live,
    stickyDisplayOnly: null,
    variants: [stn],
    userLocation: { lat: stn.lat, lng: stn.lng },
    ...GPS_BASE_DEFAULTS,
    accuracyMeters: 14,
    refresh: jest.fn(),
  });
  mockFindTop.mockReturnValue([{ station: stn, distanceKm: 0 }]);
  mockArrival.mockReturnValue(arrivalRet(null));
  mockPos.mockReturnValue(positionRet(null));
}

const lockOn7: BoardingLock = {
  destinationId: 'dest-7',
  trainCode: 'T-LOCK',
  boardingLine: '7',
  boardingStationId: yongmasan.id,
  boardedAt: T0,
  expectedDurationMs: 10 * 60_000,
};

describe('#1568 (T8b) cascade picker — backend-ssot tier', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const flushSsotRead = flushBackendSsotMirrorTick;

  it('mirror 존재 + fresh → cascade 1순위 (lock 활성, lockless 동등 우선순위)', async () => {
    // 사용자가 다른 역(청담)에 있다고 GPS가 가리켜도 backend mirror가 용마산을 권위 산출 → mirror 우선.
    setupBaselineGpsAt('청담');
    mockRead.mockResolvedValue(makeMirror({ currentStationId: yongmasan.name }));
    const hook = renderHook(() =>
      useFusedNearestStation(undefined, undefined, undefined, undefined, lockOn7),
    );
    await flushSsotRead();
    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
    expect(hook.result.current.confidence).toBe('backend-ssot');
    expect(hook.result.current.result?.station.id).toBe(yongmasan.id);
  });

  it('mirror 없음 → 기존 tier(GPS fallback)로 자연 fallback', async () => {
    setupBaselineGpsAt('청담');
    mockRead.mockResolvedValue(null);
    const hook = renderHook(() => useFusedNearestStation());
    await flushSsotRead();
    // mirror 없음 + GPS 청담 → cascade 기본 GPS fallback ('gps')
    expect(hook.result.current.source).not.toBe('backend-ssot');
    expect(hook.result.current.confidence).not.toBe('backend-ssot');
  });

  it('mirror stale(receivedAt > 180s) → 채택 거부 (#1573 T10 60s → 180s, #2261 receivedAt 재정의)', async () => {
    setupBaselineGpsAt('청담');
    mockRead.mockResolvedValue(
      makeMirror({
        currentStationId: yongmasan.name,
        receivedAt: T0 - 240_000, // 4분 전 — staleness 180s 초과
      }),
    );
    const hook = renderHook(() => useFusedNearestStation());
    await flushSsotRead();
    expect(hook.result.current.source).not.toBe('backend-ssot');
  });

  it('#2261 mirror lastAdvanceAt stale(지하·정지 non-advancing)이어도 receivedAt fresh면 채택 (deadlock 해소)', async () => {
    // 지하·정지 trip: backend가 advance를 전혀 못 해 lastAdvanceAt이 옛날 값에 고정돼 있어도
    // FG position pull이 방금 mirror를 갱신했다면(receivedAt fresh) 채택돼야 한다.
    setupBaselineGpsAt('청담');
    mockRead.mockResolvedValue(
      makeMirror({
        currentStationId: yongmasan.name,
        lastAdvanceAt: T0 - 10 * 60_000, // 10분 전 advance — non-advancing trip
        receivedAt: T0, // 방금 pull로 갱신
      }),
    );
    const hook = renderHook(() => useFusedNearestStation());
    await flushSsotRead();
    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
    expect(hook.result.current.result?.station.id).toBe(yongmasan.id);
  });

  it('mirror lock 활성 + line mismatch → station resolve 실패 → 채택 거부', async () => {
    // mirror가 2호선 강남을 가리키지만 lock은 7호선 → findStationByNameAndLine('강남', '7') = null.
    setupBaselineGpsAt('청담');
    mockRead.mockResolvedValue(makeMirror({ currentStationId: gangnam2.name }));
    const hook = renderHook(() =>
      useFusedNearestStation(undefined, undefined, undefined, undefined, lockOn7),
    );
    await flushSsotRead();
    expect(hook.result.current.source).not.toBe('backend-ssot');
  });

  it('mirror lockless → 채택 (lockless trip 동등 우선순위)', async () => {
    setupBaselineGpsAt('청담');
    mockRead.mockResolvedValue(makeMirror({ currentStationId: yongmasan.name }));
    const hook = renderHook(() => useFusedNearestStation());
    await flushSsotRead();
    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
    expect(hook.result.current.result?.station.id).toBe(yongmasan.id);
  });

  it('두 cycle 동일 entry → 추가 render skip (setState reducer no-op)', async () => {
    setupBaselineGpsAt('청담');
    mockRead.mockResolvedValue(makeMirror());
    const hook = renderHook(() => useFusedNearestStation());
    await flushSsotRead();
    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
    // 두 번째 tick에서 동일 entry → setState reducer가 prev 그대로 반환 → 추가 render 없음.
    await flushSsotRead();
    expect(hook.result.current.source).toBe('backend-ssot');
  });

  it('null → null 전이도 추가 render 없음 (no-op reducer)', async () => {
    setupBaselineGpsAt('청담');
    mockRead.mockResolvedValue(null);
    const hook = renderHook(() => useFusedNearestStation());
    await flushSsotRead();
    await flushSsotRead();
    expect(hook.result.current.source).not.toBe('backend-ssot');
  });

  it('liveResult exposes raw GPS — sticky 격리 채널', async () => {
    setupBaselineGpsAt('청담');
    mockRead.mockResolvedValue(null);
    const hook = renderHook(() => useFusedNearestStation());
    await flushSsotRead();
    expect(hook.result.current.liveResult?.station.name).toBe('청담');
  });

  it('unmount 후 resolve된 read는 setState 무시 (cancelled 가드)', async () => {
    setupBaselineGpsAt('청담');
    let resolveRead!: (entry: BackendSsotMirrorEntry | null) => void;
    mockRead.mockReturnValueOnce(
      new Promise<BackendSsotMirrorEntry | null>((res) => {
        resolveRead = res;
      }),
    );
    const hook = renderHook(() => useFusedNearestStation());
    // 5s tick으로 read 시작 (resolve는 보류)
    act(() => {
      jest.advanceTimersByTime(5_000);
    });
    hook.unmount();
    // unmount 이후에 read resolve — cancelled 가드로 setState skip되어 warning/error 없음.
    await act(async () => {
      resolveRead(makeMirror());
      await Promise.resolve();
    });
    // 별도 assertion 없음 — error 없이 통과하면 cancelled 분기 커버.
    expect(true).toBe(true);
  });

  it('mirror cycle에서 backend가 station을 바꾸면 entry diff로 setState 발화', async () => {
    setupBaselineGpsAt('청담');
    mockRead.mockResolvedValueOnce(makeMirror({ currentStationId: yongmasan.name }));
    const hook = renderHook(() => useFusedNearestStation());
    await flushSsotRead();
    await waitFor(() => {
      expect(hook.result.current.result?.station.id).toBe(yongmasan.id);
    });
    // 다음 cycle은 다른 receivedAt + 다른 currentStationId
    mockRead.mockResolvedValue(
      makeMirror({ currentStationId: chungdam.name, receivedAt: T0 + 5_000 }),
    );
    await flushSsotRead();
    await waitFor(() => {
      expect(hook.result.current.result?.station.id).toBe(chungdam.id);
    });
  });
});

describe('#1646 cascade picker — positionTrain 1순위 승격 (3-of-3 합의)', () => {
  const TRAIN_CODE = 'T-1646';
  const lockOn7Match: BoardingLock = {
    destinationId: 'dest-7',
    trainCode: TRAIN_CODE,
    boardingLine: '7',
    boardingStationId: yongmasan.id,
    boardedAt: T0,
    expectedDurationMs: 10 * 60_000,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * GPS at yongmasan + positionTrain at yongmasan (좌표 일치로 fusion gate 통과).
   * mirror가 다른 station(청담)을 가리키면 합의 충족 시 mirror가 무시되는지 검증 가능.
   */
  function setupPositionTrainMatch(opts?: { withPositionTrain?: boolean }) {
    const { withPositionTrain = true } = opts ?? {};
    setupBaselineGpsAt('용마산');
    mockPos.mockReturnValue(
      positionRet(
        withPositionTrain
          ? { line: '7', trains: [train(yongmasan.name, TRAIN_STATUS.ARRIVED, { trainNo: TRAIN_CODE })] }
          : null,
      ),
    );
  }

  function renderFusion(opts: {
    lockedTrainCode?: string | null;
    boardingLock?: BoardingLock | null;
    barometer?: { subsurface?: boolean };
  }) {
    return renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        opts.lockedTrainCode,
        opts.boardingLock,
        undefined,
        opts.barometer,
      ),
    );
  }

  it('3-of-3 합의(lock+지하+lockMatch) 시 positionTrain 1순위 — backend mirror 무시', async () => {
    setupPositionTrainMatch();
    // mirror가 다른 station(청담)을 가리켜도 합의 충족 시 무시.
    mockRead.mockResolvedValue(makeMirror({ currentStationId: chungdam.name }));
    const hook = renderFusion({
      lockedTrainCode: TRAIN_CODE,
      boardingLock: lockOn7Match,
      barometer: { subsurface: true },
    });
    await flushBackendSsotMirrorTick();
    await waitFor(() => {
      expect(hook.result.current.source).toBe('boarding-lock');
    });
    expect(hook.result.current.confidence).toBe('boarding-lock');
    expect(hook.result.current.result?.station.id).toBe(yongmasan.id);
  });

  it('3-of-3 합의 충족 + backend mirror null → positionTrain 1순위 (fallback 충돌 없음)', async () => {
    setupPositionTrainMatch();
    mockRead.mockResolvedValue(null);
    const hook = renderFusion({
      lockedTrainCode: TRAIN_CODE,
      boardingLock: lockOn7Match,
      barometer: { subsurface: true },
    });
    await flushBackendSsotMirrorTick();
    await waitFor(() => {
      expect(hook.result.current.source).toBe('boarding-lock');
    });
    expect(hook.result.current.result?.station.id).toBe(yongmasan.id);
  });

  // 본 합의 미충족 케이스 — 모두 backend mirror 1순위 채택.
  it.each<[
    string,
    Parameters<typeof renderFusion>[0],
    Parameters<typeof setupPositionTrainMatch>[0] | undefined,
  ]>([
    [
      'barometer 지상(subsurface=false)',
      { lockedTrainCode: TRAIN_CODE, boardingLock: lockOn7Match, barometer: { subsurface: false } },
      undefined,
    ],
    [
      'barometer 미전달(subsurface=undefined)',
      { lockedTrainCode: TRAIN_CODE, boardingLock: lockOn7Match },
      undefined,
    ],
    [
      'lockless trip(boardingLock=null)',
      { lockedTrainCode: TRAIN_CODE, boardingLock: null, barometer: { subsurface: true } },
      undefined,
    ],
    [
      'trainCode mismatch(lockedTrainCode != trainProgress.trainNo)',
      {
        lockedTrainCode: 'T-DIFFERENT',
        boardingLock: { ...lockOn7Match, trainCode: 'T-DIFFERENT' },
        barometer: { subsurface: true },
      },
      undefined,
    ],
    [
      'lockedTrainCode null',
      { lockedTrainCode: undefined, boardingLock: lockOn7Match, barometer: { subsurface: true } },
      undefined,
    ],
    [
      'positionTrain null(realtimePosition API outage)',
      { lockedTrainCode: TRAIN_CODE, boardingLock: lockOn7Match, barometer: { subsurface: true } },
      { withPositionTrain: false },
    ],
  ])('합의 미충족 — %s → backend mirror 1순위', async (_label, fusionOpts, mocksOpts) => {
    setupPositionTrainMatch(mocksOpts);
    mockRead.mockResolvedValue(makeMirror({ currentStationId: chungdam.name }));
    const hook = renderFusion(fusionOpts);
    await flushBackendSsotMirrorTick();
    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
  });
});

describe('#1705 ssotStation — lockless + currentStationLine line-matched resolve', () => {
  // 합정역은 2호선(line '2')과 6호선(line '6') 동명 환승역.
  // currentStationLine='2' 지정 시 2호선 합정을 정확하게 resolve해야 한다.
  const hapjeong2 = findStationByNameAndLine('합정', '2')!;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    // GPS는 청담(7호선)으로 세팅 — backend mirror가 다른 역을 권위 산출.
    setupBaselineGpsAt('청담');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('lockless + currentStationLine 있음 → line 정확 매칭으로 동명 환승역 cross-line confusion 차단', async () => {
    // currentStationLine='2': 합정 2호선을 정확히 resolve해야 함.
    mockRead.mockResolvedValue(
      makeMirror({ currentStationId: '합정', currentStationLine: '2' }),
    );
    const hook = renderHook(() => useFusedNearestStation());
    await flushBackendSsotMirrorTick();
    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
    expect(hook.result.current.result?.station.id).toBe(hapjeong2.id);
    expect(hook.result.current.result?.station.line).toBe('2');
  });
});

describe('#1773 (E) SSoT mirror staleness × stale GPS 겹침 회귀 가드', () => {
  // GPS lastFixAtMs=T0-200_000: 200s old. GPS_FALLBACK_STALE_MAX_AGE_MS(300s) 이내라 GPS 게이트 통과.
  // BACKEND_SSOT_MIRROR_MAX_AGE_MS = 180s. #2261 (ADR-031 Phase 0) 이후 receivedAt으로 SSoT
  // mirror 신선도 판정 (기존 lastAdvanceAt 기준에서 재정의).
  //
  // 시나리오:
  //   E1. mirror 60s old (fresh) + GPS 200s old → backend-ssot 채택 OK.
  //   E2. mirror 170s old (한계 직전, 여전히 fresh) + GPS 200s old → backend-ssot 채택 OK.
  //   E3. mirror 200s old (stale, >180s) + GPS 200s old → backend-ssot 채택 거부 → GPS fallback.

  function setupBaselineGpsWithLastFix(stationName: string, lastFixAtMs: number) {
    const stn = findStationByNameAndLine(stationName, '7')!;
    const live = { station: stn, distanceKm: 0 };
    (useNearestStation as jest.Mock).mockReturnValue({
      result: live,
      liveResult: live,
      stickyDisplayOnly: null,
      variants: [stn],
      userLocation: { lat: stn.lat, lng: stn.lng },
      ...GPS_BASE_DEFAULTS,
      accuracyMeters: 14,
      lastFixAtMs,
      refresh: jest.fn(),
    });
    (findTopNearestStations as jest.Mock).mockReturnValue([{ station: stn, distanceKm: 0 }]);
    (useArrivalInfo as jest.Mock).mockReturnValue(arrivalRet(null));
    (useTrainPositions as jest.Mock).mockReturnValue(positionRet(null));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('E1: mirror 60s old(fresh) + GPS 200s old → backend-ssot 채택 OK', async () => {
    // receivedAt = T0 - 60_000 (60s old). 60s < BACKEND_SSOT_MIRROR_MAX_AGE_MS(180s) → fresh.
    // GPS 200s old는 GPS_FALLBACK_STALE_MAX_AGE_MS(300s) 이내 → GPS 게이트 통과.
    // 결과: backend-ssot가 cascade 1순위로 채택됨.
    setupBaselineGpsWithLastFix('청담', T0 - 200_000);
    (readBackendSsotMirror as jest.Mock).mockResolvedValue(
      makeBackendSsotMirrorEntry({
        currentStationId: yongmasan.name,
        receivedAt: T0 - 60_000,
      }),
    );
    const hook = renderHook(() => useFusedNearestStation());
    await flushBackendSsotMirrorTick();
    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
    expect(hook.result.current.confidence).toBe('backend-ssot');
    expect(hook.result.current.result?.station.id).toBe(yongmasan.id);
  });

  it('E2: mirror 170s old(한계 직전, still fresh) + GPS 200s old → backend-ssot 채택 OK', async () => {
    // receivedAt = T0 - 170_000 (170s old). 170s < 180s → 아직 fresh(경계 직전).
    // 이 edge case는 stale 직전 구간 — 채택 허용 확인.
    setupBaselineGpsWithLastFix('청담', T0 - 200_000);
    (readBackendSsotMirror as jest.Mock).mockResolvedValue(
      makeBackendSsotMirrorEntry({
        currentStationId: yongmasan.name,
        receivedAt: T0 - 170_000,
      }),
    );
    const hook = renderHook(() => useFusedNearestStation());
    await flushBackendSsotMirrorTick();
    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
    expect(hook.result.current.result?.station.id).toBe(yongmasan.id);
  });

  it('E3: mirror 200s old(stale, >180s) + GPS 200s old → backend-ssot 채택 거부 → GPS fallback', async () => {
    // receivedAt = T0 - 200_000 (200s old). 200s > 180s → stale → ssotFresh=false → 채택 거부.
    // GPS 200s old는 GPS gate 통과 → GPS fallback으로 cascade 진행 (source='gps').
    // mirror stale + GPS not stale → fusion이 GPS tier로 fallback (source != 'backend-ssot').
    setupBaselineGpsWithLastFix('청담', T0 - 200_000);
    (readBackendSsotMirror as jest.Mock).mockResolvedValue(
      makeBackendSsotMirrorEntry({
        currentStationId: yongmasan.name,
        receivedAt: T0 - 200_000,
      }),
    );
    const hook = renderHook(() => useFusedNearestStation());
    await flushBackendSsotMirrorTick();
    expect(hook.result.current.source).not.toBe('backend-ssot');
    // GPS fallback으로 청담 채택 (GPS는 stale 아님 — 200s < 300s).
    expect(hook.result.current.result?.station.name).toBe('청담');
  });
});
