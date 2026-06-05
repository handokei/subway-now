import type { TrainType } from '../constants/trainTypes';
import type { LineNumber } from './station';

/**
 * realtimePosition 응답의 단일 열차 정보(앱 도메인 형태로 정규화).
 * statnId가 fusion 신호의 핵심 — "이 열차가 지금 어느 역에 있나" 확정 정보.
 *
 * ADR Roadmap Phase 5 (#890): nearest-station에서 cross-feature 참조되는 type을 shared로 추출.
 * 원본: `src/features/nearest-station/api/positionApi.ts` (re-export 유지).
 */
export interface TrainPosition {
  statnId: string;
  statnNm: string;
  trainNo: string;
  /** trainSttus: 0:진입, 1:도착, 2:출발, 3:전역출발 */
  trainStatus: number;
  /** 0:상행/내선, 1:하행/외선 */
  updnLine: number;
  /** 종착역 */
  terminalStationId: string;
  terminalStationName: string;
  /** directAt 매핑(express/rapid/normal — ITX는 도착정보에서만) */
  trainType: TrainType;
  isLastTrain: boolean;
  /** recptnDt 파싱 결과 — Stage 1과 같은 신선도 계약(0=알 수 없음). */
  receivedAtMs: number;
}

export interface LinePositions {
  line: LineNumber;
  trains: TrainPosition[];
  isMock?: boolean;
}

/**
 * pickCandidateTrains 산출물 — 특정 station/line/direction을 향한 후보 열차의 정규화 표현.
 * arrival(원본) → route(trackTrainProgress 등)로 cross-feature 참조되므로 shared로 추출.
 */
export interface CandidateTrain {
  trainNo: string;
  line: LineNumber;
  direction: 0 | 1;
  currentStationName: string;
  trainStatus: number;
  receivedAtMs: number;
}
