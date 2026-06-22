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
 * GPS at yongmasan, positionTrain at yongmasan (lockedTrainCode 매칭, 좌표 일치로 fusion gate 통과).
 * positions 미주입 시 positionRet(null) — realtimePosition API outage 시뮬레이션.
 * mirror 미주입 시 makeBackendSsotMirrorEntry({ currentStationId: konkuk.name }) — backend가 다른 station을 가리킴.
 */
function setupMocks(opts?: {
  withPositionTrain?: boolean;
  mirrorEntry?: ReturnType<typeof makeBackendSsotMirrorEntry> | null;
}) {
  const { withPositionTrain = true, mirrorEntry } = opts ?? {};
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
    positionRet(
      withPositionTrain
        ? { line: '7', trains: [train(yongmasan.name, TRAIN_STATUS.ARRIVED, { trainNo: TRAIN_CODE })] }
        : null,
    ),
  );
  mockRead.mockResolvedValue(
    mirrorEntry === undefined
      ? makeBackendSsotMirrorEntry({ currentStationId: konkuk.name })
      : mirrorEntry,
  );
}

/**
 * useFusedNearestStation 호출 — undefined 7개 인자를 매번 적지 않도록 wrapper.
 */
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

describe('#1646 positionTrain cascade priority 승격', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('3-of-3 합의(lock+지하+lockMatch) 시 positionTrain 1순위 — backend mirror 무시', async () => {
    setupMocks();
    const hook = renderFusion({
      lockedTrainCode: TRAIN_CODE,
      boardingLock: lockOn7,
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
    setupMocks({ mirrorEntry: null });
    const hook = renderFusion({
      lockedTrainCode: TRAIN_CODE,
      boardingLock: lockOn7,
      barometer: { subsurface: true },
    });
    await flushBackendSsotMirrorTick();
    await waitFor(() => {
      expect(hook.result.current.source).toBe('boarding-lock');
    });
    expect(hook.result.current.result?.station.id).toBe(yongmasan.id);
  });

  // 본 합의 미충족 케이스 5개 — 모두 결과 동일(backend mirror 1순위 채택). it.each로 중복 제거.
  it.each<[string, Parameters<typeof renderFusion>[0], typeof setupMocks extends (a: infer A) => unknown ? A : never]>([
    [
      'barometer 지상(subsurface=false)',
      { lockedTrainCode: TRAIN_CODE, boardingLock: lockOn7, barometer: { subsurface: false } },
      undefined,
    ],
    [
      'barometer 미전달(subsurface=undefined)',
      { lockedTrainCode: TRAIN_CODE, boardingLock: lockOn7 },
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
        boardingLock: { ...lockOn7, trainCode: 'T-DIFFERENT' },
        barometer: { subsurface: true },
      },
      undefined,
    ],
    [
      'lockedTrainCode null',
      { lockedTrainCode: undefined, boardingLock: lockOn7, barometer: { subsurface: true } },
      undefined,
    ],
    [
      'positionTrain null(realtimePosition API outage)',
      { lockedTrainCode: TRAIN_CODE, boardingLock: lockOn7, barometer: { subsurface: true } },
      { withPositionTrain: false },
    ],
  ])('합의 미충족 — %s → backend mirror 1순위', async (_label, fusionOpts, mocksOpts) => {
    setupMocks(mocksOpts);
    const hook = renderFusion(fusionOpts);
    await flushBackendSsotMirrorTick();
    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
  });
});
