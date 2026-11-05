/**
 * Raw signal dump backend client (#1520, ADR-015 §10 P5 / PR-B).
 *
 * Trip 종료 시 `useFusedNearestStation` ring buffer를 backend KV에 60일 누적해 사후
 * 회귀 분석에 사용한다. PR-A(device buffer/corrId)와 짝.
 *
 * 정책:
 *  - graceful — URL 미설정/token 부재/실패 시 throw 안 함. critical path(trip-end recall + cleanup)
 *    보호.
 *  - idempotency — `LAST_UPLOADED_SIGNAL_DUMP_CORR_ID_KEY`로 같은 corrId 재시도 skip. trip마다
 *    새 corrId가 생성되므로 정상 trip-end는 1회 upload 보장.
 *  - retry — 실패 시 outbox(`RAW_SIGNAL_OUTBOX_KEY`)에 단건 enqueue. 다음 cold-launch
 *    (`useLaunchTripReconciliation`)에서 flush. outbox는 가장 최근 1건만 보존 — 7일 회귀 사후
 *    분석에 가장 중요한 trip(최근)만 보호.
 *  - backend 호환 — 같은 corrId 재전송은 KV가 덮어쓰기로 처리(server-side dedup 불필요).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  RAW_SIGNAL_OUTBOX_KEY,
  LAST_UPLOADED_SIGNAL_DUMP_CORR_ID_KEY,
} from '../../../shared/constants/storageKeys';
import { createLogger } from '../../../shared/utils/logger';
import {
  fetchWithTelemetryTimeout,
  getAlarmBackendUrl,
} from '../../../shared/utils/telemetryHttp';
import type { RawSignalEntry } from '../../observability/utils/rawSignalBuffer';

const log = createLogger('signalDumpBackend');

export interface SignalDumpUploadResult {
  ok: boolean;
  /** URL 미설정 / token 빈 / 같은 corrId 재시도 등으로 호출이 건너뛰어진 경우 true. */
  skipped?: boolean;
  /** skip 사유 — 진단/테스트용. */
  skipReason?: 'no-url' | 'no-token' | 'no-entries' | 'duplicate';
  status?: number;
}

interface OutboxEntry {
  corrId: string;
  token: string;
  entries: RawSignalEntry[];
}

async function readOutbox(): Promise<OutboxEntry | null> {
  try {
    const raw = await AsyncStorage.getItem(RAW_SIGNAL_OUTBOX_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as OutboxEntry;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.corrId !== 'string' ||
      typeof parsed.token !== 'string' ||
      !Array.isArray(parsed.entries)
    ) {
      return null;
    }
    return parsed;
  } catch (e) {
    log.warn('outbox read error', e);
    return null;
  }
}

async function writeOutbox(entry: OutboxEntry): Promise<void> {
  try {
    await AsyncStorage.setItem(RAW_SIGNAL_OUTBOX_KEY, JSON.stringify(entry));
  } catch (e) {
    log.warn('outbox write error', e);
  }
}

async function clearOutbox(): Promise<void> {
  try {
    await AsyncStorage.removeItem(RAW_SIGNAL_OUTBOX_KEY);
  } catch (e) {
    log.warn('outbox clear error', e);
  }
}

async function getLastUploadedCorrId(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(LAST_UPLOADED_SIGNAL_DUMP_CORR_ID_KEY);
  } catch {
    return null;
  }
}

async function setLastUploadedCorrId(corrId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_UPLOADED_SIGNAL_DUMP_CORR_ID_KEY, corrId);
  } catch (e) {
    log.warn('idempotency key write error (graceful)', e);
  }
}

async function performUpload(
  base: string,
  body: OutboxEntry,
): Promise<SignalDumpUploadResult> {
  try {
    const res = await fetchWithTelemetryTimeout(`${base}/signals/dump`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      log.warn(`signal dump upload failed status=${res.status}`);
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    log.warn('signal dump upload error', e);
    return { ok: false };
  }
}

/**
 * Raw signal dump 1건을 backend `/signals/dump`로 upload.
 *
 * 호출자: `triggerTripEndRecall` (fire-and-forget). trip-end recall + cleanup의 critical path를
 *   차단하지 않게 throw 안 한다. cleanup 전에 호출되어야 corrId/entries가 유효.
 *
 * 실패 시 outbox에 enqueue — 다음 cold-launch에서 `flushSignalDumpOutbox`가 retry.
 * 같은 corrId 재호출은 즉시 skip (idempotency).
 */
export async function uploadSignalDump(
  corrId: string,
  token: string,
  entries: readonly RawSignalEntry[],
): Promise<SignalDumpUploadResult> {
  const base = getAlarmBackendUrl();
  if (!base) {
    log.info('ALARM_BACKEND_URL not set — skip signal dump');
    return { ok: false, skipped: true, skipReason: 'no-url' };
  }
  if (!token) {
    return { ok: false, skipped: true, skipReason: 'no-token' };
  }
  if (entries.length === 0) {
    return { ok: false, skipped: true, skipReason: 'no-entries' };
  }

  const lastCorrId = await getLastUploadedCorrId();
  if (lastCorrId === corrId) {
    log.info(`duplicate signal dump skip: corrId=${corrId}`);
    return { ok: false, skipped: true, skipReason: 'duplicate' };
  }

  // Outbox에 미리 적재 — 업로드 시도 도중 앱이 죽어도 다음 cold-launch에서 retry 가능.
  // 성공 시 clear, 실패 시 그대로 유지.
  const payload: OutboxEntry = {
    corrId,
    token,
    // readonly → mutable copy (JSON.stringify에는 영향 없지만 schema 일치).
    entries: [...entries],
  };
  await writeOutbox(payload);

  const result = await performUpload(base, payload);
  if (result.ok) {
    await setLastUploadedCorrId(corrId);
    await clearOutbox();
  }
  return result;
}

/**
 * Cold-launch 시 outbox flush. `useLaunchTripReconciliation` 마운트 직후 호출.
 *
 * 마지막 trip-end에서 upload 실패한 dump를 다시 시도. 성공 시 outbox + idempotency 키 갱신.
 * URL 미설정 / outbox 비어있음 / 마지막 corrId == outbox.corrId(이미 성공한 trip)는 graceful skip.
 *
 * 절대 throw 안 한다 — launch path critical.
 */
export async function flushSignalDumpOutbox(): Promise<SignalDumpUploadResult> {
  const base = getAlarmBackendUrl();
  if (!base) {
    return { ok: false, skipped: true, skipReason: 'no-url' };
  }
  const entry = await readOutbox();
  if (entry === null) {
    return { ok: false, skipped: true, skipReason: 'no-entries' };
  }

  const lastCorrId = await getLastUploadedCorrId();
  if (lastCorrId === entry.corrId) {
    // 이미 성공한 trip — outbox만 정리.
    await clearOutbox();
    return { ok: false, skipped: true, skipReason: 'duplicate' };
  }

  const result = await performUpload(base, entry);
  if (result.ok) {
    await setLastUploadedCorrId(entry.corrId);
    await clearOutbox();
  }
  return result;
}
