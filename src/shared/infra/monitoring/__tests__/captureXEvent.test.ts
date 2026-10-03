import * as Sentry from '@sentry/react-native';
import { captureXEvent, hashTripToken } from '../captureXEvent';
import { setSentryEnabled } from '../sentryState';

describe('captureXEvent (#1578)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setSentryEnabled(false);
  });

  afterAll(() => {
    setSentryEnabled(false);
  });

  it('opt-in 미동의 시 no-op (captureMessage 미호출)', () => {
    captureXEvent('X1-wrong-station-alarm', { tripToken: 'abc' });
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('opt-in 활성 시 captureMessage 호출 + level=error + tag.xEvent 포함', () => {
    setSentryEnabled(true);
    captureXEvent('X8-zombie-trip', { elapsedMs: 36_000_000 });
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'X8-zombie-trip',
      expect.objectContaining({
        level: 'error',
        tags: { xEvent: 'X8-zombie-trip' },
        extra: { elapsedMs: 36_000_000 },
      }),
    );
  });

  it('tripToken은 hash로 변환되어 원본 노출 금지', () => {
    setSentryEnabled(true);
    captureXEvent('X1-wrong-station-alarm', {
      tripToken: 'super-secret-raw-token-abcdef',
      stationName: '용마산',
    });
    const args = (Sentry.captureMessage as jest.Mock).mock.calls[0][1];
    expect(args.extra.tripToken).toBeUndefined();
    expect(args.extra.tripTokenHash).toBe(hashTripToken('super-secret-raw-token-abcdef'));
    expect(args.extra.stationName).toBe('용마산');
  });

  it('undefined 필드는 extra에서 제외', () => {
    setSentryEnabled(true);
    captureXEvent('X3-stale-alarm', { staleMs: 360_000, unset: undefined });
    const args = (Sentry.captureMessage as jest.Mock).mock.calls[0][1];
    expect(args.extra).toEqual({ staleMs: 360_000 });
  });

  it('SDK throw 시 swallow (boot path 영향 X)', () => {
    setSentryEnabled(true);
    (Sentry.captureMessage as jest.Mock).mockImplementationOnce(() => {
      throw new Error('sdk crash');
    });
    expect(() => captureXEvent('X2-duplicate-alarm', {})).not.toThrow();
  });

  it('빈 context 허용', () => {
    setSentryEnabled(true);
    captureXEvent('X9-app-kill-required');
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'X9-app-kill-required',
      expect.objectContaining({ extra: {} }),
    );
  });

  it('hashTripToken은 deterministic + 8자', () => {
    expect(hashTripToken('a')).toBe(hashTripToken('a'));
    expect(hashTripToken('a').length).toBe(8);
    expect(hashTripToken('a')).not.toBe(hashTripToken('b'));
  });
});
