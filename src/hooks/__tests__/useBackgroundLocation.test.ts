import { renderHook, act, waitFor } from '@testing-library/react-native';
import type { Station } from '../../types/station';

// ── expo-location 모킹 ──
const mockRequestBackgroundPermissionsAsync = jest.fn();
const mockStartLocationUpdatesAsync = jest.fn();
const mockStopLocationUpdatesAsync = jest.fn();

jest.mock('expo-location', () => ({
  requestBackgroundPermissionsAsync: (...args: unknown[]) =>
    mockRequestBackgroundPermissionsAsync(...args),
  startLocationUpdatesAsync: (...args: unknown[]) =>
    mockStartLocationUpdatesAsync(...args),
  stopLocationUpdatesAsync: (...args: unknown[]) =>
    mockStopLocationUpdatesAsync(...args),
  Accuracy: { High: 6 },
  LocationActivityType: { AutomotiveNavigation: 2 },
}));

// ── expo-task-manager 모킹 ──
const mockIsTaskRegisteredAsync = jest.fn();

jest.mock('expo-task-manager', () => ({
  isTaskRegisteredAsync: (...args: unknown[]) => mockIsTaskRegisteredAsync(...args),
  // defineTask는 backgroundLocationTask 모듈이 호출하지만,
  // 여기서는 그 모듈을 직접 import하지 않으므로 stub만 필요하다
  defineTask: jest.fn(),
}));

// ── backgroundLocationTask 모킹: BACKGROUND_LOCATION_TASK 상수만 필요 ──
jest.mock('../../tasks/backgroundLocationTask', () => ({
  BACKGROUND_LOCATION_TASK: 'background-location-task',
}));

// ── logger 모킹 ──
jest.mock('../../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { useBackgroundLocation } from '../useBackgroundLocation';
import { LOCATION_TRACKING_OPTIONS } from '../../constants/locationTracking';

// ── 픽스처 ──

const mockDestination: Station = {
  id: 'station-2',
  name: '시청',
  line: '1',
  lineColor: '#0052A4',
  lat: 37.565,
  lng: 126.977,
};

const mockDestination2: Station = {
  id: 'station-3',
  name: '강남',
  line: '2',
  lineColor: '#009246',
  lat: 37.498,
  lng: 127.028,
};

describe('useBackgroundLocation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStopLocationUpdatesAsync.mockResolvedValue(undefined);
    mockRequestBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    mockIsTaskRegisteredAsync.mockResolvedValue(false);
    mockStartLocationUpdatesAsync.mockResolvedValue(undefined);
  });

  // ── destination이 null인 경우 ──

  it('destination이 null이면 stopLocationUpdatesAsync를 호출한다', async () => {
    const { unmount } = renderHook(() => useBackgroundLocation(null));

    await waitFor(() => {
      expect(mockStopLocationUpdatesAsync).toHaveBeenCalledWith('background-location-task');
    });

    expect(mockRequestBackgroundPermissionsAsync).not.toHaveBeenCalled();
    expect(mockStartLocationUpdatesAsync).not.toHaveBeenCalled();
    unmount();
  });

  it('destination이 null이면 stopLocationUpdatesAsync 실패해도 에러를 던지지 않는다', async () => {
    mockStopLocationUpdatesAsync.mockRejectedValueOnce(new Error('이미 정지됨'));

    const { unmount } = renderHook(() => useBackgroundLocation(null));

    await waitFor(() => {
      expect(mockStopLocationUpdatesAsync).toHaveBeenCalled();
    });

    // .catch(() => {}) 로 감싸져 있으므로 에러 없음
    unmount();
  });

  // ── 권한 허용 + 태스크 미등록: 정상 시작 ──

  it('권한이 granted이고 태스크 미등록이면 startLocationUpdatesAsync를 호출한다', async () => {
    renderHook(() => useBackgroundLocation(mockDestination));

    await waitFor(() => {
      expect(mockStartLocationUpdatesAsync).toHaveBeenCalled();
    });

    expect(mockStartLocationUpdatesAsync).toHaveBeenCalledWith(
      'background-location-task',
      expect.any(Object),
    );

    // 회귀 가드: 추적 옵션 형태를 LOCATION_TRACKING_OPTIONS 상수와 strict 비교.
    // - 임의 키 추가(예: deferredUpdatesInterval 재유입) → toEqual 실패
    // - 키 제거/변경 → toEqual 실패
    // foregroundService는 i18n 의존이라 분리 검증.
    const callArgs = mockStartLocationUpdatesAsync.mock.calls[0]?.[1] as Record<string, unknown>;
    const { foregroundService, ...trackingOpts } = callArgs;
    expect(trackingOpts).toEqual(LOCATION_TRACKING_OPTIONS);
    expect(foregroundService).toEqual({
      notificationTitle: '지하철 위치 감지 중',
      notificationBody: '백그라운드에서 현재 역을 추적하고 있습니다',
    });
  });

  // ── 권한 거부 ──

  it('권한이 denied이면 startLocationUpdatesAsync를 호출하지 않는다', async () => {
    mockRequestBackgroundPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });

    renderHook(() => useBackgroundLocation(mockDestination));

    await waitFor(() => {
      expect(mockRequestBackgroundPermissionsAsync).toHaveBeenCalled();
    });

    expect(mockStartLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  // ── 태스크가 이미 등록된 경우: GPS 추적 공백 방지를 위해 재시작하지 않음 ──

  it('태스크가 이미 등록되어 있으면 startLocationUpdatesAsync를 호출하지 않는다', async () => {
    mockIsTaskRegisteredAsync.mockResolvedValueOnce(true);

    renderHook(() => useBackgroundLocation(mockDestination));

    await waitFor(() => {
      expect(mockIsTaskRegisteredAsync).toHaveBeenCalledWith('background-location-task');
    });

    expect(mockStartLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  // ── cleanup: cancelled 플래그로 경쟁 조건 방지 ──

  it('useEffect 클린업이 실행되면 cancelled=true로 startLocationUpdatesAsync를 호출하지 않는다', async () => {
    // 권한 요청이 느리게 resolve되는 동안 컴포넌트가 unmount된 경우를 시뮬레이션
    let resolvePermission!: (value: { status: string }) => void;
    mockRequestBackgroundPermissionsAsync.mockReturnValueOnce(
      new Promise<{ status: string }>((resolve) => {
        resolvePermission = resolve;
      }),
    );

    const { unmount } = renderHook(() => useBackgroundLocation(mockDestination));

    // unmount로 cleanup(cancelled=true) 실행 후 권한 응답
    unmount();
    resolvePermission({ status: 'granted' });

    // 마이크로태스크가 처리될 시간을 준다
    await Promise.resolve();
    await Promise.resolve();

    expect(mockStartLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  it('isTaskRegisteredAsync 응답 전 unmount되면 startLocationUpdatesAsync를 호출하지 않는다', async () => {
    // 권한은 즉시 허용되지만 isTaskRegistered가 느린 경우
    mockRequestBackgroundPermissionsAsync.mockResolvedValueOnce({ status: 'granted' });
    let resolveRegistered!: (value: boolean) => void;
    mockIsTaskRegisteredAsync.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveRegistered = resolve;
      }),
    );

    const { unmount } = renderHook(() => useBackgroundLocation(mockDestination));

    // 권한 응답까지 기다린 후 unmount
    await waitFor(() => {
      expect(mockIsTaskRegisteredAsync).toHaveBeenCalled();
    });
    unmount();
    resolveRegistered(false); // 등록 안 됨으로 응답 — 하지만 이미 cancelled

    await Promise.resolve();
    await Promise.resolve();

    expect(mockStartLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  // ── destination.id 변경 시 effect 재실행 ──

  it('destination.id가 변경되면 effect가 재실행되어 새로 startLocationUpdatesAsync를 호출한다', async () => {
    const { rerender } = renderHook(
      ({ dest }: { dest: Station | null }) => useBackgroundLocation(dest),
      { initialProps: { dest: mockDestination } },
    );

    await waitFor(() => {
      expect(mockStartLocationUpdatesAsync).toHaveBeenCalledTimes(1);
    });

    jest.clearAllMocks();
    mockRequestBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    mockIsTaskRegisteredAsync.mockResolvedValue(false);
    mockStartLocationUpdatesAsync.mockResolvedValue(undefined);

    rerender({ dest: mockDestination2 });

    await waitFor(() => {
      expect(mockStartLocationUpdatesAsync).toHaveBeenCalledTimes(1);
    });
  });

  it('destination이 null에서 non-null로 변경되면 startLocationUpdatesAsync를 호출한다', async () => {
    const { rerender } = renderHook(
      ({ dest }: { dest: Station | null }) => useBackgroundLocation(dest),
      { initialProps: { dest: null } },
    );

    await waitFor(() => {
      expect(mockStopLocationUpdatesAsync).toHaveBeenCalled();
    });

    jest.clearAllMocks();
    mockRequestBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    mockIsTaskRegisteredAsync.mockResolvedValue(false);
    mockStartLocationUpdatesAsync.mockResolvedValue(undefined);

    rerender({ dest: mockDestination });

    await waitFor(() => {
      expect(mockStartLocationUpdatesAsync).toHaveBeenCalled();
    });
  });
});
