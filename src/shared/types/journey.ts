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

// #3258 — 구간(segment) 단위 정거장 정보. 노드가 아니라 연결선에 표시한다.
export interface StopSegment {
  line: LineNumber;
  stops: number;
}

export interface Stop {
  station: string;
  line: string | null;
  mark: 'filled' | 'transfer' | 'dest' | 'intermediate';
  note?: string;
  arrivalContext?: StopArrivalContext;
  /** #3073 — 이 stop으로 타고 들어온 노선. 직전 stop→이 stop connector 색. 출발역(filled)은 없음. */
  connectorLine?: LineNumber;
  transferTarget?: StopTransferTarget;
  /** #3258 — 이 노드에서 출발하는 구간(연결선) 정보. "{노선} N정거장" 칩의 데이터. 도착 노드는 없음. */
  segmentToNext?: StopSegment;
}

export interface ArrivalTrain {
  direction: string;
  line: string;
  /** 도착 절대 시각. `null` = 시간 모름(코레일 barvlDt=0) — 이때 `positionLabel`로 위치 문구를 표시한다. */
  arrivalAtMs: number | null;
  /** arrivalAtMs가 null일 때 mm:ss 대신 보여줄 위치 문구(큰 글씨 primary + 작은 글씨 secondary). */
  positionLabel?: { primary: string; secondary?: string };
  subtext?: string;
  /** 막차 여부 — UI 안전성 배지. */
  isLastTrain?: boolean;
  /** 열차 타입 — 'normal'은 배지 미표시. */
  trainType?: TrainType;
  /** 막차 시각 lookup 컨텍스트(#1035) — 출발역 이름. 없으면 시각 표기 생략. */
  stationName?: string;
  /** 막차 시각 lookup 컨텍스트(#1035) — 타입 강한 LineNumber. `line` 필드의 좁힌 형태. */
  lineNumber?: LineNumber;
  /** 막차 시각 lookup 컨텍스트(#1035) — timetable 상행/하행. */
  directionKey?: 'up' | 'down';
}

export interface HandoffNearest {
  name: string;
  line: string;
  distanceM: number;
  walkMin: number;
}
