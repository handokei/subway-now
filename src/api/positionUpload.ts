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

import AsyncStorage from '@react-native-async-storage/async-storage';
import { ACTIVE_BOARDING_LINE_KEY } from '../constants/storageKeys';
import { snapToLinePolyline } from '../utils/linePolyline';
import type { LineNumber } from '../types/station';
import { createLogger } from '../utils/logger';

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
   * #828 Phase 2 fusion — 클라이언트가 active boarding line polyline에 좌표를 사영한 결과.
   * 짝(line+arcM)으로만 의미가 있고 한쪽만 보내면 backend가 둘 다 무시한다.
   * unmatched / boarding line 미설정 시 두 필드 모두 omit (graceful — backend는 GPS-only로 동작).
   */
  mapMatchedLine?: string;
  mapMatchedArcM?: number;
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

/**
 * #828 — active boarding line이 mirror돼 있으면 그 라인으로 좌표를 snap해 mapMatched 결과를 채운다.
 *
 * - 호출자가 `mapMatchedLine` + `mapMatchedArcM`을 명시 전달했으면 그대로 사용 (override).
 * - mirror 부재 / unmatched / AsyncStorage 실패 → 두 필드 모두 omit (graceful, GPS-only fallback).
 *
 * 결과 객체는 backend로 보낼 JSON. 호출자가 직접 쓸 수 있게 export.
 */
export async function withMapMatched(
  payload: PositionUploadPayload,
): Promise<PositionUploadPayload> {
  if (payload.mapMatchedLine !== undefined && payload.mapMatchedArcM !== undefined) {
    return payload;
  }
  let line: string | null;
  try {
    line = await AsyncStorage.getItem(ACTIVE_BOARDING_LINE_KEY);
  } catch {
    return payload;
  }
  if (!line) return payload;
  const snap = snapToLinePolyline(
    { lat: payload.lat, lng: payload.lng },
    line as LineNumber,
  );
  if (!snap.matched) return payload;
  return {
    ...payload,
    mapMatchedLine: snap.line,
    mapMatchedArcM: snap.arcM,
  };
}

export async function uploadPosition(
  payload: PositionUploadPayload,
): Promise<PositionUploadResult> {
  const base = getBackendUrl();
  if (!base) {
    log.info('ALARM_BACKEND_URL not set — skip position upload');
    return { ok: false, skipped: true };
  }
  const enriched = await withMapMatched(payload);
  try {
    const res = await fetchWithTimeout(`${base}/position`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(enriched),
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
