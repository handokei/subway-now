/**
 * #2667 — ambient LA token 등록 훅 wire-up 검증.
 *
 * 등록 판정/재시도 로직 자체는 `liveActivityPushChannel.test.ts`가 단독 검증한다. 여기서는
 * "훅이 실제로 구독을 켜고, trip 시점 변화에 보관 token 재등록을 트리거하며, unmount 시
 * 구독을 정리하는가"만 본다.
 */
import { renderHook } from '@testing-library/react-native';
import { AppState, Platform } from 'react-native';
import { useLiveActivityTokenRegistration } from '../useLiveActivityTokenRegistration';

const mockStop = jest.fn();
const mockStart = jest.fn(() => mockStop);
const mockRegisterHeld = jest.fn();
jest.mock('../../utils/liveActivityPushChannel', () => ({
  startAmbientLiveActivityTokenRegistration: () => mockStart(),
  registerHeldLiveActivityTokenForCurrentTrip: () => mockRegisterHeld(),
}));

describe('useLiveActivityTokenRegistration (#2667)', () => {
  const originalOs = Platform.OS;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
  });

  it('마운트 시 ambient 구독을 시작한다', () => {
    renderHook(() => useLiveActivityTokenRegistration(null));
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('unmount 시 구독을 정리한다', () => {
    const { unmount } = renderHook(() => useLiveActivityTokenRegistration(null));
    unmount();
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it('tripIntentKey가 생기면 보관 token 재등록을 트리거한다', () => {
    const { rerender } = renderHook(
      ({ key }: { key: string | null }) => useLiveActivityTokenRegistration(key),
      { initialProps: { key: null as string | null } },
    );
    expect(mockRegisterHeld).not.toHaveBeenCalled();

    rerender({ key: '0228' });
    expect(mockRegisterHeld).toHaveBeenCalledTimes(1);
  });

  it('같은 key로 재렌더되면 재트리거하지 않는다', () => {
    const { rerender } = renderHook(
      ({ key }: { key: string | null }) => useLiveActivityTokenRegistration(key),
      { initialProps: { key: '0228' as string | null } },
    );
    rerender({ key: '0228' });
    expect(mockRegisterHeld).toHaveBeenCalledTimes(1);
  });

  // #3162 — FG 복귀는 토큰 불변식 복구의 "다음 기회" 중 하나다. active 전이마다 복구를 트리거하고,
  // 그 외 상태 전이와 unmount 이후에는 트리거하지 않는다(리스너 누수 금지).
  describe('AppState 복귀 (#3162)', () => {
    let appStateCb: (state: string) => void = () => undefined;
    const removeAppState = jest.fn();

    beforeEach(() => {
      removeAppState.mockClear();
      jest
        .spyOn(AppState, 'addEventListener')
        .mockImplementation(((_e: string, cb: (state: string) => void) => {
          appStateCb = cb;
          return { remove: removeAppState };
        }) as unknown as typeof AppState.addEventListener);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('background -> active 전이에서 복구를 트리거한다', () => {
      renderHook(() => useLiveActivityTokenRegistration(null));
      expect(mockRegisterHeld).not.toHaveBeenCalled();

      appStateCb('background');
      expect(mockRegisterHeld).not.toHaveBeenCalled();

      appStateCb('active');
      expect(mockRegisterHeld).toHaveBeenCalledTimes(1);
    });

    it('unmount 시 AppState 리스너를 제거한다', () => {
      const { unmount } = renderHook(() => useLiveActivityTokenRegistration(null));
      unmount();
      expect(removeAppState).toHaveBeenCalledTimes(1);
    });
  });

  it('non-iOS에서는 구독도 등록도 하지 않는다', () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    renderHook(() => useLiveActivityTokenRegistration('0228'));
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockRegisterHeld).not.toHaveBeenCalled();
  });
});
