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

const HEX64_TOKEN = '0123456789abcdef'.repeat(4);
const UUID_TOKEN = '550e8400-e29b-41d4-a716-446655440000';

/**
 * #2176 — logPushFailure(pushFailureLog.test.ts와 동일 패턴)의 최소 mock D1.
 * SQL 종류(SELECT rate-limit 확인 / INSERT)별로 다른 stub을 반환한다.
 */
function makeDb(recentExists = false): { db: D1Database; insertBind: ReturnType<typeof vi.fn> } {
  const run = vi.fn().mockResolvedValue({ success: true });
  const insertBind = vi.fn().mockReturnValue({ run });
  const first = vi.fn().mockResolvedValue(recentExists ? { 1: 1 } : null);
  const selectBind = vi.fn().mockReturnValue({ first });
  const prepare = vi.fn().mockImplementation((sql: string) => {
    if (sql.startsWith('SELECT')) return { bind: selectBind };
    return { bind: insertBind };
  });
  return { db: { prepare } as unknown as D1Database, insertBind };
}

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

describe('sendWithEnvHeal — #2176 발사 전 토큰 포맷 관측 (축소 스펙: 기록만, 발사 차단 없음)', () => {
  it('red: observe 미전달(기존 caller) — UUID 토큰이어도 아무 기록 없이 그대로 발사(기존 동작 100% 유지)', async () => {
    const sender = vi.fn(async (): Promise<SendPushResult> => ({ ok: true, status: 200 }));
    const log = vi.fn();
    const { insertBind } = makeDb();
    // observe 인자를 넘기지 않음 — 08-06 로테이션 결함 당시와 동일하게 UUID가 그대로 통과되던 상태 재현.
    const result = await sendWithEnvHeal(sender, 'sandbox', APNS_HOSTS, log, UUID_TOKEN.slice(0, 8));
    expect(sender).toHaveBeenCalledTimes(1);
    expect(result.result.ok).toBe(true);
    expect(insertBind).not.toHaveBeenCalled();
  });

  it('green: observe 전달 + 무효 포맷(UUID) → invalid-token-format 사유로 기록 + 발사는 그대로 진행(차단 없음)', async () => {
    const sender = vi.fn(async (): Promise<SendPushResult> => ({ ok: true, status: 200 }));
    const log = vi.fn();
    const { db, insertBind } = makeDb();
    const result = await sendWithEnvHeal(
      sender,
      'sandbox',
      APNS_HOSTS,
      log,
      UUID_TOKEN.slice(0, 8),
      { deviceToken: UUID_TOKEN, db, tripToken: UUID_TOKEN },
    );
    // 동작 불변 — 무효 포맷이어도 sender(APNs 호출)는 그대로 1회 실행되고 결과도 그대로 반환.
    expect(sender).toHaveBeenCalledTimes(1);
    expect(result.result.ok).toBe(true);
    // 기록은 남는다 — apns_status=0(로컬 pre-flight 판정, 실제 APNs 응답 아님), reason=invalid-token-format.
    expect(insertBind).toHaveBeenCalledTimes(1);
    const bindArgs = insertBind.mock.calls[0];
    // bind 순서(pushFailureLog.ts): ts, tokenHash, tripTokenHash, pushKind, status, reason, env, envMismatchExhausted
    expect(bindArgs[4]).toBe(0);
    expect(bindArgs[5]).toBe('invalid-token-format');
    const observeLines = log.mock.calls.filter((call) =>
      String(call[0]).includes('invalid token format observed'),
    );
    expect(observeLines).toHaveLength(1);
  });

  it('green: observe 전달 + 유효 포맷(64-hex) → 기록 없음 + 정상 회귀 없음', async () => {
    const sender = vi.fn(async (): Promise<SendPushResult> => ({ ok: true, status: 200 }));
    const log = vi.fn();
    const { db, insertBind } = makeDb();
    const result = await sendWithEnvHeal(
      sender,
      'sandbox',
      APNS_HOSTS,
      log,
      HEX64_TOKEN.slice(0, 8),
      { deviceToken: HEX64_TOKEN, db, tripToken: HEX64_TOKEN },
    );
    expect(sender).toHaveBeenCalledTimes(1);
    expect(result.result.ok).toBe(true);
    expect(insertBind).not.toHaveBeenCalled();
  });

  it('rate-limit 가드: 같은 (token, pushKind) 10분 윈도 내 재관측은 재기록하지 않는다(logPushFailure 내장 게이트 재사용)', async () => {
    const sender = vi.fn(async (): Promise<SendPushResult> => ({ ok: true, status: 200 }));
    const log = vi.fn();
    const { db, insertBind } = makeDb(true); // recentExists=true → rate-limit SELECT가 "최근 기록 있음" 반환
    await sendWithEnvHeal(sender, 'sandbox', APNS_HOSTS, log, UUID_TOKEN.slice(0, 8), {
      deviceToken: UUID_TOKEN,
      db,
      tripToken: UUID_TOKEN,
    });
    expect(insertBind).not.toHaveBeenCalled();
  });

  it('db undefined(미바인딩) → graceful no-op, 발사는 그대로 진행', async () => {
    const sender = vi.fn(async (): Promise<SendPushResult> => ({ ok: true, status: 200 }));
    const log = vi.fn();
    const result = await sendWithEnvHeal(sender, 'sandbox', APNS_HOSTS, log, UUID_TOKEN.slice(0, 8), {
      deviceToken: UUID_TOKEN,
      db: undefined,
      tripToken: UUID_TOKEN,
    });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(result.result.ok).toBe(true);
  });
});
