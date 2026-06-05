/**
 * Journey/Stop type — route 슬라이스의 journeyAdapter가 정의하지만 arrival 컴포넌트
 * (EditorialTimeline 등)에서 cross-feature로 참조되므로 shared로 추출.
 *
 * ADR Roadmap Phase 5 (#890). 원본 위치: features/route/utils/journeyAdapter.ts (re-export 유지).
 */

import type { LineNumber } from './station';
import type { TrainType } from '../constants/trainTypes';

// 빠른하차 라벨 결정에 필요한 컨텍스트.
// 출발역(filled)은 도착 시점이 없으므로 미지정 — caller는 undefined를 라벨 미표시로 해석한다.
export interface StopArrivalContext {
  line: LineNumber;
  fromName: string;
  toName: string;
}

// 환승 stop에서 "갈아탈 다음 노선" — UI(EditorialTimeline)가 transferExit lookup에 사용.
// 환승역이 곧 목적지로 흡수되는 경우(0정거장 종착)에는 설정되지 않는다.
export interface StopTransferTarget {
  toLine: LineNumber;
}

export interface Stop {
  station: string;
  line: string | null;
  stopsFromPrev?: string;
  mark: 'filled' | 'transfer' | 'dest' | 'intermediate';
  note?: string;
  arrivalContext?: StopArrivalContext;
  transferTarget?: StopTransferTarget;
}

export interface ArrivalTrain {
  direction: string;
  line: string;
  arrivalAtMs: number;
  subtext?: string;
  /** 막차 여부 — UI 안전성 배지. */
  isLastTrain?: boolean;
  /** 열차 타입 — 'normal'은 배지 미표시. */
  trainType?: TrainType;
  /** arvlCd — 0:진입, 1:도착, 2:출발 등. UI 진입/도착 배지용. */
  arrivalCode?: number;
}

export interface HandoffNearest {
  name: string;
  line: string;
  distanceM: number;
  walkMin: number;
}
