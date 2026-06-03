import { renderHook, waitFor } from '@testing-library/react-native';
import { Alert, Linking } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BG_PERMISSION_DENIED_DISMISSED_KEY } from '../../constants/storageKeys';
import type { Station } from '../../types/station';

// ── Alert.alert / Linking.openSettings 모킹 ──
const mockAlertAlert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
const mockOpenSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();

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
  beforeEach(async () => {
    jest.clearAllMocks();
    // #791: dismiss flag는 AsyncStorage(영속)에 저장되므로 매 테스트마다 초기화.
    await AsyncStorage.clear();
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

  it('권한이 denied이면 안내 Alert를 띄우고 "설정 열기" 탭 시 Linking.openSettings를 호출한다 (#387)', async () => {
    mockRequestBackgroundPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });

    renderHook(() => useBackgroundLocation(mockDestination));

    await waitFor(() => {
      expect(mockAlertAlert).toHaveBeenCalled();
    });

    const [, , buttons] = mockAlertAlert.mock.calls[0]!;
    expect(buttons).toHaveLength(2);
    // 첫 번째 버튼은 닫기(cancel), 두 번째 버튼은 설정 열기.
    const openSettingsBtn = (buttons as Array<{ onPress?: () => void }>)[1];
    openSettingsBtn?.onPress?.();
    expect(mockOpenSettings).toHaveBeenCalled();
  });

  it('같은 hook 라이프타임에서 denied가 반복돼도 Alert는 한 번만 노출한다 (#387)', async () => {
    mockRequestBackgroundPermissionsAsync.mockResolvedValue({ status: 'denied' });

    const { rerender } = renderHook(
      ({ dest }: { dest: Station | null }) => useBackgroundLocation(dest),
      { initialProps: { dest: mockDestination as Station | null } },
    );

    await waitFor(() => {
      expect(mockAlertAlert).toHaveBeenCalledTimes(1);
    });

    rerender({ dest: mockDestination2 });

    await waitFor(() => {
      expect(mockRequestBackgroundPermissionsAsync).toHaveBeenCalledTimes(2);
    });

    expect(mockAlertAlert).toHaveBeenCalledTimes(1);
  });

  // #791: dismiss 플래그가 AsyncStorage에 영속 저장되어 앱 재시작 후에도 Alert가 다시 뜨지 않는다.
  it('#791 첫 denied Alert 후 dismiss 플래그가 AsyncStorage에 저장된다', async () => {
    mockRequestBackgroundPermissionsAsync.mockResolvedValue({ status: 'denied' });

    renderHook(() => useBackgroundLocation(mockDestination));

    await waitFor(() => {
      expect(mockAlertAlert).toHaveBeenCalledTimes(1);
    });

    expect(await AsyncStorage.getItem(BG_PERMISSION_DENIED_DISMISSED_KEY)).toBe('true');
  });

  it('#791 새 hook instance(앱 재시작 시나리오)에서도 dismiss 플래그가 있으면 Alert 미노출', async () => {
    mockRequestBackgroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
    await AsyncStorage.setItem(BG_PERMISSION_DENIED_DISMISSED_KEY, 'true');

    renderHook(() => useBackgroundLocation(mockDestination));

    await waitFor(() => {
      expect(mockRequestBackgroundPermissionsAsync).toHaveBeenCalled();
    });
    // 권한 요청은 여전히 일어나지만 Alert는 띄우지 않는다.
    expect(mockAlertAlert).not.toHaveBeenCalled();
  });

  it('#791 AsyncStorage getItem 오류는 "미노출 이력 없음"으로 처리 → Alert 정상 노출', async () => {
    mockRequestBackgroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
    const getItemSpy = jest
      .spyOn(AsyncStorage, 'getItem')
      .mockRejectedValueOnce(new Error('storage corrupt'));

    renderHook(() => useBackgroundLocation(mockDestination));

    await waitFor(() => {
      expect(mockAlertAlert).toHaveBeenCalledTimes(1);
    });

    getItemSpy.mockRestore();
  });

  it('#791 AsyncStorage setItem 오류는 silent — Alert는 여전히 노출', async () => {
    mockRequestBackgroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
    const setItemSpy = jest
      .spyOn(AsyncStorage, 'setItem')
      .mockRejectedValueOnce(new Error('disk full'));

    renderHook(() => useBackgroundLocation(mockDestination));

    await waitFor(() => {
      expect(mockAlertAlert).toHaveBeenCalledTimes(1);
    });

    setItemSpy.mockRestore();
  });

  it('#791 hydrate 도중 unmount되면 Alert를 띄우지 않는다 (cancelled 가드)', async () => {
    mockRequestBackgroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
    let resolveGetItem!: (value: string | null) => void;
    const getItemSpy = jest.spyOn(AsyncStorage, 'getItem').mockReturnValueOnce(
      new Promise<string | null>((resolve) => {
        resolveGetItem = resolve;
      }),
    );

    const { unmount } = renderHook(() => useBackgroundLocation(mockDestination));

    await waitFor(() => {
      expect(mockRequestBackgroundPermissionsAsync).toHaveBeenCalled();
    });

    unmount();
    resolveGetItem(null);

    await Promise.resolve();
    await Promise.resolve();

    expect(mockAlertAlert).not.toHaveBeenCalled();
    getItemSpy.mockRestore();
  });

  it('#791 setItem(dismiss 저장) 도중 unmount되면 storage는 갱신되지만 Alert는 미노출', async () => {
    mockRequestBackgroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
    let resolveSetItem!: () => void;
    const setItemSpy = jest.spyOn(AsyncStorage, 'setItem').mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveSetItem = resolve;
      }),
    );

    const { unmount } = renderHook(() => useBackgroundLocation(mockDestination));

    await waitFor(() => {
      expect(setItemSpy).toHaveBeenCalledWith(BG_PERMISSION_DENIED_DISMISSED_KEY, 'true');
    });

    unmount();
    resolveSetItem();

    await Promise.resolve();
    await Promise.resolve();

    expect(mockAlertAlert).not.toHaveBeenCalled();
    setItemSpy.mockRestore();
  });

  it('cancelled(unmount race) 상태에서는 denied여도 Alert를 띄우지 않는다 (#387)', async () => {
    let resolvePermission!: (value: { status: string }) => void;
    mockRequestBackgroundPermissionsAsync.mockReturnValueOnce(
      new Promise<{ status: string }>((resolve) => {
        resolvePermission = resolve;
      }),
    );

    const { unmount } = renderHook(() => useBackgroundLocation(mockDestination));
    unmount();
    resolvePermission({ status: 'denied' });

    await Promise.resolve();
    await Promise.resolve();

    expect(mockAlertAlert).not.toHaveBeenCalled();
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
