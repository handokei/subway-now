import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as Sentry from '@sentry/cloudflare';
import {
  sentryInit,
  captureXEvent,
  hashTripToken,
  isSentryInitialized,
  getConfiguredDsn,
  _resetSentryForTest,
} from '../sentry';
import type { Env } from '../types';

vi.mock('@sentry/cloudflare', () => ({
  captureMessage: vi.fn(),
}));

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    TRIPS: {} as KVNamespace,
    APNS_HOST: 'api.push.apple.com',
    APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
    SEOUL_API_HOST: 'seoul.host',
    SEOUL_API_KEY: 'key',
    APNS_KEY_ID: 'kid',
    APNS_TEAM_ID: 'tid',
    APNS_PRIVATE_KEY: 'pem',
    APNS_BUNDLE_ID: 'bundle',
    ...overrides,
  } as Env;
}

describe('backend sentry (#1578)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetSentryForTest();
  });

  afterEach(() => {
    _resetSentryForTest();
  });

  describe('sentryInit', () => {
    it('DSN 미설정 시 initialized=false (graceful no-op)', () => {
      sentryInit(makeEnv());
      expect(isSentryInitialized()).toBe(false);
      expect(getConfiguredDsn()).toBeNull();
    });

    it('DSN 있으면 initialized=true + idempotent', () => {
      sentryInit(makeEnv({ SENTRY_DSN: 'https://x@s/1' }));
      sentryInit(makeEnv({ SENTRY_DSN: 'https://x@s/2' }));
      expect(isSentryInitialized()).toBe(true);
      // idempotent: 두 번째 호출이 DSN을 덮어쓰지 않는다.
      expect(getConfiguredDsn()).toBe('https://x@s/1');
    });
  });

  describe('captureXEvent', () => {
    it('init 안 됐으면 no-op', () => {
      captureXEvent('X8-zombie-trip', { elapsedMs: 999 });
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it('init 후 captureMessage 호출 + level=error + tag.xEvent', () => {
      sentryInit(makeEnv({ SENTRY_DSN: 'https://x@s/1' }));
      captureXEvent('X8-zombie-trip', { elapsedMs: 36_000_000 });
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'X8-zombie-trip',
        expect.objectContaining({
          level: 'error',
          tags: { xEvent: 'X8-zombie-trip' },
          extra: { elapsedMs: 36_000_000 },
        }),
      );
    });

    it('tripToken은 hash로 변환 + undefined 필드 제외', () => {
      sentryInit(makeEnv({ SENTRY_DSN: 'https://x@s/1' }));
      captureXEvent('X1-wrong-station-alarm', {
        tripToken: 'raw-secret-token',
        stationName: '용마산',
        unset: undefined,
      });
      const args = (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(args.extra.tripToken).toBeUndefined();
      expect(args.extra.tripTokenHash).toBe(hashTripToken('raw-secret-token'));
      expect(args.extra.stationName).toBe('용마산');
      expect(args.extra.unset).toBeUndefined();
    });

    it('SDK throw 시 swallow', () => {
      sentryInit(makeEnv({ SENTRY_DSN: 'https://x@s/1' }));
      (Sentry.captureMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error('crash');
      });
      expect(() => captureXEvent('X6-late-alarm', {})).not.toThrow();
    });
  });

  describe('hashTripToken', () => {
    it('deterministic + 8자', () => {
      expect(hashTripToken('a')).toBe(hashTripToken('a'));
      expect(hashTripToken('a').length).toBe(8);
      expect(hashTripToken('a')).not.toBe(hashTripToken('b'));
    });
  });
});
