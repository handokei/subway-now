/**
 * 사용자 버그 신고 클라이언트 (#1034, docs/requirements/12-cross-cutting.md).
 *
 * SettingsScreen의 FeedbackModal이 사용. backend `POST /feedback`에 메시지 + 디바이스 컨텍스트
 * (+ #3366 report·diagnostics)를 송신한다. 실패는 graceful — UI가 "잠시 후 다시 시도" 안내.
 *
 * 환경변수:
 *   `EXPO_PUBLIC_ALARM_BACKEND_URL` — 미설정 시 ok=false + skipped=true (개발 환경 호환).
 */

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import i18n from 'i18next';
import { createLogger } from '../utils/logger';
import { scrubDiagnostics } from '../utils/scrubDiagnostics';
import type { FeedbackCategory } from '../constants/feedbackCategories';

const log = createLogger('feedbackApi');

/** fetch 타임아웃 — UI 입력 흐름에 영향 주지 않게 짧게 끊는다. */
export const FEEDBACK_REQUEST_TIMEOUT_MS = 5000;

/** #3366 — 진단(dump ~130KB) 첨부 요청은 업로드 시간을 감안해 20s. message-only는 5s 유지. */
export const FEEDBACK_DIAGNOSTICS_REQUEST_TIMEOUT_MS = 20000;

/** #3366 — "어디서 틀렸나요?" 구조화 필드. backend report 계약과 동일(무효 값은 서버가 drop). */
export interface FeedbackReport {
  category?: FeedbackCategory;
  stationId?: string;
  /** hashTripToken(APNS token) — 원본 token 아님. */
  tripKey?: string;
  occurredAt?: number;
}

export interface SubmitFeedbackOptions {
  report?: FeedbackReport;
  /** redact된 dump 텍스트. 송신 직전 방어 스크럽을 한 번 더 거친다. */
  diagnostics?: string;
}

export interface SubmitFeedbackResult {
  ok: boolean;
  /** URL 미설정 등으로 호출이 건너뛰어진 경우 true. */
  skipped?: boolean;
  status?: number;
}

function getBackendUrl(): string | null {
  const url = process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
  if (!url) return null;
  return url.replace(/\/$/, '');
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 클라이언트 디바이스 컨텍스트 — 운영자가 분기 트리아지 시 사용. */
export function buildFeedbackContext(): {
  appVersion?: string;
  platform?: 'ios' | 'android';
  locale?: string;
} {
  const ctx: { appVersion?: string; platform?: 'ios' | 'android'; locale?: string } = {};
  const version = Constants.expoConfig?.version;
  if (typeof version === 'string' && version.length > 0) ctx.appVersion = version;
  if (Platform.OS === 'ios' || Platform.OS === 'android') ctx.platform = Platform.OS;
  if (typeof i18n.language === 'string' && i18n.language.length > 0) ctx.locale = i18n.language;
  return ctx;
}

/**
 * 사용자 버그 신고 송신.
 *
 * @returns ok=true(201) / ok=false(network or non-2xx) / skipped=true(URL 미설정).
 *   호출부(FeedbackModal)는 ok 기준으로 toast/dismiss 분기 — skipped도 ok=false로 동일 처리.
 */
export async function submitFeedback(
  message: string,
  options: SubmitFeedbackOptions = {},
): Promise<SubmitFeedbackResult> {
  const base = getBackendUrl();
  if (!base) {
    log.info('ALARM_BACKEND_URL not set — skip feedback submit');
    return { ok: false, skipped: true };
  }

  const { report, diagnostics } = options;
  const body = {
    message,
    context: buildFeedbackContext(),
    ...(report === undefined ? {} : { report }),
    ...(diagnostics === undefined ? {} : { diagnostics: scrubDiagnostics(diagnostics) }),
  };
  const timeoutMs =
    diagnostics === undefined ? FEEDBACK_REQUEST_TIMEOUT_MS : FEEDBACK_DIAGNOSTICS_REQUEST_TIMEOUT_MS;

  try {
    const res = await fetchWithTimeout(
      `${base}/feedback`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
    if (!res.ok) {
      log.warn(`feedback submit failed status=${res.status}`);
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    log.warn('feedback submit error', e);
    return { ok: false };
  }
}
