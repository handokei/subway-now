const mockUseBackendSsotMirrorPoll = jest.fn();
jest.mock('../useBackendSsotMirrorPoll', () => ({
  useBackendSsotMirrorPoll: (...args: unknown[]) => mockUseBackendSsotMirrorPoll(...args),
}));

const mockResolveBackendSsotMirrorStation = jest.fn();
jest.mock('../../utils/backendSsotMirror', () => ({
  resolveBackendSsotMirrorStation: (...args: unknown[]) =>
    mockResolveBackendSsotMirrorStation(...args),
}));

const mockEvaluateBackendSsotCrossLineGuard = jest.fn((..._args: unknown[]) => false);
jest.mock('../../../route/utils/approachLine', () => ({
  evaluateBackendSsotCrossLineGuard: (...args: unknown[]) =>
    mockEvaluateBackendSsotCrossLineGuard(...args),
}));

const mockUpdateLiveActivityFromMirrorStation = jest.fn().mockResolvedValue(true);
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
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';
import { useForegroundLaMirrorSync } from '../useForegroundLaMirrorSync';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

const destination = {
  id: '0228',
  name: canonicalStationName('강남', '2'),
  line: '2' as const,
  lat: 37.5,
  lng: 127.0,
  lineColor: '#00A84D',
};
const gangnam = destination;
const yeoksam = {
  id: '0226',
  name: canonicalStationName('역삼', '2'),
  line: '2' as const,
  lat: 37.5,
  lng: 127.04,
  lineColor: '#00A84D',
};
const directRoute = { type: 'direct' as const, line: '2' as const, stops: 1, travelSeconds: 120 };
const boardingLock: BoardingLock = {
  destinationId: destination.id,
  trainCode: 'train-1',
  boardingStationId: '0001',
  boardingLine: '2',
  boardedAt: 1_700_000_000_000,
  expectedDurationMs: 600_000,
};
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
    mockEvaluateBackendSsotCrossLineGuard.mockReturnValue(false);
    mockUpdateLiveActivityFromMirrorStation.mockResolvedValue(true);
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
  });

  it('non-iOS면 no-op — useBackendSsotMirrorPoll도 enabled=false로 호출', () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    mockResolveBackendSsotMirrorStation.mockReturnValue(yeoksam);
    renderHook(() => useForegroundLaMirrorSync(destination, directRoute, null, null));
    expect(mockUseBackendSsotMirrorPoll).toHaveBeenCalledWith(false);
    expect(mockUpdateLiveActivityFromMirrorStation).not.toHaveBeenCalled();
  });

  it('destination 없으면 no-op — useBackendSsotMirrorPoll enabled=false', () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    mockResolveBackendSsotMirrorStation.mockReturnValue(yeoksam);
    renderHook(() => useForegroundLaMirrorSync(null, directRoute, null, null));
    expect(mockUseBackendSsotMirrorPoll).toHaveBeenCalledWith(false);
    expect(mockUpdateLiveActivityFromMirrorStation).not.toHaveBeenCalled();
  });

  it('destination 있으면 useBackendSsotMirrorPoll enabled=true (iOS)', () => {
    renderHook(() => useForegroundLaMirrorSync(destination, directRoute, null, null));
    expect(mockUseBackendSsotMirrorPoll).toHaveBeenCalledWith(true);
  });

  it('mirror 없으면(stale/absent) no-op', () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(null);
    renderHook(() => useForegroundLaMirrorSync(destination, directRoute, null, null));
    expect(mockResolveBackendSsotMirrorStation).not.toHaveBeenCalled();
    expect(mockUpdateLiveActivityFromMirrorStation).not.toHaveBeenCalled();
  });

  it('mirror station이 거부(line 불일치 등)되면 no-op', () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    mockResolveBackendSsotMirrorStation.mockReturnValue(null);
    renderHook(() => useForegroundLaMirrorSync(destination, directRoute, null, null));
    expect(mockUpdateLiveActivityFromMirrorStation).not.toHaveBeenCalled();
  });

  it('lockLine은 boardingLock.boardingLine을 resolveBackendSsotMirrorStation에 강제한다', () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    mockResolveBackendSsotMirrorStation.mockReturnValue(yeoksam);
    renderHook(() => useForegroundLaMirrorSync(destination, directRoute, boardingLock, null));
    expect(mockResolveBackendSsotMirrorStation).toHaveBeenCalledWith(mirrorEntry, '2');
  });

  it('cross-line 가드가 거부하면 no-op (보수적 미갱신)', () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    mockResolveBackendSsotMirrorStation.mockReturnValue(yeoksam);
    mockEvaluateBackendSsotCrossLineGuard.mockReturnValue(true);
    renderHook(() => useForegroundLaMirrorSync(destination, directRoute, boardingLock, '7'));
    expect(mockEvaluateBackendSsotCrossLineGuard).toHaveBeenCalledWith(
      yeoksam.line,
      null,
      boardingLock,
      '7',
    );
    expect(mockUpdateLiveActivityFromMirrorStation).not.toHaveBeenCalled();
  });

  it('cross-line 가드 통과 + mirror 역 전진 시 updateLiveActivityFromMirrorStation 호출', async () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    mockResolveBackendSsotMirrorStation.mockReturnValue(yeoksam);
    renderHook(() => useForegroundLaMirrorSync(destination, directRoute, boardingLock, null));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockResolveBackendSsotMirrorStation).toHaveBeenCalledWith(mirrorEntry, '2');
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledWith(
      yeoksam,
      destination,
      directRoute,
    );
  });

  it('동일 (destination, route, station) 재수신 시 dedup — 두 번째 호출 없음', async () => {
    mockResolveBackendSsotMirrorStation.mockReturnValue(yeoksam);
    const { rerender } = renderHook(
      ({ mirror }: { mirror: typeof mirrorEntry }) => {
        mockUseBackendSsotMirrorPoll.mockReturnValue(mirror);
        return useForegroundLaMirrorSync(destination, directRoute, null, null);
      },
      { initialProps: { mirror: mirrorEntry } },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(1);

    // 동일 역을 가리키는 새 entry(receivedAt만 갱신) — dedup으로 재호출 없어야 함.
    const sameStationLaterEntry = { ...mirrorEntry, receivedAt: mirrorEntry.receivedAt + 5_000 };
    rerender({ mirror: sameStationLaterEntry });
    await Promise.resolve();
    await Promise.resolve();
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(1);
  });

  it('updateLiveActivityFromMirrorStation이 no-op(applied=false) 반환 시 dedup ref를 기록하지 않아 다음 tick 재시도', async () => {
    mockResolveBackendSsotMirrorStation.mockReturnValue(yeoksam);
    mockUpdateLiveActivityFromMirrorStation.mockResolvedValueOnce(false);
    const { rerender } = renderHook(
      ({ mirror }: { mirror: typeof mirrorEntry }) => {
        mockUseBackendSsotMirrorPoll.mockReturnValue(mirror);
        return useForegroundLaMirrorSync(destination, directRoute, null, null);
      },
      { initialProps: { mirror: mirrorEntry } },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(1);

    // 같은 station이지만 재수신 tick — 이전 tick이 no-op(applied=false)이었으므로 ref가 기록되지
    // 않아 재시도되어야 한다.
    const sameStationLaterEntry = { ...mirrorEntry, receivedAt: mirrorEntry.receivedAt + 5_000 };
    mockUpdateLiveActivityFromMirrorStation.mockResolvedValueOnce(true);
    rerender({ mirror: sameStationLaterEntry });
    await Promise.resolve();
    await Promise.resolve();
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(2);
  });

  it('역이 바뀌면 dedup key가 바뀌어 재호출', async () => {
    mockResolveBackendSsotMirrorStation.mockReturnValueOnce(yeoksam).mockReturnValueOnce(gangnam);
    const { rerender } = renderHook(
      ({ mirror }: { mirror: typeof mirrorEntry }) => {
        mockUseBackendSsotMirrorPoll.mockReturnValue(mirror);
        return useForegroundLaMirrorSync(destination, directRoute, null, null);
      },
      { initialProps: { mirror: mirrorEntry } },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(1);

    const advancedEntry = {
      ...mirrorEntry,
      currentStationId: '강남',
      receivedAt: mirrorEntry.receivedAt + 5_000,
    };
    rerender({ mirror: advancedEntry });
    await Promise.resolve();
    await Promise.resolve();
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(2);
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenLastCalledWith(
      gangnam,
      destination,
      directRoute,
    );
  });

  it('destination은 같지만 route가 바뀌면(같은 station) dedup key가 바뀌어 재호출', async () => {
    mockResolveBackendSsotMirrorStation.mockReturnValue(yeoksam);
    const { rerender } = renderHook(
      ({ route }: { route: typeof directRoute }) => {
        mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
        return useForegroundLaMirrorSync(destination, route, null, null);
      },
      { initialProps: { route: directRoute } },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(1);

    const changedRoute = { ...directRoute, stops: 2 };
    rerender({ route: changedRoute });
    await Promise.resolve();
    await Promise.resolve();
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(2);
  });

  it('destination이 바뀌면 dedup key가 바뀌어 재적용 (같은 station이어도)', async () => {
    mockResolveBackendSsotMirrorStation.mockReturnValue(yeoksam);
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    const otherDestination = { ...destination, id: '9999' };
    const { rerender } = renderHook(
      ({ dest }: { dest: typeof destination }) =>
        useForegroundLaMirrorSync(dest, directRoute, null, null),
      { initialProps: { dest: destination } },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(1);

    rerender({ dest: otherDestination });
    await Promise.resolve();
    await Promise.resolve();
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(2);
  });

  it('destination이 null로 바뀌면 dedup ref가 리셋된다 (재도착 시 재적용)', async () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    mockResolveBackendSsotMirrorStation.mockReturnValue(yeoksam);
    const { rerender } = renderHook(
      ({ dest }: { dest: typeof destination | null }) =>
        useForegroundLaMirrorSync(dest, directRoute, null, null),
      { initialProps: { dest: destination } },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(1);

    rerender({ dest: null });
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(1);

    rerender({ dest: destination });
    await Promise.resolve();
    await Promise.resolve();
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(2);
  });

  it('updateLiveActivityFromMirrorStation reject는 swallow(logger.warn만)', async () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    mockResolveBackendSsotMirrorStation.mockReturnValue(yeoksam);
    mockUpdateLiveActivityFromMirrorStation.mockRejectedValueOnce(new Error('native fail'));
    renderHook(() => useForegroundLaMirrorSync(destination, directRoute, null, null));
    await Promise.resolve();
    await Promise.resolve();
  });

  it('unmount 후 늦게 resolve되어도 dedup ref/state를 건드리지 않는다', async () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    mockResolveBackendSsotMirrorStation.mockReturnValue(yeoksam);
    let resolveUpdate: (applied: boolean) => void = () => {};
    mockUpdateLiveActivityFromMirrorStation.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveUpdate = resolve;
      }),
    );
    const { unmount } = renderHook(() =>
      useForegroundLaMirrorSync(destination, directRoute, null, null),
    );
    unmount();
    resolveUpdate(true);
    await Promise.resolve();
    await Promise.resolve();
  });

  it('unmount 후 늦게 reject되어도 swallow — cancelled 가드가 catch 경로도 커버', async () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    mockResolveBackendSsotMirrorStation.mockReturnValue(yeoksam);
    let rejectUpdate: (e: Error) => void = () => {};
    mockUpdateLiveActivityFromMirrorStation.mockReturnValueOnce(
      new Promise<boolean>((_resolve, reject) => {
        rejectUpdate = reject;
      }),
    );
    const { unmount } = renderHook(() =>
      useForegroundLaMirrorSync(destination, directRoute, null, null),
    );
    unmount();
    rejectUpdate(new Error('late native fail'));
    await Promise.resolve();
    await Promise.resolve();
  });
});
