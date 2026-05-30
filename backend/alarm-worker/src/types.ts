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
  /**
   * APNs 토큰의 환경(sandbox / production). 클라이언트가 빌드 환경에 맞춰 전달.
   * 누락 시 sandbox로 간주 — 구버전 클라이언트(dev/preview)가 필드를 안 보내는 경우
   * production host로 잘못 가지 않도록 안전한 기본값. App Store/TestFlight 빌드는
   * 반드시 `apnsEnv: 'production'`을 명시한다.
   */
  apnsEnv?: ApnsEnv;
  /**
   * BoardingLock metadata (#584/#585). 디바이스가 사용자에게 탑승 열차를 확정받으면 보냄.
   * 존재 시 backend는 trainCode 단위로 다음 hop 도착 시각을 추적하고, 변동 시 reschedule
   * silent push로 디바이스 사전 예약을 정정한다. 없으면 기존 anchor waypoint 폴링으로 동작.
   */
  boardingLock?: BoardingLockMeta;
  /**
   * 마지막으로 디바이스에 reschedule push로 통지한 도착 시각 (epoch ms) — boardingLock 추적용.
   * 새 관측이 이 값과 의미있게 어긋날 때만 push를 발사해 노이즈를 줄인다.
   */
  lastTrackedArrivalEpoch?: number;
  /**
   * Live Activity push token (#586 C). ActivityKit가 발급하는 update token (hex).
   * `POST /live-activity/register`로 등록되며, APNs LA push 발사 시 device token 자리에 사용한다.
   * APNs 410(BadDeviceToken) 응답 시 발사 path에서 clear된다.
   */
  activityPushToken?: string;
  /**
   * Live Activity 수명 상태 (#586 C).
   *   - 'live'  — register 시점. 정상적으로 update push를 보낼 수 있음.
   *   - 'ended' — deregister 시점. dismissal payload 재발사 idempotency용 dedup 키.
   */
  activityState?: 'live' | 'ended';
  /**
   * 마지막으로 LA update push로 통지한 도착 epoch(ms) — #586 D.
   * 30s+ 변동 시점에만 다음 발사해 APNs LA budget을 절감한다 (reschedule push의 15s 임계와 별개).
   * waypoint shift 시 reset(undefined) — 새 hop의 첫 update를 보장한다.
   */
  lastLaPushEpoch?: number;
}

/** Device가 확정한 탑승 열차 정보 (#584). */
export interface BoardingLockMeta {
  /** Seoul API btrainNo (예: "7246") */
  trainCode: string;
  /** 노선 (Waypoint.line과 동일 표기) */
  line: LineNumber;
  /** Seoul API subwayId (예: "1007") — 환승 노선 구분용 */
  subwayId: string;
  /** 사용자가 선택한 열차 출발 시각 (epoch ms) */
  selectedDepartureTime: number;
  /** 현 BoardingLock 구간 내 정차역 시퀀스 (출발역 → 구간 끝) */
  segmentStations: string[];
  /** Lock 자동 만료 시각 (epoch ms) */
  expiresAt: number;
}

/**
 * Reschedule silent push payload (#585).
 * 디바이스가 사전 예약한 알람의 도착 시각이 backend 관측과 어긋날 때 발사.
 * 디바이스는 이 push를 받아 기존 예약을 cancel하고 newArrivalTimeEpoch로 재예약한다.
 */
export interface ReschedulePushPayload {
  pushId: string;
  kind: 'reschedule';
  trainCode: string;
  nextStation: string;
  newArrivalTimeEpoch: number;
  sentAt: number;
}

/** APNs 토큰 환경. sandbox는 dev/preview/internal 빌드, production은 App Store/TestFlight. */
export type ApnsEnv = 'sandbox' | 'production';

/**
 * Cloudflare Analytics Engine writer. Minimal surface — Worker types에 의존하지 않게 별도 선언.
 * 실제 binding은 wrangler.toml의 `[[analytics_engine_datasets]]`로 주입.
 */
export interface AnalyticsEngineWriter {
  writeDataPoint(point: {
    blobs?: string[];
    doubles?: number[];
    indexes?: string[];
  }): void;
}

export interface Env {
  TRIPS: KVNamespace;
  /**
   * silent push 게이트 outcome 텔레메트리 (#498).
   * 클라가 30분 주기로 upload하는 카운터를 Analytics Engine에 적재.
   * 미바인딩 시 endpoint는 graceful no-op (개발 환경 호환).
   */
  TELEMETRY?: AnalyticsEngineWriter;
  /**
   * 발사한 silent push의 pending 추적 (#566 P2a).
   * P2c에서 30s 미ACK push를 alert로 fallback 발사하기 위한 그릇.
   * 미바인딩 시 모든 pending 경로는 graceful no-op (개발 환경 호환).
   * 생성: `wrangler kv:namespace create PENDING_PUSHES`
   */
  PENDING_PUSHES?: KVNamespace;
  /** Production APNs host (예: api.push.apple.com) */
  APNS_HOST: string;
  /** Sandbox APNs host (예: api.sandbox.push.apple.com) — dev/preview 빌드 토큰용 */
  APNS_HOST_SANDBOX: string;
  SEOUL_API_HOST: string;
  SEOUL_API_KEY: string;
  APNS_KEY_ID: string;
  APNS_TEAM_ID: string;
  APNS_PRIVATE_KEY: string;
  APNS_BUNDLE_ID: string;
}
