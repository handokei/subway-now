/* eslint-disable import/no-restricted-paths --
 * Cross-feature test mirroring source's disable. ADR Phase 5 (#890).
 */
import { act, renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { useDestinationStore } from '../../../route/store/useDestinationStore';
import { useBoardingLockStore } from '../../store/useBoardingLockStore';
import { MOCK_STATIONS } from '../../../../testUtils/fixtures';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

const mockIsLiveActivityEnabled = jest.fn();
const mockUpdateLiveActivity = jest.fn();

jest.mock('live-activity', () => ({
  isLiveActivityEnabled: () => mockIsLiveActivityEnabled(),
  updateLiveActivity: (...args: unknown[]) => mockUpdateLiveActivity(...args),
}));

const mockClearStationNotification = jest.fn();
jest.mock('../../utils/stationNotification', () => ({
  clearStationNotification: (...args: unknown[]) => mockClearStationNotification(...args),
}));

const mockGetCurrentTripCorrIdSync = jest.fn<string | null, []>(() => null);
jest.mock('../../../observability/utils/tripCorrId', () => ({
  getCurrentTripCorrIdSync: () => mockGetCurrentTripCorrIdSync(),
}));

const mockWarn = jest.fn();
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: (...args: unknown[]) => mockWarn(...args),
    error: jest.fn(),
  }),
}));

import { useLiveActivityPreBoardingLifecycle } from '../useLiveActivityPreBoardingLifecycle';

const { gangnam, chungmuro } = MOCK_STATIONS;

const LOCK: BoardingLock = {
  trainCode: 'T001',
  boardingLine: gangnam.line,
  boardingStationId: gangnam.id,
  destinationId: chungmuro.id,
  boardingEvidence: true,
  boardedAt: Date.now(),
  expectedDurationMs: 5 * 60 * 1000,
};

describe('useLiveActivityPreBoardingLifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsLiveActivityEnabled.mockReturnValue(true);
    mockUpdateLiveActivity.mockResolvedValue(undefined);
    mockClearStationNotification.mockResolvedValue(undefined);
    useDestinationStore.setState({ destination: null, tripOrigin: null });
    useBoardingLockStore.setState({ lock: null });
  });

  it('destination 없음 + lock 없음 → 아무 것도 하지 않는다', () => {
    renderHook(() => useLiveActivityPreBoardingLifecycle());
    expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
    expect(mockClearStationNotification).not.toHaveBeenCalled();
  });

  it('destination 설정(lock 없음) → pre-boarding LA update 호출', () => {
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: null });
    renderHook(() => useLiveActivityPreBoardingLifecycle());
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
    const data = mockUpdateLiveActivity.mock.calls[0][0];
    expect(data.boardingPhase).toBe('pre-boarding');
    expect(data.destinationName).toBeTruthy();
    // GPS 미확정 — placeholder stationName ("감지 중" i18n)
    expect(data.stationName).toBe('감지 중');
    expect(data.boardingPromptOriginStation).toBeUndefined();
  });

  it('tripOrigin 확보되면 실제 역/노선 정보로 pre-boarding LA를 채운다', () => {
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam });
    renderHook(() => useLiveActivityPreBoardingLifecycle());
    const data = mockUpdateLiveActivity.mock.calls[0][0];
    expect(data.stationName).toBe(gangnam.name);
    expect(data.lineColorHex).toBe(gangnam.lineColor);
    expect(data.boardingPromptOriginStation).toBe(gangnam.name);
    expect(data.boardingPromptLine).toBe(gangnam.line);
  });

  it('tripToken이 있으면 boardingPromptTripToken을 싣는다', () => {
    mockGetCurrentTripCorrIdSync.mockReturnValue('corr-123');
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: null });
    renderHook(() => useLiveActivityPreBoardingLifecycle());
    const data = mockUpdateLiveActivity.mock.calls[0][0];
    expect(data.boardingPromptTripToken).toBe('corr-123');
  });

  it('이미 GPS 경로로 LA가 떠 있어도(활성 세션 판단 불가) 이 훅은 native update만 호출한다 — start 이중 호출 없음', () => {
    // ensureLiveActivityRegistered/startLiveActivity 경로를 타지 않는지 — updateLiveActivity만 호출됐는지 검증.
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam });
    renderHook(() => useLiveActivityPreBoardingLifecycle());
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
  });

  it('lock 생성됨 → 콘텐츠 소유권을 넘기고 이 훅은 native 호출을 하지 않는다', () => {
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam });
    useBoardingLockStore.setState({ lock: LOCK });
    renderHook(() => useLiveActivityPreBoardingLifecycle());
    expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
    expect(mockClearStationNotification).not.toHaveBeenCalled();
  });

  it('pre-boarding 세션을 스스로 시작한 뒤 lock이 생성되고, 이후 destination이 해제돼도 종료 호출을 하지 않는다(GPS 파이프라인 책임)', () => {
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam });
    const { rerender } = renderHook(() => useLiveActivityPreBoardingLifecycle());
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);

    act(() => {
      useBoardingLockStore.setState({ lock: LOCK });
    });
    rerender({});

    act(() => {
      useDestinationStore.setState({ destination: null, tripOrigin: null });
    });
    rerender({});

    expect(mockClearStationNotification).not.toHaveBeenCalled();
  });

  it('스스로 시작한 pre-boarding 세션 중 destination이 해제되면 clearStationNotification으로 종료', () => {
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam });
    const { rerender } = renderHook(() => useLiveActivityPreBoardingLifecycle());
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);

    act(() => {
      useDestinationStore.setState({ destination: null, tripOrigin: null });
    });
    rerender({});

    expect(mockClearStationNotification).toHaveBeenCalledTimes(1);
  });

  it('Android — 아무 것도 하지 않는다', () => {
    const originalOS = Platform.OS;
    Object.defineProperty(Platform, 'OS', { get: () => 'android' });
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam });
    renderHook(() => useLiveActivityPreBoardingLifecycle());
    expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
    Object.defineProperty(Platform, 'OS', { get: () => originalOS });
  });

  it('Live Activity 비활성이면 update를 호출하지 않는다', () => {
    mockIsLiveActivityEnabled.mockReturnValue(false);
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: null });
    renderHook(() => useLiveActivityPreBoardingLifecycle());
    expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
  });

  it('updateLiveActivity가 throw하면 logger.warn으로 흡수', async () => {
    mockUpdateLiveActivity.mockRejectedValueOnce(new Error('native fail'));
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: null });
    renderHook(() => useLiveActivityPreBoardingLifecycle());
    await Promise.resolve();
    await Promise.resolve();
    expect(mockWarn).toHaveBeenCalledWith('pre-boarding LA 갱신 실패', expect.any(Error));
  });

  it('clearStationNotification이 throw하면 logger.warn으로 흡수', async () => {
    mockClearStationNotification.mockRejectedValueOnce(new Error('end fail'));
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam });
    const { rerender } = renderHook(() => useLiveActivityPreBoardingLifecycle());
    act(() => {
      useDestinationStore.setState({ destination: null, tripOrigin: null });
    });
    rerender({});
    await Promise.resolve();
    await Promise.resolve();
    expect(mockWarn).toHaveBeenCalledWith('pre-boarding LA 종료 실패', expect.any(Error));
  });
});
