/* eslint-disable import/no-restricted-paths --
 * Cross-feature wire replay: 이 파일은 #2726(ADR-039 close 조건 2·3)의 실 배선 그대로 —
 * useFusedNearestStation(nearest-station)의 실 출력(`source`)을 useStationAlarm(alarm)의
 * `fusionSource` 입력으로 그대로 흘려보내는 HomeScreen.tsx 배선(src/screens/HomeScreen.tsx:740~748)을
 * 그대로 재현한다. 두 features를 직접 조합하는 것이 본질적 목적이라 file-level disable로 옵트인
 * (ADR Phase 5 orchestration 컨벤션, useFusedNearestStation.ts/useStationAlarm.ts 본체와 동일 근거).
 */

/**
 * #2726/#2728 (ADR-039 close 조건 2·3, 2026-09-18 용마산 목적지 통과 라이드 device 층 재생).
 *
 * 배경: #2718(PR #2719, 머지됨)이 이 라이드를 backend 재생 fixture로 고정했으나, 조건 2
 * (`reject:candidate-distance`)·3(`gate-phase-accuracy`/`gate-phase-time-integration`)은
 * frontend 개념(`useFusedNearestStation.ts`/`useStationAlarm.ts`)이라 backend 재생으로는
 * 구조적으로 도달 불가했다. #2713(PR #2714, 머지됨)이 조건 2를 GPS 신선도 게이트 배선으로
 * 고쳤고 전용 테스트(`useFusedNearestStation.gpsFreshnessWiring.test.ts`)를 남겼다. 조건 3은
 * 이 라이드 숫자를 관통하는 end-to-end 테스트가 없었다 — 본 파일이 그 갭을 메운다.
 *
 * 두 개의 실측 관측 창(dump `ed3e62ef-918-2.txt`)을 각각 재생한다 — fixtures/replay_20260918_
 * yongmasan_overshoot.ts 헤더 주석 참고:
 *  - "강 source 창"(17:40:31~17:46:37, src=boarding-lock/position/position-train) — 실 체인
 *    (useFusedNearestStation → useStationAlarm)으로 fusionSource를 도출해 그대로 넘긴다. #2713
 *    이전 코드로는 stale GPS(fix=17:40:13, 건대입구-중곡 3.03km)가 distance sanity에 걸려
 *    position-train 후보가 reject되고 fusionSource가 약(gps)으로 떨어져 gate-phase-time-integration이
 *    억제한다(RED) — #2713 이후엔 stale bypass로 boarding-lock이 채택돼 억제되지 않는다(GREEN).
 *  - "약 source 창"(17:46:57~17:53:41, src=gps conf=gps-only) — 덤프가 실제로 관측한
 *    fusionSource=gps를 그대로 useStationAlarm에 주입한다(재도출 아님 — position-train 후보가
 *    이 창에서 왜 사라졌는지는 미공급 입력, README/PR 본문 §미공급 입력 표 참고). 실측 라이드는
 *    이 창에서도 열차 7256에 대한 lock이 계속 활성이었다(강 source 창 진입 전 boarding, 20분
 *    expectedDurationMs) — #2728(ADR-039 §5 4단계) 이전에는 lock 활성 여부와 무관하게
 *    gate-phase-time-integration이 억제했다(FAIL). 4단계 이후에는 lock 활성 trip에서 이 게이트가
 *    fusionSource 약(estimator/GPS)만으로는 더 이상 발사를 막지 않는다 — D 매트릭스상 GPS/estimator에
 *    발사 거부 권한이 없고, 3단계(#2730)가 ETA를 Seoul 피드로 단일화해 게이트의 전제가 사라졌기
 *    때문이다(PASS). lockless(사용자 명시 의향 없음)는 여전히 억제된다 — 아래 회귀 테스트 참고.
 */
import { renderHook, waitFor } from '@testing-library/react-native';
import { findStationByNameAndLine } from '../../../shared/utils/stationRoute';
import { makeDirectRoute } from '../../../testUtils/routeFixtures';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { FusionSource } from '../../../shared/types/fusion';
import {
  TRAIN_CODE_7256,
  FROZEN_GPS_ACCURACY_M,
  FROZEN_GPS_FIX,
  STRONG_SOURCE_WINDOW_LABEL,
  WEAK_SOURCE_WINDOW_LABEL,
} from './fixtures/replay_20260918_yongmasan_overshoot';
import {
  arrivalRet,
  positionRet,
  makeTrain as train,
  GPS_BASE_DEFAULTS,
} from '../../../testUtils/positionApiFixtures';
import { TRAIN_STATUS } from '../../../shared/constants/trainStatus';
import { GPS_QUALITY_GATE_MAX_AGE_MS } from '../../../shared/constants/gpsQualityGate';

// ==========================================================================
// useFusedNearestStation 의존성 mock — useFusedNearestStation.gpsFreshnessWiring.test.ts와
// 동일 패턴(신규 하네스 아님, 기존 인프라 재사용).
// ==========================================================================
jest.mock('../../nearest-station/utils/findNearestStation', () => ({
  findTopNearestStations: jest.fn(),
}));
jest.mock('../../nearest-station/hooks/useNearestStation');
jest.mock('../../arrival/hooks/useArrivalInfo');
jest.mock('../../route/hooks/useTrainPositions');
jest.mock('../../nearest-station/hooks/useAccelerometerFingerprint', () => ({
  useAccelerometerFingerprint: jest.fn(() => 'automotive'),
}));
jest.mock('../../nearest-station/hooks/useCellularTech', () => ({
  useCellularTech: jest.fn(() => 'surface'),
}));

// ==========================================================================
// useStationAlarm 의존성 mock — leaf 인프라 경계만(useStationAlarm.test.ts와 동일 원칙).
// tripStartStorage는 두 훅이 공유(#1893 RC-17) — 한 번만 mock.
// ==========================================================================
const mockGetTripStartedAt = jest.fn().mockResolvedValue(null);
jest.mock('../utils/tripStartStorage', () => ({
  getTripStartedAt: () => mockGetTripStartedAt(),
}));

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockFireFgAuxStationPassedNotification = jest.fn().mockResolvedValue(undefined);
const mockFireLocalAlarmNotification = jest.fn().mockResolvedValue(undefined);
jest.mock('../utils/stationNotification', () => ({
  fireFgAuxStationPassedNotification: (...args: unknown[]) =>
    mockFireFgAuxStationPassedNotification(...args),
  fireLocalAlarmNotification: (...args: unknown[]) => mockFireLocalAlarmNotification(...args),
}));

const mockMarkLocalStationFired = jest.fn().mockResolvedValue(undefined);
jest.mock('../utils/recentLocalStationFires', () => ({
  markLocalStationFired: (...args: unknown[]) => mockMarkLocalStationFired(...args),
}));

const mockGetLastNotifiedStationId = jest.fn().mockResolvedValue(null);
const mockSetLastNotifiedStationId = jest.fn().mockResolvedValue(undefined);
const mockGetFiredAlarms = jest.fn().mockResolvedValue(new Set<string>());
const mockSetFiredAlarms = jest.fn().mockResolvedValue(undefined);
jest.mock('../utils/notificationState', () => ({
  getLastNotifiedStationId: (...args: unknown[]) => mockGetLastNotifiedStationId(...args),
  setLastNotifiedStationId: (...args: unknown[]) => mockSetLastNotifiedStationId(...args),
  getFiredAlarms: (...args: unknown[]) => mockGetFiredAlarms(...args),
  setFiredAlarms: (...args: unknown[]) => mockSetFiredAlarms(...args),
}));

const mockAwaitInitialScheduledAlarmDrain = jest.fn().mockResolvedValue(undefined);
jest.mock('../utils/scheduledAlarmReceiver', () => ({
  awaitInitialScheduledAlarmDrain: () => mockAwaitInitialScheduledAlarmDrain(),
}));

const mockIsImminentByArrivalCode = jest.fn().mockReturnValue(false);
jest.mock('../../arrival/utils/imminentArrivalSignal', () => ({
  isImminentByArrivalCode: (...args: unknown[]) => mockIsImminentByArrivalCode(...args),
}));

const mockFindFgArvlCdFireSignal = jest.fn().mockReturnValue(null);
jest.mock('../utils/fgArvlCdFastPath', () => ({
  findFgArvlCdFireSignal: (...args: unknown[]) => mockFindFgArvlCdFireSignal(...args),
}));

const mockGetStoredTripTrainCode = jest.fn().mockResolvedValue(null);
jest.mock('../../route/utils/tripTrainCode', () => ({
  getStoredTripTrainCode: (...args: unknown[]) => mockGetStoredTripTrainCode(...args),
}));

// 실제 조건 3(destination phase gate) 앞단에서 evaluate 자체를 관찰하고 싶을 뿐 실 evaluator
// 결과 내용은 관심사가 아니므로 항상 null(발사 없음) — gate 통과/차단 여부만 assert 대상.
const mockEvaluateAlarmPhase = jest.fn().mockReturnValue(null);
jest.mock('../utils/stationAlarm', () => {
  const actual = jest.requireActual('../utils/stationAlarm');
  return {
    ...actual,
    evaluateAlarmPhase: (...args: unknown[]) => mockEvaluateAlarmPhase(...args),
  };
});

const mockResolveAlarmDirection = jest.fn().mockReturnValue(undefined);
jest.mock('../utils/alarmDirection', () => ({
  resolveAlarmDirection: (...args: unknown[]) => mockResolveAlarmDirection(...args),
}));

const mockResolveNextTarget = jest.fn().mockReturnValue(null);
jest.mock('../utils/stationPipeline', () => ({
  resolveNextTarget: (...args: unknown[]) => mockResolveNextTarget(...args),
}));

const mockEvaluateSsotFireGate = jest
  .fn()
  .mockResolvedValue({ blocked: false, reason: 'mirror-missing' });
jest.mock('../utils/ssotFireGate', () => ({
  evaluateSsotFireGate: (input: unknown) => mockEvaluateSsotFireGate(input),
}));

let currentLock: BoardingLock | null = null;
const mockGetBoardingLock = jest.fn(() => Promise.resolve(currentLock));
jest.mock('../utils/boardingLockStorage', () => ({
  getBoardingLock: () => mockGetBoardingLock(),
}));

// 본 파일의 관심사는 gate-phase-* 억제 여부 관측뿐 — alarmLog 실 모듈을 그대로 쓰되
// logSuppressedPhaseGate만 spy로 감싼다. useFusedNearestStation.ts도 같은 모듈의 다른 export
// (logFusionPickerTier 등)를 참조하므로 전체 stub 대신 requireActual + 선택적 override가 안전하다.
const mockLogSuppressedPhaseGate = jest.fn();
jest.mock('../utils/alarmLog', () => {
  const actual = jest.requireActual('../utils/alarmLog');
  return {
    ...actual,
    logFiredAlarm: jest.fn(),
    logFiredAlarmsHydrate: jest.fn(),
    logFiredStationPassed: jest.fn(),
    logFiredAlarmsTripBoundaryReset: jest.fn(),
    logHydrationTransition: jest.fn(),
    logRefMismatch: jest.fn(),
    logSuppressedChannelAgnosticDedup: jest.fn(),
    logSuppressedCrossCategoryDedup: jest.fn(),
    logSuppressedCrossCategoryRecent: jest.fn(),
    logSuppressedFireAlarmOnce: jest.fn(),
    logSuppressedPhaseToPhaseDedup: jest.fn(),
    logSuppressedDedupAlarm: jest.fn(),
    logSuppressedDedupStation: jest.fn(),
    logSuppressedDismissSilence: jest.fn(),
    logSuppressedHopWindow: jest.fn(),
    logSuppressedHopWindowNoSource: jest.fn(),
    logSuppressedPassedEventOnLockOrigin: jest.fn(),
    logSuppressedMovement: jest.fn(),
    logSuppressedPhaseGate: (...args: unknown[]) => mockLogSuppressedPhaseGate(...args),
    logSuppressedSleepFirstTransfer: jest.fn(),
    logSuppressedSsotFireGate: jest.fn(),
    logSuppressedStationPassedWarmup: jest.fn(),
    logSuppressedLocklessNoUserIntent: jest.fn(),
    logSuppressedNotDeparted: jest.fn(),
  };
});

// ==========================================================================
// Import (mock 이후) — 실체인 그대로.
// ==========================================================================
import { useFusedNearestStation } from '../../nearest-station/hooks/useFusedNearestStation';
import { useNearestStation } from '../../nearest-station/hooks/useNearestStation';
import { useArrivalInfo } from '../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../../nearest-station/utils/findNearestStation';
import { useStationAlarm } from '../hooks/useStationAlarm';

const mockNearest = useNearestStation as jest.Mock;
const mockArrival = useArrivalInfo as jest.Mock;
const mockPos = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;

// 실측 evidence 역 — stations.json SSOT 조회(좌표를 지어내지 않는다, CLAUDE.md 정직 제약).
const konkuk = findStationByNameAndLine('건대입구', '7')!;
const junggok = findStationByNameAndLine('중곡', '7')!;
const yongmasan = findStationByNameAndLine('용마산', '7')!;

const NOW = 1_789_721_000_000; // 2026-09-18 17:43:20 KST 부근(강 source 창 내부) 고정.

function makeLock(): BoardingLock {
  return {
    destinationId: yongmasan.id,
    trainCode: TRAIN_CODE_7256,
    boardingStationId: konkuk.id,
    boardingLine: '7',
    boardedAt: NOW - 3 * 60 * 1000,
    expectedDurationMs: 20 * 60 * 1000,
  };
}

const routeContext = {
  route: makeDirectRoute(4, '7'),
  origin: konkuk,
  destination: yongmasan,
};

/** 강 source 창 재현 — stale GPS(건대입구 고착) + 실측 열차(7256) 중곡 도착. */
function renderStrongSourceWindow() {
  mockNearest.mockReturnValue({
    result: { station: konkuk, distanceKm: 0 },
    variants: [konkuk],
    userLocation: FROZEN_GPS_FIX,
    ...GPS_BASE_DEFAULTS,
    accuracyMeters: FROZEN_GPS_ACCURACY_M,
    lastFixAtMs: NOW - (GPS_QUALITY_GATE_MAX_AGE_MS + 5_000), // fix=17:40:13, 3+분 경과 — stale.
    refresh: jest.fn(),
  });
  mockFindTop.mockReturnValue([{ station: konkuk, distanceKm: 0 }]);
  mockPos.mockReturnValue(
    positionRet({
      line: '7',
      trains: [train(junggok.name, TRAIN_STATUS.ARRIVED, { trainNo: TRAIN_CODE_7256 })],
    }),
  );

  const lock = makeLock();
  currentLock = lock;
  const fused = renderHook(() =>
    useFusedNearestStation(undefined, undefined, routeContext, TRAIN_CODE_7256, lock),
  );

  return { fused, lock };
}

function renderStationAlarmWith(fusionSource: FusionSource | undefined, opts?: { userLocation?: { lat: number; lng: number } | null }) {
  return renderHook(() =>
    useStationAlarm({
      route: routeContext.route,
      destination: yongmasan,
      nearestStation: konkuk,
      userLocation: opts?.userLocation ?? null,
      speedMps: null,
      accuracyMeters: FROZEN_GPS_ACCURACY_M,
      fusionSource,
      skipWarmupGuard: true,
    }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  mockArrival.mockReturnValue(arrivalRet(null));
  mockPos.mockReturnValue(positionRet(null));
  mockGetTripStartedAt.mockResolvedValue(null);
  mockGetBoardingLock.mockImplementation(() => Promise.resolve(currentLock));
  mockEvaluateSsotFireGate.mockResolvedValue({ blocked: false, reason: 'mirror-missing' });
  currentLock = null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../utils/crossCategoryStationDedup')._resetCrossCategoryDedupForTests();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('#2726 (ADR-039 조건 2·3) — 2026-09-18 용마산 통과 라이드 device 층 wire 재생', () => {
  describe(STRONG_SOURCE_WINDOW_LABEL, () => {
    it('실 체인(useFusedNearestStation)이 stale GPS 거리 거부 없이 fusionSource=boarding-lock을 도출한다 (조건 2, #2713 GREEN)', () => {
      const { fused } = renderStrongSourceWindow();

      expect(fused.result.current.source).toBe('boarding-lock');
      expect(fused.result.current.result?.station.id).toBe(junggok.id);
    });

    it('조건 2 — reject:candidate-distance에 trainCode 7256 일치 신호 거부가 0건이다', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getCandidateRejectEntries, clearCandidateRejectEntries } = require('../../nearest-station/utils/candidateRejectBuffer');
      clearCandidateRejectEntries();

      renderStrongSourceWindow();

      const rejects = getCandidateRejectEntries() as Array<{ reason: string; trainNo?: string }>;
      const train7256Rejected = rejects.some(
        (e) => e.reason === 'candidate-distance' && e.trainNo === TRAIN_CODE_7256,
      );
      expect(train7256Rejected).toBe(false);
    });

    it('그 fusionSource를 실 체인 그대로 useStationAlarm에 주입하면 gate-phase-time-integration/gate-phase-accuracy 어느 쪽도 용마산을 억제하지 않는다 (조건 3 GREEN)', async () => {
      const { fused } = renderStrongSourceWindow();
      const derivedSource = fused.result.current.source;

      renderStationAlarmWith(derivedSource, { userLocation: FROZEN_GPS_FIX });

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      const suppressedReasonsForYongmasan = mockLogSuppressedPhaseGate.mock.calls
        .filter((c) => c[1] === yongmasan.name)
        .map((c) => c[0]);
      expect(suppressedReasonsForYongmasan).not.toContain('gate-phase-time-integration');
      expect(suppressedReasonsForYongmasan).not.toContain('gate-phase-accuracy');
    });
  });

  describe(WEAK_SOURCE_WINDOW_LABEL, () => {
    // ADR-039 §5 4단계 (#2728) — 2026-09-18 실측 라이드는 17:40:29(강 source 창 진입 전)부터
    // 열차 7256에 lock이 걸린 채로 진행됐다(makeLock() boardedAt=NOW-3분, expectedDurationMs=20분).
    // 약한 source 창(17:46:57~17:53:41)도 같은 lock이 유지된 상태다 — lock은 강/약 source 창
    // 전환과 무관하게 trip 종료까지 활성이다. 이전 버전의 이 테스트는 `currentLock`을
    // beforeEach 기본값(null)에 방치해 이 창을 사실상 lockless로 재생했다 — 실제 라이드의
    // lock 상태를 반영하지 못한 재생 오류였다(fixture 데이터 자체는 무변경, 재생 harness의
    // lock 배선만 교정). lock을 명시 세팅해 실측과 일치시킨다.
    beforeEach(() => {
      currentLock = makeLock();
    });

    it('lock 활성 + 덤프가 실측한 fusionSource=gps를 그대로 주입하면 gate-phase-time-integration이 더 이상 용마산을 억제하지 않는다 (조건 3 FAIL → PASS, #2728 4단계)', async () => {
      renderStationAlarmWith('gps', { userLocation: FROZEN_GPS_FIX });

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      // 🟢 ADR-039 4단계 이후: lock 활성 trip은 fusionSource가 약(gps)이어도
      // gate-phase-time-integration이 더 이상 destination을 억제하지 않는다 — D 매트릭스상
      // GPS/estimator에는 발사 거부 권한이 없고, 3단계(#2730)가 ETA를 Seoul 피드로 단일화했으므로
      // "ETA 계산에 GPS가 필요하다"는 이 게이트의 전제가 lock 활성 trip에서는 사라졌다.
      await waitFor(() => {
        const suppressedReasonsForYongmasan = mockLogSuppressedPhaseGate.mock.calls
          .filter((c) => c[1] === yongmasan.name)
          .map((c) => c[0]);
        expect(suppressedReasonsForYongmasan).not.toContain('gate-phase-time-integration');
      });
    });

    it('accuracy 자체는 74m(<200m 게이트)로 정상이라 gate-phase-accuracy는 이 창의 억제 원인이 아니다', async () => {
      renderStationAlarmWith('gps', { userLocation: FROZEN_GPS_FIX });

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      const suppressedReasonsForYongmasan = mockLogSuppressedPhaseGate.mock.calls
        .filter((c) => c[1] === yongmasan.name)
        .map((c) => c[0]);
      expect(suppressedReasonsForYongmasan).not.toContain('gate-phase-accuracy');
    });

    it('회귀 — lockless(같은 fusionSource=gps 입력)이면 gate-phase-time-integration이 여전히 용마산을 억제한다 (요구사항 2, lockless 무변경)', async () => {
      currentLock = null;
      renderStationAlarmWith('gps', { userLocation: FROZEN_GPS_FIX });

      await waitFor(() => {
        const suppressedReasonsForYongmasan = mockLogSuppressedPhaseGate.mock.calls
          .filter((c) => c[1] === yongmasan.name)
          .map((c) => c[0]);
        expect(suppressedReasonsForYongmasan).toContain('gate-phase-time-integration');
      });
    });
  });
});
