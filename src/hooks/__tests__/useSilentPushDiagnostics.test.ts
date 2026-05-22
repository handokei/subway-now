import { renderHook, waitFor, act } from '@testing-library/react-native';
import { AppState } from 'react-native';

const mockGetItem = jest.fn();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (...args: unknown[]) => mockGetItem(...args),
}));

const mockResolveApnsEnv = jest.fn();
jest.mock('../../utils/apnsEnv', () => ({
  resolveApnsEnv: () => mockResolveApnsEnv(),
}));

const mockGetAlarmLog = jest.fn();
jest.mock('../../utils/alarmLog', () => ({
  getAlarmLog: () => mockGetAlarmLog(),
}));

const mockGetRegistrationStatus = jest.fn();
jest.mock('../../tasks/silentPushTask', () => ({
  getSilentPushRegistrationStatus: () => mockGetRegistrationStatus(),
}));

const mockGetPermissionsAsync = jest.fn();
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: () => mockGetPermissionsAsync(),
}));

import { useSilentPushDiagnostics } from '../useSilentPushDiagnostics';
import {
  APNS_TOKEN_KEY,
  ACTIVE_TRIP_KEY,
  ROUTE_KEY,
  DESTINATION_KEY,
  LAST_NOTIFIED_STATION_KEY,
} from '../../constants/storageKeys';

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

describe('useSilentPushDiagnostics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveApnsEnv.mockReturnValue('sandbox');
    mockGetRegistrationStatus.mockReturnValue({ state: 'unknown', error: null });
    mockGetAlarmLog.mockResolvedValue([]);
    mockGetItem.mockResolvedValue(null);
    mockGetPermissionsAsync.mockResolvedValue({ status: 'granted' });
    // 기본 AppState mock — 일부 테스트는 listener를 spyOn으로 덮어쓴다.
    jest.spyOn(AppState, 'addEventListener').mockReturnValue({
      remove: jest.fn(),
    } as ReturnType<typeof AppState.addEventListener>);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('permission 조회 실패 시 permissionStatus는 null', async () => {
    mockGetPermissionsAsync.mockRejectedValue(new Error('no permission api'));
    const { result } = renderHook(() => useSilentPushDiagnostics());
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(result.current.permissionStatus).toBeNull();
  });

  it('permission 조회 성공 시 status 반영', async () => {
    mockGetPermissionsAsync.mockResolvedValue({ status: 'denied' });
    const { result } = renderHook(() => useSilentPushDiagnostics());
    await waitFor(() => expect(result.current.permissionStatus).toBe('denied'));
  });

  it('초기 mount 시 storage/log/등록상태를 한 번 로드', async () => {
    mockGetItem.mockImplementation((key: string) =>
      Promise.resolve(
        key === APNS_TOKEN_KEY ? 'apns-tok' : key === ACTIVE_TRIP_KEY ? 'trip-tok' : null,
      ),
    );
    mockGetRegistrationStatus.mockReturnValue({ state: 'success', error: null });

    const { result } = renderHook(() => useSilentPushDiagnostics());
    await waitFor(() => expect(result.current.apnsToken).toBe('apns-tok'));
    expect(result.current.activeTripToken).toBe('trip-tok');
    expect(result.current.apnsEnv).toBe('sandbox');
    expect(result.current.taskRegistrationState).toBe('success');
    expect(result.current.taskRegistrationError).toBeNull();
  });

  it('alarmLog에서 source별 최신 ts 추출 (순서 무관, 동일 source 다중 엔트리)', async () => {
    mockGetAlarmLog.mockResolvedValue([
      { ts: 100, source: 'silent-push-received', outcome: 'fired' },
      { ts: 300, source: 'silent-push-fired', outcome: 'fired' },
      { ts: 200, source: 'silent-push-received', outcome: 'fired' },
      { ts: 250, source: 'silent-push-fired', outcome: 'fired' }, // 첫 엔트리(300)보다 작음 → 갱신 안 됨
      { ts: 150, source: 'silent-push-skipped', outcome: 'suppressed' },
      { ts: 400, source: 'silent-push-skipped', outcome: 'suppressed' },
      { ts: 50, source: 'fg', outcome: 'fired' },
    ]);

    const { result } = renderHook(() => useSilentPushDiagnostics());
    await waitFor(() => expect(result.current.lastReceivedAt).toBe(200));
    expect(result.current.lastFiredAt).toBe(300);
    expect(result.current.lastSkippedAt).toBe(400);
  });

  it('source 엔트리 없으면 null 유지', async () => {
    mockGetAlarmLog.mockResolvedValue([
      { ts: 100, source: 'fg', outcome: 'fired' },
      { ts: 200, source: 'bg-scheduled', outcome: 'fired' },
    ]);

    const { result } = renderHook(() => useSilentPushDiagnostics());
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(result.current.lastReceivedAt).toBeNull();
    expect(result.current.lastFiredAt).toBeNull();
    expect(result.current.lastSkippedAt).toBeNull();
  });

  it('AppState active 전환 시 refresh', async () => {
    let listener: ((s: string) => void) | null = null;
    const addSpy = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((event, cb) => {
        if (event === 'change') listener = cb as (s: string) => void;
        return { remove: jest.fn() } as ReturnType<typeof AppState.addEventListener>;
      });

    mockGetItem.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const { result } = renderHook(() => useSilentPushDiagnostics());
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalledTimes(1));

    mockGetItem.mockResolvedValue('refreshed-token');
    await act(async () => {
      listener?.('active');
      await flushPromises();
    });
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalledTimes(2));
    expect(result.current.apnsToken).toBe('refreshed-token');

    // background 전환은 refresh 트리거하지 않음
    await act(async () => {
      listener?.('background');
      await flushPromises();
    });
    expect(mockGetAlarmLog).toHaveBeenCalledTimes(2);

    addSpy.mockRestore();
  });

  it('trip 입력 진단: route/destination/currentStation을 storage에서 읽어 노출한다 (#506)', async () => {
    mockGetItem.mockImplementation((key: string) =>
      Promise.resolve(
        key === ROUTE_KEY
          ? '{"type":"direct","stops":5,"line":"7"}'
          : key === DESTINATION_KEY
            ? JSON.stringify({ id: '7-013', name: '건대입구' })
            : key === LAST_NOTIFIED_STATION_KEY
              ? '7-015'
              : null,
      ),
    );
    const { result } = renderHook(() => useSilentPushDiagnostics());
    await waitFor(() => expect(result.current.hasRoute).toBe(true));
    expect(result.current.destinationId).toBe('7-013');
    expect(result.current.lastNotifiedStationId).toBe('7-015');
  });

  it('trip 입력 진단: storage가 비었으면 false/null로 graceful (#506)', async () => {
    const { result } = renderHook(() => useSilentPushDiagnostics());
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(result.current.hasRoute).toBe(false);
    expect(result.current.destinationId).toBeNull();
    expect(result.current.lastNotifiedStationId).toBeNull();
  });

  it('trip 입력 진단: destination JSON 손상 시 destinationId=null로 무시 (#506)', async () => {
    mockGetItem.mockImplementation((key: string) =>
      Promise.resolve(key === DESTINATION_KEY ? 'not-json{' : null),
    );
    const { result } = renderHook(() => useSilentPushDiagnostics());
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(result.current.destinationId).toBeNull();
  });

  it('trip 입력 진단: destination JSON에 id가 없거나 string이 아니면 null (#506)', async () => {
    mockGetItem.mockImplementation((key: string) =>
      Promise.resolve(key === DESTINATION_KEY ? JSON.stringify({ id: 42 }) : null),
    );
    const { result } = renderHook(() => useSilentPushDiagnostics());
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(result.current.destinationId).toBeNull();
  });

  it('unmount 시 listener 해제', () => {
    const removeSpy = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockReturnValue({
      remove: removeSpy,
    } as ReturnType<typeof AppState.addEventListener>);

    const { unmount } = renderHook(() => useSilentPushDiagnostics());
    unmount();
    expect(removeSpy).toHaveBeenCalled();
  });
});
