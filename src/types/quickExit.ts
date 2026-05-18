import type { TravelDirection } from './exitSide';

export type FacilityCategory = 'stairs' | 'elevator' | 'transfer';

// OA-22749(getFstExit) 응답 한 행을 표현한다.
//   - doorNumber: 차량-출입문 번호 (예: "8-4" = 8호차 4번 문). UI 표시에서 칸 부분 노출 여부는 caller가 결정.
//   - direction: 상하행구분(upbdnbSe) — TravelDirection으로 정규화. 단조 노선 외에는 누락 가능.
//   - towardLabel: 방면정보(drtnInfo) — "남영", "시청" 등 인접 종착/주요 역명.
export interface QuickExitEntry {
  doorNumber: string;
  direction?: TravelDirection;
  towardLabel?: string;
}

export interface StationQuickExit {
  stairs?: QuickExitEntry[];
  elevator?: QuickExitEntry[];
  transfer?: QuickExitEntry[];
}

export type QuickExitMap = Record<string, StationQuickExit>;

// 거동 불편자 모드 ON 일 때 EV 우선. 데이터 없으면 다음 카테고리로 fallback.
// transfer 카테고리는 OA-22749(getFstExit)이 직접 제공하지 않으므로 우선순위에 포함하지 않는다.
// FacilityCategory 유니언에는 남겨 두어 별도 데이터 슬라이스(환승통로 좌/우) 도입 시 확장 가능.
export const FACILITY_PRIORITY_DEFAULT: readonly FacilityCategory[] = ['stairs', 'elevator'];
export const FACILITY_PRIORITY_ACCESSIBILITY: readonly FacilityCategory[] = [
  'elevator',
  'stairs',
];
