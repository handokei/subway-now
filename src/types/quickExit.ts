export type FacilityCategory = 'stairs' | 'elevator' | 'transfer';

// 한 역의 한 시설 출구 — 차량(칸) 번호와 출입문 번호.
// transfer 카테고리에서는 환승 대상 노선 코드(서울 OpenAPI에서 받은 원본 문자열)를
// 같이 보관해 다중 환승역에서 노선별로 필터링할 수 있도록 한다.
export interface QuickExitEntry {
  doorNumber: string;
  carNumber?: string;
  targetLine?: string;
}

export interface StationQuickExit {
  stairs?: QuickExitEntry[];
  elevator?: QuickExitEntry[];
  transfer?: QuickExitEntry[];
}

export type QuickExitMap = Record<string, StationQuickExit>;

// 거동 불편자 모드 ON 일 때 EV 우선. 데이터 없으면 다음 카테고리로 fallback.
export const FACILITY_PRIORITY_DEFAULT: readonly FacilityCategory[] = ['stairs', 'transfer'];
export const FACILITY_PRIORITY_ACCESSIBILITY: readonly FacilityCategory[] = [
  'elevator',
  'transfer',
  'stairs',
];
