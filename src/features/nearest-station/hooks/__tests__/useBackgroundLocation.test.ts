// #1973 — useBackgroundLocation은 cross-feature orchestrator로 route/store/useNavigationStore를
// 명시적으로 소비. 테스트에서도 같은 store를 직접 set/read해야 navigationActive lifecycle을 검증할 수 있다.
/* eslint-disable import/no-restricted-paths */
import { renderHook, waitFor } from '@testing-library/react-native';
import { Alert, Linking } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  BG_PERMISSION_DENIED_DISMISSED_KEY,
  BG_FOREGROUND_SERVICE_TEXT_KEY,
  BG_LOCATION_PROFILE_KEY,
} from '../../../../shared/constants/storageKeys';
import type { Station } from '../../../../shared/types/station';

// ── Alert.alert / Linking.openSettings 모킹 ──
const mockAlertAlert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
const mockOpenSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();

// ── expo-location 모킹 ──
const mockRequestForegroundPermissionsAsync = jest.fn();
const mockRequestBackgroundPermissionsAsync = jest.fn();
const mockStartLocationUpdatesAsync = jest.fn();
const mockStopLocationUpdatesAsync = jest.fn();

jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: (...args: unknown[]) =>
    mockRequestForegroundPermissionsAsync(...args),
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
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { useBackgroundLocation } from '../useBackgroundLocation';
import { LOCATION_TRACKING_OPTIONS } from '../../../../shared/constants/locationTracking';
import { useNavigationStore } from '../../../route/store/useNavigationStore';

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

describe('useBackgroundLocation (#1973 명시 trigger)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    // #791: dismiss flag는 AsyncStorage(영속)에 저장되므로 매 테스트마다 초기화.
    await AsyncStorage.clear();
    mockStopLocationUpdatesAsync.mockResolvedValue(undefined);
    // 기본: Always granted (호환 — 기존 시나리오)
    mockRequestForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    mockRequestBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    mockIsTaskRegisteredAsync.mockResolvedValue(false);
    mockStartLocationUpdatesAsync.mockResolvedValue(undefined);
    // #1973 — 매 테스트 navigationActive=true로 set (명시 trigger 후 시나리오가 default).
    useNavigationStore.setState({ navigationActive: true });
  });

  afterEach(() => {
    useNavigationStore.setState({ navigationActive: false });
  });

  // ── #1973 — navigationActive=false 시 자동 trigger 차단 ──

  describe('#1973 — 명시 trigger 패러다임', () => {
    it('navigationActive=false이면 destination 있어도 startLocationUpdatesAsync 미호출 (자동 trigger 차단)', async () => {
      useNavigationStore.setState({ navigationActive: false });

      renderHook(() => useBackgroundLocation(mockDestination));

      await waitFor(() => {
        expect(mockStopLocationUpdatesAsync).toHaveBeenCalledWith('background-location-task');
      });

      expect(mockRequestForegroundPermissionsAsync).not.toHaveBeenCalled();
      expect(mockRequestBackgroundPermissionsAsync).not.toHaveBeenCalled();
      expect(mockStartLocationUpdatesAsync).not.toHaveBeenCalled();
    });

    it('navigationActive false→true 전환 시 effect 재실행되어 startLocationUpdatesAsync 호출', async () => {
      useNavigationStore.setState({ navigationActive: false });

      const { rerender } = renderHook(() => useBackgroundLocation(mockDestination));

      await waitFor(() => {
        expect(mockStopLocationUpdatesAsync).toHaveBeenCalled();
      });
      expect(mockStartLocationUpdatesAsync).not.toHaveBeenCalled();

      jest.clearAllMocks();
      mockRequestForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
      mockRequestBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
      mockIsTaskRegisteredAsync.mockResolvedValue(false);
      mockStartLocationUpdatesAsync.mockResolvedValue(undefined);

      useNavigationStore.setState({ navigationActive: true });
      rerender({});

      await waitFor(() => {
        expect(mockStartLocationUpdatesAsync).toHaveBeenCalled();
      });
    });

    it('navigationActive true→false 전환 시 stopLocationUpdatesAsync 호출 (안내 중단)', async () => {
      const { rerender } = renderHook(() => useBackgroundLocation(mockDestination));

      await waitFor(() => {
        expect(mockStartLocationUpdatesAsync).toHaveBeenCalled();
      });

      jest.clearAllMocks();
      mockStopLocationUpdatesAsync.mockResolvedValue(undefined);

      useNavigationStore.setState({ navigationActive: false });
      rerender({});

      await waitFor(() => {
        expect(mockStopLocationUpdatesAsync).toHaveBeenCalledWith('background-location-task');
      });
      expect(mockStartLocationUpdatesAsync).not.toHaveBeenCalled();
    });
  });

  // ── destination이 null인 경우 ──

  it('destination이 null이면 stopLocationUpdatesAsync를 호출한다', async () => {
    const { unmount } = renderHook(() => useBackgroundLocation(null));

    await waitFor(() => {
      expect(mockStopLocationUpdatesAsync).toHaveBeenCalledWith('background-location-task');
    });

    expect(mockRequestForegroundPermissionsAsync).not.toHaveBeenCalled();
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

  // ── #1973 권한 단계화: WhileInUse + Always 둘 다 granted (Always 사용자) ──

  it('Foreground granted + Background granted (Always 사용자) → startLocationUpdatesAsync 호출', async () => {
    renderHook(() => useBackgroundLocation(mockDestination));

    await waitFor(() => {
      expect(mockStartLocationUpdatesAsync).toHaveBeenCalled();
    });

    expect(mockRequestForegroundPermissionsAsync).toHaveBeenCalled();
    expect(mockRequestBackgroundPermissionsAsync).toHaveBeenCalled();
    expect(mockStartLocationUpdatesAsync).toHaveBeenCalledWith(
      'background-location-task',
      expect.any(Object),
    );

    const callArgs = mockStartLocationUpdatesAsync.mock.calls[0]?.[1] as Record<string, unknown>;
    const { foregroundService, ...trackingOpts } = callArgs;
    expect(trackingOpts).toEqual(LOCATION_TRACKING_OPTIONS);
    expect(foregroundService).toEqual({
      notificationTitle: '지하철 위치 감지 중',
      notificationBody: '백그라운드에서 현재 역을 추적하고 있습니다',
    });
  });

  // ── #2344 (V8a) — profile 전환 인프라를 위한 foregroundService 텍스트 캐시 + profile 초기화 ──

  it('#2344 — startLocationUpdatesAsync 성공 시 foregroundService 텍스트를 캐시하고 profile을 surface로 초기화한다', async () => {
    renderHook(() => useBackgroundLocation(mockDestination));

    await waitFor(() => {
      expect(mockStartLocationUpdatesAsync).toHaveBeenCalled();
    });

    expect(await AsyncStorage.getItem(BG_FOREGROUND_SERVICE_TEXT_KEY)).toBe(
      JSON.stringify({
        notificationTitle: '지하철 위치 감지 중',
        notificationBody: '백그라운드에서 현재 역을 추적하고 있습니다',
      }),
    );
    expect(await AsyncStorage.getItem(BG_LOCATION_PROFILE_KEY)).toBe('surface');
  });

  // ── #1973 권한 단계화: WhileInUse granted + Always denied (네이버 패턴 핵심) ──

  it('Foreground granted + Background denied (WhileInUse 사용자) → 그래도 startLocationUpdatesAsync 호출 (네이버 패턴)', async () => {
    mockRequestForegroundPermissionsAsync.mockResolvedValueOnce({ status: 'granted' });
    mockRequestBackgroundPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });

    renderHook(() => useBackgroundLocation(mockDestination));

    await waitFor(() => {
      expect(mockStartLocationUpdatesAsync).toHaveBeenCalled();
    });
    // Background denied여도 Alert 띄우지 않음 (WhileInUse만으로 진행 — 네이버 패턴)
    expect(mockAlertAlert).not.toHaveBeenCalled();
  });

  // ── #1973 권한 단계화: WhileInUse denied → 권한 안내 Alert + startLocationUpdatesAsync 미호출 ──

  it('Foreground denied → startLocationUpdatesAsync 미호출 + Alert 노출 (#387 보존)', async () => {
    mockRequestForegroundPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });

    renderHook(() => useBackgroundLocation(mockDestination));

    await waitFor(() => {
      expect(mockAlertAlert).toHaveBeenCalled();
    });

    expect(mockRequestBackgroundPermissionsAsync).not.toHaveBeenCalled();
    expect(mockStartLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  it('Foreground denied 시 "설정 열기" 탭 → Linking.openSettings 호출', async () => {
    mockRequestForegroundPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });

    renderHook(() => useBackgroundLocation(mockDestination));

    await waitFor(() => {
      expect(mockAlertAlert).toHaveBeenCalled();
    });

    const [, , buttons] = mockAlertAlert.mock.calls[0]!;
    expect(buttons).toHaveLength(2);
    const openSettingsBtn = (buttons as Array<{ onPress?: () => void }>)[1];
    openSettingsBtn?.onPress?.();
    expect(mockOpenSettings).toHaveBeenCalled();
  });

  it('Foreground denied 반복 시 dismiss flag로 Alert 한 번만 노출', async () => {
    mockRequestForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });

    const { rerender } = renderHook(
      ({ dest }: { dest: Station | null }) => useBackgroundLocation(dest),
      { initialProps: { dest: mockDestination as Station | null } },
    );

    await waitFor(() => {
      expect(mockAlertAlert).toHaveBeenCalledTimes(1);
    });

    rerender({ dest: mockDestination2 });

    await waitFor(() => {
      expect(mockRequestForegroundPermissionsAsync).toHaveBeenCalledTimes(2);
    });

    expect(mockAlertAlert).toHaveBeenCalledTimes(1);
  });

  // #791: dismiss 플래그가 AsyncStorage에 영속 저장되어 앱 재시작 후에도 Alert가 다시 뜨지 않는다.
  it('#791 첫 denied Alert 후 dismiss 플래그가 AsyncStorage에 저장된다', async () => {
    mockRequestForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });

    renderHook(() => useBackgroundLocation(mockDestination));

    await waitFor(() => {
      expect(mockAlertAlert).toHaveBeenCalledTimes(1);
    });

    expect(await AsyncStorage.getItem(BG_PERMISSION_DENIED_DISMISSED_KEY)).toBe('true');
  });

  it('#791 새 hook instance(앱 재시작 시나리오)에서도 dismiss 플래그가 있으면 Alert 미노출', async () => {
    mockRequestForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
    await AsyncStorage.setItem(BG_PERMISSION_DENIED_DISMISSED_KEY, 'true');

    renderHook(() => useBackgroundLocation(mockDestination));

    await waitFor(() => {
      expect(mockRequestForegroundPermissionsAsync).toHaveBeenCalled();
    });
    expect(mockAlertAlert).not.toHaveBeenCalled();
  });

  it('#791 AsyncStorage getItem 오류는 "미노출 이력 없음"으로 처리 → Alert 정상 노출', async () => {
    mockRequestForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
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
    mockRequestForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
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
    mockRequestForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
    let resolveGetItem!: (value: string | null) => void;
    const getItemSpy = jest.spyOn(AsyncStorage, 'getItem').mockReturnValueOnce(
      new Promise<string | null>((resolve) => {
        resolveGetItem = resolve;
      }),
    );

    const { unmount } = renderHook(() => useBackgroundLocation(mockDestination));

    await waitFor(() => {
      expect(mockRequestForegroundPermissionsAsync).toHaveBeenCalled();
    });

    unmount();
    resolveGetItem(null);

    await Promise.resolve();
    await Promise.resolve();

    expect(mockAlertAlert).not.toHaveBeenCalled();
    getItemSpy.mockRestore();
  });

  it('#791 setItem(dismiss 저장) 도중 unmount되면 storage는 갱신되지만 Alert는 미노출', async () => {
    mockRequestForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
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

  it('cancelled(unmount race) 상태에서는 Foreground denied여도 Alert를 띄우지 않는다', async () => {
    let resolvePermission!: (value: { status: string }) => void;
    mockRequestForegroundPermissionsAsync.mockReturnValueOnce(
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

  it('#1973 — Background permission 응답 전 unmount 시 startLocationUpdatesAsync 미호출', async () => {
    mockRequestForegroundPermissionsAsync.mockResolvedValueOnce({ status: 'granted' });
    let resolveBackground!: (value: { status: string }) => void;
    mockRequestBackgroundPermissionsAsync.mockReturnValueOnce(
      new Promise<{ status: string }>((resolve) => {
        resolveBackground = resolve;
      }),
    );

    const { unmount } = renderHook(() => useBackgroundLocation(mockDestination));

    await waitFor(() => {
      expect(mockRequestBackgroundPermissionsAsync).toHaveBeenCalled();
    });
    unmount();
    resolveBackground({ status: 'granted' });

    await Promise.resolve();
    await Promise.resolve();

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
    let resolvePermission!: (value: { status: string }) => void;
    mockRequestForegroundPermissionsAsync.mockReturnValueOnce(
      new Promise<{ status: string }>((resolve) => {
        resolvePermission = resolve;
      }),
    );

    const { unmount } = renderHook(() => useBackgroundLocation(mockDestination));

    unmount();
    resolvePermission({ status: 'granted' });

    await Promise.resolve();
    await Promise.resolve();

    expect(mockStartLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  it('isTaskRegisteredAsync 응답 전 unmount되면 startLocationUpdatesAsync를 호출하지 않는다', async () => {
    mockRequestForegroundPermissionsAsync.mockResolvedValueOnce({ status: 'granted' });
    mockRequestBackgroundPermissionsAsync.mockResolvedValueOnce({ status: 'granted' });
    let resolveRegistered!: (value: boolean) => void;
    mockIsTaskRegisteredAsync.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveRegistered = resolve;
      }),
    );

    const { unmount } = renderHook(() => useBackgroundLocation(mockDestination));

    await waitFor(() => {
      expect(mockIsTaskRegisteredAsync).toHaveBeenCalled();
    });
    unmount();
    resolveRegistered(false);

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
    mockRequestForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
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
    mockRequestForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    mockRequestBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    mockIsTaskRegisteredAsync.mockResolvedValue(false);
    mockStartLocationUpdatesAsync.mockResolvedValue(undefined);

    rerender({ dest: mockDestination });

    await waitFor(() => {
      expect(mockStartLocationUpdatesAsync).toHaveBeenCalled();
    });
  });
});
