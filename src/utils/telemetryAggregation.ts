/**
 * silent push 게이트 outcome 카운터 집계 (#498).
 *
 * alarmLog의 silent-push-* 엔트리에서 since(exclusive) 이후 항목만 골라
 * { received, fired, skipped, skipReasons }로 집계한다. 백엔드 /telemetry/silent-push
 * payload 형식 그대로.
 *
 * 동작 변경 없음 — 순수 측정 집계 함수.
 */

import type { AlarmLogEntry, AlarmLogReason } from '../features/alarm/utils/alarmLog';

export interface SilentPushTelemetryPayload {
  /** 이전 flush 시각(epoch ms). 첫 flush는 0. */
  since: number;
  /** 현재 flush 시각(epoch ms). entries.ts <= until만 포함. */
  until: number;
  received: number;
  fired: number;
  skipped: number;
  /** skipped의 reason별 카운트. 0인 reason은 키 자체 생략. */
  skipReasons: Partial<Record<AlarmLogReason, number>>;
}

export function aggregateSilentPushEntries(
  entries: AlarmLogEntry[],
  since: number,
  until: number,
): SilentPushTelemetryPayload {
  let received = 0;
  let fired = 0;
  let skipped = 0;
  const skipReasons: Partial<Record<AlarmLogReason, number>> = {};

  for (const entry of entries) {
    if (entry.ts <= since) continue;
    if (entry.ts > until) continue;
    switch (entry.source) {
      case 'silent-push-received':
        received += 1;
        break;
      case 'silent-push-fired':
        fired += 1;
        break;
      case 'silent-push-skipped': {
        skipped += 1;
        const reason = entry.reason;
        if (reason) {
          skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
        }
        break;
      }
      default:
        break;
    }
  }

  return { since, until, received, fired, skipped, skipReasons };
}

/** 모든 카운터가 0이면 upload할 의미가 없음 — flush 호출 측에서 skip 판단. */
export function isEmptyTelemetry(payload: SilentPushTelemetryPayload): boolean {
  return payload.received === 0 && payload.fired === 0 && payload.skipped === 0;
}
