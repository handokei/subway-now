/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration test — Phase 5 file-level disable opt-in.
 * (#1385 / #1419)
 */
import * as Notifications from 'expo-notifications';
import { AppState, type AppStateStatus } from 'react-native';
import { renderHook, waitFor } from '@testing-library/react-native';
import {
  useBoardingPromptDisplayLogger,
  wasBoardingPromptDisplayed,
  markBoardingPromptDisplayed,
  __resetBoardingPromptDisplayedDedup,
} from '../useBoardingPromptDisplayLogger';
import { BOARDING_PROMPT_CATEGORY, DISEMBARK_PROMPT_CATEGORY } from '../../utils/notificationCategory';

jest.mock('expo-notifications', () => ({
  addNotificationReceivedListener: jest.fn(),
  getPresentedNotificationsAsync: jest.fn().mockResolvedValue([]),
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

describe('useBoardingPromptDisplayLogger (#1385 / #1419)', () => {
  let registeredHandler: ((notification: any) => void) | null = null;
  let appStateHandler: ((state: AppStateStatus) => void) | null = null;
  const subscriptionRemove = jest.fn();
  const appStateRemove = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    registeredHandler = null;
    appStateHandler = null;
    __resetBoardingPromptDisplayedDedup();
    (Notifications.addNotificationReceivedListener as jest.Mock).mockImplementation(
      (handler) => {
        registeredHandler = handler;
        return { remove: subscriptionRemove };
      },
    );
    (Notifications.getPresentedNotificationsAsync as jest.Mock).mockResolvedValue([]);
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation(((
        _event: string,
        handler: (state: AppStateStatus) => void,
      ) => {
        appStateHandler = handler;
        return { remove: appStateRemove };
      }) as unknown as typeof AppState.addEventListener);
  });

  it('FG receive listener를 등록한다', () => {
    renderHook(() => useBoardingPromptDisplayLogger());
    expect(Notifications.addNotificationReceivedListener).toHaveBeenCalledTimes(1);
    expect(registeredHandler).not.toBeNull();
  });

  it('unmount 시 subscription + AppState listener 둘 다 remove', () => {
    const { unmount } = renderHook(() => useBoardingPromptDisplayLogger());
    unmount();
    expect(subscriptionRemove).toHaveBeenCalled();
    expect(appStateRemove).toHaveBeenCalled();
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

  // #2282 — hop-end 는 DISEMBARK_PROMPT_CATEGORY로 분리 발사되므로 fired 적재도 인정해야 한다.
  it('DISEMBARK_PROMPT category notification 수신 시에도 logBoardingPromptFired 호출', () => {
    renderHook(() => useBoardingPromptDisplayLogger());
    registeredHandler!(
      makeNotification({ identifier: 'n-disembark', categoryIdentifier: DISEMBARK_PROMPT_CATEGORY }),
    );
    expect(logBoardingPromptFired).toHaveBeenCalledTimes(1);
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

  // #1419 — BG 발사 drain (presented tray)
  it('마운트 시 presented tray drain 1회 호출 + BOARDING_PROMPT 적재', async () => {
    (Notifications.getPresentedNotificationsAsync as jest.Mock).mockResolvedValue([
      makeNotification({ identifier: 'bg-1' }),
    ]);
    renderHook(() => useBoardingPromptDisplayLogger());
    await waitFor(() => {
      expect(logBoardingPromptFired).toHaveBeenCalledTimes(1);
    });
    expect(wasBoardingPromptDisplayed('bg-1')).toBe(true);
  });

  it('AppState active 진입 시 drain — BG로 받은 prompt가 displayed로 적재', async () => {
    renderHook(() => useBoardingPromptDisplayLogger());
    await waitFor(() => expect(appStateHandler).not.toBeNull());
    (Notifications.getPresentedNotificationsAsync as jest.Mock).mockResolvedValue([
      makeNotification({ identifier: 'bg-2' }),
    ]);
    appStateHandler!('active');
    await waitFor(() => {
      expect(logBoardingPromptFired).toHaveBeenCalledWith({ originStation: '강남', line: '2' });
    });
    expect(wasBoardingPromptDisplayed('bg-2')).toBe(true);
  });

  it('AppState background 진입 시에는 drain 안 함', async () => {
    renderHook(() => useBoardingPromptDisplayLogger());
    await waitFor(() => expect(appStateHandler).not.toBeNull());
    (Notifications.getPresentedNotificationsAsync as jest.Mock).mockClear();
    appStateHandler!('background');
    expect(Notifications.getPresentedNotificationsAsync).not.toHaveBeenCalled();
  });

  it('drain — FG receive와 동일 identifier는 dedup으로 중복 적재 X', async () => {
    renderHook(() => useBoardingPromptDisplayLogger());
    await waitFor(() => expect(registeredHandler).not.toBeNull());
    registeredHandler!(makeNotification({ identifier: 'dup-1' }));
    expect(logBoardingPromptFired).toHaveBeenCalledTimes(1);
    (Notifications.getPresentedNotificationsAsync as jest.Mock).mockResolvedValue([
      makeNotification({ identifier: 'dup-1' }),
    ]);
    appStateHandler!('active');
    await waitFor(() => {
      // 추가 호출 없음 — 첫 호출 1회만 유지.
      expect(logBoardingPromptFired).toHaveBeenCalledTimes(1);
    });
  });

  it('drain — BOARDING_PROMPT 외 category는 skip', async () => {
    (Notifications.getPresentedNotificationsAsync as jest.Mock).mockResolvedValue([
      makeNotification({ identifier: 'other-1', categoryIdentifier: 'OTHER_CATEGORY' }),
    ]);
    renderHook(() => useBoardingPromptDisplayLogger());
    await waitFor(() => {
      expect(Notifications.getPresentedNotificationsAsync).toHaveBeenCalled();
    });
    expect(logBoardingPromptFired).not.toHaveBeenCalled();
  });

  it('drain — getPresentedNotificationsAsync 예외 swallow', async () => {
    (Notifications.getPresentedNotificationsAsync as jest.Mock).mockRejectedValue(
      new Error('tray boom'),
    );
    expect(() => renderHook(() => useBoardingPromptDisplayLogger())).not.toThrow();
    await waitFor(() => {
      expect(Notifications.getPresentedNotificationsAsync).toHaveBeenCalled();
    });
    expect(logBoardingPromptFired).not.toHaveBeenCalled();
  });
});
