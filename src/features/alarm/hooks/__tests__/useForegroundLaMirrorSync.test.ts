const mockUseBackendSsotMirrorPoll = jest.fn();
jest.mock('../useBackendSsotMirrorPoll', () => ({
  useBackendSsotMirrorPoll: (...args: unknown[]) => mockUseBackendSsotMirrorPoll(...args),
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
    mockUpdateLiveActivityFromMirrorStation.mockResolvedValue(true);
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
  });

  it('non-iOS면 no-op — useBackendSsotMirrorPoll도 enabled=false로 호출', () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    renderHook(() => useForegroundLaMirrorSync(destination, directRoute, yeoksam));
    expect(mockUseBackendSsotMirrorPoll).toHaveBeenCalledWith(false);
    expect(mockUpdateLiveActivityFromMirrorStation).not.toHaveBeenCalled();
  });

  it('destination 없으면 no-op — useBackendSsotMirrorPoll enabled=false', () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    renderHook(() => useForegroundLaMirrorSync(null, directRoute, yeoksam));
    expect(mockUseBackendSsotMirrorPoll).toHaveBeenCalledWith(false);
    expect(mockUpdateLiveActivityFromMirrorStation).not.toHaveBeenCalled();
  });

  it('currentStation 없으면 no-op (mirror/destination이 있어도)', () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    renderHook(() => useForegroundLaMirrorSync(destination, directRoute, null));
    expect(mockUpdateLiveActivityFromMirrorStation).not.toHaveBeenCalled();
  });

  it('destination 있으면 useBackendSsotMirrorPoll enabled=true (iOS)', () => {
    renderHook(() => useForegroundLaMirrorSync(destination, directRoute, yeoksam));
    expect(mockUseBackendSsotMirrorPoll).toHaveBeenCalledWith(true);
  });

  it('mirror 없으면(stale/absent) no-op — backend 갱신 트리거가 없으므로 미갱신', () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(null);
    renderHook(() => useForegroundLaMirrorSync(destination, directRoute, yeoksam));
    expect(mockUpdateLiveActivityFromMirrorStation).not.toHaveBeenCalled();
  });

  // #2790 (code review P3) — mirror의 currentStationId 자체가 currentStation과 발산하는 mirror를
  // 주입해 "mirror content는 station 결정에 안 쓰인다"는 계약을 명시적으로 실증한다. mirror는
  // 강남을 가리키지만 currentStation은 역삼 — LA는 강남이 아니라 역삼(currentStation)으로
  // 호출돼야 한다. (currentStationId='역삼'인 mirrorEntry만으로는 두 값이 우연히 같아 이 계약을
  // 증명하지 못했다 — mirror는 이제 station 소스가 아니라 트리거일 뿐이므로 content는 무관해야 함.)
  it('#2790: LA는 mirror가 가리키는 역이 아니라 in-app 채택 currentStation을 따른다 (mirror는 강남, currentStation은 역삼)', async () => {
    const mirrorPointingElsewhere = { ...mirrorEntry, currentStationId: '강남' };
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorPointingElsewhere);
    renderHook(() => useForegroundLaMirrorSync(destination, directRoute, yeoksam));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledWith(
      yeoksam,
      destination,
      directRoute,
    );
    // mirror가 가리키는 강남으로는 호출되지 않아야 한다 — 실패 사유를 명확히 구분.
    expect(mockUpdateLiveActivityFromMirrorStation).not.toHaveBeenCalledWith(
      gangnam,
      destination,
      directRoute,
    );
  });

  it('mirror 트리거 + currentStation 있으면 updateLiveActivityFromMirrorStation 호출', async () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    renderHook(() => useForegroundLaMirrorSync(destination, directRoute, yeoksam));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledWith(
      yeoksam,
      destination,
      directRoute,
    );
  });

  it('동일 (destination, route, currentStation) 재수신 시 dedup — 두 번째 호출 없음', async () => {
    const { rerender } = renderHook(
      ({ mirror }: { mirror: typeof mirrorEntry }) => {
        mockUseBackendSsotMirrorPoll.mockReturnValue(mirror);
        return useForegroundLaMirrorSync(destination, directRoute, yeoksam);
      },
      { initialProps: { mirror: mirrorEntry } },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(1);

    // 같은 currentStation을 가리키는 새 mirror entry(receivedAt만 갱신) — dedup으로 재호출 없어야 함.
    const sameStationLaterEntry = { ...mirrorEntry, receivedAt: mirrorEntry.receivedAt + 5_000 };
    rerender({ mirror: sameStationLaterEntry });
    await Promise.resolve();
    await Promise.resolve();
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(1);
  });

  it('updateLiveActivityFromMirrorStation이 no-op(applied=false) 반환 시 dedup ref를 기록하지 않아 다음 tick 재시도', async () => {
    mockUpdateLiveActivityFromMirrorStation.mockResolvedValueOnce(false);
    const { rerender } = renderHook(
      ({ mirror }: { mirror: typeof mirrorEntry }) => {
        mockUseBackendSsotMirrorPoll.mockReturnValue(mirror);
        return useForegroundLaMirrorSync(destination, directRoute, yeoksam);
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

  it('currentStation이 바뀌면(역 전진) dedup key가 바뀌어 재호출', async () => {
    const { rerender } = renderHook(
      ({ station }: { station: typeof yeoksam }) => {
        mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
        return useForegroundLaMirrorSync(destination, directRoute, station);
      },
      { initialProps: { station: yeoksam } },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(1);

    rerender({ station: gangnam });
    await Promise.resolve();
    await Promise.resolve();
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(2);
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenLastCalledWith(
      gangnam,
      destination,
      directRoute,
    );
  });

  it('destination은 같지만 route가 바뀌면(같은 currentStation) dedup key가 바뀌어 재호출', async () => {
    const { rerender } = renderHook(
      ({ route }: { route: typeof directRoute }) => {
        mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
        return useForegroundLaMirrorSync(destination, route, yeoksam);
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

  it('destination이 바뀌면 dedup key가 바뀌어 재적용 (같은 currentStation이어도)', async () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    const otherDestination = { ...destination, id: '9999' };
    const { rerender } = renderHook(
      ({ dest }: { dest: typeof destination }) =>
        useForegroundLaMirrorSync(dest, directRoute, yeoksam),
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
    const { rerender } = renderHook(
      ({ dest }: { dest: typeof destination | null }) =>
        useForegroundLaMirrorSync(dest, directRoute, yeoksam),
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

  it('currentStation이 null로 바뀌면 dedup ref가 리셋된다 (재도착 시 재적용)', async () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    const { rerender } = renderHook(
      ({ station }: { station: typeof yeoksam | null }) =>
        useForegroundLaMirrorSync(destination, directRoute, station),
      { initialProps: { station: yeoksam } },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(1);

    rerender({ station: null });
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(1);

    rerender({ station: yeoksam });
    await Promise.resolve();
    await Promise.resolve();
    expect(mockUpdateLiveActivityFromMirrorStation).toHaveBeenCalledTimes(2);
  });

  it('updateLiveActivityFromMirrorStation reject는 swallow(logger.warn만)', async () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    mockUpdateLiveActivityFromMirrorStation.mockRejectedValueOnce(new Error('native fail'));
    renderHook(() => useForegroundLaMirrorSync(destination, directRoute, yeoksam));
    await Promise.resolve();
    await Promise.resolve();
  });

  it('unmount 후 늦게 resolve되어도 dedup ref/state를 건드리지 않는다', async () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    let resolveUpdate: (applied: boolean) => void = () => {};
    mockUpdateLiveActivityFromMirrorStation.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveUpdate = resolve;
      }),
    );
    const { unmount } = renderHook(() =>
      useForegroundLaMirrorSync(destination, directRoute, yeoksam),
    );
    unmount();
    resolveUpdate(true);
    await Promise.resolve();
    await Promise.resolve();
  });

  it('unmount 후 늦게 reject되어도 swallow — cancelled 가드가 catch 경로도 커버', async () => {
    mockUseBackendSsotMirrorPoll.mockReturnValue(mirrorEntry);
    let rejectUpdate: (e: Error) => void = () => {};
    mockUpdateLiveActivityFromMirrorStation.mockReturnValueOnce(
      new Promise<boolean>((_resolve, reject) => {
        rejectUpdate = reject;
      }),
    );
    const { unmount } = renderHook(() =>
      useForegroundLaMirrorSync(destination, directRoute, yeoksam),
    );
    unmount();
    rejectUpdate(new Error('late native fail'));
    await Promise.resolve();
    await Promise.resolve();
  });
});
