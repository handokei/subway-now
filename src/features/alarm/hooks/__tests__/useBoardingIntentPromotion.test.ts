import { act, renderHook } from '@testing-library/react-native';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import { PENDING_TRAIN_CODE } from '../../../../shared/constants/boardingLock';
import { useBoardingLockStore } from '../../store/useBoardingLockStore';
import { useUserIntentStore } from '../../store/useUserIntentStore';
import { useBoardingIntentPromotion } from '../useBoardingIntentPromotion';

// #2792 — C 하이브리드: boardingLock이 (null→활성)으로 형성될 때 promptOptIn(안내 시작)을
// 매역 intent(infoModeEnabled)로 승격한다. 갭은 auto-lock(device evidence)뿐이다 — 프롬프트
// 응답/열차 탭은 이미 infoModeEnabled=true를 직접 stamp하므로 이 승격 없이도 동작한다.

function makeRealLock(overrides: Partial<BoardingLock> = {}): BoardingLock {
  return {
    destinationId: 'dest-1',
    trainCode: 'REAL-TRAIN-1',
    boardingStationId: 'stn-A',
    boardingLine: '2',
    boardedAt: Date.now(),
    expectedDurationMs: 30 * 60_000,
    boardingEvidence: true,
    ...overrides,
  };
}

function makePendingLock(overrides: Partial<BoardingLock> = {}): BoardingLock {
  return makeRealLock({ trainCode: PENDING_TRAIN_CODE, boardingEvidence: false, ...overrides });
}

describe('useBoardingIntentPromotion (#2792 C 하이브리드)', () => {
  let setInfoModeEnabled: jest.Mock;

  beforeEach(() => {
    setInfoModeEnabled = jest.fn().mockResolvedValue(undefined);
    useBoardingLockStore.setState({ lock: null });
    useUserIntentStore.setState({
      promptOptIn: false,
      infoModeEnabled: false,
      setInfoModeEnabled,
    });
  });

  it('promptOptIn=true 상태에서 실 lock이 형성되면 setInfoModeEnabled(true)를 호출한다', () => {
    useUserIntentStore.setState({ promptOptIn: true });
    const { rerender } = renderHook(() => useBoardingIntentPromotion());

    act(() => {
      useBoardingLockStore.setState({ lock: makeRealLock() });
    });
    rerender({});

    expect(setInfoModeEnabled).toHaveBeenCalledTimes(1);
    expect(setInfoModeEnabled).toHaveBeenCalledWith(true);
  });

  it('promptOptIn=false면 실 lock이 형성돼도 setInfoModeEnabled를 호출하지 않는다', () => {
    useUserIntentStore.setState({ promptOptIn: false });
    const { rerender } = renderHook(() => useBoardingIntentPromotion());

    act(() => {
      useBoardingLockStore.setState({ lock: makeRealLock() });
    });
    rerender({});

    expect(setInfoModeEnabled).not.toHaveBeenCalled();
  });

  it('infoModeEnabled가 이미 true면 lock이 형성돼도 재호출하지 않는다(멱등)', () => {
    useUserIntentStore.setState({ promptOptIn: true, infoModeEnabled: true });
    const { rerender } = renderHook(() => useBoardingIntentPromotion());

    act(() => {
      useBoardingLockStore.setState({ lock: makeRealLock() });
    });
    rerender({});

    expect(setInfoModeEnabled).not.toHaveBeenCalled();
  });

  it('집 시나리오: promptOptIn=true인데 lock이 없으면 호출하지 않는다(#2651 오발사 방지 유지)', () => {
    useUserIntentStore.setState({ promptOptIn: true });
    renderHook(() => useBoardingIntentPromotion());

    expect(setInfoModeEnabled).not.toHaveBeenCalled();
  });

  it('PENDING sentinel lock(탑승 미확정)은 승격 트리거로 보지 않는다', () => {
    useUserIntentStore.setState({ promptOptIn: true });
    const { rerender } = renderHook(() => useBoardingIntentPromotion());

    act(() => {
      useBoardingLockStore.setState({ lock: makePendingLock() });
    });
    rerender({});

    expect(setInfoModeEnabled).not.toHaveBeenCalled();
  });

  it('PENDING → 실 trainCode로 승격되면(탑승 확정) 그 시점에 setInfoModeEnabled(true) 호출', () => {
    useUserIntentStore.setState({ promptOptIn: true });
    useBoardingLockStore.setState({ lock: makePendingLock() });
    const { rerender } = renderHook(() => useBoardingIntentPromotion());

    expect(setInfoModeEnabled).not.toHaveBeenCalled();

    act(() => {
      useBoardingLockStore.setState({ lock: makeRealLock() });
    });
    rerender({});

    expect(setInfoModeEnabled).toHaveBeenCalledTimes(1);
    expect(setInfoModeEnabled).toHaveBeenCalledWith(true);
  });

  it('lock이 없는 상태로 유지되면 promptOptIn이 true로 바뀌어도 호출하지 않는다', () => {
    const { rerender } = renderHook(() => useBoardingIntentPromotion());

    act(() => {
      useUserIntentStore.setState({ promptOptIn: true });
    });
    rerender({});

    expect(setInfoModeEnabled).not.toHaveBeenCalled();
  });
});
