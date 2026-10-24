/**
 * 사용자 버그 신고 클라이언트 (#1034, docs/requirements/12-cross-cutting.md).
 *
 * SettingsScreen의 FeedbackModal이 사용. backend `POST /feedback`에 메시지 + 디바이스 컨텍스트를
 * 송신한다. 실패는 graceful — UI가 "잠시 후 다시 시도" 안내.
 *
 * 환경변수:
 *   `EXPO_PUBLIC_ALARM_BACKEND_URL` — 미설정 시 ok=false + skipped=true (개발 환경 호환).
 */

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import i18n from 'i18next';
import { createLogger } from '../utils/logger';

const log = createLogger('feedbackApi');

/** fetch 타임아웃 — UI 입력 흐름에 영향 주지 않게 짧게 끊는다. */
export const FEEDBACK_REQUEST_TIMEOUT_MS = 5000;

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

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEEDBACK_REQUEST_TIMEOUT_MS);
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
export async function submitFeedback(message: string): Promise<SubmitFeedbackResult> {
  const base = getBackendUrl();
  if (!base) {
    log.info('ALARM_BACKEND_URL not set — skip feedback submit');
    return { ok: false, skipped: true };
  }

  const body = { message, context: buildFeedbackContext() };

  try {
    const res = await fetchWithTimeout(`${base}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
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
