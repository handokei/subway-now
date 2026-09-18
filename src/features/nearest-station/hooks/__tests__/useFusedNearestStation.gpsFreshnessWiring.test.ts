/* eslint-disable import/no-restricted-paths -- cross-feature orchestration (#890) */

/**
 * #2713 (ADR-039 1단계) — 결정 tier GPS 좌표 소비 지점 fix 신선도 게이트 회귀 방지.
 *
 * 실측 evidence(2026-09-18 라이드): GPS fix가 17:40:13(건대입구)에 얼어붙어 7분+ 갱신되지
 * 않았다. 그 상태에서 잠긴 열차(trainCode=7256)가 실제로 중곡에 도달했는데도, 얼어붙은
 * GPS(건대입구)-중곡 거리(≈3.03km)가 distance sanity gate(#444/#1616)를 통과하지 못해
 * 실측 신호가 거부됐다. 본 파일은 그 정확한 상황(건대입구↔중곡, ≈3.03km)을 재현한다.
 *
 * - stale(fix age ≥ 15s, GPS_QUALITY_GATE_MAX_AGE_MS): 거리 sanity를 건너뛰고 실측 신호를 채택.
 * - fresh(fix age < 15s): #444가 막던 "엉뚱한 역 채택"이 여전히 막히는 회귀 테스트.
 */
import { renderHook } from '@testing-library/react-native';
import { useFusedNearestStation } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import { TRAIN_STATUS } from '../../../../shared/constants/trainStatus';
import { GPS_QUALITY_GATE_MAX_AGE_MS } from '../../../../shared/constants/gpsQualityGate';
import { getCandidateRejectEntries, clearCandidateRejectEntries } from '../../utils/candidateRejectBuffer';
import {
  arrivalRet,
  positionRet,
  makeTrain as train,
  GPS_BASE_DEFAULTS,
} from '../../../../testUtils/positionApiFixtures';
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

jest.mock('../../utils/findNearestStation', () => ({
  findTopNearestStations: jest.fn(),
}));
jest.mock('../useNearestStation');
jest.mock('../../../arrival/hooks/useArrivalInfo');
jest.mock('../../../route/hooks/useTrainPositions');
jest.mock('../useAccelerometerFingerprint', () => ({
  useAccelerometerFingerprint: jest.fn(() => 'automotive'),
}));
jest.mock('../useCellularTech', () => ({
  useCellularTech: jest.fn(() => 'surface'),
}));
jest.mock('../../../alarm/utils/tripStartStorage', () => ({
  getTripStartedAt: jest.fn().mockResolvedValue(null),
}));

const mockNearest = useNearestStation as jest.Mock;
const mockArrival = useArrivalInfo as jest.Mock;
const mockPos = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;

// 실측 evidence 역: 7호선 건대입구(탑승, GPS 동결 지점) ↔ 중곡(실제 열차 위치, ≈3.03km).
const konkuk = findStationByNameAndLine('건대입구', '7')!;
const junggok = findStationByNameAndLine('중곡', '7')!;
const yongmasan = findStationByNameAndLine('용마산', '7')!;

const NOW = 1_700_000_000_000;
const TRAIN_CODE = '7256';

function gpsBase(overrides?: Record<string, unknown>) {
  return {
    result: { station: konkuk, distanceKm: 0 },
    variants: [konkuk],
    userLocation: { lat: konkuk.lat, lng: konkuk.lng },
    ...GPS_BASE_DEFAULTS,
    // 실측 evidence: accuracy=74m — "정상"처럼 보이는 값. 문제는 accuracy가 아니라 age.
    accuracyMeters: 74,
    refresh: jest.fn(),
    ...overrides,
  };
}

function makeLock(overrides?: Partial<BoardingLock>): BoardingLock {
  return {
    destinationId: yongmasan.id,
    trainCode: TRAIN_CODE,
    boardingStationId: konkuk.id,
    boardingLine: '7',
    boardedAt: NOW,
    expectedDurationMs: 600_000,
    ...overrides,
  };
}

const routeContext = {
  route: makeDirectRoute(4, '7'),
  origin: konkuk,
  destination: yongmasan,
};

type SetupOpts = {
  fixAgeMs: number;
  lock?: BoardingLock;
};

function setup({ fixAgeMs, lock = makeLock() }: SetupOpts) {
  mockNearest.mockReturnValue(
    gpsBase({ lastFixAtMs: NOW - fixAgeMs }),
  );
  mockFindTop.mockReturnValue([{ station: konkuk, distanceKm: 0 }]);
  mockPos.mockReturnValue(
    positionRet({
      line: '7',
      trains: [train(junggok.name, TRAIN_STATUS.ARRIVED, { trainNo: TRAIN_CODE })],
    }),
  );
  return renderHook(() =>
    useFusedNearestStation(undefined, undefined, routeContext, TRAIN_CODE, lock),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  mockArrival.mockReturnValue(arrivalRet(null));
  mockPos.mockReturnValue(positionRet(null));
  clearCandidateRejectEntries();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('#2713 (ADR-039 1단계) GPS 신선도 게이트 배선', () => {
  it('stale fix(age ≥ 15s) — 얼어붙은 GPS(건대입구)-실측 열차(중곡) 거리(≈3.03km)로 실측 신호를 거부하지 않는다', () => {
    const { result } = setup({ fixAgeMs: GPS_QUALITY_GATE_MAX_AGE_MS + 5_000 });

    // 거리 sanity가 건너뛰어져 실측 position-train 신호(잠긴 열차와 일치)가 채택된다.
    expect(result.current.source).toBe('boarding-lock');
    expect(result.current.result?.station.id).toBe(junggok.id);
  });

  it('fresh fix(age < 15s) — 회귀 방지: #444가 막던 거리 sanity가 여전히 동작해 같은 조건에서 거부된다', () => {
    const { result } = setup({ fixAgeMs: GPS_QUALITY_GATE_MAX_AGE_MS - 5_000 });

    // fresh GPS는 그대로 거리 계산에 쓰여 3.03km > MAX_FUSION_DISTANCE_KM(0.6km) → 거부.
    expect(result.current.source).not.toBe('position-train');
    expect(result.current.source).not.toBe('boarding-lock');
  });

  it('stale fix에서 candidateRejectBuffer에 gps-stale 배제 카운터가 기록된다 (요구사항 4 계측)', () => {
    setup({ fixAgeMs: GPS_QUALITY_GATE_MAX_AGE_MS + 5_000 });

    const entries = getCandidateRejectEntries();
    expect(entries.some((e) => e.reason === 'gps-stale')).toBe(true);
  });

  it('fresh fix에서는 gps-stale 배제 카운터가 기록되지 않는다', () => {
    setup({ fixAgeMs: GPS_QUALITY_GATE_MAX_AGE_MS - 5_000 });

    const entries = getCandidateRejectEntries();
    expect(entries.some((e) => e.reason === 'gps-stale')).toBe(false);
  });

  it('lastFixAtMs 미제공(테스트 mock 등 판단 불가) — 신선한 것으로 취급해 기존 거리 sanity 동작 보존', () => {
    // gps.lastFixAtMs가 number가 아니면 "판단 불가 시 stale로 단정하지 않는다" 원칙에 따라
    // decisionUserLocation=gps.userLocation 그대로 — 기존(이슈 이전) 동작과 동일해야 한다.
    mockNearest.mockReturnValue(gpsBase({ lastFixAtMs: null }));
    mockFindTop.mockReturnValue([{ station: konkuk, distanceKm: 0 }]);
    mockPos.mockReturnValue(
      positionRet({
        line: '7',
        trains: [train(junggok.name, TRAIN_STATUS.ARRIVED, { trainNo: TRAIN_CODE })],
      }),
    );
    const { result } = renderHook(() =>
      useFusedNearestStation(undefined, undefined, routeContext, TRAIN_CODE, makeLock()),
    );

    expect(result.current.source).not.toBe('position-train');
    expect(result.current.source).not.toBe('boarding-lock');
  });

  it('stale + candidates 없음(라인 필터 등으로 GPS-nearest 후보 자체가 없음) — gps-stale 카운터 태그할 line이 없어 push 생략', () => {
    mockNearest.mockReturnValue(gpsBase({ lastFixAtMs: NOW - (GPS_QUALITY_GATE_MAX_AGE_MS + 5_000) }));
    // candidates 배열이 비어있는 상황 — gps-stale 카운터가 태그할 line이 없다.
    mockFindTop.mockReturnValue([]);
    mockPos.mockReturnValue(
      positionRet({
        line: '7',
        trains: [train(junggok.name, TRAIN_STATUS.ARRIVED, { trainNo: TRAIN_CODE })],
      }),
    );
    renderHook(() =>
      useFusedNearestStation(undefined, undefined, routeContext, TRAIN_CODE, makeLock()),
    );

    const entries = getCandidateRejectEntries();
    expect(entries.some((e) => e.reason === 'gps-stale')).toBe(false);
  });

  it('stale + positionTrainResult가 게이트를 우회해 채택 — lockGpsDriftMeters가 decisionUserLocation=null로 drift 계산을 건너뛴다(lock 유지)', () => {
    // #2713이 없었다면 이 시나리오 자체가 positionTrainResult 자체의 distance gate(0.6km)에
    // 막혀 도달 불가능했다 — 이제 stale bypass로 positionTrainBoardingLockMatch까지 도달하고,
    // lockGpsDriftMeters도 같은 decisionUserLocation을 참조해 drift를 "계산 불가"로 처리한다.
    mockNearest.mockReturnValue(
      gpsBase({ lastFixAtMs: NOW - (GPS_QUALITY_GATE_MAX_AGE_MS + 5_000) }),
    );
    mockFindTop.mockReturnValue([{ station: konkuk, distanceKm: 0 }]);
    mockPos.mockReturnValue(
      positionRet({
        line: '7',
        trains: [train(junggok.name, TRAIN_STATUS.ARRIVED, { trainNo: TRAIN_CODE })],
      }),
    );

    const { result } = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        routeContext,
        TRAIN_CODE,
        makeLock(),
        undefined,
        { subsurface: true }, // cascadeEnvironment='underground' → positionTrainBoardingLockMatch 활성화 조건.
      ),
    );

    // drift 계산 불가(decisionUserLocation=null) → gate 통과 → lock 유지.
    expect(result.current.source).toBe('boarding-lock');
    expect(result.current.result?.station.id).toBe(junggok.id);
  });
});
