/**
 * silent push 게이트 outcome 텔레메트리 적재 (#498).
 *
 * 클라(`src/utils/telemetryAggregation.ts`)가 alarmLog의 silent-push-* 엔트리를
 * 30분 주기로 집계해 POST한 카운터를 Cloudflare Analytics Engine에 적재한다.
 *
 * Privacy: 개별 push 내용/시각/위치 좌표는 포함하지 않는다. 카운트만.
 * token은 8자 prefix만 blob에 남겨 anonymous aggregate에 사용. 전체 token은 저장하지 않는다.
 */

import type { AnalyticsEngineWriter } from './types';

/**
 * 클라이언트가 보내는 telemetry upload payload.
 * 카운터는 모두 0 이상 정수.
 */
export interface TelemetryUpload {
  /** APNs device token (hex). prefix(8자)만 anonymous aggregate에 사용. */
  token: string;
  /** 이전 flush 시각(epoch ms). 첫 flush는 0. */
  since: number;
  /** 현재 flush 시각(epoch ms). */
  until: number;
  /** silent-push-received 카운트 (분모). */
  received: number;
  /** silent-push-fired 카운트 (게이트 통과 → 발사). */
  fired: number;
  /** silent-push-skipped 카운트 (게이트 차단). */
  skipped: number;
  /** skipped의 reason별 카운트. 알려진 키만 집계, 나머지는 무시. */
  skipReasons: Record<string, number>;
}

const KNOWN_SKIP_REASONS = [
  'gate-unknown-station',
  'gate-no-location',
  'gate-stale-location',
  'gate-out-of-range',
  'payload-missing-kind',
] as const;

export type KnownSkipReason = (typeof KNOWN_SKIP_REASONS)[number];

function isFiniteNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isInteger(value);
}

/**
 * payload 검증. 형태가 깨졌으면 null, 정상이면 정규화된 객체.
 * - 음수/NaN/소수 reject (카운터는 자연수)
 * - skipReasons는 객체만 허용, 알려진 키만 보존
 */
export function validateTelemetryUpload(input: unknown): TelemetryUpload | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.token !== 'string' || obj.token.length === 0) return null;
  if (!isFiniteNonNegativeInt(obj.since)) return null;
  if (!isFiniteNonNegativeInt(obj.until)) return null;
  if (obj.until < obj.since) return null;
  if (!isFiniteNonNegativeInt(obj.received)) return null;
  if (!isFiniteNonNegativeInt(obj.fired)) return null;
  if (!isFiniteNonNegativeInt(obj.skipped)) return null;
  if (!obj.skipReasons || typeof obj.skipReasons !== 'object') return null;

  const rawReasons = obj.skipReasons as Record<string, unknown>;
  const skipReasons: Record<string, number> = {};
  for (const key of KNOWN_SKIP_REASONS) {
    const v = rawReasons[key];
    if (v === undefined) continue;
    if (!isFiniteNonNegativeInt(v)) return null;
    skipReasons[key] = v;
  }

  return {
    token: obj.token,
    since: obj.since,
    until: obj.until,
    received: obj.received,
    fired: obj.fired,
    skipped: obj.skipped,
    skipReasons,
  };
}

/** anonymous aggregate용 token prefix. 전체 토큰은 절대 로그/AE에 적재하지 않는다. */
export function tokenPrefix(token: string): string {
  return token.slice(0, 8);
}

/**
 * Analytics Engine에 카운터별 data point를 적재한다.
 * 0인 카운터는 skip — query 노이즈 감소.
 *
 * Schema:
 *   blob1 = source label (예: 'received', 'fired', 'skipped:gate-out-of-range')
 *   blob2 = token prefix (8자)
 *   double1 = count
 *   index1 = token prefix (sampling용)
 */
export function writeTelemetryDataPoints(
  writer: AnalyticsEngineWriter,
  payload: TelemetryUpload,
): void {
  const prefix = tokenPrefix(payload.token);
  const write = (label: string, count: number): void => {
    if (count <= 0) return;
    writer.writeDataPoint({
      blobs: [label, prefix],
      doubles: [count],
      indexes: [prefix],
    });
  };

  write('received', payload.received);
  write('fired', payload.fired);
  write('skipped', payload.skipped);
  for (const reason of KNOWN_SKIP_REASONS) {
    const count = payload.skipReasons[reason] ?? 0;
    write(`skipped:${reason}`, count);
  }
}
