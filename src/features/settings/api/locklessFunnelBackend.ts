/**
 * Lockless funnel telemetry backend client (#1175, Epic #1008).
 *
 * alarm-worker `/telemetry/lockless-funnel` endpoint로 funnel step 1건을 POST 한다.
 * 동작 변경 없음 — 순수 측정 인프라. 기존 telemetryBackend.ts와 동형 graceful 정책:
 *   - URL 미설정 → skipped=true (no-op)
 *   - fetch 실패 → ok=false 반환 (throw 안 함)
 *
 * apnsToken은 alarm flow에서 이미 등록된 device 식별자를 그대로 사용해
 * funnel을 device 단위로 dedup 가능하게 한다.
 */

import type { LocklessFunnelStep } from '../utils/locklessFunnel';
import { createLogger } from '../../../shared/utils/logger';
import {
  fetchWithTelemetryTimeout,
  getAlarmBackendUrl,
} from '../../../shared/utils/telemetryHttp';

const log = createLogger('locklessFunnelBackend');

export interface LocklessFunnelUploadResult {
  ok: boolean;
  /** URL/token 미설정 등으로 호출 자체가 건너뛰어진 경우. */
  skipped?: boolean;
  status?: number;
}

export async function uploadLocklessFunnelStep(
  token: string,
  step: LocklessFunnelStep,
  meta?: Record<string, unknown>,
): Promise<LocklessFunnelUploadResult> {
  const base = getAlarmBackendUrl();
  if (!base) {
    log.info('ALARM_BACKEND_URL not set — skip funnel upload');
    return { ok: false, skipped: true };
  }
  if (!token) {
    return { ok: false, skipped: true };
  }

  const body: Record<string, unknown> = {
    token,
    step,
    at: Date.now(),
  };
  if (meta !== undefined) {
    body.meta = meta;
  }

  try {
    const res = await fetchWithTelemetryTimeout(`${base}/telemetry/lockless-funnel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      log.warn(`funnel upload failed status=${res.status}`);
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    log.warn('funnel upload error', e);
    return { ok: false };
  }
}
