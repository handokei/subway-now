/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * iOS silent push(BG) 핸들러 — alarm-worker 백엔드가 보내는 발사 신호.
 *
 * payload (백엔드 apns.ts SilentPushPayload와 1:1):
 * ```
 * aps: { 'content-available': 1 }
 * data: { nextWaypoint, etaSeconds, phase, kind, sentAt }
 * ```
 *
 * 동작 (#2064 Phase 1-device — 매역 알림 backend visible push 단일 채널 전환):
 *   1. payload 검증 + 수신 로그 적재 (#478 측정 인프라)
 *   2. kind(transfer/destination/intermediate)는 device 로컬 알림을 발사하지 않는다.
 *      logSilentPushSkipped(reason='legacy-station-kind-ignored') 적재 후 no-op.
 *   3. boarding-prompt / sleep-alarm-companion 등 별도 discriminator 채널은 기존대로 gate 무관 발사.
 *   4. 상태 sync(lock-release/widget/LA refresh)는 kind 무관 항상 수행.
 */

import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import * as Battery from 'expo-battery';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import {
  persistBackendSsotMirror,
  parseAlarmEventsMirror,
  type SilentPushSsotMirror,
} from '../utils/backendSsotMirror';
import type { LineNumber, Station } from '../../../shared/types/station';
import {
  APNS_TOKEN_KEY,
  ACTIVE_TRIP_KEY,
  DESTINATION_KEY,
} from '../../../shared/constants/storageKeys';
import { sendPushAck } from '../api/alarmBackend';
import { createLogger } from '../../../shared/utils/logger';
import {
  flushAlarmLog,
  logCrossTripMirrorSkip,
  logSilentPushReceived,
  logSilentPushRescheduleReceived,
  logSilentPushTripEndedReceived,
  logSilentPushSkipped,
  logCompanionAlarmFired,
  logPushContractKindSkew,
  logPushContractValueSkew,
  type AlarmLogReason,
} from '../utils/alarmLog';
import { fireCompanionAlarm, readSleepMode } from '../utils/alarmLocalAuthority';
import { runTripBoundCleanups, cancelTripBoundOsQueue } from '../store/tripBoundCleanups';
import {
  setTripEndedSentinel,
  clearTripEndedSentinel,
} from '../utils/tripEndedSentinel';
import {
  setLastSilentPushReceivedAt,
  getLastSilentPushReceivedAt,
} from '../utils/lastSilentPushReceivedAt';
import { triggerTripEndRecall } from '../utils/triggerTripEndRecall';
import {
  checkTripDeathByPull,
  shouldCheckTripDeathOnSilentPush,
  getBackendUrl as getTripDeathPullBackendUrl,
} from '../utils/tripDeathPullBackstop';
import { getCurrentTripCorrIdSync } from '../../observability/utils/tripCorrId';
import { triggerTripGroundTruthPrompt } from '../../debug/utils/triggerTripGroundTruthPrompt';
import { addFiredPushId } from '../utils/firedPushIds';
import {
  rescheduleSafetyNetAlarm,
  cancelSafetyNetByStationKind,
} from '../utils/safetyNetScheduler';
import { cancelPrescheduledByStationKind } from '../utils/stationPrescheduler';
import { mapBackendKindToLocalFireKind, buildAlarmContent } from '../utils/stationNotification';
import { markLocalStationFired } from '../utils/recentLocalStationFires';
import { ROUTE_KEY } from '../../../shared/constants/storageKeys';
import type { Route } from '../../../shared/utils/stationRoute';
import { refreshLiveActivityFromBackgroundContext } from '../utils/refreshLiveActivityFromBackgroundContext';
import { updateWidgetFromSilentPush } from '../../widget/utils/updateWidgetFromSilentPush';
import { readWidgetRefreshContext } from '../utils/widgetRefreshContext';
import { useBoardingLockStore } from '../store/useBoardingLockStore';
import { useDestinationStore } from '../../route/store/useDestinationStore';
import { addDomainBreadcrumb } from '../../../shared/infra/monitoring/breadcrumb';
import {
  assertNever,
  isControlPushKind,
  isPushAlarmPhase,
  isSleepAlarmTargetKind,
  isStationWaypointKind,
  isValidEtaSeconds,
  type ControlPushKind,
  type SleepAlarmTargetKind,
  type StationWaypointKind,
} from '../../../shared/types/pushContract';

const logger = createLogger('SilentPushTask');

export const SILENT_PUSH_TASK = 'silent-push-reschedule';

export interface SilentPushPayload {
  nextWaypoint: string;
  etaSeconds: number;
  phase: 'early' | 'imminent';
  /** Waypoint 종류 (#416). transfer/destination/intermediate. 구 백엔드 호환 위해 optional. */
  kind?: StationWaypointKind;
  /**
   * #2231 — `kind`가 알려진 값(transfer/destination/intermediate)과 매치되지 않을 때 backend가
   * 실제로 보낸 원본 kind 문자열. 계약 스큐(backend가 새/변경된 kind를 보냈는데 device가 모르는 값)
   * 관측용 — 정상 kind거나 필드 자체가 없으면 undefined.
   */
  kindRaw?: string;
  /**
   * 백엔드 발사 시점 epoch ms (#478 측정 인프라).
   * 종료 조건: 신 백엔드 배포 후 required로 승격.
   */
  sentAt?: number;
  /**
   * Push 1건의 unique 식별자 (#566 P2a). 디바이스는 이 값을 `/push/ack`로 echo한다.
   * 구 백엔드 호환 위해 optional — 누락 시 ACK skip(P2c fallback이 발사할 가능성 감수).
   */
  pushId?: string;
  /**
   * 백엔드 trip waypoint의 0-based 절대 시퀀스 위치 (#1273 D3 / Epic #1204 그룹 2).
   * lockless intermediate hop-window 매치 게이트의 SSOT. 구 백엔드 호환 위해 optional —
   * 누락 시 거리 기반 widened fallback 경로로 동작 (silentPushLocationGate가 처리).
   * D1(#1207) hop estimator currentHopIndex와 짝지어 사용.
   */
  hopIndex?: number;
  /**
   * #1307 — 발사 시점 trip의 지하(subsurface) 판정. server-authoritative.
   * #2064 (Phase 1-device) — 이 필드를 소비하던 device 위치 게이트(`fireWithGate`)가 매역
   * 알림 backend visible push 전환으로 제거됨. 구 backend 호환을 위한 payload schema만 유지.
   */
  subsurface?: boolean;
  /**
   * #1322 — backend lock-path fire가 실어 보내는 boardingLock 노선 (server-authoritative).
   * #2064 (Phase 1-device) — 이 필드를 소비하던 device line sanity-guard(`fireWithGate`)가
   * 매역 알림 backend visible push 전환으로 제거됨. 구 backend 호환을 위한 payload schema만 유지.
   */
  boardingLine?: string;
  /**
   * #1365 — backend가 forward한 발사 시점 waypoint의 line. 환승역(같은 hop index에 line 다른
   * stop) misfire 차단용 — `silentPushLocationGate`가 디바이스 현재 line과 cross-validation.
   * 구 backend 호환 위해 optional — 누락 시 cross-check 자연 skip(graceful).
   */
  occupiedLine?: string;
  /**
   * #1399 — backend가 push 발사 시점에 stamp한 active trip token (좀비 알림 cleanup).
   * 디바이스는 `ACTIVE_TRIP_KEY`와 비교해 mismatch면 즉시 drop (현재 trip이 아님 — 만료 token push).
   *
   * 사용 시나리오: 백엔드 vanish + GPS 동결 + 트립 종료 → 종료 push 도착 → device cleanup →
   * 지상 재진입 후 OS queue/네트워크에 잔존하던 stale silent push가 늦게 도착해도 active trip이
   * 이미 다른 token이거나 null이면 본 가드가 발사를 차단한다 (S8 14:19 좀비 회귀).
   *
   * 구 backend 호환 위해 optional — 누락 시 가드 자연 skip(기존 동작 보존).
   */
  tripToken?: string;
  /**
   * #1438 (E5) — backend → device lock release sync 채널. backend `apns.ts` `LockReleasedReason`과 1:1.
   * 'transfer' = 환승 waypoint 통과로 backend가 lock release.
   * 'vanish'   = trainCode 소실로 backend가 lock release floor fire 후 release.
   * 디바이스는 본 신호를 받으면 즉시 `useBoardingLockStore.releaseLock()` 호출해 backend와 sync.
   * 구 backend 호환 위해 optional — 누락 시 sync 자연 skip(기존 동작 보존).
   */
  lockReleasedReason?: 'transfer' | 'vanish';
  /**
   * #1539 (S6, Epic #1533 / ADR-016) — backend가 trip 시작 후 통과를 확인한 모든 station 누적 배열
   * (직전 N개, 최신순 뒤). cron 1분 race로 device가 station을 "지나친 것" 인지 못 한 케이스를
   * 사후 backfill하기 위한 SSOT.
   *
   * 사용: device는 사전 예약 큐(`bl:`/`tba:`)와 diff하여 payload에 있지만 아직 발사되지 않은
   * station-passed를 backfill 발사한다. **본 PR(S6) 단계는 schema/extract만 — actual diff/fire
   * wiring은 S5 머지 후 후속 PR**(S5 pre-scheduled window 확장과 결합).
   *
   * 구 backend 호환 / 빈 배열 / wire 누락 → undefined → 기존 동작 그대로(backfill 자연 skip).
   */
  passedStations?: readonly string[];
  /**
   * #1561 (T8, ADR-017 / S2 #1535 흡수) — backend가 forward한 TripPositionSSoT 권위 스냅샷.
   *
   * device의 cascade picker(`useFusedNearestStation`)가 `backend-ssot` tier(최상위)로 채택한다.
   * silent push handler가 본 값을 BACKEND_SSOT_MIRROR_KEY에 mirror하고 cascade picker가 다음 cycle에 read.
   *
   * 구 backend 호환 / 누락 → undefined → cascade는 기존 tier fallback (graceful).
   */
  ssot?: SilentPushSsotMirror;
}

/**
 * #1568 (T8b) — `SilentPushSsotMirror` / `BackendSsotMirrorEntry` / `persistBackendSsotMirror` /
 * `readBackendSsotMirror`는 expo-notifications 의존성 없이 cascade picker / DebugModal에서 import
 * 가능하도록 `utils/backendSsotMirror.ts`로 이전했다. 기존 호출자 호환을 위해 본 파일에서 re-export.
 */
export {
  persistBackendSsotMirror,
  readBackendSsotMirror,
  type SilentPushSsotMirror,
  type BackendSsotMirrorEntry,
  type AlarmEventMirror,
} from '../utils/backendSsotMirror';

/**
 * Reschedule silent push payload (#725). 백엔드 `sendReschedulePush`가 일반 silent push와
 * 다른 schema(`nextStation` / `newArrivalTimeEpoch` / `trainCode`)를 보낸다 — 별도 인터페이스로
 * 모델링하고 `kind: 'reschedule'`을 discriminator로 사용해 union narrowing.
 *
 * #2089 — OS 예약 채널이 safetyNetScheduler 단일 모듈로 통합되며 `channels`(bl/tba 정정 대상
 * 배열) 필드는 device에서 더 이상 의미가 없다. 구 backend가 여전히 필드를 보내도 무시 — parse
 * 대상에서 제외해도 안전(추가 프로퍼티는 destructuring에서 자연 무시).
 */
export interface RescheduleSilentPushPayload {
  kind: Extract<ControlPushKind, 'reschedule'>;
  nextStation: string;
  newArrivalTimeEpoch: number;
  trainCode: string;
  sentAt?: number;
  pushId?: string;
  /**
   * #1193 — 같은 stationName이 route에 중복 등장하는 경우 정정 대상 occurrence(0-based).
   * 미지정 시 0(첫 등장)으로 해석 — 구 backend 호환 및 중복 없는 trip 동작 보존.
   */
  occurrenceIdx?: number;
}

/**
 * Boarding-prompt silent push payload (#2028) — Layer 2 사용자 도달 채널.
 *
 * 상황: backend는 boarding-prompt를 alert push(`aps.alert` + BOARDING_PROMPT category)로
 * 발사해 iOS가 native로 표시하지만, 사용자 Focus / DND / 취침 등으로 alert가 사용자에게
 * 도달하지 않으면 boardingPrompt 응답률이 0%가 된다(7일 evidence: displayed=0 / responded=0).
 *
 * 본 payload는 backend가 alert push와 함께(또는 alert 실패 시 fallback으로) `content-available:1`
 * silent push를 보낼 때 도달률을 확보하기 위한 채널이다. device silentPushTask가 수신하면
 * gate 무관(location / silence / motion / dedup 모두 skip) 즉시 local notification을 schedule해
 * 사용자에게 소리 + 진동 + 배너로 노출한다.
 *
 * 도달률 우선 정책 — ADR-022 정합. gate 실패로 UI 미노출이 되는 것은 회귀보다 크므로 무조건 발사.
 * dedup은 tripToken 세션 스코프 in-memory Set으로 관리해 backend cron 재시도(3회)로 인한 중복
 * 알림만 차단한다. 세션(앱 재시작)이 바뀌면 dedup은 자연 초기화 — 사용자가 실제로 응답하지 않은
 * 이전 trip의 prompt는 재발사되지 않는다(pushId 기준 backend가 이미 정지).
 */
export interface BoardingPromptSilentPushPayload {
  kind: Extract<ControlPushKind, 'boarding-prompt'>;
  /**
   * 사용자 출발역. hop-end 분기(#2034) 에서는 "환승 지점 역명" (=사용자가 하차해야 하는 station)
   * 으로 재해석. hopEndKind 필드로 분기 처리.
   */
  originStation: string;
  /**
   * 노선. hop-end(#2034) 시엔 직전 leg 노선 (하차 대상). 일반 boarding-prompt 는 승차 대상 노선.
   */
  line: string;
  /** trip 토큰 — dedup key + boarding-prompt 응답 시 trip 컨텍스트 복원용. */
  tripToken: string;
  /**
   * push의 unique 식별자. dedup은 tripToken 스코프이지만 pushId도 backend `/push/ack`에 필요.
   * 구 backend 호환 위해 optional — 누락 시 ACK skip.
   */
  pushId?: string;
  /** 백엔드 발사 시점 epoch ms. 구 backend 호환 위해 optional. */
  sentAt?: number;
  /** 목적지 방향 filter (#1740). BoardingPrompt 응답 flow에서 arrival 후보 필터에 사용. */
  destinationDirection?: 'up' | 'down';
  /**
   * 사용자 표시 title (backend가 i18n resolve해서 넣어줌). 미지정 시 device fallback.
   * backend `sendBoardingPromptPush`의 title과 동형.
   */
  title?: string;
  /**
   * 사용자 표시 body (backend가 i18n resolve해서 넣어줌). 미지정 시 device fallback.
   * backend `sendBoardingPromptPush`의 body와 동형.
   */
  body?: string;
  /**
   * #2034 — hop-end (환승역 하차) 프롬프트 분기. 미지정(legacy) = 승차 프롬프트. 'disembark'
   * = "하차했나요?" UI. device 는 이 필드로 title/body/응답 처리를 분기.
   */
  hopEndKind?: 'disembark';
  /** #2034 — hop-end 시 다음 leg 노선. 미지정이면 UI 에서 line 만 fallback 노출. */
  nextLine?: string;
  /** #2034 — hop-end 시 다음 leg 출발역. 미지정이면 UI 에서 next-line 만 표시. */
  nextStation?: string;
}

/**
 * 취침모드 companion 알람 silent push payload (#2036 Issue I γ → #2067 Phase 2-device D3 전환).
 *
 * 사용자 확정 flow: "환승역/도착역 임박 → 취침모드 시 알람 발사, 일반모드는 일반 상황과 동일".
 * 주 채널은 원격 visible push(`sound: alarm.wav`, #2066)로 전환됐고, 본 payload는 device가
 * 깨어있을 때 TTS/진동으로 소리를 보강하고 OS 안전망 예약을 cancel하는 companion 채널이다.
 *
 * 정책 (ADR-023 정합):
 *  - **Backend는 취침 무관 발사** (기존 arvlCd/vanish/lockless 발사기가 취침 상태 조회하지 않음).
 *  - **Device가 sleepMode=true 확인 후 발사 결정** — `AlarmLocalAuthority.fireCompanionAlarm`이 게이트.
 *  - 알림(배너) 생성 없음 — TTS + Haptics 진동만. dedup은 `AlarmLocalAuthority`의 persisted ledger(TTL 1h).
 *  - gate 무관 (location / silence / motion 모두 skip) — 도달률 우선. boarding-prompt와 같은 정책.
 *
 * targetKind — 알람 대상이 환승역인지 도착역인지(#2066). device는 문구/식별자 분기에 사용.
 */
export interface SleepAlarmCompanionSilentPushPayload {
  kind: Extract<ControlPushKind, 'sleep-alarm-companion'>;
  /** 사용자가 지금 있는 역(직전 역, arvlCd 진입/도착 확정 시점). 사용자 컨텍스트/식별자 기록용. */
  originStation: string;
  /** 알람 대상이 환승역인지 도착역인지. device 문구/식별자 분기용. */
  targetKind: SleepAlarmTargetKind;
  /** 알람 대상 역의 노선. 알림 본문에 노출. */
  nextLine: string;
  /** 알람 대상 역(환승역 또는 도착역). 알림 본문 + 식별자로 사용. */
  nextStation: string;
  /** trip 토큰 — 식별자 구성 + `AlarmLocalAuthority` ledger key로 사용. */
  tripToken: string;
  /**
   * push의 unique 식별자. backend `/push/ack`에 필요.
   * 구 backend 호환 위해 optional — 누락 시 ACK skip.
   */
  pushId?: string;
  /** 백엔드 발사 시점 epoch ms. 구 backend 호환 위해 optional. */
  sentAt?: number;
  /**
   * 사용자 표시 title (backend가 i18n resolve해서 넣어줌). 미지정 시 device fallback.
   */
  title?: string;
  /**
   * 사용자 표시 body (backend가 i18n resolve해서 넣어줌). 미지정 시 device fallback.
   */
  body?: string;
}

/**
 * Trip ended silent push payload (#868). 백엔드가 server-side로 trip을 자동 종료했을 때
 * 클라이언트의 route/destination/lock state를 동기화하라는 신호. backend `apns.ts`의
 * `TripEndedPushPayload`와 1:1.
 *
 * reason 타입은 backend types.ts의 `TripEndedReason`과 동일 enum literal을 사용하지만,
 * 클라는 unknown reason도 graceful하게 처리하기 위해 string으로 받아 후처리한다.
 * (구버전 backend 호환 + 신규 reason 추가 시 회귀 없음.)
 */
export interface TripEndedSilentPushPayload {
  kind: Extract<ControlPushKind, 'trip-ended'>;
  reason: TripEndedReason;
  sentAt?: number;
  pushId?: string;
  /**
   * race 가드용 trip 식별자(#868 P1-2). backend가 보낸 trip의 token — 클라가 현재
   * ACTIVE_TRIP_KEY와 비교해 불일치 시 cleanup skip. 구버전 backend 호환을 위해 optional.
   */
  tripToken?: string;
  /**
   * #2120 — 종료된 trip 인스턴스 corrId echo. tripToken(APNs 기기 토큰)은 기기당 고정이라
   * 같은 기기의 옛 trip 종료 push가 새 trip 등록 후 도착해도 token 비교만으로는 못 막는다
   * (#2114 RCA 잔여 hole). corrId는 trip 인스턴스 단위로 매 등록마다 새로 발급되므로, 클라의
   * 현재 corrId(`getCurrentTripCorrIdSync()`)와 대조해 불일치 시 cleanup을 skip한다.
   * 양쪽 중 하나라도 없으면(구버전 backend / cache 미수화) 기존 동작 100% 유지.
   */
  corrId?: string;
}

/**
 * Trip 자동 종료 reason — backend `types.ts`의 TripEndedReason과 정렬.
 * 알 수 없는 reason은 'unknown'으로 정규화해 처리 (구버전 backend 호환 + cleanup은 동일).
 * 'seoul-outage' (#1663) — Seoul API HTTP error로 인한 false-end. cleanup 동작은 'eta-missing'과 동일.
 */
export type TripEndedReason =
  | 'eta-missing'
  | 'seoul-outage'
  | 'destination-arrived'
  | 'expired'
  | 'push-unrecoverable'
  | 'unknown';

/** extractPayload 결과 — standard silent push / reschedule / trip-ended / boarding-prompt / sleep-alarm-companion. */
export type ExtractedPayload =
  | SilentPushPayload
  | RescheduleSilentPushPayload
  | TripEndedSilentPushPayload
  | BoardingPromptSilentPushPayload
  | SleepAlarmCompanionSilentPushPayload;

/**
 * expo-notifications iOS의 `BackgroundEventTransformer.swift`가 APNs payload를
 * 다음과 같이 변환해 task 콜백에 전달한다:
 *   { data: { ...non-aps fields, dataString }, notification: <aps.alert | null>, aps: {...} }
 *
 * 우리 백엔드(alarm-worker)는 `{ aps: {...}, data: { <fields> } }`로 발사하므로
 * 변환 결과는 `taskData.data.data.<field>`에 우리 fields가 위치한다.
 * (#641 — silent push BG handler 회귀: 과거에는 `notification.data` 경로를 읽다 보니
 *  silent push가 alert를 동반하지 않아 `notification`이 null인 production payload에서
 *  항상 null로 떨어졌다.)
 */
interface NotificationBackgroundTaskData {
  data?: Record<string, unknown>;
  error?: { message: string } | null;
}

/**
 * payload 안에서 fields 레이어를 찾는다.
 *   - `taskData.data.data` (production: backend가 `data: { fields }` 발사 → Swift 변환 후 한 단계 더 nested)
 *   - `taskData.data` (backend가 flat payload 발사 시)
 *   - `taskData` (legacy / 일부 테스트 호환)
 *
 * standard silent push는 `nextWaypoint` 필드로 식별, reschedule push(#725)는 `kind: 'reschedule'`
 * 로 식별 (nextStation을 쓰므로 nextWaypoint가 없다).
 */
function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isStandardCandidate(rec: Record<string, unknown>): boolean {
  return typeof rec.nextWaypoint === 'string' && (rec.nextWaypoint as string).length > 0;
}

function isRescheduleCandidate(rec: Record<string, unknown>): boolean {
  return rec.kind === 'reschedule';
}

function isTripEndedCandidate(rec: Record<string, unknown>): boolean {
  return rec.kind === 'trip-ended';
}

function isBoardingPromptCandidate(rec: Record<string, unknown>): boolean {
  return rec.kind === 'boarding-prompt';
}

function isSleepAlarmCompanionCandidate(rec: Record<string, unknown>): boolean {
  return rec.kind === 'sleep-alarm-companion';
}

/**
 * `taskData` 안에서 `predicate`를 만족하는 첫 fields 레이어를 찾는다. 탐색 순서(level2 → level1 →
 * root)는 `findFieldsLayer`와 동일 — layer 탐색 로직 자체는 predicate와 무관해 재사용한다
 * (#2243, ADR-029 Phase 1 — control-shaped unknown-kind skew 탐지가 다른 predicate로 같은
 * 탐색을 재사용).
 */
function findFieldsLayerBy(
  taskData: NotificationBackgroundTaskData['data'],
  predicate: (rec: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  const candidates: Array<Record<string, unknown>> = [];
  const root = asPlainObject(taskData);
  if (root) {
    const level1 = asPlainObject(root.data);
    if (level1) {
      const level2 = asPlainObject(level1.data);
      if (level2) candidates.push(level2);
      candidates.push(level1);
    }
    candidates.push(root);
  }
  for (const rec of candidates) {
    if (predicate(rec)) return rec;
  }
  return null;
}

function findFieldsLayer(
  taskData: NotificationBackgroundTaskData['data'],
): Record<string, unknown> | null {
  return findFieldsLayerBy(
    taskData,
    (rec) =>
      isStandardCandidate(rec) ||
      isRescheduleCandidate(rec) ||
      isTripEndedCandidate(rec) ||
      isBoardingPromptCandidate(rec) ||
      isSleepAlarmCompanionCandidate(rec),
  );
}

/**
 * G6 (#2243, ADR-029 Phase 1) — control-shaped 계약 스큐 후보 판정. station-shaped(nextWaypoint
 * 보유)가 아니면서 `kind`가 non-empty string인데 CONTROL_PUSH_KINDS 밖의 값인 경우만 true.
 * `extractPayload`가 이미 알려진 control kind(reschedule/trip-ended/boarding-prompt/
 * sleep-alarm-companion)는 먼저 처리하므로, 이 predicate는 그 분기들이 모두 실패한 뒤에만
 * (findFieldsLayer 자체가 null을 반환한 뒤) 호출된다.
 */
function isUnknownControlKindCandidate(rec: Record<string, unknown>): boolean {
  if (isStandardCandidate(rec)) return false;
  const { kind } = rec;
  return typeof kind === 'string' && kind.length > 0 && !isControlPushKind(kind);
}

/**
 * `extractPayload`가 null을 반환했을 때만 호출한다 — 이미 알려진 kind(station/control 불문)는
 * extractPayload가 먼저 처리하므로 여기 도달하는 것은 "SSoT에 없는 kind를 실은, station 형태가
 * 아닌 payload"뿐이다. G6 정책(`pushContract.UNKNOWN_KIND_POLICY.controlLike` = fail-closed)의
 * 판정 입력을 만든다 — 실제 fail-closed 처리(발사 안 함 + 로그)는 호출자(`handleSilentPush`)가 한다.
 */
function detectUnknownControlKindSkew(
  taskData: NotificationBackgroundTaskData['data'],
): { rawKind: string; pushId: string | undefined } | null {
  const rec = findFieldsLayerBy(taskData, isUnknownControlKindCandidate);
  if (!rec) return null;
  return { rawKind: rec.kind as string, pushId: validPushId(rec.pushId) };
}

/**
 * 알림 raw payload → 검증된 SilentPushPayload.
 *
 * 입력은 expo-notifications BG task가 전달하는 `NotificationTaskPayload`이다.
 * 우리 backend가 `{ aps, data: { fields } }` 형태로 발사하므로 fields는
 * `root.data.<field>` 위치에 있다. flat payload 호환을 위해 root 직접도 fallback.
 */
export function extractPayload(
  taskData: NotificationBackgroundTaskData['data'],
): ExtractedPayload | null {
  const obj = findFieldsLayer(taskData);
  if (!obj) return null;
  // reschedule 분기 (#725) — schema가 standard와 다름. discriminator는 kind === 'reschedule'.
  if (obj.kind === 'reschedule') return extractReschedulePayload(obj);
  // trip-ended 분기 (#868) — schema는 단순 (reason만). discriminator는 kind === 'trip-ended'.
  if (obj.kind === 'trip-ended') return extractTripEndedPayload(obj);
  // boarding-prompt 분기 (#2028) — Layer 2 사용자 도달. discriminator는 kind === 'boarding-prompt'.
  if (obj.kind === 'boarding-prompt') return extractBoardingPromptPayload(obj);
  // sleep-alarm-companion 분기 (#2036 Issue I γ → #2067 D3) — 취침 시 companion 알람.
  // discriminator는 kind === 'sleep-alarm-companion'.
  if (obj.kind === 'sleep-alarm-companion') return extractSleepAlarmCompanionPayload(obj);
  return extractStandardPayload(obj);
}

function extractStandardPayload(obj: Record<string, unknown>): SilentPushPayload | null {
  // extractPayload가 obj.kind === 'reschedule' 분기를 먼저 처리하므로 여기 도달했다는 것은
  // standard 경로. findFieldsLayer는 isStandardCandidate(nextWaypoint non-empty) 또는
  // isRescheduleCandidate(kind='reschedule') 중 하나로 통과시키지만, kind='reschedule'
  // 케이스는 위 분기에서 잡혔으므로 잔여 케이스는 isStandardCandidate가 보증한 것 — nextWaypoint 보장.
  const {
    nextWaypoint,
    etaSeconds,
    phase,
    kind,
    sentAt,
    pushId,
    hopIndex,
    subsurface,
    boardingLine,
    occupiedLine,
    tripToken,
    lockReleasedReason,
    passedStations,
    ssot,
  } = obj as {
    nextWaypoint: string;
  } & Record<string, unknown>;
  // G2 (#2243, ADR-029 Phase 1) — etaSeconds/phase는 SilentPushPayload에서 required 필드다.
  // 타입은 맞아도 값이 도메인 semantics를 벗어나는 drift(NaN, 음수, 비정상 상한 초과, 알 수
  // 없는 phase 문자열)는 조용히 drop하지 않고 skew로 관측한 뒤 기존과 동일하게 처리를 중단한다.
  if (!isValidEtaSeconds(etaSeconds)) {
    logPushContractValueSkew({ field: 'etaSeconds', rawValue: etaSeconds, stationName: nextWaypoint });
    return null;
  }
  if (!isPushAlarmPhase(phase)) {
    logPushContractValueSkew({ field: 'phase', rawValue: phase, stationName: nextWaypoint });
    return null;
  }
  const validKind = isStationWaypointKind(kind) ? kind : undefined;
  // #2231 — kind가 존재하지만(빈 문자열 제외) 알려진 값과 매치되지 않는 경우만 raw로 보존한다.
  // kind 자체가 없는(구버전 backend 단순 미지정) 경우는 계약 스큐가 아니므로 kindRaw를 남기지 않는다.
  const kindRaw =
    typeof kind === 'string' && kind.length > 0 && validKind === undefined ? kind : undefined;
  return {
    nextWaypoint,
    etaSeconds,
    phase,
    kind: validKind,
    kindRaw,
    sentAt: validSentAt(sentAt),
    pushId: validPushId(pushId),
    hopIndex: validHopIndex(hopIndex),
    subsurface: validSubsurface(subsurface),
    boardingLine: validBoardingLine(boardingLine),
    occupiedLine: validBoardingLine(occupiedLine),
    tripToken: validTripToken(tripToken),
    lockReleasedReason: validLockReleasedReason(lockReleasedReason),
    passedStations: validPassedStations(passedStations),
    ssot: validSsotMirror(ssot),
  };
}

/**
 * #1561 (T8, ADR-017 / S2 흡수) — payload.ssot 검증. 모든 필수 필드가 유효해야 통과.
 *
 * 누락/형식 오류/필수 필드 부재 → undefined → cascade picker가 기존 tier fallback(graceful).
 * passedStations는 string 배열로 정규화 (비-string 항목 필터). 빈 배열은 허용 (backend가 보낼 수 있음).
 *
 * #1572 (T9) — alarmEvents 슬롯 추가 (optional). 각 entry는 alarmId/stationId/type/decidedAt
 * strict 검사. 형식 mismatch entry는 graceful drop (잔여만 채택). 필드 자체가 array가 아니면 omit.
 */
export function validSsotMirror(value: unknown): SilentPushSsotMirror | undefined {
  if (value == null || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  const { currentStationId, motionState, lastAdvanceEvidence, lastAdvanceAt, passedStations, alarmEvents } = obj;
  if (typeof currentStationId !== 'string' || currentStationId.length === 0) return undefined;
  if (motionState !== 'moving' && motionState !== 'stationary' && motionState !== 'unknown') {
    return undefined;
  }
  if (typeof lastAdvanceEvidence !== 'string' || lastAdvanceEvidence.length === 0) return undefined;
  if (typeof lastAdvanceAt !== 'number' || !Number.isFinite(lastAdvanceAt)) return undefined;
  const passed: string[] = [];
  if (Array.isArray(passedStations)) {
    for (const p of passedStations) {
      if (typeof p === 'string' && p.length > 0) passed.push(p);
    }
  }
  // #1572 (T9) — alarmEvents 항목별 strict 검사. 빈 배열도 허용 (backend가 보낼 수 있음).
  // array 아니면 undefined → SSoT 본체는 채택 (graceful, evaluateSsotFireGate는 mirror-missing fallback).
  // backendSsotMirror.parseAlarmEventsMirror와 같은 narrow 정책 — 단일 진입점으로 통합 (SonarCloud CPD 회피).
  const events = parseAlarmEventsMirror(alarmEvents);
  return {
    currentStationId,
    motionState,
    lastAdvanceEvidence,
    lastAdvanceAt,
    passedStations: passed,
    ...(events !== undefined ? { alarmEvents: events } : {}),
  };
}

/**
 * #1539 (S6) — payload.passedStations 검증. non-empty string 배열만 통과.
 * - 누락/형식 오류/빈 배열 → undefined → device backfill 자연 skip(기존 동작 보존).
 * - 항목별 비-string 또는 빈 string은 필터 후 잔여가 있으면 그것만 채택. 잔여 0이면 undefined.
 * - 길이 cap은 backend 책임(`PASSED_STATIONS_MAX_LEN`). device 추가 cap은 적용하지 않는다 —
 *   payload 크기 제약은 APNs serializer에서 이미 강제.
 *
 * S5 머지 후 wiring PR에서 사전 예약 큐 diff에 사용된다.
 */
function validPassedStations(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const filtered: string[] = [];
  for (const v of value) {
    if (typeof v === 'string' && v.length > 0) filtered.push(v);
  }
  return filtered.length > 0 ? filtered : undefined;
}

/**
 * #1438 (E5) — payload.lockReleasedReason 검증. 'transfer'|'vanish' 만 통과.
 * 그 외(누락/형식 오류/unknown 문자열)는 undefined로 정규화 → store sync 자연 skip (구 backend 호환).
 */
function validLockReleasedReason(value: unknown): 'transfer' | 'vanish' | undefined {
  return value === 'transfer' || value === 'vanish' ? value : undefined;
}

/**
 * #1399 — payload.tripToken 검증. 비어있지 않은 string만 통과.
 * backend가 push 발사 시점의 active trip token을 stamp해 device가 좀비 알림 cleanup에 사용.
 * 구 backend는 누락 → undefined → 가드 자연 skip(기존 동작 보존).
 */
function validTripToken(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * #1322 — payload.boardingLine 검증. 비어있지 않은 string만 통과 (LineNumber 표기).
 * #2064 (Phase 1-device) — 소비하던 device 게이트(`fireWithGate`) 제거됨. schema 파싱만 유지.
 */
function validBoardingLine(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * #1307 — payload.subsurface 검증. boolean true만 의미를 갖는다. backend는 true일 때만
 * wire하므로 false/누락/형식 오류는 모두 undefined로 정규화 → 게이트가 로컬 stamp fallback.
 */
function validSubsurface(value: unknown): boolean | undefined {
  return value === true ? true : undefined;
}

/**
 * #1273 D3 — payload.hopIndex 검증. 0 이상 정수만 통과. 구 backend가 필드를 안 보내면 undefined →
 * `silentPushLocationGate`가 거리 기반 widened fallback 경로로 동작.
 * (validOccurrenceIdx와 의미가 다르므로 별도 헬퍼 — hopIndex는 절대 시퀀스, occurrenceIdx는 중복 station 선택.)
 */
function validHopIndex(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
}

function extractReschedulePayload(
  obj: Record<string, unknown>,
): RescheduleSilentPushPayload | null {
  const { nextStation, newArrivalTimeEpoch, trainCode, sentAt, pushId, occurrenceIdx } = obj;
  if (typeof nextStation !== 'string' || nextStation.length === 0) return null;
  if (typeof newArrivalTimeEpoch !== 'number' || !Number.isFinite(newArrivalTimeEpoch)) return null;
  if (typeof trainCode !== 'string' || trainCode.length === 0) return null;
  return {
    kind: 'reschedule',
    nextStation,
    newArrivalTimeEpoch,
    trainCode,
    sentAt: validSentAt(sentAt),
    pushId: validPushId(pushId),
    occurrenceIdx: validOccurrenceIdx(occurrenceIdx),
  };
}

/**
 * #1193 — payload.occurrenceIdx 검증. 0 이상 정수만 통과. 구 backend가 필드를 안 보내면 undefined →
 * `rescheduleTripBoundAlarm`이 0(첫 등장)으로 fallback.
 */
function validOccurrenceIdx(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
}

/**
 * trip-ended payload 추출 (#868). schema 최소 — discriminator(kind)와 reason만.
 * reason이 known set에 없으면 'unknown'으로 정규화 (구버전 backend / 신규 reason 호환).
 */
function extractTripEndedPayload(
  obj: Record<string, unknown>,
): TripEndedSilentPushPayload | null {
  const { reason, sentAt, pushId, tripToken, corrId } = obj;
  return {
    kind: 'trip-ended',
    reason: normalizeTripEndedReason(reason),
    sentAt: validSentAt(sentAt),
    pushId: validPushId(pushId),
    tripToken: typeof tripToken === 'string' && tripToken.length > 0 ? tripToken : undefined,
    // #2120 — corrId echo. 구버전 backend는 필드 미송신 → undefined (null-graceful).
    corrId: typeof corrId === 'string' && corrId.length > 0 ? corrId : undefined,
  };
}

/**
 * boarding-prompt payload 추출 (#2028). schema — kind + originStation + line + tripToken은 필수,
 * pushId / sentAt / destinationDirection / title / body는 optional (구 backend 호환).
 *
 * originStation / line / tripToken 중 하나라도 비어 있으면 null → 발사 skip. 발사에 필요한
 * 최소 정보를 갖추지 못한 payload는 wire fallback으로 backend가 별도 신호를 보낼 것.
 */
function extractBoardingPromptPayload(
  obj: Record<string, unknown>,
): BoardingPromptSilentPushPayload | null {
  const {
    originStation,
    line,
    tripToken,
    pushId,
    sentAt,
    destinationDirection,
    title,
    body,
    hopEndKind,
    nextLine,
    nextStation,
  } = obj;
  if (typeof originStation !== 'string' || originStation.length === 0) return null;
  if (typeof line !== 'string' || line.length === 0) return null;
  if (typeof tripToken !== 'string' || tripToken.length === 0) return null;
  return {
    kind: 'boarding-prompt',
    originStation,
    line,
    tripToken,
    pushId: validPushId(pushId),
    sentAt: validSentAt(sentAt),
    destinationDirection:
      destinationDirection === 'up' || destinationDirection === 'down'
        ? destinationDirection
        : undefined,
    title: typeof title === 'string' && title.length > 0 ? title : undefined,
    body: typeof body === 'string' && body.length > 0 ? body : undefined,
    // #2034 — hop-end 필드. 미지정 시 undefined (legacy = 승차 prompt).
    hopEndKind: hopEndKind === 'disembark' ? 'disembark' : undefined,
    nextLine: typeof nextLine === 'string' && nextLine.length > 0 ? nextLine : undefined,
    nextStation:
      typeof nextStation === 'string' && nextStation.length > 0 ? nextStation : undefined,
  };
}

/**
 * sleep-alarm-companion payload 추출 (#2036 Issue I γ → #2067 D3). schema — kind + originStation +
 * targetKind + nextLine + nextStation + tripToken은 필수. pushId / sentAt / title / body 는
 * optional (구 backend 호환).
 *
 * 필수 필드 중 하나라도 비어 있거나 targetKind가 'transfer'/'destination'이 아니면 null → 발사 skip.
 * 발사에 필요한 최소 정보(사용자 컨텍스트/식별자)를 갖추지 못한 payload는 backend 정상 wire 문제로
 * 판정 — device는 조용히 drop.
 */
function extractSleepAlarmCompanionPayload(
  obj: Record<string, unknown>,
): SleepAlarmCompanionSilentPushPayload | null {
  const { originStation, targetKind, nextLine, nextStation, tripToken, pushId, sentAt, title, body } =
    obj;
  if (typeof originStation !== 'string' || originStation.length === 0) return null;
  if (!isSleepAlarmTargetKind(targetKind)) return null;
  if (typeof nextLine !== 'string' || nextLine.length === 0) return null;
  if (typeof nextStation !== 'string' || nextStation.length === 0) return null;
  if (typeof tripToken !== 'string' || tripToken.length === 0) return null;
  return {
    kind: 'sleep-alarm-companion',
    originStation,
    targetKind,
    nextLine,
    nextStation,
    tripToken,
    pushId: validPushId(pushId),
    sentAt: validSentAt(sentAt),
    title: typeof title === 'string' && title.length > 0 ? title : undefined,
    body: typeof body === 'string' && body.length > 0 ? body : undefined,
  };
}

const KNOWN_TRIP_ENDED_REASONS: ReadonlyArray<TripEndedReason> = [
  'eta-missing',
  'seoul-outage',
  'destination-arrived',
  'expired',
  'push-unrecoverable',
];

function normalizeTripEndedReason(reason: unknown): TripEndedReason {
  if (typeof reason !== 'string') return 'unknown';
  return KNOWN_TRIP_ENDED_REASONS.includes(reason as TripEndedReason)
    ? (reason as TripEndedReason)
    : 'unknown';
}

function validSentAt(sentAt: unknown): number | undefined {
  return typeof sentAt === 'number' && Number.isFinite(sentAt) ? sentAt : undefined;
}

function validPushId(pushId: unknown): string | undefined {
  return typeof pushId === 'string' && pushId.length > 0 ? pushId : undefined;
}

/**
 * #1768 — foreground + background 권한 조합에서 permissionMode를 파생한다.
 * 실패 시 undefined 반환 — graceful, ack 전체를 block하지 않는다.
 */
async function resolvePermissionMode(): Promise<'always' | 'whileInUse' | 'denied' | undefined> {
  try {
    const [fg, bg] = await Promise.all([
      Location.getForegroundPermissionsAsync(),
      Location.getBackgroundPermissionsAsync(),
    ]);
    if (fg.status !== 'granted') return 'denied';
    if (bg.status === 'granted') return 'always';
    return 'whileInUse';
  } catch {
    return undefined;
  }
}

/**
 * #1772 — expo-battery로 battery state를 조회한다.
 * lowPowerMode ON → 'lowPowerMode', OFF → 'normal'. 실패 시 'unknown'.
 */
async function resolveBatteryState(): Promise<'normal' | 'lowPowerMode' | 'unknown'> {
  try {
    const state = await Battery.getPowerStateAsync();
    return state.lowPowerMode ? 'lowPowerMode' : 'normal';
  } catch {
    return 'unknown';
  }
}

/**
 * 백엔드 P2c fallback에서 이 push가 alert로 재발사되지 않도록 처리 결과를 통보한다 (#568 P2b).
 * fire-and-forget — 실패해도 silent push 본 처리 흐름에는 영향 없음.
 * 누락 입력(pushId/token 중 하나라도 null/undefined)은 그대로 skip한다:
 *   - pushId 누락 = 구 백엔드 호환 경로
 *   - token 누락 = APNs 권한 미부여/저장 실패
 * #1768 — permissionMode를 비동기로 resolve해 payload에 포함한다.
 * #1772 — latencyMs(sentAt 기반 계산) + batteryState를 'received' ack에 포함한다.
 */
async function ackOutcome(
  pushId: string | undefined,
  token: string | null,
  outcome: 'received' | 'fired' | 'skipped',
  reason?: string,
  latencyMs?: number,
): Promise<void> {
  if (!pushId || !token) return;
  const permissionMode = await resolvePermissionMode();
  if (outcome === 'received') {
    const batteryState = await resolveBatteryState();
    void sendPushAck({ pushId, token, outcome, reason, permissionMode, latencyMs, batteryState });
    return;
  }
  void sendPushAck({ pushId, token, outcome, reason, permissionMode });
}

async function loadApnsToken(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(APNS_TOKEN_KEY);
  } catch {
    return null;
  }
}

// #1568 (T8b) — persistBackendSsotMirror / readBackendSsotMirror는 utils/backendSsotMirror로 이전.
// 본 파일 상단에서 type/함수 re-export 유지.

/**
 * Task 콜백 본체 — 단위 테스트가 직접 호출할 수 있도록 export.
 */
export async function handleSilentPush(input: NotificationBackgroundTaskData): Promise<void> {
  // #1935 — finally 블록에서 widget update가 payload.ssot 또는 standard kind를 활용하려면
  // payload가 outer scope에 있어야 한다. valid extract 후 assign; invalid면 null 유지.
  let payload: ExtractedPayload | null = null;
  // #2178 — pull death backstop 트리거 조건(마지막 backend 접촉 staleness) 판정용. 이번
  // push의 receivedAt으로 덮어쓰기 *전* 값을 캡처해야 의미가 있어 outer scope에 둔다.
  let priorLastReceivedAt: number | null = null;
  // #735 — BG task 시간 제약. 모든 종료 경로(early return, fire-with-gate, error)에서 적재된
  // alarmLog pending이 OS suspend로 손실되지 않도록 try/finally로 명시 flush.
  try {
    if (input.error) {
      logger.error('silent push task error:', input.error.message);
      return;
    }

    payload = extractPayload(input.data);
    if (!payload) {
      // G6 (#2243, ADR-029 Phase 1) — extractPayload가 null을 반환한 것이 "완전히 malformed"인지
      // "control-shaped인데 SSoT에 없는 kind"(계약 스큐)인지 구분한다. 후자만 fail-closed 정책
      // 대상 — 조용한 drop 대신 skew를 명시적으로 관측한다(A2).
      const controlSkew = detectUnknownControlKindSkew(input.data);
      if (controlSkew) {
        logPushContractKindSkew({ category: 'control-like', rawKind: controlSkew.rawKind });
        addDomainBreadcrumb('push', 'contract-skew', {
          category: 'control-like',
          rawKind: controlSkew.rawKind,
        });
        logger.warn(
          `push contract skew (control-like, fail-closed): kind=${controlSkew.rawKind}`,
        );
        if (controlSkew.pushId) {
          const apnsToken = await loadApnsToken();
          void ackOutcome(controlSkew.pushId, apnsToken, 'skipped', 'push-contract-skew-control-fail-closed');
        }
        return;
      }
      logger.info('payload missing or invalid — skip');
      return;
    }
    const receivedAt = Date.now();
    priorLastReceivedAt = await getLastSilentPushReceivedAt();
    addDomainBreadcrumb('push', 'silent-push', { kind: payload.kind ?? 'fire' });
    // #2045 (Signal 4) — 유효 payload 진입 시점에 last-received stamp 갱신.
    // useLaunchTripReconciliation이 launch 시 read해 backend-timeout self-end 판정 (관찰 22 BG kill 커버).
    // fire-and-forget — write 실패해도 다음 push 수신에서 재갱신, 판정 실패는 9h force-end backstop 흡수.
    void setLastSilentPushReceivedAt(receivedAt);
    const apnsToken = await loadApnsToken();

    // #1561 (T8, ADR-017 / S2 #1535 흡수) — backend SSoT 권위 mirror 저장.
    //
    // standard silent push payload에 ssot가 실려 있으면 BACKEND_SSOT_MIRROR_KEY에 그대로 영속화.
    // useFusedNearestStation cascade picker가 다음 polling cycle에서 본 값을 read해 `backend-ssot`
    // tier(최상위)로 채택한다. receivedAt도 함께 stamp해 cascade picker가 자체 staleness 판단.
    //
    // reschedule/trip-ended payload는 SSoT를 forward하지 않으므로 본 분기에서는 호출되지 않는다.
    //
    // 실패는 silent — backend SSoT mirror는 보조 신호로 cascade는 기존 tier fallback이 가능.
    //
    // R11-b (#1612) — trip token mismatch 시 mirror write skip (race A 차단).
    // cleanup 후 OLD trip의 지연 silent push가 늦게 도착해 mirror가 부활하면
    // 다음 cascade cycle이 stale `backend-ssot` tier로 잘못된 currentStationId 채택 — cross-trip
    // 잔재 회귀(2026-06-19/20 trip evidence). payload.tripToken과 device ACTIVE_TRIP_KEY가
    // 명확히 다르면 mirror write를 건너뛴다. activeToken null(cold-launch race)이거나
    // payload.tripToken undefined(구 backend 호환)면 기존 동작 보존 — 정상 진입을 막지 않는다.
    if ('ssot' in payload && payload.ssot !== undefined) {
      const activeTripToken = await AsyncStorage.getItem(ACTIVE_TRIP_KEY);
      const tripTokenMismatch =
        'tripToken' in payload &&
        payload.tripToken !== undefined &&
        activeTripToken !== null &&
        activeTripToken !== payload.tripToken;
      if (tripTokenMismatch) {
        logger.info(
          `mirror write skip: trip token mismatch payload=${payload.tripToken!.slice(0, 8)} active=${activeTripToken.slice(0, 8)}`,
        );
        // #1628 — R11-b 차단 1건 측정.
        logCrossTripMirrorSkip('mismatch');
      } else {
        await persistBackendSsotMirror(payload.ssot, receivedAt);
      }
    }

    // #1370 L5 — silent push 도달률 observability stamp.
    //
    // 게이트 평가 이전, payload가 유효한 시점에 도달 신호를 backend로 보낸다.
    // backend는 KV에 `received:<pushId>` stamp만 적재하고 pending entry는 보존 — 후속
    // fired/skipped ack가 P2c fallback 결정을 그대로 처리한다.
    //
    // 효과: backend tail의 `reschedule push → 어린이대공원` pushed 이벤트와 device received
    // stamp를 1:1 비교 가능. stamp 부재 = APNs 전달 실패 또는 OS suspend로 task 미시작.
    //
    // pushId/token 둘 다 있어야 임의 echo 차단 정책을 지킬 수 있으므로 ackOutcome과 동일하게
    // 누락 시 skip한다 (구 backend 호환 경로).
    // #1772 — latencyMs: sentAt이 valid number인 경우만 계산. 구 backend(sentAt 누락) graceful.
    const latencyMs = typeof payload.sentAt === 'number' && Number.isFinite(payload.sentAt)
      ? Math.max(0, receivedAt - payload.sentAt)
      : undefined;
    void ackOutcome(payload.pushId, apnsToken, 'received', undefined, latencyMs);

    // reschedule 분기 (#725). 백엔드는 사전 예약 알람(#584) 시각을 정정하려고 이 push를 보낸다.
    // - 수신 신호는 받았다 알리고(`lastReceivedAt` 갱신)
    // - ack로 P2c alert fallback을 차단한다.
    //
    // ackOutcome 3번째 인자는 'fired'를 보내지만, 사용자에게 알림이 실제 발사된 것은 아니다 —
    // 백엔드 ackPending(`pendingPushes.ts`)이 outcome을 통계로 쓰지 않고 KV entry 삭제 신호로만
    // 사용하므로 안전 (`outcome=fired` = "이 push는 처리 완료, alert fallback 발사 마라").
    // reason 'reschedule-received'로 의도가 디버그 로그에 보존된다.
    //
    // 사전 예약 자체의 시각 조정은 별도 follow-up에서 다룬다 — 본 PR은 schema mismatch로 drop되던
    // 수신을 회복시키는 것이 범위.
    //
    // #2235 (ADR-029 Phase 0) — control-kind 분기를 if-체인에서 exhaustive switch + assertNever로
    // 전환. ExtractedPayload는 `kind`를 discriminant로 하는 union이라 각 case에서 payload가
    // 해당 payload 타입으로 narrow된다. station waypoint kind(transfer/destination/intermediate)와
    // undefined(kind 미상)는 이 switch에서 처리하지 않고 break로 아래 standard 처리로 넘어간다.
    // CONTROL_PUSH_KINDS에 새 값이 추가되면 이 switch의 default가 컴파일 에러를 낸다(A1 실증).
    switch (payload.kind) {
      case 'reschedule': {
        logger.info(
          `reschedule received: trainCode=${payload.trainCode} nextStation=${payload.nextStation} newEpoch=${payload.newArrivalTimeEpoch} sentAt=${payload.sentAt ?? 'unknown'} pushId=${payload.pushId ?? 'unknown'}`,
        );
        logSilentPushRescheduleReceived({
          nextStation: payload.nextStation,
          sentAt: payload.sentAt,
          receivedAt,
        });
        await applyReschedule(payload, receivedAt);
        void ackOutcome(payload.pushId, apnsToken, 'fired', 'reschedule-received');
        return;
      }

      // trip-ended 분기 (#868) — backend가 server-side trip 자동 종료를 알리는 신호.
      // route/destination/lock 등 trip-bound storage를 일괄 cleanup해 다음 FG 진입 시
      // store hydrate가 stale state를 그대로 재현하지 않도록 한다.
      //
      // ack outcome='fired'는 backend pendingPushes 입장에서는 "처리 완료, alert fallback 발사 마라"
      // 신호. trip-ended는 alert fallback 대상이 아니지만 호환을 위해 일반 silent push와 같은 의미로 ack.
      case 'trip-ended': {
        logger.info(
          `trip-ended received: reason=${payload.reason} tripToken=${payload.tripToken?.slice(0, 8) ?? 'unknown'} sentAt=${payload.sentAt ?? 'unknown'} pushId=${payload.pushId ?? 'unknown'}`,
        );
        // race 가드(#868 P1-2). 신규 backend는 tripToken을 항상 보냄. 구버전(undefined)은
        // 호환 위해 cleanup 진행 — race 가능성은 있지만 backend 배포 후 사라짐.
        if (payload.tripToken !== undefined) {
          const activeTripToken = await AsyncStorage.getItem(ACTIVE_TRIP_KEY);
          if (activeTripToken !== null && activeTripToken !== payload.tripToken) {
            logger.warn(
              `trip-ended skip: tripToken mismatch payload=${payload.tripToken.slice(0, 8)} active=${activeTripToken.slice(0, 8)}`,
            );
            void ackOutcome(payload.pushId, apnsToken, 'fired', `trip-ended:${payload.reason}:token-mismatch`);
            return;
          }
        }
        // #2120 (#2114 근본 수리 Phase 2) — corrId 인스턴스 가드. tripToken(APNs 기기 토큰)은
        // 기기당 고정이라 위 token 비교는 "같은 기기의 다른 trip" race를 못 잡는다. backend
        // 자동종료(la-stale/eta-missing 등) push가 in-flight인 수 초 사이 device가 재등록하면,
        // 새 trip의 ACTIVE_TRIP_KEY(=같은 token)를 그대로 통과해 옛 trip 종료 push가 새 trip을
        // 즉시 cleanup해버린다. corrId는 register마다 새로 발급되는 trip 인스턴스 식별자이므로
        // payload와 device 현재 값이 둘 다 있는데 다르면 그 사이 재등록이 있었다는 뜻 — cleanup
        // 전체를 skip한다. 어느 한쪽이라도 없으면(구버전 backend / cache 미수화) 기존 동작 유지.
        // payload.corrId가 없는(구버전 backend) 경로는 device corrId를 조회할 필요조차 없다 —
        // 불필요한 sync cache read를 피해 이후 endedCorrIdSnapshot 캡처 시점과의 혼동도 방지한다.
        if (payload.corrId !== undefined) {
          const deviceCorrId = getCurrentTripCorrIdSync();
          if (deviceCorrId !== null && payload.corrId !== deviceCorrId) {
            logger.warn(
              `trip-ended skip: corrId mismatch payload=${payload.corrId} device=${deviceCorrId}`,
            );
            logSilentPushSkipped({
              stationName: `trip-ended:${payload.reason}`,
              kind: undefined,
              reason: 'trip-ended-corr-mismatch',
            });
            void ackOutcome(payload.pushId, apnsToken, 'skipped', `trip-ended:${payload.reason}:corr-mismatch`);
            return;
          }
        }
        logSilentPushTripEndedReceived({
          reason: payload.reason,
          sentAt: payload.sentAt,
          receivedAt,
        });
        // #1370 L4 — OS scheduled queue burst fire 차단. 종착역 도착 시 backend trip-ended push가
        // 도달할 때 device 로컬 OS queue(`bl:`/`tba:`)에 잔존한 사전 예약 알람이 동시에 발사돼
        // 사용자가 "용마산 도착 후 한꺼번에 받음"으로 인지하는 회귀.
        //
        // runTripBoundCleanups가 결국 OS queue를 cancel하지만, 그 전에 triggerTripEndRecall이
        // routeStops 구성 + network upload로 수 초 stall할 수 있어 race window가 열린다.
        // OS queue cancel만 별도 helper로 분리해 trip-ended 진입 즉시 호출 — recall/cleanup 흐름은
        // 그대로 유지. cancel 자체는 멱등하므로 runTripBoundCleanups의 중복 cancel은 안전 통과.
        await cancelTripBoundOsQueue();
        // #919 — trip-end recall KPI upload. *반드시* cleanup 전에 호출해야 한다 — trigger가
        // ROUTE_KEY/DESTINATION_KEY/TRIP_STARTED_AT_KEY를 읽어 routeStops를 구성하기 때문.
        // trigger는 throw하지 않으므로 후속 cleanup/sentinel 흐름 차단 없음.
        await triggerTripEndRecall();
        // #1597 — clearTripCorrId가 cache를 비우기 전에 종료된 trip의 corrId snapshot 캡처.
        const endedCorrIdSnapshot = getCurrentTripCorrIdSync();
        await runTripBoundCleanups();
        // #1597 — trip-end 사용자 정답지 prompt enqueue (cleanup 후, corrId snapshot으로).
        await triggerTripGroundTruthPrompt(endedCorrIdSnapshot);
        // #899 (Seam C) — BG에서는 zustand store에 접근 불가. FG 복귀 시점에
        // useStateRehydration이 이 sentinel을 보고 destination/lock store도 reset.
        // #2114 (방안 C′) — sentinel에 corrId 동봉해 다음 소비 시점 trip 인스턴스 스코프 비교 가능하게.
        await setTripEndedSentinel(receivedAt, endedCorrIdSnapshot);
        // #2018 γ' — FG 상태에서는 useStateRehydration의 AppState 'active' 이벤트가
        // 발생하지 않아 sentinel이 다음 BG/FG cycle까지 처리되지 않는다. 그동안 in-memory
        // destination store가 stale로 남아 UI가 "현재역 → 현재역 0정거장" 형태로 잔존
        // (2026-07-02 dogfood 관찰 20 성수→성수 evidence). FG 진행 중이면 setState를
        // 여기서 즉시 수행해 store를 정리하고 sentinel을 그 자리에서 clear한다.
        // BG 상태에서는 zustand runtime 접근이 불확실하므로 sentinel만 남기고 기존
        // useStateRehydration 경로에 의존 — 기존 회귀 표면 없음.
        if (AppState.currentState === 'active') {
          try {
            useDestinationStore.setState({
              destination: null,
              customOrigin: null,
              tripOrigin: null,
            });
            addDomainBreadcrumb('trip', 'end', {
              reason: 'silent-push-fg-immediate',
            });
            await useBoardingLockStore.getState().releaseLock();
            await clearTripEndedSentinel();
          } catch (e) {
            logger.warn('FG 즉시 store reset 실패 (graceful — sentinel 유지):', e);
          }
        }
        // #2069 (Phase 3) — B12 원격 alert push 단일 채널. iOS가 시스템 banner를 직접 표시하므로
        // 로컬 알림 재생성(D11, 구 `surfaceTripEnded`)은 제거. dedup store에는 그대로 기록해 같은
        // pushId의 backend retry가 도달해도(FIRED_PUSH_IDS 공유) 중복 처리를 막는다.
        if (payload.pushId) await addFiredPushId(payload.pushId);
        void ackOutcome(payload.pushId, apnsToken, 'fired', `trip-ended:${payload.reason}`);
        return;
      }

      // boarding-prompt 분기 (#2069 Phase 3) — B7 원격 alert push 단일 채널로 정리되며 B8(silent
      // fallback) 이 제거됐다. 이 kind 는 이 BG task 로 더 이상 발사되지 않지만, 롤아웃 중 구버전
      // backend 재시도가 도달할 가능성에 대비해 no-op + 로그만 남긴다 (로컬 알림 재구성 X).
      // 응답 버튼(BOARDING_PROMPT_CATEGORY)은 원격 alert push 자체의 category 로 노출되며, 등록은
      // 앱 초기화(`app/_layout.tsx` → `setupBoardingPromptCategory`)에서 로컬 발사와 무관하게 이뤄진다.
      case 'boarding-prompt': {
        logger.info(
          `boarding-prompt received (remote-only, no local notification): originStation=${payload.originStation} line=${payload.line} tripToken=${payload.tripToken.slice(0, 8)} sentAt=${payload.sentAt ?? 'unknown'} pushId=${payload.pushId ?? 'unknown'}`,
        );
        void ackOutcome(payload.pushId, apnsToken, 'skipped', 'boarding-prompt-remote-only');
        return;
      }

      // sleep-alarm-companion 분기 (#2036 Issue I γ → #2067 Phase 2-device D3) — 취침모드 companion
      // 알람. 알림(배너) 생성 없이 TTS/진동만 부가하고 OS 안전망 예약을 cancel한다.
      //
      // 정책 (ADR-023 정합):
      //  - Backend는 취침 무관 발사 (기존 arvlCd/vanish 경로는 sleep 조회 없음).
      //  - Device가 `AlarmLocalAuthority.fireCompanionAlarm`이 sleepMode=true 확인 후에만 발사.
      //  - sleepMode=false면 일반모드 = 원격 visible push(#2066)가 주 채널 담당 → 본 분기는 no-op skip.
      //  - dedup: `AlarmLocalAuthority`의 persisted ledger(TTL 1h) — 앱 재시작 생존.
      case 'sleep-alarm-companion': {
        logger.info(
          `sleep-alarm-companion received: originStation=${payload.originStation} targetKind=${payload.targetKind} nextLine=${payload.nextLine} nextStation=${payload.nextStation} tripToken=${payload.tripToken.slice(0, 8)} sentAt=${payload.sentAt ?? 'unknown'} pushId=${payload.pushId ?? 'unknown'}`,
        );
        await fireSleepAlarmCompanion(payload, apnsToken);
        return;
      }

      // station waypoint kind(standard silent push)와 kind 미상(구 백엔드)은 이 switch가 다루지
      // 않는다 — 아래 standard 처리 경로로 넘어간다.
      case 'transfer':
      case 'destination':
      case 'intermediate':
      case undefined:
        break;

      /* istanbul ignore next -- 위 case들이 ExtractedPayload['kind']의 모든 값을 exhaustive하게
       * 나열하므로(reschedule/trip-ended/boarding-prompt/sleep-alarm-companion/transfer/destination/
       * intermediate/undefined) default는 컴파일 타임에만 의미가 있는 방어 코드다. CONTROL_PUSH_KINDS
       * 또는 STATION_WAYPOINT_KINDS(pushContract SSoT)에 새 값이 추가되고 이 switch가 갱신되지
       * 않으면 여기 도달 전에 이미 컴파일 에러가 난다(A1 실증) — 런타임 도달은 타입 시스템이 깨진
       * 경우(예: any 캐스팅)뿐이라 테스트 불가능한 순수 방어 코드.
       */
      default:
        assertNever(payload, 'handleSilentPush control-kind dispatch');
    }

    logger.info(
      `received: kind=${payload.kind ?? 'unknown'} phase=${payload.phase} station=${payload.nextWaypoint} eta=${payload.etaSeconds} sentAt=${payload.sentAt ?? 'unknown'} pushId=${payload.pushId ?? 'unknown'}`,
    );

    // 측정 인프라 — 수신 시점 무조건 적재 (#478 PR 1-1).
    logSilentPushReceived({
      stationName: payload.nextWaypoint,
      kind: payload.kind,
      phaseId: payload.phase,
      sentAt: payload.sentAt,
      receivedAt,
      rawKind: payload.kindRaw,
    });

    // #1438 (E5) — backend → device lock release sync. payload.lockReleasedReason이 있으면
    // backend가 trip.boardingLock을 release했다는 신호 → 로컬 store도 같이 release한다. fire/skip
    // 분기와 독립적으로 state sync만 수행. 'transfer' 시 다음 leg boardingPrompt 재요청을 유도하고,
    // 'vanish'는 lockless 인계로 자연 fallback. store releaseLock은 멱등 — lock 없을 때 graceful.
    if (payload.lockReleasedReason !== undefined) {
      try {
        await useBoardingLockStore.getState().releaseLock(payload.lockReleasedReason);
        logger.info(
          `lock-release sync: reason=${payload.lockReleasedReason} station=${payload.nextWaypoint}`,
        );
      } catch (e) {
        logger.error('lock-release sync 실패:', e);
      }
    }

    // kind 미상은 발사 불가 — 알림 본문/dedup 키 결정 불가. 구 백엔드 호환은 received 로그에만.
    if (!payload.kind) {
      // G6 (#2243, ADR-029 Phase 1) — kindRaw가 있으면 "kind가 아예 없는" 구버전 backend 호환
      // 케이스가 아니라 "kind는 있는데 SSoT(STATION_WAYPOINT_KINDS) 밖의 값" 계약 스큐다.
      // station-shaped(nextWaypoint 보유) payload이므로 정책은 fallback-imminent-fire — 조용히
      // drop하는 대신 generic imminent 알림을 즉시 발사해 안전을 우선한다.
      if (payload.kindRaw) {
        await fireStationKindSkewFallback(payload);
        logPushContractKindSkew({
          category: 'station-like',
          rawKind: payload.kindRaw,
          stationName: payload.nextWaypoint,
        });
        addDomainBreadcrumb('push', 'contract-skew', {
          category: 'station-like',
          rawKind: payload.kindRaw,
        });
        void ackOutcome(
          payload.pushId,
          apnsToken,
          'fired',
          'push-contract-skew-station-fallback-fired',
        );
        logger.warn(
          `push contract skew (station-like, fallback fire): kind=${payload.kindRaw} station=${payload.nextWaypoint}`,
        );
        return;
      }
      logSilentPushSkipped({
        stationName: payload.nextWaypoint,
        kind: undefined,
        phaseId: payload.phase,
        reason: 'payload-missing-kind',
      });
      void ackOutcome(payload.pushId, apnsToken, 'skipped', 'payload-missing-kind');
      logger.info('kind missing — skip fire');
      return;
    }

    // #918 — BG wake = backend visible push 도착 시점("결정 evolve" 2026-08-03 2차 2항 BG 방향).
    // 이 station의 presched(OS 사전예약) pending을 즉시 취소 + 이미 OS가 발사했다면 delivered
    // tray에서도 제거 + recentLocalStationFires에 마킹 — FG willPresent 2차 방어선(#2122)이
    // 뒤늦게 도착하는(사실상 이미 도착한) presched 발사를 억제하도록 갱신한다. 3-소스 중 하나가
    // 먼저 도달하면 나머지 둘의 흔적을 정리하는 대칭 동작(FG 방향은 scheduledAlarmReceiver).
    const localKind = mapBackendKindToLocalFireKind(payload.kind);
    // istanbul ignore next -- 이 지점에 도달하는 payload.kind는 이미 위에서 reschedule/trip-ended/
    // boarding-prompt/sleep-alarm-companion/missing-kind 분기로 전부 걸러진 뒤라
    // 'transfer'|'destination'|'intermediate' 3종뿐이고, mapBackendKindToLocalFireKind는 이 3종을
    // 전부 non-null로 매핑한다(stationNotification.ts BACKEND_PUSH_KIND_TO_LOCAL_FIRE_KIND) — else
    // 분기는 두 소스가 서로 어긋나는 회귀가 생기기 전까지는 도달 불가능한 방어 코드.
    if (localKind === 'transfer' || localKind === 'destination' || localKind === 'station-passed') {
      await cancelPrescheduledByStationKind(payload.nextWaypoint, localKind).catch((e: unknown) => {
        logger.warn('presched cancel-on-remote-arrival 실패:', e);
      });
      await markLocalStationFired(payload.nextWaypoint, localKind).catch((e: unknown) => {
        logger.warn('markLocalStationFired 실패:', e);
      });
    }

    // #2064 (Phase 1-device) — 매역 알림 backend visible push 전환. transfer/destination/
    // intermediate kind는 더 이상 device가 로컬 알림을 발사하지 않는다(이중 발사 제거).
    // 수신 자체는 유지(위 logSilentPushReceived + finally의 LA/widget refresh)해 상태 sync는
    // 그대로 동작한다. 전환기 구버전 backend가 여전히 이 kind를 보내는 경우를 대비한 no-op.
    logSilentPushSkipped({
      stationName: payload.nextWaypoint,
      kind: payload.kind === 'intermediate' ? 'station-passed' : payload.kind,
      phaseId: payload.phase,
      reason: 'legacy-station-kind-ignored',
    });
    void ackOutcome(payload.pushId, apnsToken, 'skipped', 'legacy-station-kind-ignored');
    logger.info(
      `legacy station kind ignored: kind=${payload.kind} station=${payload.nextWaypoint}`,
    );
  } finally {
    // #900 Seam D — 권한 무관 LA refresh. 모든 silent push 종료 경로(정상/early-return/error)
    // 끝에서 한 번 호출. **순서 중요**: flushAlarmLog 먼저 await — 지하 환경에서 native LA
    // update가 ActivityKit lock으로 수 초 stall 가능. BG task 시간 예산(~25s)을 LA가 잠식하면
    // alarmLog가 손실(#735 회귀). 측정 인프라(alarmLog)가 항상 보호되도록 LA를 뒤에 둔다.
    await flushAlarmLog();
    // #1935 — LA + widget refresh. 권한(Always/WhileInUse) 무관 채널.
    //   - LA: `refreshLiveActivityFromBackgroundContext`가 처리 (#900 Seam D, 기존 동작)
    //   - widget: `updateWidgetFromSilentPush`가 처리 — WhileInUse 사용자 BG widget 회복
    //     (paradigm `feedback_whileinuse_must_work` 정신 충족).
    //
    // Promise.allSettled로 격리해 한 채널 실패가 다른 채널을 막지 않게 한다. payload가
    // null(invalid extract)인 경우 widget update는 skip — 신호 부재로 더 stale을 유발하지 않는다.
    const tasks: Array<Promise<unknown>> = [
      refreshLiveActivityFromBackgroundContext().catch((e) => {
        logger.error('refreshLiveActivityFromBackgroundContext 실패:', e);
      }),
    ];
    if (payload !== null) {
      tasks.push(refreshWidgetForPayload(payload));
    }
    await Promise.allSettled(tasks);

    // #2178 — pull 기반 trip 死 backstop. 처리 말미(모든 종료 경로 공통)에서 로컬 active
    // trip이 있는데 이번 payload의 trip 신원이 불일치하거나 마지막 backend 접촉이 오래됐으면
    // backend에 GET trip status로 생존을 직접 확인한다. baseUrl 미설정/네트워크 실패/404는
    // checkTripDeathByPull 내부에서 graceful skip — 이 finally 블록을 절대 막지 않는다.
    try {
      const baseUrl = getTripDeathPullBackendUrl();
      if (baseUrl !== null) {
        const activeTripToken = await AsyncStorage.getItem(ACTIVE_TRIP_KEY);
        const payloadTripToken =
          payload !== null && 'tripToken' in payload ? payload.tripToken : undefined;
        if (
          shouldCheckTripDeathOnSilentPush({
            activeTripToken,
            payloadTripToken,
            priorLastReceivedAt,
            now: Date.now(),
          })
        ) {
          await checkTripDeathByPull(baseUrl, 'silent-push');
        }
      }
    } catch (e) {
      logger.warn('pull death backstop 실패 (graceful)', e);
    }

    // 리뷰 P1 (PR #2189) — backstop이 내부적으로 적재하는 alarmLog 엔트리(trip-dead-pull-detected)는
    // appendAlarmLog의 1초 debounce pending에 걸린다. 위 flushAlarmLog()는 backstop 실행 *전*이라
    // 이 엔트리를 못 비우고, BG task가 곧 suspend되는 시나리오(=이 backstop의 존재 목적)에서 그대로
    // 유실될 수 있었다 — 유일한 관측 채널(V/X: DebugModal alarm log) 상실. backstop 블록을 flush
    // 앞으로 옮기는 대신(네트워크 GET이 기존 flush를 지연시켜 지하 LA stall 회귀 재현), 기존 flush
    // 순서는 그대로 두고 backstop 산출 로그만 한 번 더 flush한다.
    await flushAlarmLog();
  }
}

/**
 * #1935 — silent push 채널 widget update wrapper.
 *
 * payload가 standard SilentPushPayload(ssot 필드 가능)일 때 SSoT를 우선 사용,
 * reschedule / trip-ended payload는 ssot가 없으므로 BG context fallback만 활용.
 * trip-ended는 trip을 종료시키지만 widget도 같은 신호로 freshness 갱신.
 *
 * `readWidgetRefreshContext` + `updateWidgetFromSilentPush` 조합. 예외는 swallow.
 */
async function refreshWidgetForPayload(payload: ExtractedPayload): Promise<void> {
  try {
    const ctx = await readWidgetRefreshContext();
    const ssot = 'ssot' in payload ? payload.ssot : undefined;
    await updateWidgetFromSilentPush(ssot, ctx.bgContext, ctx.destination, ctx.route);
  } catch (e) {
    logger.error('updateWidgetFromSilentPush 실패:', e);
  }
}

/**
 * reschedule silent push(#698) 적용 — 백엔드가 보낸 nextStation/newArrivalTimeEpoch로
 * 사전 예약(안전망 또는 presched)을 cancel + 재예약한다. 본 함수는 SLA 게이트가 아니라
 * 정정 신호이므로 결과 무관 ack(`reschedule-received`)는 호출자가 처리한다.
 *
 * #2089 — 3종 채널(bl/tba) 통합 이후 단일 안전망 채널만 정정한다. lock 상태와 무관
 * (tripToken 기반 lockless) — 옛 `applyRescheduleBl`의 trainCode/lock 매칭은 더 이상 필요 없다.
 *
 * **#2202 (ADR-026 Decision 2)** — stationPrescheduler(매역 사전예약) 채널이 퇴역하며
 * sleepMode OFF 방향의 정정 대상이 사라졌다. 본 함수는 이제 sleepMode ON(safetyNetScheduler,
 * backend-outage 안전망) 전용 — sleepMode OFF는 no-op skip한다. 일반 모드 매역 정정은
 * backend가 직접 보정된 visible push를 재발송하는 것으로 대체됐다(#2201 단일 emitter).
 *
 * 사전 조건 누락(`route`/`destination`/`tripToken` 중 하나라도 없음, 또는 newArrivalTimeEpoch
 * 과거)은 모두 graceful no-op — 신호가 도달했어도 SLA를 깨지 않는다(원본 사전 예약 유지).
 * 예외는 외부로 전파하지 않고 logger.error 후 swallow — 다른 silent push 흐름과 일관.
 */
async function applyReschedule(
  payload: RescheduleSilentPushPayload,
  receivedAt: number,
): Promise<void> {
  try {
    if (payload.newArrivalTimeEpoch <= receivedAt) {
      logger.info(
        `reschedule skip: newArrivalTimeEpoch=${payload.newArrivalTimeEpoch} <= receivedAt=${receivedAt}`,
      );
      return;
    }
    const [sleepMode, routeRaw, destRaw, backendTripToken] = await Promise.all([
      readSleepMode(),
      AsyncStorage.getItem(ROUTE_KEY),
      AsyncStorage.getItem(DESTINATION_KEY),
      AsyncStorage.getItem(ACTIVE_TRIP_KEY),
    ]);

    // #2202 — stationPrescheduler 퇴역 후 sleepMode OFF는 정정 대상 없음(no-op).
    if (!sleepMode) {
      logger.info('reschedule skip: presched channel retired (#2202) — sleepMode OFF');
      return;
    }
    const route = parseRoute(routeRaw);
    const destinationName = parseDestinationName(destRaw);
    if (!route || !destinationName || !backendTripToken) {
      logger.info(
        `reschedule skip: route=${route ? 'ok' : 'null'} destination=${destinationName ?? 'null'} tripToken=${backendTripToken ? 'ok' : 'null'}`,
      );
      return;
    }
    await rescheduleSafetyNetAlarm({
      tripToken: backendTripToken,
      route,
      destinationName,
      stationName: payload.nextStation,
      newArrivalMs: payload.newArrivalTimeEpoch,
      // #1193 — 중복역 trip은 backend가 occurrenceIdx를 명시. 미지정 시 0(첫 등장).
      occurrenceIdx: payload.occurrenceIdx,
      now: receivedAt,
    });
  } catch (e) {
    logger.error('reschedule apply 실패:', e);
  }
}

function parseRoute(raw: string | null): Route | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Route;
  } catch {
    return null;
  }
}

function parseDestinationName(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Station> | null;
    return parsed && typeof parsed.name === 'string' ? parsed.name : null;
  } catch {
    return null;
  }
}

/**
 * #2067 (Phase 2-device, D3) — 취침모드 companion 알람 silent push 수신 시 처리.
 *
 * 절차:
 *   1. `AlarmLocalAuthority.fireCompanionAlarm` 호출 — sleepMode gate + persisted ledger dedup +
 *      TTS/진동 발사를 단일 진입점이 담당한다. 알림(배너) 생성 없음.
 *   2. 발사 성공 시 해당 station의 OS 안전망 예약(safetyNetScheduler)을 cancel — companion 도달 =
 *      사용자가 이미 소리/진동으로 인지했으므로 중복 안전망 알림이 불필요하다.
 *   3. skip 사유(not-sleep-mode / dedup)에 따라 ack outcome을 분기.
 *
 * gate 무관 (location / silence / motion 모두 skip) — boarding-prompt와 같은 도달률 우선 정책.
 * 사용자 확정 flow (`project_2026_07_03_user_manual_action_flow`): "환승역/도착역 → 취침 시 알람 발사".
 *
 * ADR-023 정합: backend는 취침 무관 발사, device가 필터 → `fireCompanionAlarm`이 필터의 결정 지점.
 */
async function fireSleepAlarmCompanion(
  payload: SleepAlarmCompanionSilentPushPayload,
  apnsToken: string | null,
): Promise<void> {
  const body =
    payload.body ??
    `${payload.originStation}에서 ${payload.nextLine}호선 ${payload.nextStation}으로 환승`;

  const result = await fireCompanionAlarm({
    tripToken: payload.tripToken,
    station: payload.nextStation,
    kind: payload.targetKind,
    body,
  });

  if (!result.fired) {
    const reason =
      result.reason === 'dedup' ? 'sleep-alarm-companion-dedup' : 'sleep-alarm-companion-not-sleep-mode';
    logger.info(
      `sleep-alarm-companion skip: reason=${result.reason} nextStation=${payload.nextStation}`,
    );
    void ackOutcome(payload.pushId, apnsToken, 'skipped', reason);
    return;
  }

  // companion 도달 = 사용자가 이미 소리/진동으로 인지 → 남은 OS 안전망 예약을 정리(#2089
  // cross-channel cancel의 대체 — 채널이 하나뿐이라 "반대 채널 cleanup"이 아니라 "companion으로
  // 이미 전달된 waypoint의 안전망 제거"가 목적).
  await cancelSafetyNetByStationKind(payload.nextStation, payload.targetKind);

  logCompanionAlarmFired({
    originStation: payload.originStation,
    nextStation: payload.nextStation,
    nextLine: payload.nextLine,
  });
  addDomainBreadcrumb('push', 'sleep-alarm-companion-fired', {
    nextLine: payload.nextLine,
    originStation: payload.originStation,
    nextStation: payload.nextStation,
  });
  logger.info(
    `sleep-alarm-companion fired: originStation=${payload.originStation} nextLine=${payload.nextLine} nextStation=${payload.nextStation} tripToken=${payload.tripToken.slice(0, 8)}`,
  );
  void ackOutcome(payload.pushId, apnsToken, 'fired', 'sleep-alarm-companion');
}

/**
 * G6 (#2243, ADR-029 Phase 1) — station-shaped 계약 스큐(backend가 STATION_WAYPOINT_KINDS 밖의
 * kind를 실은 standard silent push) fallback. 정책 SSoT: `pushContract.UNKNOWN_KIND_POLICY.
 * stationLike`. 어떤 세부 종류(환승/도착/통과)인지는 알 수 없지만 어느 역인지는 알고 있으므로,
 * transfer/destination 공용 문구 빌더(`buildAlarmContent`)를 `type: 'destination'`(비-환승 문구,
 * 더 일반적인 표현)으로 재사용해 generic "곧 도착" 알림을 즉시 발사한다.
 */
async function fireStationKindSkewFallback(payload: SilentPushPayload): Promise<void> {
  const { title, body } = buildAlarmContent({
    phaseId: 'imminent',
    type: 'destination',
    stationName: payload.nextWaypoint,
  });
  await Notifications.scheduleNotificationAsync({
    identifier: `skew-fallback-${payload.nextWaypoint}`,
    content: { title, body, sound: true },
    trigger: null,
  });
}

/** Task 등록 — 모듈 로드 시점에 한 번 실행. */
TaskManager.defineTask(SILENT_PUSH_TASK, handleSilentPush);

// 등록 상태 추적 — DebugModal의 silent push 진단 섹션(#506)이 읽는다.
// 'unknown'은 registerSilentPushTask가 아직 호출되지 않은 상태.
export type SilentPushRegistrationState = 'unknown' | 'success' | 'failed';
interface RegistrationStatus {
  state: SilentPushRegistrationState;
  error: string | null;
}
let registrationStatus: RegistrationStatus = { state: 'unknown', error: null };

/** DebugModal/진단용 — 현재 silent push task 등록 결과를 읽는다(#506). */
export function getSilentPushRegistrationStatus(): RegistrationStatus {
  return registrationStatus;
}

/**
 * 앱 초기화 시 호출 — Notifications가 BG payload를 이 task로 라우팅하도록 등록한다.
 */
export async function registerSilentPushTask(): Promise<void> {
  try {
    await Notifications.registerTaskAsync(SILENT_PUSH_TASK);
    registrationStatus = { state: 'success', error: null };
    logger.info('silent push task registered');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    registrationStatus = { state: 'failed', error: message };
    logger.warn('failed to register silent push task:', e);
  }
}
