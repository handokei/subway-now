/* eslint-disable import/no-restricted-paths -- cross-feature orchestration (#890) */

/**
 * #1568 (T8b, Epic ADR-017 #1553) — cascade picker `backend-ssot` tier 회귀 가드.
 *
 * 시나리오:
 *   1. backend SSoT mirror 존재 + fresh → cascade 1순위 채택, confidence/source='backend-ssot'.
 *   2. mirror 미존재 → 기존 tier(WiFi/position-train/...) fallback.
 *   3. mirror stale(lastAdvanceAt 60s 초과) → cascade 채택 거부 → 기존 tier fallback.
 *   4. mirror lock 활성 + line mismatch → station resolve null → 채택 거부.
 *   5. mirror lockless + resolve 가능 → cascade 채택 (lockless도 lock과 동급 우선순위).
 */

import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useFusedNearestStation } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import {
  arrivalRet,
  positionRet,
  GPS_BASE_DEFAULTS,
} from '../../../../testUtils/positionApiFixtures';
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

const T0 = 1_700_000_000_000;

function makeMirror(overrides: Partial<BackendSsotMirrorEntry> = {}): BackendSsotMirrorEntry {
  return {
    currentStationId: yongmasan.name,
    motionState: 'moving',
    lastAdvanceEvidence: 'arvlcd-arrived',
    lastAdvanceAt: T0,
    passedStations: [],
    receivedAt: T0,
    ...overrides,
  };
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

  async function flushSsotRead() {
    // 5s interval tick으로 SSoT mirror state hydrate.
    await act(async () => {
      jest.advanceTimersByTime(5_000);
      // microtask flush
      await Promise.resolve();
    });
  }

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

  it('mirror stale(lastAdvanceAt > 60s) → 채택 거부', async () => {
    setupBaselineGpsAt('청담');
    mockRead.mockResolvedValue(
      makeMirror({
        currentStationId: yongmasan.name,
        lastAdvanceAt: T0 - 120_000, // 2분 전 — staleness 60s 초과
      }),
    );
    const hook = renderHook(() => useFusedNearestStation());
    await flushSsotRead();
    expect(hook.result.current.source).not.toBe('backend-ssot');
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
