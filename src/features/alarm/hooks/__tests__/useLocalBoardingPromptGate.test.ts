import { renderHook, waitFor } from '@testing-library/react-native';
import { useLocalBoardingPromptGate } from '../useLocalBoardingPromptGate';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import type { StationArrival } from '../../../../shared/types/arrival';
import { getStationById } from '../../../../shared/utils/stationRoute';
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockAddDomainBreadcrumb = jest.fn();
jest.mock('../../../../shared/infra/monitoring/breadcrumb', () => ({
  addDomainBreadcrumb: (...args: unknown[]) => mockAddDomainBreadcrumb(...args),
}));

const mockBuildBoardingPromptContext = jest.fn();
jest.mock('../../utils/boardingPromptContext', () => ({
  buildBoardingPromptContext: (...args: unknown[]) => mockBuildBoardingPromptContext(...args),
}));

const mockEvaluateLocalBoardingPromptGate = jest.fn();
jest.mock('../../utils/localBoardingPromptGate', () => ({
  evaluateLocalBoardingPromptGate: (...args: unknown[]) =>
    mockEvaluateLocalBoardingPromptGate(...args),
}));

const mockFireLocalBoardingPromptNotification = jest.fn();
jest.mock('../../utils/stationNotification', () => ({
  fireLocalBoardingPromptNotification: (...args: unknown[]) =>
    mockFireLocalBoardingPromptNotification(...args),
}));

const mockIsMinimalAlarmEnabled = jest.fn();
jest.mock('../../../../shared/constants/debugFlags', () => ({
  isMinimalAlarmEnabled: () => mockIsMinimalAlarmEnabled(),
}));

// #2858 — transfer-release 직후 쿨다운. useLegAdvanceStore.stampedAt을 읽어 최근 환승 stamp
// 윈도우 안이면 발사를 억제한다. getState() 기반 non-reactive read — 기존 #2278 패턴과 동일.
const mockGetLegAdvanceState = jest.fn();
jest.mock('../../store/useLegAdvanceStore', () => ({
  useLegAdvanceStore: {
    getState: () => mockGetLegAdvanceState(),
  },
}));

const currentStation = getStationById('2-020')!; // 중곡
const destination = getStationById('2-022')!; // 건대입구
const route = makeDirectRoute(4, '2');

const arrival: StationArrival = { up: [], down: [] };

function makeLock(overrides: Partial<BoardingLock> = {}): BoardingLock {
  return {
    destinationId: destination.id,
    trainCode: '7246',
    boardingStationId: currentStation.id,
    boardingLine: '2',
    boardedAt: 1_700_000_000_000,
    expectedDurationMs: 600_000,
    ...overrides,
  };
}

const context = {
  promptGeoContext: {
    origin: { lat: currentStation.lat, lng: currentStation.lng },
    nextStation: { lat: destination.lat, lng: destination.lng },
    direction: 'up' as const,
    originDistanceM: 50,
    originAccuracyM: 10,
  },
  promptDisplay: { originStation: currentStation.name, line: '2' },
};

describe('useLocalBoardingPromptGate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // 기존 시나리오는 전부 dogfood(MINIMAL_ALARM ON) 전제 — 아래 OFF 전용 테스트에서만 override.
    mockIsMinimalAlarmEnabled.mockReturnValue(true);
    mockBuildBoardingPromptContext.mockReturnValue(context);
    mockEvaluateLocalBoardingPromptGate.mockReturnValue({ pass: true });
    mockFireLocalBoardingPromptNotification.mockResolvedValue(true);
    // 기존 시나리오는 전부 legAdvance stamp 없음(leg-1/direct trip 전제) — 쿨다운 전용 테스트에서만 override.
    mockGetLegAdvanceState.mockReturnValue({ nextLine: null, stampedAt: null });
  });

  it('MINIMAL_ALARM 플래그가 OFF면 게이트가 pass여도 로컬 발사하지 않는다 (backend가 유일 소스)', () => {
    mockIsMinimalAlarmEnabled.mockReturnValue(false);
    renderHook(() =>
      useLocalBoardingPromptGate({
        route,
        currentStation,
        destination,
        lock: null,
        gpsFix: null,
        arrival,
      }),
    );
    expect(mockFireLocalBoardingPromptNotification).not.toHaveBeenCalled();
  });

  it('MINIMAL_ALARM 플래그가 ON이면 기존과 동일하게 발사한다 (dogfood 회귀 없음)', async () => {
    mockIsMinimalAlarmEnabled.mockReturnValue(true);
    renderHook(() =>
      useLocalBoardingPromptGate({
        route,
        currentStation,
        destination,
        lock: null,
        gpsFix: null,
        arrival,
      }),
    );
    await waitFor(() => {
      expect(mockFireLocalBoardingPromptNotification).toHaveBeenCalledWith(
        currentStation.name,
        '2',
        'up',
      );
    });
  });

  it('lock이 활성이면 게이트 평가 자체를 스킵한다 (context 빌드/발사 모두 안 함)', () => {
    renderHook(() =>
      useLocalBoardingPromptGate({
        route,
        currentStation,
        destination,
        lock: makeLock(),
        gpsFix: null,
        arrival,
      }),
    );
    expect(mockBuildBoardingPromptContext).not.toHaveBeenCalled();
    expect(mockFireLocalBoardingPromptNotification).not.toHaveBeenCalled();
  });

  it('arrival이 null이면 스킵한다', () => {
    renderHook(() =>
      useLocalBoardingPromptGate({
        route,
        currentStation,
        destination,
        lock: null,
        gpsFix: null,
        arrival: null,
      }),
    );
    expect(mockBuildBoardingPromptContext).not.toHaveBeenCalled();
    expect(mockFireLocalBoardingPromptNotification).not.toHaveBeenCalled();
  });

  it('context가 null이면(route/currentStation/destination 미해소 등) 발사 안 함', () => {
    mockBuildBoardingPromptContext.mockReturnValue(null);
    renderHook(() =>
      useLocalBoardingPromptGate({
        route,
        currentStation,
        destination,
        lock: null,
        gpsFix: null,
        arrival,
      }),
    );
    expect(mockEvaluateLocalBoardingPromptGate).not.toHaveBeenCalled();
    expect(mockFireLocalBoardingPromptNotification).not.toHaveBeenCalled();
  });

  it('게이트 fail이면 발사 안 함', () => {
    mockEvaluateLocalBoardingPromptGate.mockReturnValue({ pass: false, reason: 'not-near-origin' });
    renderHook(() =>
      useLocalBoardingPromptGate({
        route,
        currentStation,
        destination,
        lock: null,
        gpsFix: null,
        arrival,
      }),
    );
    expect(mockFireLocalBoardingPromptNotification).not.toHaveBeenCalled();
  });

  it('게이트 pass면 context.promptDisplay/promptGeoContext.direction으로 발사하고, 성공 시 breadcrumb를 남긴다', async () => {
    renderHook(() =>
      useLocalBoardingPromptGate({
        route,
        currentStation,
        destination,
        lock: null,
        gpsFix: null,
        arrival,
      }),
    );
    await waitFor(() => {
      expect(mockFireLocalBoardingPromptNotification).toHaveBeenCalledWith(
        currentStation.name,
        '2',
        'up',
      );
    });
    await waitFor(() => {
      expect(mockAddDomainBreadcrumb).toHaveBeenCalledWith('boarding', 'local_boarding_prompt_fired', {
        originStation: currentStation.name,
        line: '2',
      });
    });
  });

  it('발사 함수가 false(이미 dedup됨)를 반환하면 breadcrumb를 남기지 않는다', async () => {
    mockFireLocalBoardingPromptNotification.mockResolvedValue(false);
    renderHook(() =>
      useLocalBoardingPromptGate({
        route,
        currentStation,
        destination,
        lock: null,
        gpsFix: null,
        arrival,
      }),
    );
    await waitFor(() => {
      expect(mockFireLocalBoardingPromptNotification).toHaveBeenCalled();
    });
    expect(mockAddDomainBreadcrumb).not.toHaveBeenCalled();
  });

  it('발사 함수가 reject되어도 throw하지 않는다 (에러 삼킴)', async () => {
    mockFireLocalBoardingPromptNotification.mockRejectedValue(new Error('network'));
    renderHook(() =>
      useLocalBoardingPromptGate({
        route,
        currentStation,
        destination,
        lock: null,
        gpsFix: null,
        arrival,
      }),
    );
    await waitFor(() => {
      expect(mockFireLocalBoardingPromptNotification).toHaveBeenCalled();
    });
    // reject 후에도 in-flight 가드가 풀려 재평가 가능해야 한다 — 다음 assertion으로 간접 검증.
  });

  it('발사 in-flight 중 재렌더는 중복 발사하지 않는다', async () => {
    let resolveFire: (v: boolean) => void = () => {};
    mockFireLocalBoardingPromptNotification.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveFire = resolve;
      }),
    );
    const { rerender } = renderHook(
      (props: { gpsFix: { lat: number; lng: number; accuracyM: number } | null }) =>
        useLocalBoardingPromptGate({
          route,
          currentStation,
          destination,
          lock: null,
          gpsFix: props.gpsFix,
          arrival,
        }),
      { initialProps: { gpsFix: null } },
    );
    await waitFor(() => {
      expect(mockFireLocalBoardingPromptNotification).toHaveBeenCalledTimes(1);
    });
    // deps 변경으로 effect 재실행 — in-flight 가드가 두 번째 호출을 막아야 한다.
    rerender({ gpsFix: { lat: 1, lng: 1, accuracyM: 1 } });
    expect(mockFireLocalBoardingPromptNotification).toHaveBeenCalledTimes(1);
    resolveFire(true);
    await waitFor(() => {
      expect(mockAddDomainBreadcrumb).toHaveBeenCalled();
    });
  });

  // #2858 — leg-aware context fix(findLocklessActiveLegWaypoint) 외 추가 방어. transfer-release로
  // legAdvance가 방금(AUTO_RELEASE_GRACE_MS 이내) stamp됐으면 GPS/route가 아직 새 leg로 안정화되지
  // 않았을 edge를 대비해 로컬 프롬프트 발사를 쿨다운한다.
  describe('#2858 transfer-release 직후 쿨다운', () => {
    it('legAdvance stamp가 AUTO_RELEASE_GRACE_MS 이내면 context 평가 자체를 건너뛴다(발사 안 함)', () => {
      mockGetLegAdvanceState.mockReturnValue({ nextLine: '7', stampedAt: Date.now() - 1000 });
      renderHook(() =>
        useLocalBoardingPromptGate({
          route,
          currentStation,
          destination,
          lock: null,
          gpsFix: null,
          arrival,
        }),
      );
      expect(mockBuildBoardingPromptContext).not.toHaveBeenCalled();
      expect(mockFireLocalBoardingPromptNotification).not.toHaveBeenCalled();
    });

    it('legAdvance stamp가 쿨다운(AUTO_RELEASE_GRACE_MS)을 지났으면 평소대로 발사한다', async () => {
      mockGetLegAdvanceState.mockReturnValue({ nextLine: '7', stampedAt: Date.now() - 60_000 });
      renderHook(() =>
        useLocalBoardingPromptGate({
          route,
          currentStation,
          destination,
          lock: null,
          gpsFix: null,
          arrival,
        }),
      );
      await waitFor(() => {
        expect(mockFireLocalBoardingPromptNotification).toHaveBeenCalled();
      });
    });

    it('legAdvance stamp가 없으면(stampedAt=null, leg-1/direct trip) 쿨다운 미적용 — 기존 동작 유지', async () => {
      mockGetLegAdvanceState.mockReturnValue({ nextLine: null, stampedAt: null });
      renderHook(() =>
        useLocalBoardingPromptGate({
          route,
          currentStation,
          destination,
          lock: null,
          gpsFix: null,
          arrival,
        }),
      );
      await waitFor(() => {
        expect(mockFireLocalBoardingPromptNotification).toHaveBeenCalled();
      });
    });
  });
});
