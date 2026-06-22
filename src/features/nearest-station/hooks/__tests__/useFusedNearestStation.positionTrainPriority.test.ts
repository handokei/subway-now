/* eslint-disable import/no-restricted-paths -- cross-feature orchestration (#890) */

/**
 * #1646 — positionTrain cascade priority 승격 회귀 가드.
 *
 * 사용자 trip evidence (2026-06-22 14:28/14:30/14:33): backend SSoT mirror lag(10-30s)로
 * 인해 b역 도착해도 fusion 현재역이 1역 뒤쳐지는 회귀. positionTrain이 실시간 신호인데도
 * cascade 3순위라 backend mirror가 advance될 때까지 채택되지 않음.
 *
 * Fix: 3-of-3 합의(positionTrain + lockMatch + barometer subsurface + boardingLock 활성) 시
 * positionTrain을 backend SSoT mirror보다 1순위로 승격.
 *
 * 시나리오:
 *   1. 3-of-3 합의 충족 → positionTrain 1순위 채택 (backend mirror 무시).
 *   2. 합의 미충족(barometer 지상) → 기존 cascade (backend mirror 1순위).
 *   3. 합의 미충족(lockless trip) → 기존 cascade.
 *   4. 합의 미충족(trainCode mismatch) → 기존 cascade (positionTrain은 position-train tier로 채택).
 *   5. positionTrain null → 기존 cascade (backend mirror 또는 fallback).
 */

import { renderHook, waitFor } from '@testing-library/react-native';
import { useFusedNearestStation } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import { TRAIN_STATUS } from '../../../../shared/constants/trainStatus';
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
const konkuk = findStationByNameAndLine('건대입구', '7')!;

const TRAIN_CODE = 'T-1646';

const lockOn7: BoardingLock = {
  destinationId: konkuk.id,
  trainCode: TRAIN_CODE,
  boardingLine: '7',
  boardingStationId: yongmasan.id,
  boardedAt: T0,
  expectedDurationMs: 10 * 60_000,
};

/**
 * GPS at yongmasan, positionTrain at yongmasan (lockedTrainCode 매칭).
 * backend SSoT mirror는 konkuk를 가리켜(advance lag 시뮬레이션) — cascade priority 충돌 시 누가 채택되는지 검증.
 * GPS-positionTrain 좌표 일치로 fusion distance gate(MAX_FUSION_DISTANCE_KM=0.6km) 통과 보장.
 */
function setupBaseline() {
  const live = { station: yongmasan, distanceKm: 0 };
  mockNearest.mockReturnValue({
    result: live,
    liveResult: live,
    stickyDisplayOnly: null,
    variants: [yongmasan],
    userLocation: { lat: yongmasan.lat, lng: yongmasan.lng },
    ...GPS_BASE_DEFAULTS,
    accuracyMeters: 14,
    refresh: jest.fn(),
  });
  mockFindTop.mockReturnValue([{ station: yongmasan, distanceKm: 0 }]);
  mockArrival.mockReturnValue(arrivalRet(null));
  mockPos.mockReturnValue(
    positionRet({
      line: '7',
      trains: [train(yongmasan.name, TRAIN_STATUS.ARRIVED, { trainNo: TRAIN_CODE })],
    }),
  );
}

describe('#1646 positionTrain cascade priority 승격', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const flushSsotRead = flushBackendSsotMirrorTick;

  it('3-of-3 합의(lock+지하+lockMatch) 시 positionTrain 1순위 — backend mirror 무시', async () => {
    setupBaseline();
    // backend mirror가 다른 station(건대입구)을 가리켜도 무시 — positionTrain 우선.
    mockRead.mockResolvedValue(makeBackendSsotMirrorEntry({ currentStationId: konkuk.name }));

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        TRAIN_CODE,
        lockOn7,
        undefined,
        { subsurface: true },
      ),
    );
    await flushSsotRead();

    await waitFor(() => {
      expect(hook.result.current.source).toBe('boarding-lock');
    });
    expect(hook.result.current.confidence).toBe('boarding-lock');
    expect(hook.result.current.result?.station.id).toBe(yongmasan.id);
  });

  it('barometer 지상(subsurface=false) → 기존 cascade (backend mirror 1순위)', async () => {
    setupBaseline();
    mockRead.mockResolvedValue(makeBackendSsotMirrorEntry({ currentStationId: konkuk.name }));

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        TRAIN_CODE,
        lockOn7,
        undefined,
        { subsurface: false },
      ),
    );
    await flushSsotRead();

    // backend mirror가 1순위 — 건대입구 채택.
    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
    expect(hook.result.current.result?.station.id).toBe(konkuk.id);
  });

  it('barometer 미전달(subsurface=undefined) → 기존 cascade (backend mirror 1순위)', async () => {
    setupBaseline();
    mockRead.mockResolvedValue(makeBackendSsotMirrorEntry({ currentStationId: konkuk.name }));

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        TRAIN_CODE,
        lockOn7,
      ),
    );
    await flushSsotRead();

    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
  });

  it('lockless trip(boardingLock=null) → 기존 cascade (backend mirror 1순위)', async () => {
    setupBaseline();
    mockRead.mockResolvedValue(makeBackendSsotMirrorEntry({ currentStationId: konkuk.name }));

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        TRAIN_CODE,
        null,
        undefined,
        { subsurface: true },
      ),
    );
    await flushSsotRead();

    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
  });

  it('trainCode mismatch(lockedTrainCode != trainProgress.trainNo) → 기존 cascade', async () => {
    setupBaseline();
    mockRead.mockResolvedValue(makeBackendSsotMirrorEntry({ currentStationId: konkuk.name }));

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        'T-DIFFERENT', // lockedTrainCode mismatches positionTrain.trainNo
        { ...lockOn7, trainCode: 'T-DIFFERENT' },
        undefined,
        { subsurface: true },
      ),
    );
    await flushSsotRead();

    // 3-of-3 합의 미충족 (lockMatch=false) → backend mirror 1순위.
    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
  });

  it('positionTrain null(realtimePosition API outage) → 기존 cascade (backend mirror 1순위)', async () => {
    // GPS at yongmasan, positionTrain 미존재 (positions=null).
    const live = { station: yongmasan, distanceKm: 0 };
    mockNearest.mockReturnValue({
      result: live,
      liveResult: live,
      stickyDisplayOnly: null,
      variants: [yongmasan],
      userLocation: { lat: yongmasan.lat, lng: yongmasan.lng },
      ...GPS_BASE_DEFAULTS,
      accuracyMeters: 14,
      refresh: jest.fn(),
    });
    mockFindTop.mockReturnValue([{ station: yongmasan, distanceKm: 0 }]);
    mockArrival.mockReturnValue(arrivalRet(null));
    mockPos.mockReturnValue(positionRet(null));
    mockRead.mockResolvedValue(makeBackendSsotMirrorEntry({ currentStationId: konkuk.name }));

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        TRAIN_CODE,
        lockOn7,
        undefined,
        { subsurface: true },
      ),
    );
    await flushSsotRead();

    // positionTrainResult=null → 3-of-3 합의 미충족 → backend mirror 1순위.
    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
  });

  it('lockedTrainCode null → 기존 cascade (lockMatch=false)', async () => {
    setupBaseline();
    mockRead.mockResolvedValue(makeBackendSsotMirrorEntry({ currentStationId: konkuk.name }));

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        undefined, // lockedTrainCode null
        lockOn7,
        undefined,
        { subsurface: true },
      ),
    );
    await flushSsotRead();

    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
  });

  it('3-of-3 합의 충족 + backend mirror null → positionTrain 1순위 (fallback 충돌 없음)', async () => {
    setupBaseline();
    mockRead.mockResolvedValue(null); // backend mirror 없음

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        TRAIN_CODE,
        lockOn7,
        undefined,
        { subsurface: true },
      ),
    );
    await flushSsotRead();

    await waitFor(() => {
      expect(hook.result.current.source).toBe('boarding-lock');
    });
    expect(hook.result.current.result?.station.id).toBe(yongmasan.id);
  });
});
