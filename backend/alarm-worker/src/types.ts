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
  /**
   * 연속 etaMissing 카운트 (#706). 운행 시간대 외(새벽 등)에 trainCode가 Seoul API에서
   * 사라져도 trip이 자동 종료되지 않아 무한 폴링하던 회귀(8h × 1/min) 방지용.
   * runTrainCodeTracking이 estimate=null 받을 때마다 +1, 성공 시 0 reset.
   * MAX_CONSECUTIVE_ETA_MISSING 초과 시 trip을 cleanup한다.
   * 기존 trip(필드 부재)은 0으로 fallback (backward compat).
   */
  consecutiveEtaMissing?: number;
  /**
   * #816 C — 사용자 opt-in lockless station-passed.
   * BoardingLock 없는 trip에서도 station-passed(intermediate) 알림을 발사할지 여부.
   *
   * 기본 (필드 부재 또는 false): #640 게이트 그대로 — lock 없으면 cycle skip.
   * true: lock 없어도 intermediate waypoint 도착만 push 발사 허용.
   *   - transfer/destination waypoint는 여전히 skip (trainCode 없이 정확도 보장 불가)
   *   - 사용자가 명시 설정 토글로 ON했을 때만 trip 등록 시 송신
   *
   * 노이즈 차단 책임: 사용자에게 옵트인 권한 위임. #640 회귀는 OFF가 default로 보호.
   */
  locklessStationPassed?: boolean;
  /**
   * boarding-prompt(#819) 발사 추적 — trip당 1회 + dismiss 5분 silence 게이트(#9).
   * 부재 = 미발사 상태. 사용자 응답으로 lock이 생기면 자연스럽게 게이트 #2가 차단한다.
   */
  boardingPromptState?: BoardingPromptState;
  /**
   * boarding-prompt 평가용 출발역/다음역 좌표 (#819 게이트 #4/#5).
   * backend는 stations.json을 갖지 않으므로 클라이언트가 trip 등록 시 함께 보낸다.
   * 부재 시 boarding-prompt 평가 자체를 skip — 좌표 없는 lockMissing trip은 silent.
   */
  promptGeoContext?: PromptGeoContext;
  /**
   * boarding-prompt에 노출할 사용자 표시명 (#819).
   * `originStation`: lock의 boardingStationId가 아닌 실제 역 이름 (Notification body 빌드).
   * `line`: trip 출발 라인 (lock 생성 시 boardingLine으로 그대로 사용).
   */
  promptDisplay?: PromptDisplay;
  /**
   * Phase 3 E3 (#825) — 운행 phase 분류 + 2 cycle hysteresis 상태. cron 사이클마다
   * stationPhase.ts가 분류 결과로 갱신한다. 사용자가 명시 보내는 필드 아님 — backend 자체 stamp.
   * 부재(첫 평가 전) = phase 분류 신호 없음.
   */
  stationPhase?: StationPhaseState;
}

/**
 * 운행 phase 분류 (#825 Phase 3 E3).
 *   APPROACHING — 진입/감속
 *   DWELLING   — 정차
 *   DEPARTING  — 출발/가속
 *   CRUISING   — 순항
 */
export type StationPhaseType = 'APPROACHING' | 'DWELLING' | 'DEPARTING' | 'CRUISING';

/**
 * trip별 phase 분류 + 2 cycle hysteresis 상태.
 *   - current: 마지막으로 확정된 phase
 *   - candidate / candidateCount: 직전 candidate (current와 다른 신호)와 연속 횟수.
 *     2 cycle 연속 같은 candidate면 current로 승격 (flicker 방지).
 *   - confidence: 마지막 분류의 confidence 0~1 (hysteresis boost 후 값)
 *   - lastEvaluatedAt: 마지막 분류 epoch ms — 진단/디버그 로그용.
 */
export interface StationPhaseState {
  current: StationPhaseType;
  confidence: number;
  candidate?: StationPhaseType;
  candidateCount?: number;
  lastEvaluatedAt: number;
}

/** boarding-prompt 게이트 평가용 출발역/다음역 좌표. */
export interface PromptGeoContext {
  origin: { lat: number; lng: number };
  nextStation: { lat: number; lng: number };
  /** 방향 게이트(#5)에서 어느 방향으로 가야 하는지 — Seoul API의 isUp과 정합. */
  direction: 'up' | 'down' | null;
}

/** boarding-prompt 사용자 표시 컨텍스트. */
export interface PromptDisplay {
  originStation: string;
  line: string;
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
 * 클라이언트가 송신한 단일 위치 샘플 (#819 Phase 1 fusion).
 * KV 시리즈에 60s window로 누적되며 게이트 #3~#7 평가에 사용된다.
 */
export interface PositionPoint {
  /** 위도 (degrees, WGS84) */
  lat: number;
  /** 경도 (degrees, WGS84) */
  lng: number;
  /** GPS accuracy meters — `>= 50m`는 평균속도 계산에서 제외 (게이트 #3 정책). */
  accuracy: number;
  /** epoch ms — 디바이스에서 측정한 시각 (시계 drift는 평균속도가 자가 보정). */
  ts: number;
  /** CMMotionActivity 분류 — graceful: 미지원/권한 거절 시 'unknown'. */
  motion: 'stationary' | 'walking' | 'automotive' | 'unknown';
  /**
   * Phase 2 map matching (#828) — 클라이언트가 활성 boarding line polyline에 좌표를 사영해
   * 산출한 누적 arc 거리(m) + 노선 코드. (`src/utils/linePolyline.ts`)
   *
   * - 양 끝 sample이 모두 같은 line + arcM을 갖는 경우에만 evaluateWindow가 mapMatchedKmh
   *   산출 → fusedSpeed가 GPS+map matching 가중평균으로 동작.
   * - 부재 시 mapMatchedKmh=null로 강등 → fusedSpeed가 GPS-only로 동작 (Phase 1 회귀 없음).
   * - 환승역 disambiguate: 클라이언트가 active line으로만 snap하므로 다른 line snap은 자연 차단.
   * - backend는 stations.json을 갖지 않으므로 snap은 반드시 클라이언트 책임이다 (types 주석 참조).
   */
  mapMatchedLine?: string;
  mapMatchedArcM?: number;
  /**
   * Phase 3 E3 (#825) — 가장 가까운 정거장까지의 거리 (meters). 클라이언트가 매 sample
   * 송신 시 `stations.json` 좌표 사전으로 haversine 산출해 stamp한다 (#834).
   *
   * 사용: backend `stationPhase.ts`가 운행 phase(APPROACHING/DWELLING/DEPARTING/CRUISING)
   * 분류 입력 중 하나로 사용. 미적용 단계는 undefined — phase 산출 skip (회귀 없음).
   *
   * 정책: backend는 stations.json을 갖지 않으므로 거리는 반드시 클라 책임
   * (mapMatchedLine/ArcM과 동일 패턴).
   */
  nearestStationDistanceM?: number;
}

/**
 * 디바이스에서 1초 window로 압축한 선형 가속도 요약 (#823 Phase 3 E1).
 *
 * 100Hz raw를 backend로 보내지 않는 이유: BG 배터리/네트워크 비용. 디바이스에서
 * 평균/표준편차/피크 magnitude로 압축해 1Hz 요약만 송신한다. backend는 KV ring buffer로
 * 누적하며 (E2 Kalman / E3 phase 감지가 입력으로 사용), 단위는 m/s² (SI).
 *
 * 모든 axis 값은 중력이 이미 제거된 **linear acceleration**.
 */
export interface AccelSummary {
  /** window 시작 epoch ms. */
  startTs: number;
  /** window 종료 epoch ms. */
  endTs: number;
  /** window 내 raw sample 수. 디바이스측 MIN_SAMPLES_FOR_SUMMARY(50) 이상만 backend에 도달. */
  count: number;
  /** linear ax 평균 (m/s²). */
  ax: number;
  /** linear ay 평균 (m/s²). */
  ay: number;
  /** linear az 평균 (m/s²). */
  az: number;
  /** linear magnitude 평균 (m/s²). 정거장 phase 감지 1차 신호. */
  magnitudeMean: number;
  /** linear magnitude 표준편차 (m/s²). 도보/지하철 noise 패턴 구분용. */
  magnitudeStd: number;
  /** linear magnitude 최대값 (m/s²). 출발/감속 피크 감지용. */
  magnitudePeak: number;
}

/**
 * trip 단위 boarding-prompt 발사 상태 (#819 게이트 #9).
 * 같은 trip에 1회 + 사용자 dismiss/미탑승 후 5분 silence 정책.
 */
export interface BoardingPromptState {
  /** 마지막 발사 시각 (epoch ms). */
  lastFiredAt?: number;
  /** 사용자가 dismiss/미탑승으로 silence 요청한 시각 (epoch ms). */
  silencedUntil?: number;
  /** 이 trip에 이미 발사 후 사용자 응답을 받았는지 — 한 trip 1회 정책. */
  fired?: boolean;
}

/**
 * boarding-prompt push payload (#819 B 슬라이스).
 * BOARDING_PROMPT iOS category 액션 [탑승]/[미탑승]을 함께 노출하기 위해
 * alert + category로 발사한다 (silent 아님).
 */
export interface BoardingPromptPushPayload {
  pushId: string;
  kind: 'boarding-prompt';
  /** 사용자 출발역 (lock 생성 시 boardingStation으로 사용). */
  originStation: string;
  /** 출발 노선 (lock 생성 시 boardingLine으로 사용). */
  line: string;
  /** trip 토큰 — 푸시 응답 시점에 trip 컨텍스트 복원용. */
  tripToken: string;
  sentAt: number;
}

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
