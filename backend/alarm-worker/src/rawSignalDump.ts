/**
 * Raw signal dump endpoint helpers (#1520, ADR-015 §10 P5 / PR-B).
 *
 * Device가 trip 종료 시 `useFusedNearestStation`의 raw signal ring buffer를 backend KV에
 * 60일 누적해 사후 회귀 분석에 사용한다. PR-A(device buffer/corrId)와 짝.
 *
 * Privacy:
 *  - token은 8자 prefix로 익명화 (`tokenPrefix`와 동일 정책).
 *  - entries는 fusion 측정값(GPS/motion/source/confidence/arvlCd 등) — 원문 사용자 식별자 없음.
 *  - corrId는 `${epoch ms}-${8 hex}` — device-local 생성, 사용자 식별 불가.
 */
import { tokenPrefix } from './telemetry';

/** corrId 형식 — `${epoch ms}-${8 hex}` (device tripCorrId.ts와 정합). */
export const CORR_ID_PATTERN = /^\d+-[0-9a-f]{8}$/;

/** entries 수 cap — device buffer capacity(120) × 안전 여유. 초과 시 400. */
export const MAX_DUMP_ENTRIES = 500;

/** KV TTL — 60일. */
export const RAW_SIGNAL_DUMP_TTL_SEC = 60 * 24 * 3600;

/** KV key prefix — `dump:{corrId}`. export endpoint도 동일 prefix. */
export const RAW_SIGNAL_DUMP_KEY_PREFIX = 'dump:';

export function dumpKey(corrId: string): string {
  return `${RAW_SIGNAL_DUMP_KEY_PREFIX}${corrId}`;
}

export interface SignalDumpUpload {
  corrId: string;
  token: string;
  /**
   * Raw signal entries — device 측 `RawSignalEntry[]`와 정합.
   * backend는 schema 검증 안 한다 (forward compat — device가 새 필드 추가해도 KV에 그대로 적재).
   * 단 배열 + 객체임은 검사한다.
   */
  entries: unknown[];
}

export interface SignalDumpStored {
  tokenPrefix: string;
  entries: unknown[];
  uploadedAt: number;
}

export function validateSignalDumpUpload(input: unknown): SignalDumpUpload | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.corrId !== 'string' || !CORR_ID_PATTERN.test(obj.corrId)) return null;
  if (typeof obj.token !== 'string' || obj.token.length === 0) return null;
  if (!Array.isArray(obj.entries)) return null;
  if (obj.entries.length === 0) return null;
  if (obj.entries.length > MAX_DUMP_ENTRIES) return null;
  // 모든 entry가 object여야 함 (primitive/null reject — schema 안정성).
  for (const e of obj.entries) {
    if (!e || typeof e !== 'object') return null;
  }
  return {
    corrId: obj.corrId,
    token: obj.token,
    entries: obj.entries,
  };
}

/** KV에 dump 1건 적재. tokenPrefix만 보관 (PII 보호). */
export async function storeSignalDump(
  kv: KVNamespace,
  upload: SignalDumpUpload,
  now: number,
): Promise<void> {
  const stored: SignalDumpStored = {
    tokenPrefix: tokenPrefix(upload.token),
    entries: upload.entries,
    uploadedAt: now,
  };
  await kv.put(dumpKey(upload.corrId), JSON.stringify(stored), {
    expirationTtl: RAW_SIGNAL_DUMP_TTL_SEC,
  });
}

/** corrId로 stored dump 조회. 부재/parse 실패 시 null. */
export async function readSignalDump(
  kv: KVNamespace,
  corrId: string,
): Promise<SignalDumpStored | null> {
  if (!CORR_ID_PATTERN.test(corrId)) return null;
  const raw = await kv.get(dumpKey(corrId));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as SignalDumpStored;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
