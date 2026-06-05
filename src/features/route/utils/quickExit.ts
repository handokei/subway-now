import quickExitData from '../../../data/quickExit.json';
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
import type { TravelDirection } from '../types/exitSide';

const QUICK_EXIT_MAP = quickExitData as QuickExitMap;

// 한 역에 빠른하차 데이터가 존재하는지(어떤 카테고리든) — 알람 본문의 추상 힌트 표시 여부 판단.
export function hasQuickExitData(stationId: string): boolean {
  const station = QUICK_EXIT_MAP[stationId];
  if (!station) return false;
  return Boolean(
    (station.stairs && station.stairs.length > 0) ||
      (station.elevator && station.elevator.length > 0) ||
      (station.transfer && station.transfer.length > 0),
  );
}

interface ResolveOptions {
  // 거동 불편자 모드 ON 일 때 EV 우선 — FACILITY_PRIORITY_ACCESSIBILITY를 사용한다.
  accessibilityMode?: boolean;
  // 진행방향이 주어지면 같은 방향의 엔트리만 후보로 본다. 미지정 시 모든 엔트리.
  direction?: TravelDirection;
}

export interface ResolvedQuickExit {
  category: FacilityCategory;
  entry: QuickExitEntry;
}

// 시설 우선순위를 따라가며 처음으로 매칭되는 카테고리의 첫 엔트리를 반환한다.
// 데이터가 모든 우선순위 카테고리에서 비어 있거나 station이 등록되어 있지 않으면 null.
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
    const filtered = options.direction
      ? entries.filter((e) => e.direction === options.direction)
      : entries;
    if (filtered.length === 0) continue;
    return { category, entry: filtered[0] };
  }
  return null;
}
