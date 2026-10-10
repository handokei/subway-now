/**
 * Trip status reconciliation client (#1339 PR2 device).
 *
 * Backend GET `/trips/:tripToken/status` 호출. PR2 backend(#1341)가 추가한 endpoint로,
 * 디바이스가 cold-launch / FG 복귀 시 trip이 backend 측에서 이미 종료됐는지(예: silent
 * push 누락 / kill-app 동안 종료) 확인하는 backstop.
 *
 * 응답 contract:
 *   200 `{ status: 'active', endedAt: null, endReason: null }` → 아직 살아있음.
 *   200 `{ status: 'ended', endedAt: number, endReason: TripStatusEndReason }` → 자동 종료.
 *   404 → KV에서 trip/marker 모두 사라짐 (정리 대상).
 *   410 → ended record는 있지만 retention 만료 (정리 대상).
 *
 * 본 함수는 trip 자체가 정리 대상인지 caller가 판별할 수 있도록
 *  - active/ended는 객체 반환
 *  - 404/410은 null 반환 (정리만)
 *  - 네트워크 에러는 throw — caller가 silent fail 처리.
 *
 * Backend endReason은 'destination' / 'expired' / 'eta-missing' / 'push-unrecoverable' contract.
 * 디바이스 `TripEndedReason`은 'destination-arrived' / 'expired' / 'eta-missing' / 'push-unrecoverable'
 * / 'unknown'. backend 'destination'를 디바이스 'destination-arrived'로 정규화한다 —
 * 알 수 없는 값은 'unknown'.
 */

import type { TripEndedReason } from '../tasks/silentPushTask';
import { instrumentBackendFetch } from '../../../shared/utils/instrumentBackendFetch';

/** active/ended 응답 (200) — null이면 trip이 사라진 것(404/410). */
export interface TripStatusResult {
  status: 'active' | 'ended';
  /** ended일 때만 epoch ms. active는 null. */
  endedAt: number | null;
  /** ended일 때만 reason. active는 null. */
  endReason: TripEndedReason | null;
}

const REQUEST_TIMEOUT_MS = 5000;

type FetchImpl = typeof fetch;

function normalizeBaseUrl(base: string): string {
  return base.replace(/\/$/, '');
}

function normalizeEndReason(raw: unknown): TripEndedReason {
  if (typeof raw !== 'string') return 'unknown';
  if (raw === 'destination') return 'destination-arrived';
  if (
    raw === 'eta-missing' ||
    raw === 'expired' ||
    raw === 'push-unrecoverable'
  ) {
    return raw;
  }
  return 'unknown';
}

async function fetchWithTimeout(
  fetchImpl: FetchImpl,
  input: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    // #1518 — instrumentBackendFetch로 wrapping해 call/response/error entry를 진단 buffer에 push.
    return await instrumentBackendFetch(input, { ...init, signal: controller.signal }, fetchImpl);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Trip status를 backend에 조회한다.
 *
 * @param tripToken — 디바이스가 register 시 사용한 tripToken.
 * @param baseUrl — alarm backend base URL (trailing slash 무관).
 * @param fetchImpl — 기본 `fetch`. 테스트 주입용.
 *
 * @returns
 *   - 200 → `{ status, endedAt, endReason }`.
 *   - 404/410 → `null`.
 *
 * @throws 네트워크 에러 / 5xx / 기타 비정상 응답.
 */
export async function fetchTripStatus(
  tripToken: string,
  baseUrl: string,
  fetchImpl: FetchImpl = fetch,
): Promise<TripStatusResult | null> {
  const url = `${normalizeBaseUrl(baseUrl)}/trips/${encodeURIComponent(tripToken)}/status`;
  const res = await fetchWithTimeout(fetchImpl, url, { method: 'GET' });

  if (res.status === 404 || res.status === 410) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`trip status fetch failed: ${res.status}`);
  }

  const body = (await res.json()) as {
    status?: unknown;
    endedAt?: unknown;
    endReason?: unknown;
  };

  if (body.status === 'active') {
    return { status: 'active', endedAt: null, endReason: null };
  }
  if (body.status === 'ended') {
    const endedAt = typeof body.endedAt === 'number' && Number.isFinite(body.endedAt)
      ? body.endedAt
      : Date.now();
    return {
      status: 'ended',
      endedAt,
      endReason: normalizeEndReason(body.endReason),
    };
  }
  throw new Error(`trip status fetch: unexpected body`);
}
