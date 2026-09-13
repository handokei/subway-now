const mockUseBackendSsotMirrorPoll = jest.fn();
jest.mock('../useBackendSsotMirrorPoll', () => ({
  useBackendSsotMirrorPoll: () => mockUseBackendSsotMirrorPoll(),
}));

const mockResolveBackendSsotMirrorStation = jest.fn();
jest.mock('../../utils/backendSsotMirror', () => ({
  resolveBackendSsotMirrorStation: (...args: unknown[]) =>
    mockResolveBackendSsotMirrorStation(...args),
}));

const mockUpdateLiveActivityFromMirrorStation = jest.fn().mockResolvedValue(undefined);
jest.mock('../../utils/liveActivityMirrorSync', () => ({
  updateLiveActivityFromMirrorStation: (...args: unknown[]) =>
    mockUpdateLiveActivityFromMirrorStation(...args),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { Platform } from 'react-native';
import { renderHook } from '@testing-library/react-native';
import { useForegroundLaMirrorSync } from '../useForegroundLaMirrorSync';

const destination = { id: '0228', name: '강남', line: '2' as const, lat: 37.5, lng: 127.0, lineColor: '#00A84D' };
const gangnam = { id: '0228', name: '강남', line: '2' as const, lat: 37.5, lng: 127.0, lineColor: '#00A84D' };
const yeoksam = { id: '0226', name: '역삼', line: '2' as const, lat: 37.5, lng: 127.04, lineColor: '#00A84D' };
const directRoute = { type: 'direct' as const, line: '2' as const, stops: 1, travelSeconds: 120 };
const mirrorEntry = {
  currentStationId: '역삼',
  motionState: 'moving' as const,
  lastAdvanceEvidence: 'position-train',
  lastAdvanceAt: 1_700_000_000_000,
  passedStations: [],
  receivedAt: 1_700_000_000_000,
};

describe('useForegroundLaMirrorSync', () => {
  const originalOs = Platform.OS;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseBackendSsotMirrorPoll.mockReturnValue(null);
    mockResolveBackendSsotMirrorStation.mockReturnValue(null);
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
  });

  it('non-iOS면 no-op', () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    mockResolveBackendSsotMirrorStation.mockReturnValue(yeoksam);
    renderHook(() => useForegroundLaMirrorSync(destination, directRoute));
    expect(mockUpdateLiveActivityFromMirrorStation).not.toHaveBeenCalled();
  });

  it('destination 없으면 no-op', () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    mockResolveBackendSsotMirrorStation.mockReturnValue(yeoksam);
    renderHook(() => useForegroundLaMirrorSync(null, directRoute));
    expect(mockUpdateLiveActivityFromMirrorStation).not.toHaveBeenCalled();
  });

  it('mirror 없으면(stale/absent) no-op', () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(null);
    renderHook(() => useForegroundLaMirrorSync(destination, directRoute));
    expect(mockResolveBackendSsotMirrorStation).not.toHaveBeenCalled();
    expect(mockUpdateLiveActivityFromMirrorStation).not.toHaveBeenCalled();
  });

  it('mirror station이 거부(line 불일치 등)되면 no-op', () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    mockResolveBackendSsotMirrorStation.mockReturnValue(null);
    renderHook(() => useForegroundLaMirrorSync(destination, directRoute));
    expect(mockUpdateLiveActivityFromMirrorStation).not.toHaveBeenCalled();
  });

  it('mirror 역 전진 시 updateLiveActivityFromMirrorStation 호출(역명 반영)', () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    mockResolveBackendSsotMirrorStation.mockReturnValue(yeoksam);
    renderHook(() => useForegroundLaMirrorSync(destination, directRoute, '2'));
    expect(mockResolveBackendSsotMirrorStation).toHaveBeenCalledWith(mirrorEntry, '2');
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledWith(
      yeoksam,
      destination,
      directRoute,
    );
  });

  it('동일 역 재수신 시 dedup — 두 번째 호출 없음', () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    mockResolveBackendSsotMirrorStation.mockReturnValue(yeoksam);
    const { rerender } = renderHook(
      ({ mirror }: { mirror: typeof mirrorEntry }) => {
        mockUseBackendSsotMirrorPoll.mockReturnValue(mirror);
        return useForegroundLaMirrorSync(destination, directRoute);
      },
      { initialProps: { mirror: mirrorEntry } },
    );
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(1);

    // 동일 역을 가리키는 새 entry(receivedAt만 갱신) — dedup으로 재호출 없어야 함.
    const sameStationLaterEntry = { ...mirrorEntry, receivedAt: mirrorEntry.receivedAt + 5_000 };
    rerender({ mirror: sameStationLaterEntry });
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(1);
  });

  it('역이 바뀌면 dedup ref 갱신 후 재호출', () => {
    mockResolveBackendSsotMirrorStation.mockReturnValueOnce(yeoksam).mockReturnValueOnce(gangnam);
    const { rerender } = renderHook(
      ({ mirror }: { mirror: typeof mirrorEntry }) => {
        mockUseBackendSsotMirrorPoll.mockReturnValue(mirror);
        return useForegroundLaMirrorSync(destination, directRoute);
      },
      { initialProps: { mirror: mirrorEntry } },
    );
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(1);

    const advancedEntry = { ...mirrorEntry, currentStationId: '강남', receivedAt: mirrorEntry.receivedAt + 5_000 };
    rerender({ mirror: advancedEntry });
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(2);
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenLastCalledWith(
      gangnam,
      destination,
      directRoute,
    );
  });

  it('destination이 null로 바뀌면 dedup ref가 리셋된다 (재도착 시 재적용)', () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    mockResolveBackendSsotMirrorStation.mockReturnValue(yeoksam);
    const { rerender } = renderHook(
      ({ dest }: { dest: typeof destination | null }) =>
        useForegroundLaMirrorSync(dest, directRoute),
      { initialProps: { dest: destination } },
    );
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(1);

    rerender({ dest: null });
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(1);

    rerender({ dest: destination });
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(2);
  });

  it('updateLiveActivityFromMirrorStation reject는 swallow(logger.warn만)', async () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    mockResolveBackendSsotMirrorStation.mockReturnValue(yeoksam);
    mockUpdateLiveActivityFromMirrorStation.mockRejectedValueOnce(new Error('native fail'));
    renderHook(() => useForegroundLaMirrorSync(destination, directRoute));
    await Promise.resolve();
    await Promise.resolve();
  });
});
