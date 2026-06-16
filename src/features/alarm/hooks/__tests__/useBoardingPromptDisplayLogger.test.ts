/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration test — Phase 5 file-level disable opt-in.
 * (#1385)
 */
import * as Notifications from 'expo-notifications';
import { renderHook } from '@testing-library/react-native';
import {
  useBoardingPromptDisplayLogger,
  wasBoardingPromptDisplayed,
  markBoardingPromptDisplayed,
  __resetBoardingPromptDisplayedDedup,
} from '../useBoardingPromptDisplayLogger';
import { BOARDING_PROMPT_CATEGORY } from '../../utils/notificationCategory';

jest.mock('expo-notifications', () => ({
  addNotificationReceivedListener: jest.fn(),
}));
jest.mock('../../utils/alarmLog', () => ({
  logBoardingPromptFired: jest.fn(),
}));
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const { logBoardingPromptFired } = jest.requireMock('../../utils/alarmLog');

const VALID_DATA = {
  kind: 'boarding-prompt',
  originStation: '강남',
  line: '2',
  tripToken: 'tok',
};

function makeNotification(overrides: {
  identifier?: string;
  categoryIdentifier?: string | null;
  data?: unknown;
}) {
  return {
    request: {
      identifier: overrides.identifier ?? 'noti-1',
      content: {
        // null/undefined를 그대로 전달해야 "categoryIdentifier 미수신" 케이스를 시뮬레이션할 수 있다.
        categoryIdentifier:
          'categoryIdentifier' in overrides
            ? overrides.categoryIdentifier
            : BOARDING_PROMPT_CATEGORY,
        data: overrides.data ?? VALID_DATA,
      },
    },
  };
}

describe('useBoardingPromptDisplayLogger (#1385)', () => {
  let registeredHandler: ((notification: any) => void) | null = null;
  const subscriptionRemove = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    registeredHandler = null;
    __resetBoardingPromptDisplayedDedup();
    (Notifications.addNotificationReceivedListener as jest.Mock).mockImplementation(
      (handler) => {
        registeredHandler = handler;
        return { remove: subscriptionRemove };
      },
    );
  });

  it('FG receive listener를 등록한다', () => {
    renderHook(() => useBoardingPromptDisplayLogger());
    expect(Notifications.addNotificationReceivedListener).toHaveBeenCalledTimes(1);
    expect(registeredHandler).not.toBeNull();
  });

  it('unmount 시 subscription remove', () => {
    const { unmount } = renderHook(() => useBoardingPromptDisplayLogger());
    unmount();
    expect(subscriptionRemove).toHaveBeenCalled();
  });

  it('BOARDING_PROMPT category notification 수신 시 logBoardingPromptFired 호출', () => {
    renderHook(() => useBoardingPromptDisplayLogger());
    registeredHandler!(makeNotification({ identifier: 'n-1' }));
    expect(logBoardingPromptFired).toHaveBeenCalledTimes(1);
    expect(logBoardingPromptFired).toHaveBeenCalledWith({
      originStation: '강남',
      line: '2',
    });
    expect(wasBoardingPromptDisplayed('n-1')).toBe(true);
  });

  it('같은 identifier 재수신 시 dedup — logBoardingPromptFired 추가 호출 없음', () => {
    renderHook(() => useBoardingPromptDisplayLogger());
    registeredHandler!(makeNotification({ identifier: 'n-1' }));
    registeredHandler!(makeNotification({ identifier: 'n-1' }));
    expect(logBoardingPromptFired).toHaveBeenCalledTimes(1);
  });

  it('다른 identifier는 별도 1건씩 적재', () => {
    renderHook(() => useBoardingPromptDisplayLogger());
    registeredHandler!(makeNotification({ identifier: 'n-1' }));
    registeredHandler!(makeNotification({ identifier: 'n-2' }));
    expect(logBoardingPromptFired).toHaveBeenCalledTimes(2);
  });

  it('다른 categoryIdentifier → no-op', () => {
    renderHook(() => useBoardingPromptDisplayLogger());
    registeredHandler!(
      makeNotification({ categoryIdentifier: 'OTHER_CATEGORY' }),
    );
    expect(logBoardingPromptFired).not.toHaveBeenCalled();
  });

  it('categoryIdentifier null (Android 등) → no-op', () => {
    renderHook(() => useBoardingPromptDisplayLogger());
    registeredHandler!(makeNotification({ categoryIdentifier: null }));
    expect(logBoardingPromptFired).not.toHaveBeenCalled();
  });

  it('payload schema 미일치(kind 다름) → no-op', () => {
    renderHook(() => useBoardingPromptDisplayLogger());
    registeredHandler!(
      makeNotification({ data: { kind: 'reschedule' } }),
    );
    expect(logBoardingPromptFired).not.toHaveBeenCalled();
  });

  it('identifier 누락 → no-op', () => {
    renderHook(() => useBoardingPromptDisplayLogger());
    registeredHandler!(
      makeNotification({ identifier: '' }),
    );
    expect(logBoardingPromptFired).not.toHaveBeenCalled();
  });

  it('listener 콜백 내부 예외 — swallow (throw 안 함)', () => {
    renderHook(() => useBoardingPromptDisplayLogger());
    // request.content 접근 시 throw 케이스
    expect(() =>
      registeredHandler!({
        get request() {
          throw new Error('boom');
        },
      }),
    ).not.toThrow();
    expect(logBoardingPromptFired).not.toHaveBeenCalled();
  });

  it('helper — markBoardingPromptDisplayed가 dedup set에 반영된다', () => {
    expect(wasBoardingPromptDisplayed('m-1')).toBe(false);
    markBoardingPromptDisplayed('m-1');
    expect(wasBoardingPromptDisplayed('m-1')).toBe(true);
  });

  it('helper — __resetBoardingPromptDisplayedDedup이 set을 비운다', () => {
    markBoardingPromptDisplayed('m-2');
    expect(wasBoardingPromptDisplayed('m-2')).toBe(true);
    __resetBoardingPromptDisplayedDedup();
    expect(wasBoardingPromptDisplayed('m-2')).toBe(false);
  });
});
