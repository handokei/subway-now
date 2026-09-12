/**
 * #1170 — boarding-prompt 게이트/응답 acceptance dashboard 측정.
 *
 * Epic #1008 B3 acceptance 측정 인프라. backend 9단 게이트(#819)를 통과해 발사된
 * boarding-prompt push에 대해 사용자가 어떻게 응답하는지 정량 추적.
 *
 * 측정 채널 (모두 source='boarding-prompt' alarmLog entry):
 *
 *   - displayed: `logBoardingPromptFired` (#1021) — gate 통과 후 prompt 표시.
 *     `outcome='fired'`이고 `reason` 미설정인 entry.
 *
 *   - responded:
 *       boarded   = `logBoardingPromptResponded({outcome:'boarded'})` — [탑승]/$default tap.
 *       dismissed = `logBoardingPromptResponded({outcome:'dismissed'})` — [미탑승]/dismiss.
 *     `outcome='received'`이고 `reason='response-boarded'|'response-dismissed'`인 entry.
 *
 * 측정 한계:
 *   - "gate 진입" (backend가 9단 게이트 평가에 진입한 횟수)은 client에서 직접 관찰 불가.
 *     backend `/admin/quota`/cron stats가 진입 카운터를 가지고 있다 (`scheduled.ts` stats).
 *     본 모듈은 client 관찰 가능 metric에 집중 — "표시 vs 응답" 응답률이 acceptance 핵심 지표.
 *
 *   - response가 backend 미도달(네트워크 실패)인 경우에도 client 적재는 발생 — 사용자 인지
 *     기준 응답률을 측정. backend 도달률은 별도 channel.
 *
 * 일별 집계 (`byDay`):
 *   - 1주 baseline 측정을 위해 로컬 날짜(YYYY-MM-DD) key로 displayed/responded 누적.
 *   - 타임존: client 로컬. acceptance dashboard는 사용자 체감 기준이라 UTC 대신 로컬이 적절.
 */

import type { AlarmLogEntry, AlarmLogReason } from './alarmLog';

export interface BoardingPromptDayCounts {
  displayed: number;
  responded: number;
  boarded: number;
  dismissed: number;
}

export interface BoardingPromptMonitorStats {
  /** 전체 prompt 표시 횟수 (gate 통과 후 발사). */
  displayed: number;
  /** 응답 (boarded + dismissed) 총합. */
  responded: number;
  boarded: number;
  dismissed: number;
  /**
   * 응답률 = responded / displayed (%, 소수점 1자리). displayed=0이면 null.
   * dashboard에서 "—"로 표기.
   */
  responseRatePct: number | null;
  /**
   * 탑승률 = boarded / responded (%, 소수점 1자리). responded=0이면 null.
   * 9단 게이트 정확도 proxy — 게이트가 정확하면 boarded 비율이 높다.
   */
  boardedRatePct: number | null;
  /** 로컬 날짜(YYYY-MM-DD) → 카운트. 1주 baseline export 용. */
  byDay: Record<string, BoardingPromptDayCounts>;
}

const RESPONSE_REASONS: ReadonlySet<AlarmLogReason> = new Set<AlarmLogReason>([
  'response-boarded',
  'response-dismissed',
]);

/**
 * 엔트리를 displayed / boarded / dismissed 중 어디로 분류할지 결정.
 * 분류 안 되면 null (다른 채널 entry — autolock telemetry 등).
 */
function classify(
  entry: AlarmLogEntry,
): 'displayed' | 'boarded' | 'dismissed' | null {
  if (entry.source !== 'boarding-prompt') return null;
  if (entry.outcome === 'fired' && entry.reason === undefined) return 'displayed';
  if (entry.outcome === 'received' && entry.reason !== undefined) {
    if (entry.reason === 'response-boarded') return 'boarded';
    if (entry.reason === 'response-dismissed') return 'dismissed';
  }
  return null;
}

/**
 * 로컬 타임존 기준 YYYY-MM-DD 변환. ISO UTC string(slice(0,10)) 사용 시 타임존 경계에서
 * "전날 23:30 fire가 다음날로 집계"되는 사고가 생기므로 toLocaleDateString sv-SE (ISO format)
 * 채택 — 모든 region에서 YYYY-MM-DD 형태.
 */
export function toLocalDayKey(ts: number): string {
  return new Date(ts).toLocaleDateString('sv-SE');
}

function emptyDay(): BoardingPromptDayCounts {
  return { displayed: 0, responded: 0, boarded: 0, dismissed: 0 };
}

function pct(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function computeBoardingPromptMonitor(
  entries: readonly AlarmLogEntry[],
): BoardingPromptMonitorStats {
  const stats: BoardingPromptMonitorStats = {
    displayed: 0,
    responded: 0,
    boarded: 0,
    dismissed: 0,
    responseRatePct: null,
    boardedRatePct: null,
    byDay: {},
  };

  for (const entry of entries) {
    const bucket = classify(entry);
    if (bucket === null) continue;

    const dayKey = toLocalDayKey(entry.ts);
    const day = stats.byDay[dayKey] ?? emptyDay();
    const count = entry.count ?? 1;

    if (bucket === 'displayed') {
      stats.displayed += count;
      day.displayed += count;
    } else {
      stats.responded += count;
      day.responded += count;
      if (bucket === 'boarded') {
        stats.boarded += count;
        day.boarded += count;
      } else {
        stats.dismissed += count;
        day.dismissed += count;
      }
    }
    stats.byDay[dayKey] = day;
  }

  stats.responseRatePct = pct(stats.responded, stats.displayed);
  stats.boardedRatePct = pct(stats.boarded, stats.responded);
  return stats;
}

/**
 * 일별 집계를 최근 N일 (오늘 포함) 시계열로 정렬해 반환. dashboard / export 진입점.
 * 누락된 날짜는 0 채움. 정렬: 과거 → 현재.
 */
export interface BoardingPromptDayRow extends BoardingPromptDayCounts {
  dayKey: string;
}

export function exportRecentDays(
  stats: BoardingPromptMonitorStats,
  days: number,
  now: number = Date.now(),
): BoardingPromptDayRow[] {
  const rows: BoardingPromptDayRow[] = [];
  const DAY_MS = 24 * 60 * 60 * 1000;
  // 로컬 자정 정렬을 위해 dayKey 기반으로 역산. 단순 ts-=DAY_MS는 DST 경계 1시간 어긋날 수 있지만
  // 본 dashboard는 정확한 자정 정렬보다 "최근 N일" 추세 표시가 목적이라 허용.
  for (let i = days - 1; i >= 0; i -= 1) {
    const ts = now - i * DAY_MS;
    const dayKey = toLocalDayKey(ts);
    const counts = stats.byDay[dayKey] ?? emptyDay();
    rows.push({ dayKey, ...counts });
  }
  return rows;
}
