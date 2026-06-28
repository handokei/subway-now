/**
 * apnsHost.ts 단위 테스트 — sendWithEnvHeal의 race-evidence 로그 라인(#1931) 검증.
 *
 * scheduled.test.ts는 cron 통합 시나리오에서 self-heal 동작을 확인하나,
 * 본 파일은 호출자에 독립적으로 `kind=apns AND reason=env-mismatch-race` log emit을 검증해
 * Cloudflare Dashboard 측정 채널 추가가 유실되지 않도록 한다.
 */
import { describe, expect, it, vi } from 'vitest';
import { sendWithEnvHeal } from '../apnsHost';
import type { ApnsEnv } from '../types';
import type { SendPushResult } from '../apns';

const APNS_HOSTS: Record<ApnsEnv, string> = {
  sandbox: 'api.sandbox.push.apple.com',
  production: 'api.push.apple.com',
};

describe('sendWithEnvHeal (#1931 race evidence)', () => {
  it('1차 성공 → race-evidence 라인 미발사 (정상 경로)', async () => {
    const sender = vi.fn(async (): Promise<SendPushResult> => ({ ok: true, status: 200 }));
    const log = vi.fn();
    const result = await sendWithEnvHeal(sender, 'sandbox', APNS_HOSTS, log, 'token-xx');
    expect(result.result.ok).toBe(true);
    expect(result.correctedEnv).toBeUndefined();
    expect(result.envMismatchExhausted).toBe(false);
    expect(sender).toHaveBeenCalledTimes(1);
    // race-evidence 라인은 emit 되지 않아야 한다.
    const raceLines = log.mock.calls.filter(
      (call) => call[1] && (call[1] as Record<string, unknown>).reason === 'env-mismatch-race',
    );
    expect(raceLines).toHaveLength(0);
  });

  it('1차 non-BadDeviceToken 실패 → race-evidence 라인 미발사 (env mismatch 아님)', async () => {
    const sender = vi.fn(async (): Promise<SendPushResult> => ({
      ok: false,
      status: 410,
      reason: 'Unregistered',
    }));
    const log = vi.fn();
    const result = await sendWithEnvHeal(sender, 'production', APNS_HOSTS, log, 'token-xx');
    expect(result.result.ok).toBe(false);
    expect(sender).toHaveBeenCalledTimes(1);
    const raceLines = log.mock.calls.filter(
      (call) => call[1] && (call[1] as Record<string, unknown>).reason === 'env-mismatch-race',
    );
    expect(raceLines).toHaveLength(0);
  });

  it.each([
    ['sandbox', 'production'],
    ['production', 'sandbox'],
  ] as const)(
    'BadDeviceToken(from=%s) → race-evidence 라인 + opposite host(to=%s) retry',
    async (from, to) => {
      const sender = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 400, reason: 'BadDeviceToken' })
        .mockResolvedValueOnce({ ok: true, status: 200 });
      const log = vi.fn();
      const result = await sendWithEnvHeal(sender, from, APNS_HOSTS, log, 'token-prefix');
      expect(result.result.ok).toBe(true);
      expect(result.correctedEnv).toBe(to);
      // race-evidence 라인 1회 발사 — Cloudflare Dashboard query `reason=env-mismatch-race` 매칭.
      const raceLines = log.mock.calls.filter(
        (call) => call[1] && (call[1] as Record<string, unknown>).reason === 'env-mismatch-race',
      );
      expect(raceLines).toHaveLength(1);
      const [message, meta] = raceLines[0];
      expect(message).toBe('apns env mismatch (race evidence)');
      expect(meta).toMatchObject({
        kind: 'apns',
        reason: 'env-mismatch-race',
        token: 'token-prefix',
        from,
        to,
      });
    },
  );

  it('undefined env(legacy 누락) → race-evidence from="sandbox"(safe default)', async () => {
    const sender = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400, reason: 'BadDeviceToken' })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const log = vi.fn();
    const result = await sendWithEnvHeal(sender, undefined, APNS_HOSTS, log, 'token-undef');
    expect(result.correctedEnv).toBe('production');
    const raceLines = log.mock.calls.filter(
      (call) => call[1] && (call[1] as Record<string, unknown>).reason === 'env-mismatch-race',
    );
    expect(raceLines).toHaveLength(1);
    expect(raceLines[0][1]).toMatchObject({ from: 'sandbox', to: 'production' });
  });

  it('opposite host도 BadDeviceToken → envMismatchExhausted=true + race-evidence는 여전히 1회', async () => {
    const sender = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400, reason: 'BadDeviceToken' })
      .mockResolvedValueOnce({ ok: false, status: 400, reason: 'BadDeviceToken' });
    const log = vi.fn();
    const result = await sendWithEnvHeal(sender, 'sandbox', APNS_HOSTS, log, 'token-xx');
    expect(result.envMismatchExhausted).toBe(true);
    expect(result.correctedEnv).toBeUndefined();
    const raceLines = log.mock.calls.filter(
      (call) => call[1] && (call[1] as Record<string, unknown>).reason === 'env-mismatch-race',
    );
    expect(raceLines).toHaveLength(1);
  });

  it('opposite host transient 실패(500) → envMismatchExhausted=false (race evidence 1회)', async () => {
    const sender = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400, reason: 'BadDeviceToken' })
      .mockResolvedValueOnce({ ok: false, status: 500, reason: 'InternalServerError' });
    const log = vi.fn();
    const result = await sendWithEnvHeal(sender, 'sandbox', APNS_HOSTS, log, 'token-xx');
    expect(result.envMismatchExhausted).toBe(false);
    expect(result.correctedEnv).toBeUndefined();
    const raceLines = log.mock.calls.filter(
      (call) => call[1] && (call[1] as Record<string, unknown>).reason === 'env-mismatch-race',
    );
    expect(raceLines).toHaveLength(1);
  });
});
