/**
 * #3221 PR-3a — 탑승 질문 발사 기록(`prompt_fires`, migrations/0009).
 *
 * - writer는 cron `fireBoardingPromptForAnchor` 한 곳(송신 전). trip 레코드 밖 D1이라 재등록·KV 되돌림과 무관.
 * - 쓰기 실패는 삼키고 Sentry(`D1-write-failure{table:'prompt_fires'}`) — fail-open 잔여(관측 가능).
 * - 읽기 실패/행 없음 = `null` -> 호출부는 열차 미표시(fail-closed).
 * - 정리는 `cleanupTripEvents`와 같은 7일 상수·같은 시 단위 게이트(scheduled.ts)에서 호출한다.
 */
import { captureXEvent } from './sentry';
import { TRIP_EVENT_RETENTION_MS } from './tripEventLog';

export interface PromptFireInput {
  tokenHash: string;
  station: string;
  /** 노선 코드('7'). */
  line: string;
  /** null = ambiguity 발사(열차 특정 실패). */
  trainCode: string | null;
  issuedAt: number;
  decision: string;
}

/** 발사 1건의 열차·시각. LA content의 `trainCode`·`trainCodeIssuedAtMs`의 원천. */
export interface PromptFire {
  trainCode: string | null;
  issuedAt: number;
}

export async function recordPromptFire(db: D1Database | undefined, input: PromptFireInput): Promise<void> {
  if (!db) return;
  const { tokenHash, station, line, trainCode, issuedAt, decision } = input;
  try {
    await db
      .prepare(
        'INSERT INTO prompt_fires (token_hash, station, line, train_code, issued_at, decision) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(tokenHash, station, line, trainCode, issuedAt, decision)
      .run();
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'promptFires write failed', err: String(e) }));
    captureXEvent('D1-write-failure', { table: 'prompt_fires', err: String(e) });
  }
}

/** (token, station, line) anchor의 최신 발사. 없음/읽기 실패 = null. */
export async function readLatestPromptFire(
  db: D1Database | undefined,
  tokenHash: string,
  station: string,
  line: string,
): Promise<PromptFire | null> {
  if (!db) return null;
  try {
    const row = await db
      .prepare(
        'SELECT train_code, issued_at FROM prompt_fires WHERE token_hash = ? AND station = ? AND line = ? ORDER BY issued_at DESC, id DESC LIMIT 1',
      )
      .bind(tokenHash, station, line)
      .first<{ train_code: string | null; issued_at: number }>();
    return row ? { trainCode: row.train_code, issuedAt: row.issued_at } : null;
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'promptFires read failed', err: String(e) }));
    return null;
  }
}

/** 보존 기간 초과 행 삭제. 삭제 행 수(DB 없음/실패 0). */
export async function cleanupPromptFires(db: D1Database | undefined, now: number): Promise<number> {
  if (!db) return 0;
  try {
    const result = await db
      .prepare('DELETE FROM prompt_fires WHERE issued_at < ?')
      .bind(now - TRIP_EVENT_RETENTION_MS)
      .run();
    return result.meta?.changes ?? 0;
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'promptFires cleanup failed', err: String(e) }));
    captureXEvent('D1-write-failure', { table: 'prompt_fires', kind: 'cleanup', err: String(e) });
    return 0;
  }
}
