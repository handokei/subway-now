/* eslint-disable import/no-restricted-paths -- cross-feature orchestration (#890) */

/**
 * #1668 — arvlCd=1(ARRIVED) + lock.trainCode 매칭 즉시 SSoT 채택 cascade tier 회귀 가드.
 *
 * 시나리오:
 *   1. lock 활성 + ARRIVED + trainCode 매칭 + 신선 → cascade 1순위 (positionTrain 1순위 뒤, backend-ssot 앞).
 *   2. arvlCd=0 (ENTERING) → 채택 거부 (ARRIVED만 허용).
 *   3. trainCode mismatch → 채택 거부.
 *   4. stale (age > 35s) → 채택 거부.
 *   5. receivedAtMs === 0 (mock/schedule fallback) → 채택 거부.
 *   6. lockless trip (boardingLock=null) → 채택 거부 → 기존 cascade.
 *   7. backend-ssot fresh + ARRIVED match → arvlCdArrivedMatch 1순위 (backend-ssot 양보).
 */

import { renderHook, waitFor } from '@testing-library/react-native';
import { useFusedNearestStation } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { findStationByNameAndLine } from '../../../../shared/utils/stationLookup';
import { ARRIVAL_CODE } from '../../../../shared/constants/arrivalCodes';
import {
  arrivalRet,
  positionRet,
  GPS_BASE_DEFAULTS,
} from '../../../../testUtils/positionApiFixtures';
import {
  BACKEND_SSOT_FIXTURE_T0 as T0,
  flushBackendSsotMirrorTick,
  makeBackendSsotMirrorEntry,
} from '../../../../testUtils/backendSsotMirrorFixtures';
import { makeArrivalInfo } from '../../../../testUtils/fixtures';
import { readBackendSsotMirror } from '../../../alarm/utils/backendSsotMirror';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import type { StationArrival } from '../../../../shared/types/arrival';

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

const LOCK_TRAIN_CODE = 'T-1668';

const lockOn7: BoardingLock = {
  destinationId: 'dest-7',
  trainCode: LOCK_TRAIN_CODE,
  boardingLine: '7',
  boardingStationId: yongmasan.id,
  boardedAt: T0,
  expectedDurationMs: 10 * 60_000,
};

/**
 * GPS + candidates를 yongmasan(7호선)으로 세팅.
 * arrival은 makeFreshArrived()로 주입 가능.
 */
function setupBaselineAt(
  stationName: string,
  line: '7',
  arrival: StationArrival | null = null,
) {
  const stn = findStationByNameAndLine(stationName, line)!;
  const live = { station: stn, distanceKm: 0 };
  mockNearest.mockReturnValue({
    result: live,
    liveResult: live,
    stickyDisplayOnly: null,
    variants: [stn],
    userLocation: { lat: stn.lat, lng: stn.lng },
    ...GPS_BASE_DEFAULTS,
    accuracyMeters: 50,
    lastFixAtMs: T0,
    refresh: jest.fn(),
  });
  mockFindTop.mockReturnValue([{ station: stn, distanceKm: 0 }]);
  mockArrival.mockImplementation((sName: string | null, sLine: string | null) => {
    if (sName === stn.name && sLine === line && arrival !== null) {
      return arrivalRet(arrival);
    }
    return arrivalRet(null);
  });
  mockPos.mockReturnValue(positionRet(null));
}

/** ARRIVED(arvlCd=1) + lock trainCode + fresh receivedAtMs */
function makeFreshArrivedArrival(trainCode: string, receivedAtMs: number): StationArrival {
  return {
    up: [
      makeArrivalInfo({
        destination: '장암',
        arrivalSeconds: 0,
        arrivalCode: ARRIVAL_CODE.ARRIVED,
        trainCode,
        line: '7',
        receivedAtMs,
      }),
    ],
    down: [],
  };
}

describe('#1668 arvlCdArrivedMatch cascade tier', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    mockRead.mockResolvedValue(null);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('lock + ARRIVED + trainCode 매칭 + 신선 → boarding-lock 1순위', () => {
    // backend mirror null → arvlCdArrivedMatch가 1순위가 돼야 함
    const arrival = makeFreshArrivedArrival(LOCK_TRAIN_CODE, T0);
    setupBaselineAt('용마산', '7', arrival);
    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        LOCK_TRAIN_CODE,
        lockOn7,
      ),
    );
    expect(hook.result.current.source).toBe('boarding-lock');
    expect(hook.result.current.confidence).toBe('boarding-lock');
    expect(hook.result.current.result?.station.id).toBe(yongmasan.id);
  });

  it('ARRIVED + trainCode 매칭 + 신선 → backend-ssot 보다 1순위', async () => {
    // backend mirror가 다른 역(건대입구)을 가리켜도 arvlCdArrivedMatch가 우선
    const arrival = makeFreshArrivedArrival(LOCK_TRAIN_CODE, T0);
    setupBaselineAt('용마산', '7', arrival);
    mockRead.mockResolvedValue(
      makeBackendSsotMirrorEntry({ currentStationId: konkuk.name }),
    );
    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        LOCK_TRAIN_CODE,
        lockOn7,
      ),
    );
    await flushBackendSsotMirrorTick();
    await waitFor(() => {
      // backend-ssot가 아닌 boarding-lock이어야 함
      expect(hook.result.current.confidence).toBe('boarding-lock');
    });
    expect(hook.result.current.result?.station.id).toBe(yongmasan.id);
    expect(hook.result.current.source).not.toBe('backend-ssot');
  });

  it('arvlCd=0 (ENTERING) → 채택 거부 → 기존 cascade (not boarding-lock)', () => {
    const enteringArrival: StationArrival = {
      up: [
        makeArrivalInfo({
          destination: '장암',
          arrivalSeconds: 0,
          arrivalCode: ARRIVAL_CODE.ENTERING,
          trainCode: LOCK_TRAIN_CODE,
          line: '7',
          receivedAtMs: T0,
        }),
      ],
      down: [],
    };
    setupBaselineAt('용마산', '7', enteringArrival);
    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        LOCK_TRAIN_CODE,
        lockOn7,
      ),
    );
    // ENTERING은 거부 → arvlCdArrivedMatch null → 기존 cascade (fused arrival-arriving)
    // boarding-lock은 arvlCdArrivedMatch 전용 — 미채택 확인
    expect(hook.result.current.confidence).not.toBe('boarding-lock');
    expect(hook.result.current.source).not.toBe('boarding-lock');
  });

  it('trainCode mismatch → 채택 거부 → 기존 cascade (not boarding-lock)', () => {
    // ARRIVED이지만 trainCode가 다른 열차
    const mismatchArrival = makeFreshArrivedArrival('T-OTHER', T0);
    setupBaselineAt('용마산', '7', mismatchArrival);
    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        LOCK_TRAIN_CODE,
        lockOn7,
      ),
    );
    // trainCode 불일치 → arvlCdArrivedMatch 거부 → 기존 cascade
    expect(hook.result.current.confidence).not.toBe('boarding-lock');
    expect(hook.result.current.source).not.toBe('boarding-lock');
  });

  it('stale (age > 35s) → 채택 거부 → 기존 cascade (not boarding-lock)', () => {
    // T0 기준 시스템 시간이지만, receivedAtMs가 36s 전 — ARVL_CD_ARRIVED_MAX_AGE_MS(35s) 초과
    const staleReceivedAt = T0 - 36_000;
    const staleArrival = makeFreshArrivedArrival(LOCK_TRAIN_CODE, staleReceivedAt);
    setupBaselineAt('용마산', '7', staleArrival);
    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        LOCK_TRAIN_CODE,
        lockOn7,
      ),
    );
    expect(hook.result.current.confidence).not.toBe('boarding-lock');
    expect(hook.result.current.source).not.toBe('boarding-lock');
  });

  it('receivedAtMs === 0 (mock/schedule API) → 채택 거부 → 기존 cascade', () => {
    // receivedAtMs === 0: mock/schedule fallback — 신선도 판정 불가 → 거부
    const mockArrivalData: StationArrival = {
      up: [
        makeArrivalInfo({
          destination: '장암',
          arrivalSeconds: 0,
          arrivalCode: ARRIVAL_CODE.ARRIVED,
          trainCode: LOCK_TRAIN_CODE,
          line: '7',
          receivedAtMs: 0,
        }),
      ],
      down: [],
    };
    setupBaselineAt('용마산', '7', mockArrivalData);
    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        LOCK_TRAIN_CODE,
        lockOn7,
      ),
    );
    // receivedAtMs=0 → 신선도 판정 불가 → 거부
    expect(hook.result.current.confidence).not.toBe('boarding-lock');
    expect(hook.result.current.source).not.toBe('boarding-lock');
  });

  it('lockless trip (boardingLock=null) → 채택 거부 → 기존 cascade', () => {
    const arrival = makeFreshArrivedArrival(LOCK_TRAIN_CODE, T0);
    setupBaselineAt('용마산', '7', arrival);
    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        LOCK_TRAIN_CODE,
        null, // boardingLock=null
      ),
    );
    // lockless → arvlCdArrivedMatch 미진입 (boardingLock 없음)
    // fused 경로로 arrival-confirmed가 올 수 있음 — boarding-lock 아님 확인
    expect(hook.result.current.source).not.toBe('boarding-lock');
    expect(hook.result.current.confidence).not.toBe('boarding-lock');
  });

  it('lockedTrainCode null → 채택 거부 → 기존 cascade', () => {
    const arrival = makeFreshArrivedArrival(LOCK_TRAIN_CODE, T0);
    setupBaselineAt('용마산', '7', arrival);
    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        null, // lockedTrainCode=null
        lockOn7,
      ),
    );
    // lockedTrainCode null → arvlCdArrivedMatch 미진입
    expect(hook.result.current.source).not.toBe('boarding-lock');
    expect(hook.result.current.confidence).not.toBe('boarding-lock');
  });

  it('arrival 없음 (null) → 채택 거부 → GPS fallback', () => {
    // arrival=null: arrival API unavailable → no rows to check → GPS fallback
    setupBaselineAt('용마산', '7', null);
    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        LOCK_TRAIN_CODE,
        lockOn7,
      ),
    );
    expect(hook.result.current.source).toBe('gps');
  });

  it('down 방향 ARRIVED row에서도 매칭 가능', () => {
    // down 방향 arrival row에서 ARRIVED + trainCode 매칭
    const downArrival: StationArrival = {
      up: [],
      down: [
        makeArrivalInfo({
          destination: '부천종합운동장',
          arrivalSeconds: 0,
          arrivalCode: ARRIVAL_CODE.ARRIVED,
          trainCode: LOCK_TRAIN_CODE,
          line: '7',
          receivedAtMs: T0,
        }),
      ],
    };
    setupBaselineAt('용마산', '7', downArrival);
    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        LOCK_TRAIN_CODE,
        lockOn7,
      ),
    );
    expect(hook.result.current.source).toBe('boarding-lock');
    expect(hook.result.current.confidence).toBe('boarding-lock');
    expect(hook.result.current.result?.station.id).toBe(yongmasan.id);
  });
});
