/**
 * #819 — backend로 GPS 좌표 + Motion 송신.
 *
 * 디바이스가 BG/FG location task에서 fix마다 호출. backend가 device token별 series를 KV에
 * 축적해 cron 사이클마다 9단 boarding-prompt 게이트(ADR Section 2)에 사용한다.
 *
 * iOS `client.speed`는 -1/빈 값으로 자주 떨어지는 것이 #812 회귀의 직접 원인 — backend가 좌표
 * series로 평균 속도를 자체 계산하는 것이 정책 (ADR Section 6 step 5).
 *
 * 백엔드 URL 미설정/네트워크 실패는 throw 없이 graceful `{ ok:false, skipped:true }` — Phase 0
 * baseline(사전 예약만)은 그대로 동작한다.
 */

import { createLogger } from '../utils/logger';
import type { AccelSummary } from '../utils/accelMotion';

const log = createLogger('positionUpload');

export type PositionMotion = 'stationary' | 'walking' | 'automotive' | 'unknown';

export interface PositionUploadPayload {
  /** APNs device token (hex) — backend가 같은 키로 series 적재. */
  token: string;
  lat: number;
  lng: number;
  /** GPS accuracy meters. backend가 ≥ 50m sample은 hop 계산에서 제외. */
  accuracy: number;
  /** epoch ms — 디바이스 측정 시각. backend 시계와의 drift는 평균속도가 자체 보정. */
  ts: number;
  motion: PositionMotion;
  /**
   * #823 Phase 3 E1 — 가속도 1초 window 요약값 (옵션).
   * 디바이스에서 100Hz raw → 1Hz 요약 변환 후 첨부. 부재 시 backend는 가속도 series append를 skip
   * — 기존 #819 게이트는 영향 없음 (E1은 신호 추가만, fusion 사용은 E2 단계 몫).
   */
  accelSummary?: AccelSummary;
}

export interface PositionUploadResult {
  ok: boolean;
  skipped?: boolean;
  status?: number;
}

/** fetch 타임아웃 — BG task는 OS suspend 임박이라 짧게 유지. */
const REQUEST_TIMEOUT_MS = 5000;

function getBackendUrl(): string | null {
  const url = process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
  if (!url) return null;
  return url.replace(/\/$/, '');
}

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function uploadPosition(
  payload: PositionUploadPayload,
): Promise<PositionUploadResult> {
  const base = getBackendUrl();
  if (!base) {
    log.info('ALARM_BACKEND_URL not set — skip position upload');
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetchWithTimeout(`${base}/position`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      log.warn(`position upload failed status=${res.status}`);
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    log.warn('position upload error', e);
    return { ok: false };
  }
}

/**
 * boarding-prompt 사용자 [미탑승]/dismiss 통보 (#819 게이트 #9).
 * backend가 trip.boardingPromptState.silencedUntil를 5분 후로 set해 재발사 차단.
 */
export async function dismissBoardingPrompt(token: string): Promise<PositionUploadResult> {
  const base = getBackendUrl();
  if (!base) {
    log.info('ALARM_BACKEND_URL not set — skip boarding-prompt dismiss');
    return { ok: false, skipped: true };
  }
  if (!token) return { ok: false };
  try {
    const res = await fetchWithTimeout(`${base}/boarding-prompt/dismiss`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      log.warn(`dismiss failed status=${res.status}`);
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    log.warn('dismiss error', e);
    return { ok: false };
  }
}
