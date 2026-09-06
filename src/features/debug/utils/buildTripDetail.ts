/**
 * #1956 (S-m3-1, Epic #1503) — TripDetailModal 데이터 변환 helper.
 *
 * Operation Dashboard 4 metric 차트 클릭 시 진입하는 TripDetailModal은 4 영역을 표시:
 *   1) token   — 클릭된 trip의 corrId (또는 'unknown' 버킷)
 *   2) timeline — trip lifecycle 시작/종료 + enter/exit/cycle 카운트
 *   3) rawSignal — 해당 corrId의 RawSignalEntry 시간순 목록 (DISPLAY_LIMIT 적용)
 *   4) deepLink  — Sentry/R2 사후 검사용 외부 URL (DSN 미설정 시 null)
 *
 * 본 helper는 입력 entries + tripToken을 받아 위 4 영역에 필요한 derived data를
 * 즉시 사용 가능한 형태로 변환한다. View는 결과 객체의 필드를 그대로 렌더하면 된다.
 *
 * Wire 정합성:
 *   - tripToken=null 또는 매칭 entry 0건 → null 반환 (caller가 fallback 화면 렌더)
 *   - corrId=null 항목은 'unknown' 버킷으로 그룹화 (MetricDrillDownView와 동일 컨벤션)
 *
 * 순수 함수 — AsyncStorage / fetch / Date.now() 호출 없음. 모든 시각은 entry.ts에서 derive.
 */
import type { RawSignalEntry, RawSignalKind } from '../../observability/utils/rawSignalBuffer';

/** corrId=null 항목이 그룹화되는 단일 버킷 이름. MetricDrillDownView와 공유. */
export const UNKNOWN_CORR_ID_BUCKET = 'unknown';

/** rawSignal 영역에 표시할 최대 entry 수. UI 스크롤 부담 + dump 분량 균형. */
export const TRIP_DETAIL_RAW_SIGNAL_LIMIT = 30;

/** RawSignalKind별 카운트 합계. lifecycle timeline에 cycle/enter/exit 빈도 표시. */
export type RawSignalKindCounts = Record<RawSignalKind, number>;

/**
 * TripDetailModal에 전달할 변환된 trip 상세 데이터.
 * tripToken과 매칭되는 entries가 0건이면 null이 반환되므로 객체 존재 자체가
 * "최소 1건의 raw signal entry 존재"를 의미한다.
 */
export interface TripDetail {
  /** corrId (예: `corr-abc123`) 또는 'unknown' 버킷. */
  tripToken: string;
  /** lifecycle: 첫 entry ts (epoch ms). */
  firstTs: number;
  /** lifecycle: 마지막 entry ts (epoch ms). */
  lastTs: number;
  /** lifecycle: 총 누적 시간 (lastTs - firstTs). */
  durationMs: number;
  /** lifecycle: kind별 entry 카운트 (cycle/enter/exit). */
  kindCounts: RawSignalKindCounts;
  /** rawSignal 영역에 표시할 entry 목록 — 최신순(lastTs 내림차순), 최대 TRIP_DETAIL_RAW_SIGNAL_LIMIT. */
  entries: readonly RawSignalEntry[];
}

/**
 * tripToken과 매칭되는 RawSignalEntry를 필터링.
 * tripToken === UNKNOWN_CORR_ID_BUCKET이면 corrId=null entries만 반환.
 * 그 외에는 corrId === tripToken인 entries만 반환.
 */
function filterEntriesByToken(
  entries: readonly RawSignalEntry[],
  tripToken: string,
): readonly RawSignalEntry[] {
  if (tripToken === UNKNOWN_CORR_ID_BUCKET) {
    return entries.filter((e) => e.corrId === null);
  }
  return entries.filter((e) => e.corrId === tripToken);
}

/** kind별 카운트 집계 — 0 초기값에서 누적. */
function countByKind(entries: readonly RawSignalEntry[]): RawSignalKindCounts {
  const counts: RawSignalKindCounts = { cycle: 0, enter: 0, exit: 0 };
  for (const entry of entries) {
    counts[entry.kind] += 1;
  }
  return counts;
}

/**
 * 주어진 tripToken에 대한 TripDetail snapshot을 빌드.
 *
 * 입력:
 *   - entries: rawSignalBuffer 전체 snapshot (또는 caller가 제공한 subset)
 *   - tripToken: corrId 문자열 또는 'unknown' 버킷
 *
 * 반환:
 *   - 매칭 entries 0건 → null (caller가 빈 화면 fallback)
 *   - 1건 이상 → TripDetail (entries는 최신순 + DISPLAY_LIMIT 적용)
 */
export function buildTripDetail(
  entries: readonly RawSignalEntry[],
  tripToken: string | null,
): TripDetail | null {
  if (tripToken === null) return null;

  const matched = filterEntriesByToken(entries, tripToken);
  if (matched.length === 0) return null;

  const timestamps = matched.map((e) => e.ts);
  const firstTs = Math.min(...timestamps);
  const lastTs = Math.max(...timestamps);
  const kindCounts = countByKind(matched);

  // 최신순 정렬 + display limit
  const sorted = [...matched].sort((a, b) => b.ts - a.ts);
  const limited = sorted.slice(0, TRIP_DETAIL_RAW_SIGNAL_LIMIT);

  return {
    tripToken,
    firstTs,
    lastTs,
    durationMs: lastTs - firstTs,
    kindCounts,
    entries: limited,
  };
}
