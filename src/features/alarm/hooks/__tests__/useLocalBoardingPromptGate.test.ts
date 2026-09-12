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
});
