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
});
