import quickExitData from '../data/quickExit.json';
import type {
  FacilityCategory,
  QuickExitEntry,
  QuickExitMap,
  StationQuickExit,
} from '../types/quickExit';
import {
  FACILITY_PRIORITY_ACCESSIBILITY,
  FACILITY_PRIORITY_DEFAULT,
} from '../types/quickExit';

const QUICK_EXIT_MAP = quickExitData as QuickExitMap;

interface ResolveOptions {
  // 거동 불편자 모드 ON 일 때 EV 우선 — FACILITY_PRIORITY_ACCESSIBILITY를 사용한다.
  accessibilityMode?: boolean;
  // 환승 카테고리에서 특정 환승 대상 노선만 추리고 싶을 때.
  targetLine?: string;
}

export interface ResolvedQuickExit {
  category: FacilityCategory;
  entry: QuickExitEntry;
}

// 시설 우선순위를 따라가며 처음으로 매칭되는 카테고리의 첫 엔트리를 반환한다.
// 데이터가 모든 카테고리에서 비어 있거나 station이 등록되어 있지 않으면 null.
// caller(UI)는 null이면 빠른하차 라벨을 생략한다.
export function resolveQuickExit(
  stationId: string,
  options: ResolveOptions = {},
): ResolvedQuickExit | null {
  const station: StationQuickExit | undefined = QUICK_EXIT_MAP[stationId];
  if (!station) return null;

  const priority = options.accessibilityMode
    ? FACILITY_PRIORITY_ACCESSIBILITY
    : FACILITY_PRIORITY_DEFAULT;

  for (const category of priority) {
    const entries = station[category];
    if (!entries || entries.length === 0) continue;
    // targetLine은 환승 카테고리에서만 의미가 있다 (transfer 출구는 환승 대상 노선별로 다름).
    // 다른 카테고리(stairs/elevator)에서는 단순히 첫 엔트리를 채택.
    const entry =
      category === 'transfer' && options.targetLine
        ? entries.find((e) => e.targetLine === options.targetLine)
        : entries[0];
    if (entry) return { category, entry };
  }
  return null;
}
