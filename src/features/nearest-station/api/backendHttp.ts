/**
 * Seam E (#901) — alarm backend HTTP 공통 헬퍼.
 *
 * `getBackendUrl` / `fetchWithTimeout`는 positionUpload·boardingLockSync 양쪽이 1:1로
 * 사용하는 동일 로직. 한곳에서만 정의해 dup 제거 + 후속 backend endpoint 추가 시 동일 패턴 재사용.
 */

const REQUEST_TIMEOUT_MS = 5000;

/** `EXPO_PUBLIC_ALARM_BACKEND_URL` trim. 미설정 시 null — 호출자는 graceful skip 처리. */
export function getBackendUrl(): string | null {
  const url = process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
  if (!url) return null;
  return url.replace(/\/$/, '');
}

/** AbortController 기반 5s 타임아웃 fetch. BG/foreground 모두 동일 짧은 cutoff. */
export async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
