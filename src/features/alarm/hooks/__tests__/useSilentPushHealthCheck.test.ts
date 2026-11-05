/**
 * #1677 — useSilentPushHealthCheck 회귀 가드.
 *
 * 시나리오:
 *   1. 정상 (최근 30s 내 수신 기록) → healthy=true.
 *   2. silent push 60s+ 부재 → healthy=false.
 *   3. alarmLog 엔트리 없음(최초 실행) → healthy=true (초기값 유지, lastReceivedAt=null).
 *   4. silent push 재수신 후 복구 → healthy=true로 전환.
 *   5. BG / silent-push-fired (non-received) 엔트리는 healthy 판정에 영향 없음.
 */

import { renderHook, act, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';

const mockGetAlarmLog = jest.fn();
jest.mock('../../utils/alarmLog', () => ({
  getAlarmLog: () => mockGetAlarmLog(),
}));

// AppState.addEventListener mock은 아래 beforeEach에서 spyOn으로 처리.

import {
  useSilentPushHealthCheck,
  SILENT_PUSH_HEALTH_THRESHOLD_MS,
  SILENT_PUSH_HEALTH_POLL_INTERVAL_MS,
} from '../useSilentPushHealthCheck';

type AlarmLogEntry = { source: string; ts: number };

/** alarmLog를 [source, ts] 배열로 구성한 fixture 반환. */
function makeLog(entries: AlarmLogEntry[]) {
  return entries.map((e) => ({ ...e }));
}

describe('useSilentPushHealthCheck', () => {
  let removeListenerMock: jest.Mock;
  let appStateCallback: ((state: string) => void) | null;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    removeListenerMock = jest.fn();
    appStateCallback = null;

    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, cb) => {
      appStateCallback = cb as (state: string) => void;
      return { remove: removeListenerMock };
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('시나리오 1: 최근 30s 내 수신 기록 있음 → healthy=true', async () => {
    const now = 1_000_000;
    jest.setSystemTime(now);
    const receivedAt = now - 30_000; // 30s 전 (threshold 60s 이내)
    mockGetAlarmLog.mockResolvedValue(
      makeLog([{ source: 'silent-push-received', ts: receivedAt }]),
    );

    const { result } = renderHook(() => useSilentPushHealthCheck());
    await waitFor(() => expect(result.current.lastReceivedAt).toBe(receivedAt));

    expect(result.current.healthy).toBe(true);
    expect(result.current.lastReceivedAt).toBe(receivedAt);
  });

  it('시나리오 2: silent push 60s+ 부재 → healthy=false', async () => {
    const now = 1_000_000;
    jest.setSystemTime(now);
    const receivedAt = now - SILENT_PUSH_HEALTH_THRESHOLD_MS - 1; // threshold 초과
    mockGetAlarmLog.mockResolvedValue(
      makeLog([{ source: 'silent-push-received', ts: receivedAt }]),
    );

    const { result } = renderHook(() => useSilentPushHealthCheck());
    await waitFor(() => expect(result.current.lastReceivedAt).toBe(receivedAt));

    expect(result.current.healthy).toBe(false);
    expect(result.current.lastReceivedAt).toBe(receivedAt);
  });

  it('시나리오 3: alarmLog 엔트리 없음(최초 실행) → healthy=true, lastReceivedAt=null', async () => {
    const now = 3_000_000;
    jest.setSystemTime(now);
    mockGetAlarmLog.mockResolvedValue([]);

    const { result } = renderHook(() => useSilentPushHealthCheck());
    // alarmLog 없음: latest=null → healthy = (null === null || ...) = true.
    // waitFor로 setState가 최종 settled될 때까지 기다린다.
    // healthy=true가 초기값이지만 refresh 후에도 그대로여야 한다 — state identity는
    // setState reducer의 no-op gate(prev.healthy === next.healthy)로 확인.
    await act(async () => { await Promise.resolve(); });
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalledTimes(1));
    // alarmLog refresh 후에도 healthy=true 유지 (null → healthy=true 공식).
    expect(result.current.healthy).toBe(true);
    expect(result.current.lastReceivedAt).toBeNull();
  });

  it('시나리오 4: AppState active 전환(재수신) 후 healthy=true로 복구', async () => {
    const now = 1_000_000;
    jest.setSystemTime(now);

    // 처음: unhealthy (60s+ 이전)
    const staleTs = now - SILENT_PUSH_HEALTH_THRESHOLD_MS - 1;
    mockGetAlarmLog.mockResolvedValueOnce(
      makeLog([{ source: 'silent-push-received', ts: staleTs }]),
    );

    const { result } = renderHook(() => useSilentPushHealthCheck());
    await waitFor(() => expect(result.current.healthy).toBe(false));

    // silent push 재수신 — 새 fresh entry 추가.
    const freshTs = now - 10_000; // 10s 전
    mockGetAlarmLog.mockResolvedValue(
      makeLog([
        { source: 'silent-push-received', ts: staleTs },
        { source: 'silent-push-received', ts: freshTs },
      ]),
    );

    // AppState 'active' 전환 → refresh.
    act(() => {
      appStateCallback?.('active');
    });
    await waitFor(() => expect(result.current.healthy).toBe(true));

    expect(result.current.lastReceivedAt).toBe(freshTs);
  });

  it('시나리오 5: non-received 엔트리(silent-push-fired 등)는 healthy 판정에 영향 없음', async () => {
    const now = 1_000_000;
    jest.setSystemTime(now);

    // silent-push-fired 엔트리 있음(최근) + silent-push-received 없음.
    mockGetAlarmLog.mockResolvedValue(
      makeLog([
        { source: 'silent-push-fired', ts: now - 10_000 },
        { source: 'fg-evaluated', ts: now - 5_000 },
      ]),
    );

    const { result } = renderHook(() => useSilentPushHealthCheck());
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());

    // received 없음 → lastReceivedAt=null → healthy=true (초기값 유지).
    expect(result.current.healthy).toBe(true);
    expect(result.current.lastReceivedAt).toBeNull();
  });

  it('30s interval 경과 시 alarmLog 재조회', async () => {
    const now = 1_000_000;
    jest.setSystemTime(now);
    mockGetAlarmLog.mockResolvedValue([]);

    renderHook(() => useSilentPushHealthCheck());
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalledTimes(1));

    // 30s 경과.
    act(() => {
      jest.advanceTimersByTime(SILENT_PUSH_HEALTH_POLL_INTERVAL_MS);
    });
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalledTimes(2));
  });

  it('unmount 시 interval + AppState listener 정리', async () => {
    mockGetAlarmLog.mockResolvedValue([]);
    const { unmount } = renderHook(() => useSilentPushHealthCheck());
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());

    unmount();
    // 언마운트 후 removeListener 호출 확인.
    expect(removeListenerMock).toHaveBeenCalled();
    // 언마운트 후 interval 경과해도 추가 getAlarmLog 없음.
    const callCount = mockGetAlarmLog.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(SILENT_PUSH_HEALTH_POLL_INTERVAL_MS * 2);
    });
    expect(mockGetAlarmLog).toHaveBeenCalledTimes(callCount);
  });

  it('AppState background/inactive 전환은 refresh 미호출', async () => {
    mockGetAlarmLog.mockResolvedValue([]);
    renderHook(() => useSilentPushHealthCheck());
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalledTimes(1));

    // background / inactive 전환 — refresh 호출 없음.
    act(() => {
      appStateCallback?.('background');
      appStateCallback?.('inactive');
    });
    // 추가 getAlarmLog 호출 없음 (initial 1회만).
    expect(mockGetAlarmLog).toHaveBeenCalledTimes(1);
  });

  it('복수 silent-push-received 엔트리 중 가장 최신 ts 선택 (내림차순 입력)', async () => {
    const now = 2_000_000;
    jest.setSystemTime(now);

    const oldTs = now - 50_000; // 50s 전
    const newTs = now - 20_000; // 20s 전 (최신)
    // 내림차순(최신 먼저) 입력 → latest가 이미 newTs일 때 oldTs < latest → branch(line 47) 미실행.
    mockGetAlarmLog.mockResolvedValue(
      makeLog([
        { source: 'silent-push-received', ts: newTs }, // 최신 먼저
        { source: 'silent-push-received', ts: oldTs }, // 이전 — ts <= latest이므로 분기 skip
      ]),
    );

    const { result } = renderHook(() => useSilentPushHealthCheck());
    await waitFor(() => expect(result.current.lastReceivedAt).toBe(newTs));

    // 가장 최신(newTs) 기준 — threshold(60s) 이내 → healthy.
    expect(result.current.healthy).toBe(true);
  });

  it('복수 silent-push-received 엔트리 중 가장 최신 ts 선택 (오름차순 입력)', async () => {
    const now = 2_000_000;
    jest.setSystemTime(now);

    const oldTs = now - 50_000; // 50s 전
    const newTs = now - 20_000; // 20s 전 (최신)
    // 오름차순(오래된 것 먼저) 입력 → latest가 null → oldTs 설정, 다음에 newTs > oldTs → 갱신.
    mockGetAlarmLog.mockResolvedValue(
      makeLog([
        { source: 'silent-push-received', ts: oldTs }, // 먼저
        { source: 'silent-push-received', ts: newTs }, // 최신 → 갱신
      ]),
    );

    const { result } = renderHook(() => useSilentPushHealthCheck());
    await waitFor(() => expect(result.current.lastReceivedAt).toBe(newTs));

    expect(result.current.healthy).toBe(true);
  });
});
