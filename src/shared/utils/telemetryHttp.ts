/**
 * Telemetry HTTP 공용 헬퍼 (#1175 SonarCloud 중복 제거).
 *
 * alarm-worker `/telemetry/*` 엔드포인트 호출자들이 공유하는 base URL 조회 +
 * AbortController 기반 timeout fetch. 텔레메트리는 후속 알람 흐름을 차단하지
 * 않도록 짧은 timeout으로 끊는다.
 */

/** fetch 타임아웃 — 텔레메트리 호출이 후속 알람 흐름에 영향 주지 않게 짧게 끊는다. */
export const TELEMETRY_REQUEST_TIMEOUT_MS = 5000;

/** alarm-worker base URL. 미설정 시 null → 호출자는 graceful skip 처리. */
export function getAlarmBackendUrl(): string | null {
  const url = process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
  if (!url) return null;
  return url.replace(/\/$/, '');
}

/** AbortController 기반 timeout fetch. 타임아웃 시 호출자가 catch. */
export async function fetchWithTelemetryTimeout(
  input: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEMETRY_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
