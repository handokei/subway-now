/**
 * Arrival API SSOT Feature Flag — backend remote 조회 client (Phase 0, ADR-022 / #1982).
 *
 * `/admin/arch-flag` 엔드포인트를 GET 으로 조회해 현재 KV 상태(`on` / `off`) 를 얻는다.
 * ADMIN_TOKEN / ALARM_BACKEND_URL 미설정 환경(일반 사용자 빌드) 에서는 `unconfigured`
 * 를 반환 — 호출자는 remote 없이 env 만으로 판정한다. observabilityMetricsClient 와 동일 패턴.
 */

import {
  fetchWithTelemetryTimeout,
  getAlarmBackendUrl,
} from '../utils/telemetryHttp';

/** Fetch 결과 union — 호출자는 kind 로 분기. */
export type FetchArchFlagResult =
  | { kind: 'ok'; value: 'on' | 'off' }
  | { kind: 'error'; message: string }
  | { kind: 'unconfigured' };

/** ADMIN_TOKEN 환경변수 조회. 미설정 시 null. observabilityMetricsClient 동일 패턴. */
function getAdminToken(): string | null {
  const token = process.env.EXPO_PUBLIC_ADMIN_TOKEN;
  if (!token) return null;
  return token;
}

/**
 * `/admin/arch-flag` 단건 fetch.
 *
 *  - ADMIN_TOKEN 미설정 → `{ kind: 'unconfigured' }`
 *  - ALARM_BACKEND_URL 미설정 → `{ kind: 'unconfigured' }`
 *  - HTTP 오류 / 네트워크 실패 / body parse 실패 → `{ kind: 'error', message }`
 *  - 성공 → `{ kind: 'ok', value }`
 */
export async function fetchArchFlag(): Promise<FetchArchFlagResult> {
  const token = getAdminToken();
  if (!token) return { kind: 'unconfigured' };

  const base = getAlarmBackendUrl();
  if (!base) return { kind: 'unconfigured' };

  try {
    const res = await fetchWithTelemetryTimeout(`${base}/admin/arch-flag`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return { kind: 'error', message: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { value?: unknown };
    if (body.value === 'on' || body.value === 'off') {
      return { kind: 'ok', value: body.value };
    }
    return { kind: 'error', message: 'invalid_body' };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { kind: 'error', message };
  }
}

// Internal exports for tests — DO NOT use from app code.
export const __test__ = {
  getAdminToken,
};
