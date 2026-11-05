import { Platform } from 'react-native';

type Listener = (...args: unknown[]) => void;

const mockAddListener =
  jest.fn<{ remove: () => void }, [string, Listener]>();
const mockRequireOptionalNativeModule = jest.fn();

jest.mock('expo-modules-core', () => ({
  __esModule: true,
  requireOptionalNativeModule: (...args: unknown[]) =>
    mockRequireOptionalNativeModule(...args),
}));

describe('live-activity push token / ended listeners', () => {
  beforeEach(() => {
    jest.resetModules();
    mockAddListener.mockReset();
    mockRequireOptionalNativeModule.mockReset();
  });

  it('iOS: addPushTokenListener wires native addListener("onPushToken", cb)', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'ios' });
    const remove = jest.fn();
    mockAddListener.mockReturnValue({ remove });
    mockRequireOptionalNativeModule.mockReturnValue({ addListener: mockAddListener });

    const mod = require('../index');
    const cb = jest.fn();
    const sub = mod.addPushTokenListener(cb);

    expect(mockAddListener).toHaveBeenCalledWith('onPushToken', cb);
    sub.remove();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('iOS: addActivityEndedListener wires native addListener("onActivityEnded", cb)', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'ios' });
    const remove = jest.fn();
    mockAddListener.mockReturnValue({ remove });
    mockRequireOptionalNativeModule.mockReturnValue({ addListener: mockAddListener });

    const mod = require('../index');
    const cb = jest.fn();
    const sub = mod.addActivityEndedListener(cb);

    expect(mockAddListener).toHaveBeenCalledWith('onActivityEnded', cb);
    sub.remove();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('non-iOS: returns noop subscription without crashing', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    mockRequireOptionalNativeModule.mockReturnValue(null);

    const mod = require('../index');
    const tokenSub = mod.addPushTokenListener(() => undefined);
    const endedSub = mod.addActivityEndedListener(() => undefined);

    expect(mockAddListener).not.toHaveBeenCalled();
    expect(() => tokenSub.remove()).not.toThrow();
    expect(() => endedSub.remove()).not.toThrow();
  });

  it('iOS but native module missing: returns noop subscription', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'ios' });
    mockRequireOptionalNativeModule.mockReturnValue(null);

    const mod = require('../index');
    const sub = mod.addPushTokenListener(() => undefined);

    expect(mockAddListener).not.toHaveBeenCalled();
    expect(() => sub.remove()).not.toThrow();
  });

  it('iOS: addActivityDismissedListener wires native addListener("onActivityDismissed", cb)', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'ios' });
    const remove = jest.fn();
    mockAddListener.mockReturnValue({ remove });
    mockRequireOptionalNativeModule.mockReturnValue({ addListener: mockAddListener });

    const mod = require('../index');
    const cb = jest.fn();
    const sub = mod.addActivityDismissedListener(cb);

    expect(mockAddListener).toHaveBeenCalledWith('onActivityDismissed', cb);
    sub.remove();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('non-iOS: addActivityDismissedListener returns noop subscription', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    mockRequireOptionalNativeModule.mockReturnValue(null);

    const mod = require('../index');
    const sub = mod.addActivityDismissedListener(() => undefined);

    expect(mockAddListener).not.toHaveBeenCalled();
    expect(() => sub.remove()).not.toThrow();
  });

  it('iOS but native module missing: addActivityDismissedListener returns noop subscription', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'ios' });
    mockRequireOptionalNativeModule.mockReturnValue(null);

    const mod = require('../index');
    const sub = mod.addActivityDismissedListener(() => undefined);

    expect(mockAddListener).not.toHaveBeenCalled();
    expect(() => sub.remove()).not.toThrow();
  });

  // #3107 — 관측 전용 신규 이벤트. 기존 onActivityEnded/Dismissed 의미는 불변.
  it.each([
    ['addActivityEndObservedListener', 'onActivityEndObserved'],
    ['addActivityAdoptedListener', 'onActivityAdopted'],
  ])('iOS: %s wires native addListener("%s", cb)', (fn, eventName) => {
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'ios' });
    const remove = jest.fn();
    mockAddListener.mockReturnValue({ remove });
    mockRequireOptionalNativeModule.mockReturnValue({ addListener: mockAddListener });

    const mod = require('../index');
    const cb = jest.fn();
    const sub = mod[fn](cb);

    expect(mockAddListener).toHaveBeenCalledWith(eventName, cb);
    sub.remove();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it.each(['addActivityEndObservedListener', 'addActivityAdoptedListener'])(
    'non-iOS: %s returns noop subscription',
    (fn) => {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
      mockRequireOptionalNativeModule.mockReturnValue(null);

      const mod = require('../index');
      const sub = mod[fn](() => undefined);

      expect(mockAddListener).not.toHaveBeenCalled();
      expect(() => sub.remove()).not.toThrow();
    },
  );

  // #3162 — adopt된 Activity는 토큰을 재emit하지 않으므로 JS가 native에서 현재 토큰을 직접 재조회한다.
  it('iOS: requestLiveActivityPushToken calls native requestPushToken and returns its token', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'ios' });
    const requestPushToken = jest.fn().mockResolvedValue('abcd');
    mockRequireOptionalNativeModule.mockReturnValue({ requestPushToken });

    const mod = require('../index');

    await expect(mod.requestLiveActivityPushToken()).resolves.toBe('abcd');
    expect(requestPushToken).toHaveBeenCalledTimes(1);
  });

  it('non-iOS: requestLiveActivityPushToken resolves null', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    mockRequireOptionalNativeModule.mockReturnValue(null);

    const mod = require('../index');

    await expect(mod.requestLiveActivityPushToken()).resolves.toBeNull();
  });

  it('#3221: 탑승 push-to-start token / 종료 listener는 전용 이벤트에만 연결되고 ambient onPushToken과 분리된다', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'ios' });
    mockAddListener.mockReturnValue({ remove: jest.fn() });
    mockRequireOptionalNativeModule.mockReturnValue({ addListener: mockAddListener });

    const mod = require('../index');
    const tokenCb = jest.fn();
    const endedCb = jest.fn();
    mod.addBoardingPushToStartTokenListener(tokenCb);
    mod.addBoardingActivityEndedListener(endedCb);

    expect(mockAddListener).toHaveBeenCalledWith('onBoardingPushToStartToken', tokenCb);
    expect(mockAddListener).toHaveBeenCalledWith('onBoardingActivityEnded', endedCb);
    // ambient(여정) 이벤트는 구독되지 않는다 — 탑승 token이 여정 trip에 등록되는 경로 차단.
    expect(mockAddListener).not.toHaveBeenCalledWith('onPushToken', expect.anything());
    expect(mockAddListener).not.toHaveBeenCalledWith('onActivityDismissed', expect.anything());
  });

  it('#3221: 탑승 LA 함수 3종이 native 모듈로 위임되고, 모듈 부재 시 안전한 기본값을 반환한다', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'ios' });
    const native = {
      startBoardingActivity: jest.fn().mockResolvedValue(undefined),
      endBoardingActivities: jest.fn().mockResolvedValue(undefined),
      requestBoardingPushToStartToken: jest.fn().mockResolvedValue('abcd'),
      addListener: mockAddListener,
    };
    mockRequireOptionalNativeModule.mockReturnValue(native);
    const mod = require('../index');
    const data = {
      promptId: 'p1',
      tripToken: 't1',
      phase: 'pre-boarding',
      originStation: '용마산',
      line: '7호선',
      lineName: '7호선',
      lineColorHex: '#747F00',
      title: '탑승하셨나요?',
    };
    await mod.startBoardingActivity(data);
    await mod.endBoardingActivities();
    await expect(mod.requestBoardingPushToStartToken()).resolves.toBe('abcd');
    expect(native.startBoardingActivity).toHaveBeenCalledWith(data);
    expect(native.endBoardingActivities).toHaveBeenCalledTimes(1);

    jest.resetModules();
    mockRequireOptionalNativeModule.mockReturnValue(null);
    const bare = require('../index');
    await expect(bare.startBoardingActivity(data)).resolves.toBeUndefined();
    await expect(bare.endBoardingActivities()).resolves.toBeUndefined();
    await expect(bare.requestBoardingPushToStartToken()).resolves.toBeNull();
    expect(bare.addBoardingPushToStartTokenListener(jest.fn()).remove).toBeDefined();
    expect(bare.addBoardingActivityEndedListener(jest.fn()).remove).toBeDefined();
  });
});
