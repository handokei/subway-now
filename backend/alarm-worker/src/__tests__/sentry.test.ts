import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as Sentry from '@sentry/cloudflare';
import {
  sentryInit,
  sentryOptions,
  captureXEvent,
  captureBackendException,
  addValidateRejectBreadcrumb,
  hashTripToken,
  isSentryInitialized,
  getConfiguredDsn,
  _resetSentryForTest,
} from '../sentry';
import type { Env } from '../types';

vi.mock('@sentry/cloudflare', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
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
  };
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
      const args = vi.mocked(Sentry.captureMessage).mock.calls[0][1] as {
        extra: Record<string, unknown>;
      };
      expect(args.extra.tripToken).toBeUndefined();
      expect(args.extra.tripTokenHash).toBe(hashTripToken('raw-secret-token'));
      expect(args.extra.stationName).toBe('용마산');
      expect(args.extra.unset).toBeUndefined();
    });

    it('SDK throw 시 swallow', () => {
      sentryInit(makeEnv({ SENTRY_DSN: 'https://x@s/1' }));
      vi.mocked(Sentry.captureMessage).mockImplementationOnce(() => {
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

describe('sentryOptions (#1829)', () => {
  it('DSN 미설정 시 undefined 반환', () => {
    const env = { APNS_HOST: '', APNS_HOST_SANDBOX: '', SEOUL_API_HOST: '', SEOUL_API_KEY: '', APNS_KEY_ID: '', APNS_TEAM_ID: '', APNS_PRIVATE_KEY: '', APNS_BUNDLE_ID: '', TRIPS: {} as KVNamespace };
    expect(sentryOptions(env as Env)).toBeUndefined();
  });

  it('DSN 설정 시 options 반환 + environment production default', () => {
    const env = { APNS_HOST: '', APNS_HOST_SANDBOX: '', SEOUL_API_HOST: '', SEOUL_API_KEY: '', APNS_KEY_ID: '', APNS_TEAM_ID: '', APNS_PRIVATE_KEY: '', APNS_BUNDLE_ID: '', TRIPS: {} as KVNamespace, SENTRY_DSN: 'https://x@s/1' };
    const opts = sentryOptions(env as Env);
    expect(opts).toBeDefined();
    expect(opts?.dsn).toBe('https://x@s/1');
    expect(opts?.environment).toBe('production');
  });

  it('APNS_HOST가 sandbox URL이면 environment=sandbox', () => {
    const env = { APNS_HOST: 'api.sandbox.push.apple.com', APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com', SEOUL_API_HOST: '', SEOUL_API_KEY: '', APNS_KEY_ID: '', APNS_TEAM_ID: '', APNS_PRIVATE_KEY: '', APNS_BUNDLE_ID: '', TRIPS: {} as KVNamespace, SENTRY_DSN: 'https://x@s/1' };
    const opts = sentryOptions(env as Env);
    expect(opts?.environment).toBe('sandbox');
  });
});

describe('captureBackendException (#1829)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetSentryForTest();
  });

  afterEach(() => {
    _resetSentryForTest();
  });

  it('init 안 됐으면 no-op', () => {
    captureBackendException(new Error('boom'));
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('init 후 captureException 호출', () => {
    const env = { APNS_HOST: '', APNS_HOST_SANDBOX: '', SEOUL_API_HOST: '', SEOUL_API_KEY: '', APNS_KEY_ID: '', APNS_TEAM_ID: '', APNS_PRIVATE_KEY: '', APNS_BUNDLE_ID: '', TRIPS: {} as KVNamespace, SENTRY_DSN: 'https://x@s/1' };
    sentryInit(env as Env);
    const err = new Error('cron failed');
    captureBackendException(err, { path: 'scheduled/runScheduled' });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ extra: expect.objectContaining({ path: 'scheduled/runScheduled' }) }),
    );
  });

  it('SDK throw 시 swallow', () => {
    const env = { APNS_HOST: '', APNS_HOST_SANDBOX: '', SEOUL_API_HOST: '', SEOUL_API_KEY: '', APNS_KEY_ID: '', APNS_TEAM_ID: '', APNS_PRIVATE_KEY: '', APNS_BUNDLE_ID: '', TRIPS: {} as KVNamespace, SENTRY_DSN: 'https://x@s/1' };
    sentryInit(env as Env);
    vi.mocked(Sentry.captureException).mockImplementationOnce(() => { throw new Error('sdk crash'); });
    expect(() => captureBackendException(new Error('original'))).not.toThrow();
  });

  it('context 없이 호출 가능', () => {
    const env = { APNS_HOST: '', APNS_HOST_SANDBOX: '', SEOUL_API_HOST: '', SEOUL_API_KEY: '', APNS_KEY_ID: '', APNS_TEAM_ID: '', APNS_PRIVATE_KEY: '', APNS_BUNDLE_ID: '', TRIPS: {} as KVNamespace, SENTRY_DSN: 'https://x@s/1' };
    sentryInit(env as Env);
    captureBackendException(new Error('bare'));
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), undefined);
  });
});

describe('addValidateRejectBreadcrumb (#1829)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetSentryForTest();
  });

  afterEach(() => {
    _resetSentryForTest();
  });

  it('init 안 됐으면 no-op', () => {
    addValidateRejectBreadcrumb('missing_field', { field: 'token' });
    expect(Sentry.addBreadcrumb).not.toHaveBeenCalled();
  });

  it('init 후 addBreadcrumb 호출', () => {
    const env = { APNS_HOST: '', APNS_HOST_SANDBOX: '', SEOUL_API_HOST: '', SEOUL_API_KEY: '', APNS_KEY_ID: '', APNS_TEAM_ID: '', APNS_PRIVATE_KEY: '', APNS_BUNDLE_ID: '', TRIPS: {} as KVNamespace, SENTRY_DSN: 'https://x@s/1' };
    sentryInit(env as Env);
    addValidateRejectBreadcrumb('missing_field', { field: 'token' });
    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'trips-validate', level: 'warning' }),
    );
  });
});
