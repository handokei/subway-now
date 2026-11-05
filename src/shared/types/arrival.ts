import type { LineNumber } from './station';
import type { TrainType } from '../constants/trainTypes';

/**
 * 단일 열차의 도착 예측 정보.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890) — shared로 추출.
 * 원본 위치: `src/features/arrival/api/arrivalApi.ts`. 호출자는 여전히 `arrivalApi`에서 import해도
 * 호환되도록 re-export 유지.
 */
export interface ArrivalInfo {
  destination: string;
  /**
   * 도착까지 남은 초. `null` = 시간 모름(코레일 운영 노선이 barvlDt=0을 "정보 없음"으로 내려줌, 2026-10-21 실측).
   * 0은 "진짜 0초"(arvlCd 0/1/2 진입·도착·출발)만 의미한다 — 모름을 0으로 접으면 화면에 00:00이 뜬다.
   */
  arrivalSeconds: number | null;
  /** 몇 역 전인지 — `[N]번째 전역`의 N, arvlCd 3/4/5(전역 출발/진입/도착) unknown 행은 1, 그 외 null. */
  stopsAway: number | null;
  /** 피드 `arvlMsg3` — 열차가 있는 역명("전역 도착"이면 직전 역). 표시 보조 라인용. 구버전 BFF는 누락(undefined). */
  locationStation?: string;
  statusMessage: string;
  trainCode: string;
  /**
   * 이 열차가 속한 호선. 실시간 API는 subwayId로 매핑, 어느 경로로도 결정 못 하면 lineHint로 fallback.
   * 환승역에서 같은 statnNm으로 두 노선 응답이 섞여도 라인 단위 필터·BoardingLock 생성에 정확한 호선 사용 가능.
   */
  line: LineNumber;
  /** 데이터 생성 시각(epoch ms). 0이면 알 수 없음(mock 또는 누락). Stage 2 fusion 신호 신선도 판정용. */
  receivedAtMs: number;
  /**
   * arvlCd 응답값 — 0:진입, 1:도착, 2:출발, 3:전역출발, 4:전역진입, 5:전역도착, 99:운행중.
   * 누락/비숫자는 -1. fusion 우선순위 판정에 사용 (constants/arrivalCodes.ts).
   */
  arrivalCode: number;
  /** lstcarAt === '1'이면 막차. 사용자 안전성 표시용. */
  isLastTrain: boolean;
  /** btrainSttus 매핑. 'normal'은 라벨 빈 문자열로 배지 미표시. */
  trainType: TrainType;
  /**
   * #2696 — 이 열차가 최종적으로 정차하는 종착역명(Seoul Open API `bstatnNm`).
   * `destination`(raw `trainLineNm`, UI 라벨용 — 의미/소비자 변경 금지)과 별개 필드다.
   * 조기 종착(사용자의 다음 목표역 전에 정차) 판정에 사용 — `isBoardableCandidate` 참고.
   * 파싱 실패/누락 시 undefined — 판정 불가는 배제하지 않음(그레이스풀)으로 처리한다.
   */
  terminalStation?: string;
}

export type ArrivalSource = 'realtime' | 'schedule' | 'closed';

export interface StationArrival {
  up: ArrivalInfo[];
  down: ArrivalInfo[];
  isMock?: boolean;
  /** 데이터 출처. UI 라벨 분기(시간표 기준 / 운행 종료)에 사용. */
  source?: ArrivalSource;
}
