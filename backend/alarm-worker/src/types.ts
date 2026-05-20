/**
 * Worker 전역 타입 정의.
 *
 * Route 타입은 앱 코드(src/utils/stationRoute.ts)의 형태를 그대로 미러링한다.
 * 앱과 백엔드는 별도 빌드이므로 import 대신 구조적 호환을 유지한다.
 */

export type LineNumber = string;

export interface DirectRoute {
  type: 'direct';
  stops: number;
  line: LineNumber;
}

export interface TransferSegment {
  transferName: string;
  fromLine: LineNumber;
  toLine: LineNumber;
  stopsToTransfer: number;
}

export interface TransferRoute {
  type: 'transfer';
  transferName: string;
  fromLine: LineNumber;
  toLine: LineNumber;
  stopsToTransfer: number;
  stopsFromTransfer: number;
}

export interface MultiTransferRoute {
  type: 'multi-transfer';
  transfers: TransferSegment[];
  stopsAfterLastTransfer: number;
}

export type Route = DirectRoute | TransferRoute | MultiTransferRoute;

/** 다음 알람을 발사할 후보 역. */
export interface Waypoint {
  /** 표시명 (예: "신도림") */
  stationName: string;
  /** 노선 키 (정확히 어느 호선에서 도착을 봐야 하는지) */
  line: LineNumber;
  /** "transfer" — 환승 안내 / "destination" — 최종 도착 / "intermediate" — 중간역 통과 */
  kind: 'transfer' | 'destination' | 'intermediate';
}

export interface Trip {
  /** APNs device token (hex) */
  token: string;
  route: Route;
  /** 목적지 역 ID (예: "0228" 같은 stations.json id) */
  destination: string;
  waypoints: Waypoint[];
  /** epoch ms — 트립이 종료되어 자동 삭제될 시각 */
  expiresAt: number;
  /** epoch ms — 트립 등록 시각 */
  createdAt: number;
  /** 알람 5분 윈도우 진입 여부 계산용. 사용자가 설정한 알람 발사 예상 시각(epoch ms). */
  alarmAtEpochMs: number;
  /** 마지막으로 발사한 phase. dedup용. */
  lastFiredPhase?: 'early' | 'imminent';
  /** 마지막 폴링 시 관측 ETA(seconds). 변동 감지용. */
  lastEtaSeconds?: number;
}

export interface Env {
  TRIPS: KVNamespace;
  APNS_HOST: string;
  SEOUL_API_HOST: string;
  SEOUL_API_KEY: string;
  APNS_KEY_ID: string;
  APNS_TEAM_ID: string;
  APNS_PRIVATE_KEY: string;
  APNS_BUNDLE_ID: string;
}
