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
  /**
   * #1193 — 같은 stationName이 trip 원본 waypoint 시퀀스에 중복 등장(순환선/회차)할 때,
   * 이 waypoint가 몇 번째 등장인지(0-based). reschedule push의 `occurrenceIdx`로 전달돼
   * 클라이언트 `rescheduleTripBoundAlarm`이 정확한 `:n` suffix 알람을 cancel + 재예약한다.
   *
   * `validateTrip`(POST /trips)에서 incoming 전체 waypoints에 대해 1-pass로 계산해 stamp한다.
   * waypoint shift가 진행돼도 occurrenceIdx는 stamp 그대로 유지(불변) — 정정 push 시점에
   * 클라이언트 routeStops 인덱스와 round-trip 일치 보장.
   *
   * 구 backend / 구 client 호환을 위해 optional. 미지정 시 클라이언트가 0(첫 등장)으로 fallback.
   */
  occurrenceIdx?: number;
  /**
   * Epic #1204 그룹 2 D3 (#1273) — 원본 waypoint 시퀀스에서의 0-based 위치(=hop index).
   * `validateTrip`(POST /trips)이 incoming waypoints 전체에 대해 1-pass로 stamp하며, waypoint
   * shift가 진행돼도 값은 불변. silent push payload `hopIndex` 필드의 SSOT로 사용된다.
   *
   * 클라이언트 `silentPushLocationGate`는 D1 estimator의 `currentHopIndex`와 이 값을 비교해
   * ±LOCKLESS_HOP_WINDOW_TOLERANCE 이내면 거리 검증 우회(hop-window-match), `gate-no-location`
   * skipReason 발생 시에도 동일 매치로 fallback pass 한다.
   *
   * 구 client 호환을 위해 optional — `occurrenceIdx`와 동일 패턴.
   */
  hopIndex?: number;
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
  /**
   * #1367 — cross-station 동시 fire 차단용. 마지막 station-passed (arvlCd) push의 (stationName,
   * epoch ms). 같은 cron tick 또는 짧은 윈도우(SAME_PHASE_STATION_DEDUP_WINDOW_MS) 안에
   * 다른 station의 동일 신호가 도달해도 client 채널에서 두 banner가 동시기로 뜨지 않도록
   * backend side에서 한 번 더 게이트한다. 이전 PR들의 per-station `arvlCdFireKey` dedup은
   * 같은 (token, trainCode, station, arvlCd) 조합 재발사만 막아 cross-station은 통과시킨다.
   */
  lastFiredStation?: { stationName: string; epochMs: number };
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
   * 마지막으로 LA update push를 발사한 시각(epoch ms) — #900 Seam D.
   * lastLaPushEpoch가 "콘텐츠 기준 시간(추정 도착)"인 반면 이 필드는 "발사 시각(wall clock)"이라
   * 60s heartbeat 게이트 평가에 사용된다. waypoint shift 시 lastLaPushEpoch와 함께 reset.
   * 레거시 trip(필드 부재) → heartbeat 미평가 → 기존 ΔETA 임계 그대로.
   */
  lastLaPushAt?: number;
  /**
   * 연속 etaMissing 카운트 (#706). 운행 시간대 외(새벽 등)에 trainCode가 Seoul API에서
   * 사라져도 trip이 자동 종료되지 않아 무한 폴링하던 회귀(8h × 1/min) 방지용.
   * runTrainCodeTracking이 estimate=null 받을 때마다 +1, 성공 시 0 reset.
   * MAX_CONSECUTIVE_ETA_MISSING 초과 시 trip을 cleanup한다.
   * 기존 trip(필드 부재)은 0으로 fallback (backward compat).
   */
  consecutiveEtaMissing?: number;
  /**
   * #816 C — 사용자 opt-in lockless station-passed (UI: "전체역 보기").
   * BoardingLock 없는 trip에서도 station-passed(intermediate) 알림을 발사할지 여부.
   *
   * 기본 (필드 부재 또는 false): #640 게이트 그대로 — lock 없으면 cycle skip.
   * true: lock 없어도 intermediate waypoint 도착만 push 발사 허용.
   *   - transfer/destination waypoint는 여전히 skip (trainCode 없이 정확도 보장 불가)
   *   - 사용자가 명시 설정 토글로 ON했을 때만 trip 등록 시 송신
   *
   * 노이즈 차단 책임: 사용자에게 옵트인 권한 위임. #640 회귀는 OFF가 default로 보호.
   * (#1669 device rename: locklessStationPassed → infoModeEnabled, 필드명 동기화)
   */
  infoModeEnabled?: boolean;
  /**
   * boarding-prompt(#819) 발사 추적 — trip당 1회 + dismiss 5분 silence 게이트(#9).
   * 부재 = 미발사 상태. 사용자 응답으로 lock이 생기면 자연스럽게 게이트 #2가 차단한다.
   */
  boardingPromptState?: BoardingPromptState;
  /**
   * #916 follow-up B — backend auto-lock 또는 boarding-prompt가 발사된 마지막 시각(epoch ms).
   * `boardingPromptState`와 별개로 유지되는 dedup 마커.
   *
   * 필요한 이유: `boardingPromptState`는 `isSameSession=false` 분기에서 `baseTrip=incoming`로
   * 갈아치워져 사라진다. auto-lock 성공 직후 사용자가 lock을 클리어/swap하거나 목적지를
   * 살짝 바꿔 새 createdAt으로 재등록하면 새 trip 세션처럼 인식돼 prompt가 재발사된다 —
   * 같은 trip token + 같은 출발 컨텍스트에 대해 backend가 방금 자동 lock을 시도/성공한 직후라.
   *
   * 본 필드는 같은 token + window 내 새 세션에도 보존되어 `evaluateAndMaybeFireBoardingPrompt`
   * 초입에서 prompt 재평가 자체를 차단한다 (AUTO_PROMPT_DEDUP_WINDOW_MS = 30분, lockSwap의
   * SWAP_LOCK_TTL_MS와 정합). 윈도우 만료 또는 명백히 다른 trip(createdAt이 window 이상 차이)은
   * 보존하지 않아 새 prompt가 자연 발사된다.
   *
   * 클라이언트는 절대 송신하지 않는다 — backend가 stamp + 자체 보존.
   */
  lastAutoPromptedAt?: number;
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
  /**
   * #903 (Seam G) — 클라이언트 기압계가 지하 진입을 시사하는가. true면 backend가
   * consecutiveEtaMissing threshold를 5→10(SUBSURFACE_ETA_MISSING_TOLERANCE)으로 늘려 일시 GPS/arrival
   * 누락을 더 인내한다. 부재/false면 기존 threshold(MAX_CONSECUTIVE_ETA_MISSING=5) 유지.
   *
   * 운영 정책: 기압계 신호는 client가 매 register POST에 동봉. 새 POST가 오면 갱신되며,
   * 한 trip 내에서 지상→지하 전이로 false→true 변동 가능. cron 사이클 사이의 stale은 next register로 자연 정정.
   */
  subsurface?: boolean;
  /**
   * #1539 (S6, Epic #1533 / ADR-016) — backend가 trip 시작 후 통과를 확인한 모든 station
   * 누적 배열. waypoint advance 시점(`advanceBoardingLockWaypoint` / `runLocklessIntermediate`)에
   * 직전 waypoint stationName을 push한다. 최대 길이 `PASSED_STATIONS_MAX_LEN`로 cap.
   *
   * 용도: silent push payload에 forward되어 device가 사전 예약 큐와 diff하여 cron 1분 race로
   * 누락된 station-passed 알림을 backfill 발사할 수 있게 한다(S5의 pre-scheduled window 확장과
   * 결합). 본 PR(S6)은 누적 + payload wire + cron jitter metric만 다루고, device-side diff/fire
   * wiring은 S5 머지 후 후속 PR.
   *
   * 부재(레거시 trip / 신규 trip 첫 cycle 전) → undefined → device는 backfill 자연 skip.
   */
  passedStations?: string[];
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
  /**
   * #916 follow-up A — backend가 9단 게이트 통과 시점에 자동 합성한 lock의 stamp (epoch ms).
   * 사용자가 명시적으로 [탑승] 버튼을 탭해 client가 POST한 lock에는 절대 부재한다.
   *
   * 용도: 같은 세션에서 client가 lock 필드 없이 `POST /trips`로 재등록할 때(예: GPS update,
   * cold restart) baseTrip spread가 `existing.boardingLock`을 silent하게 drop하던 회귀를 차단한다.
   * 이 마커가 있는 existing lock은 incoming.boardingLock===undefined일 때 보존되고,
   * 마커가 없는 사용자 명시 lock은 기존 정책대로 drop된다 ("lock 해제" 의미 유지).
   *
   * 사용자가 다른 trainCode를 탭해 새 lock을 POST하면 incoming.boardingLock이 truthy라
   * 기존 swap 경로(`lockSwap.ts`)가 그대로 동작 — 마커 유무와 무관히 새 lock 채택.
   */
  autoLockedAt?: number;
}

/**
 * Reschedule push channel discriminator (#918 A3 PR4).
 *
 *  - 'bl' — boarding-lock scheduler (`bl:` prefix). 기존 #585 경로. trainCode 매칭으로 hop 정정.
 *  - 'tba' — trip-bound scheduler (`tba:` prefix). lock-free 사전 예약 정정 — trainCode 무관.
 *
 * 한 reschedule push는 둘 다를 동시에 정정할 수 있도록 `ReschedulePushPayload.channels`에
 * 배열로 담는다 (단일 push로 두 채널의 사전 예약을 동기화 — APNs budget 절약).
 */
export type RescheduleChannel = 'bl' | 'tba';

/** 신규 backend가 default로 보내는 channels — bl + tba 모두 정정. */
export const RESCHEDULE_CHANNELS_DEFAULT: ReadonlyArray<RescheduleChannel> = ['bl', 'tba'];

/**
 * Reschedule silent push payload (#585).
 * 디바이스가 사전 예약한 알람의 도착 시각이 backend 관측과 어긋날 때 발사.
 * 디바이스는 이 push를 받아 기존 예약을 cancel하고 newArrivalTimeEpoch로 재예약한다.
 *
 * `channels` (#918 A3 PR4): 정정 대상 scheduler 채널. 미지정 시 구 backend 호환을 위해
 * 클라가 `['bl']` 단독으로 해석 (기존 동작 보존). 신규 backend는 `RESCHEDULE_CHANNELS_DEFAULT`로
 * `['bl', 'tba']`를 보내 `tba:` 사전 예약도 함께 정정한다.
 */
export interface ReschedulePushPayload {
  pushId: string;
  kind: 'reschedule';
  trainCode: string;
  nextStation: string;
  newArrivalTimeEpoch: number;
  sentAt: number;
  channels?: ReadonlyArray<RescheduleChannel>;
  /**
   * #1193 — `tba:` 채널 정정 시 정정 대상 occurrence(0-based). nextStation이 trip route에 중복
   * 등장하면 클라이언트는 이 인덱스로 N번째 등장의 사전 예약 알람을 정확히 cancel + 재예약한다.
   * 미지정 시 클라이언트는 0(첫 등장)으로 fallback — 중복 없는 trip / 구 backend 호환.
   */
  occurrenceIdx?: number;
}

/**
 * Trip 자동 종료 reason (#868).
 *   - 'eta-missing' — consecutiveEtaMissing 임계 초과 (운행 시간대 외 / trainCode 소실)
 *   - 'seoul-outage' — consecutiveEtaMissing 임계 초과 + Seoul API HTTP error 관측 (#1663)
 *                      outage 기인 false-end로 판별 → #1425 cooldown 면제 대상
 *   - 'destination-arrived' — 목적지 도착 또는 마지막 intermediate 통과로 trip 종료
 *   - 'expired' — trip.expiresAt 시각 초과로 자동 만료
 *   - 'push-unrecoverable' — APNs unrecoverable error로 trip 폐기
 *
 * 클라가 명시적으로 trip을 끝낸 경로(HTTP DELETE /trips/:token)는 발사 대상이 아님 —
 * 사용자가 destination을 clear하면 이미 클라이언트 store가 정리된 상태이기 때문.
 */
export type TripEndedReason =
  | 'eta-missing'
  | 'seoul-outage'
  | 'destination-arrived'
  | 'expired'
  | 'push-unrecoverable';

/**
 * Trip ended alert push payload (#1337). server-side trip 자동 종료 시 발사되는 alert push의
 * `data` 필드. 구 silent push payload(`TripEndedPushPayload`)는 force-quit 앱에 전달되지 않아
 * killed 상태 알림 누락 사고가 있어 alert로 전환됐다(#1337).
 *
 * client BG 핸들러는 alert 수신 시(`aps.alert` 존재) OS가 이미 banner를 띄웠으므로 추가 로컬
 * 알림을 발사하지 않고, `data.pushId`/`data.tripToken`을 sentinel/dedup에만 사용한다.
 *
 * `tripToken`은 race 가드용 — backend가 trip A에 대해 push를 발사한 후 APNs latency 동안
 * 사용자가 trip B를 새로 시작했다면, 클라는 tripToken과 현재 ACTIVE_TRIP_KEY를 비교해
 * 불일치 시 cleanup을 skip (trip B의 storage를 잘못 파괴하는 것을 방지).
 */
export interface TripEndedAlertPushPayload {
  pushId: string;
  kind: 'trip-ended';
  tripToken: string;
  reason: TripEndedReason;
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
  /**
   * #1363 — 클라이언트가 산출한 "사용자 현재 추정 역" 이름. backend log 진단(`scheduled.ts`)에서
   * `waypoint`(trip 다음 정거장)과 명시적으로 구분하기 위한 필드. backend는 게이트 결정에
   * 사용하지 않고 log 라벨링에만 활용한다 — RCA 시 사용자 실제 위치 ↔ trip 목표 정거장의 혼동을
   * 차단한다. 미전달 시 log에서 `currentStation` 키가 omit (graceful, 회귀 없음).
   */
  currentStationName?: string;
  /**
   * #1543 (ADR-016 S10) — 디바이스 CTRadioAccessTechnology 환경 vote.
   *
   * - 'surface'      : 4G/5G 잡힘 → 지상 환경 vote
   * - 'underground'  : 2G/3G fallback → 지하 환경 vote
   * - 'unknown' / 미전송 : vote 미투표 (게이트 영향 0)
   *
   * 본 필드는 backend `evaluateConsensusGate`가 `cellularEnvironmentVote`로 입력받아 4분면 SSOT
   * 합의 게이트의 환경 contradict 판정에 사용한다. iOS only — Android는 본 값을 보내지 않으며
   * backend는 undefined를 'unknown' 동급으로 graceful 처리.
   */
  cellularEnvironmentVote?: 'surface' | 'underground' | 'unknown';
  /**
   * #1667 (ADR-015 strongDB wire) — 디바이스가 WiFi SSID 매핑으로 결정한 역명.
   *
   * device가 `lookupStationBySsid(currentWifiSsid)` 결과를 forward한다 — backend는
   * stations.json을 갖지 않으므로 lookup은 device 책임 (`mapMatchedLine/ArcM`과 동일 패턴).
   *
   * - 매칭 성공: `Station.name` 문자열 (예: '강남')
   * - 미연결 / 매칭 실패 / Android: undefined → consensusGate strongDB는 자연 false fallback
   *   (undefined → `wifiSsidMatch ?? false` → false, strongBE/strongCB fallback 유지)
   * - iOS WiFi constraint: 사용자가 연결된 SSID만 얻을 수 있음 (5G/LTE 전용 시 undefined).
   *   `reference_ios_wifi_api_constraint.md` 참조.
   */
  wifiSsidStationName?: string;
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
  /**
   * #1536 (S3, T13) — trigger source 구분.
   *
   * - 'cron': scheduled.ts cron 사이클에서 9단 게이트 통과로 발사 (기존 동작).
   * - 'instant': POST /trips 등록 즉시 발사 path (T13 trigger 재설계). 9단 cron loop
   *   우회. lockSuggestion 부재 + 30s advance 없음 confidence 가 부족할 때 fallback 으로
   *   cron 게이트 발사.
   *
   * 부재(legacy) = 'cron' 으로 해석. device 는 telemetry 적재 시 source 분포 측정에 사용.
   */
  triggerKind?: 'cron' | 'instant';
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
  /**
   * 사용자 버그 신고 KV (#1034, docs/requirements/12-cross-cutting.md).
   * `POST /feedback`이 메시지 + 디바이스 컨텍스트를 30일 TTL로 적재.
   * 미바인딩 시 endpoint는 503 graceful (운영자가 namespace 발급 전 환경 호환).
   * 생성: `wrangler kv namespace create FEEDBACK`
   */
  FEEDBACK?: KVNamespace;
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
  /**
   * 운영 alert webhook URL (#972, PR #961 follow-up). Slack incoming webhook 또는 호환
   * receiver. 미설정 시 `evaluateAndMaybeAlert`는 graceful no-op.
   * 등록: `wrangler secret put RECALL_ALERT_WEBHOOK_URL`
   */
  RECALL_ALERT_WEBHOOK_URL?: string;
  /**
   * Cloudflare Analytics Engine SQL HTTP API 호출용 account ID (#972).
   * `RECALL_ALERT_WEBHOOK_URL`과 함께 셋 다 있어야 alert 평가가 동작.
   */
  CF_ACCOUNT_ID?: string;
  /** Cloudflare API token (Analytics Engine read 권한) (#972). secret으로 등록. */
  CF_API_TOKEN?: string;
  /**
   * 운영자용 admin endpoint Bearer token (#1042 follow-up).
   * `/admin/feedback`, `/admin/feedback/export.csv`가 본 토큰으로 인증한다.
   * 미설정 시 admin endpoint들은 503 (운영자가 secret 등록 전 환경 호환).
   * 등록: `wrangler secret put ADMIN_TOKEN`
   */
  ADMIN_TOKEN?: string;
  /**
   * Device raw signal dump KV (#1520, ADR-015 §10 P5 / PR-B).
   * Trip 종료 시 device가 fusion raw signal ring buffer를 60일 TTL로 적재 →
   * 운영자가 `/admin/signals/export?corrId=`로 조회해 7일 회귀 사후 분석.
   * 미바인딩 시 `/signals/dump`는 503 graceful (개발 환경 호환).
   * 생성: `wrangler kv namespace create RAW_SIGNALS`
   */
  RAW_SIGNALS?: KVNamespace;
  /**
   * Sentry DSN (#1578, Phase 0 P0-2). 미설정 시 `sentryInit`/`captureXEvent`는
   * graceful no-op. 등록: `wrangler secret put SENTRY_DSN`.
   */
  SENTRY_DSN?: string;
  /**
   * Phase 0 측정 인프라 — Cloudflare Analytics Engine dataset (#1577, Epic #1576).
   *
   * V/X acceptance (ADR-017/016) 검증용 시계열. advance / fire / suppress /
   * motion-transition / position-upload / trip-mutation 6 event를 `src/analytics.ts`의
   * `writeMetric()` helper로 적재한다.
   *
   * 미바인딩 시 모든 적재 경로는 graceful no-op (TELEMETRY 동형) — 개발/테스트 환경 호환.
   * 생성: `wrangler.toml`의 `[[analytics_engine_datasets]]` binding=`TRIP_METRICS`,
   *      dataset=`trip_metrics`.
   */
  TRIP_METRICS?: AnalyticsEngineWriter;
  /**
   * Device alarmLog telemetry forward → R2 archive (#1579, Phase 0 epic #1576 P0-3).
   * Trip 종료 시 device가 alarmLog/fusionLog/gpsDrops/ssotMirror snapshot을 forward해
   * `trip-evidence/YYYY/MM/DD/{tokenPrefix}-{tripStartedAt}.ndjson` 키로 90일 보관.
   * 미바인딩 시 `/telemetry/alarm-log`는 503 graceful.
   * 생성: `wrangler r2 bucket create subway-now-telemetry`
   *   + 90일 lifecycle 룰은 Cloudflare Dashboard에서 운영자가 수동 설정.
   */
  TELEMETRY_R2?: R2Bucket;
}
