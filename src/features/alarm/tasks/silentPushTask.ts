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
 * 동작 (#478 PR 1-2 — 사전예약 완전 폐기):
 *   1. payload 검증 + 수신 로그 적재 (#478 측정 인프라)
 *   2. 위치 게이트(`silentPushLocationGate`) 통과 여부 확인
 *      - 통과: trigger:null 즉시 알림 발사 + FIRED_ALARMS dedup 갱신 + logSilentPushFired
 *      - 실패: logSilentPushSkipped(reason)
 *   3. 사전예약(scheduleAlarmsForRoute) 호출 없음
 */

import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import * as Battery from 'expo-battery';
import AsyncStorage from '@react-native-async-storage/async-storage';
import i18next from 'i18next';
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
  SLEEP_MODE_KEY,
} from '../../../shared/constants/storageKeys';
import { sendPushAck } from '../api/alarmBackend';
import { createLogger } from '../../../shared/utils/logger';
import {
  flushAlarmLog,
  logBoardingPromptFired,
  logCrossTripMirrorSkip,
  logSilentPushReceived,
  logSilentPushRescheduleReceived,
  logSilentPushTripEndedReceived,
  logSilentPushFired,
  logSilentPushSkipped,
  logSleepTransferAlarmFired,
  logSuppressedChannelAgnosticDedup,
  type AlarmLogReason,
} from '../utils/alarmLog';
import { vibrateAlarm } from '../utils/alarmSound';
import {
  isAnyChannelRecentlyFired,
  markStationFired,
} from '../utils/crossCategoryStationDedup';
import { runTripBoundCleanups, cancelTripBoundOsQueue } from '../store/tripBoundCleanups';
import {
  setTripEndedSentinel,
  clearTripEndedSentinel,
} from '../utils/tripEndedSentinel';
import { triggerTripEndRecall } from '../utils/triggerTripEndRecall';
import { getCurrentTripCorrIdSync } from '../../observability/utils/tripCorrId';
import { triggerTripGroundTruthPrompt } from '../../debug/utils/triggerTripGroundTruthPrompt';
import { evaluateDismissSilence } from '../utils/dismissSilenceGate';
import { clearDismissSilence, getDismissSilence } from '../utils/dismissSilenceStorage';
import { evaluateSsotFireGate } from '../utils/ssotFireGate';
import { evaluateMovement, MOVEMENT_TO_ALARM_LOG_REASON } from '../../nearest-station/utils/movementGate';
import { getCurrentMotionStationary } from '../../nearest-station/utils/motionActivity';
import { addFiredPushId, hasFiredPushId } from '../utils/firedPushIds';
import {
  checkSilentPushLocationGate,
  type GateSkipReason,
} from '../utils/silentPushLocationGate';
import {
  rescheduleHopForLock,
  cancelBlByStationPhase,
} from '../utils/boardingLockScheduler';
import {
  rescheduleTripBoundAlarm,
  cancelTbaByStationPhase,
} from '../utils/tripBoundScheduler';
import { ALARM_PHASES } from '../utils/alarmPhases';
import { ROUTE_KEY } from '../../../shared/constants/storageKeys';
import type { Route } from '../../../shared/utils/stationRoute';
import { alarmKey, type AlarmEvent } from '../utils/stationAlarm';
import { buildAlarmContent, sendTripEndedNotification } from '../utils/stationNotification';
import { BOARDING_PROMPT_CATEGORY } from '../utils/notificationCategory';
import { refreshLiveActivityFromBackgroundContext } from '../utils/refreshLiveActivityFromBackgroundContext';
import { updateWidgetFromSilentPush } from '../../widget/utils/updateWidgetFromSilentPush';
import { readWidgetRefreshContext } from '../utils/widgetRefreshContext';
import { type NotificationSource } from '../utils/notificationSource';
import { getFiredAlarms, setFiredAlarms } from '../utils/notificationState';
import { getBoardingLock } from '../utils/boardingLockStorage';
import { useBoardingLockStore } from '../store/useBoardingLockStore';
import { useDestinationStore } from '../../route/store/useDestinationStore';
import { getSubsurfaceState } from '../../../shared/utils/subsurfaceState';
import { findStationByName, findStationByNameAndLine } from '../../../shared/utils/stationLookup';
import { addDomainBreadcrumb } from '../../../shared/infra/monitoring/breadcrumb';

// silent push는 서버가 train data 기반으로 발사하므로 라벨도 'positionTrain'으로 고정.
// 향후 GPS 게이트 경로 등 다른 출처가 생기면 인자화 한다.
const SILENT_PUSH_SOURCE: NotificationSource = 'positionTrain';

const logger = createLogger('SilentPushTask');

export const SILENT_PUSH_TASK = 'silent-push-reschedule';

/**
 * #2028 — boarding-prompt silent push local notification identifier.
 * 같은 identifier로 schedule하면 iOS가 이전 알림을 대체(dismiss + 재발사)해 사용자 tray에 1건만 유지.
 */
const BOARDING_PROMPT_NOTIFICATION_ID = 'boarding-prompt-silent-push';

/**
 * #2036 (Issue I γ) — 취침모드 환승 알람 local notification identifier.
 * 같은 identifier로 schedule하면 iOS가 이전 알림을 대체 — 사용자 tray에 1건만 유지.
 */
const SLEEP_TRANSFER_ALARM_NOTIFICATION_ID = 'sleep-transfer-alarm-silent-push';

/**
 * #2028 — tripToken 세션 스코프 dedup. 같은 tripToken으로 여러 backend cron 재시도가 도달해도
 * 로컬 알림을 1회만 발사한다. in-memory Set — 앱 재시작(cold-launch) 시 자연 초기화되지만
 * backend `boardingPromptState.promptedAt` dedup이 자체 재발사를 차단하므로 회귀 없음.
 * 사용자 응답 시 backend는 dismiss/lock 처리로 새 push를 발사하지 않는다.
 */
const boardingPromptFiredTripTokens = new Set<string>();

/**
 * #2036 (Issue I γ) — 취침모드 환승 알람 dedup. tripToken + nextStation 조합 스코프.
 * 같은 trip의 다른 환승역(예: 강남→성수 후 성수→내방)은 별 hop이라 nextStation이 다르므로
 * 각각 발사됨. backend cron retry(같은 hop 재시도)만 dedup 대상. in-memory Set — 앱 재시작
 * 시 자연 초기화되지만 backend가 waypoint advance 후 재발사하지 않으므로 회귀 없음.
 */
const sleepTransferAlarmFiredKeys = new Set<string>();

function sleepTransferAlarmDedupKey(tripToken: string, nextStation: string): string {
  return `${tripToken}::${nextStation}`;
}

/** 테스트 격리용 — dedup set을 비운다. production 코드에서는 호출하지 않는다. */
export function __resetBoardingPromptSilentPushDedup(): void {
  boardingPromptFiredTripTokens.clear();
}

/**
 * #2036 (Issue I γ) — 테스트 격리용. sleep-transfer alarm dedup set을 비운다.
 * production 코드에서는 호출하지 않는다.
 */
export function __resetSleepTransferAlarmSilentPushDedup(): void {
  sleepTransferAlarmFiredKeys.clear();
}

export interface SilentPushPayload {
  nextWaypoint: string;
  etaSeconds: number;
  phase: 'early' | 'imminent';
  /** Waypoint 종류 (#416). transfer/destination/intermediate. 구 백엔드 호환 위해 optional. */
  kind?: 'transfer' | 'destination' | 'intermediate';
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
   * 위치 게이트는 이 server flag를 우선하고, 부재 시 디바이스 로컬 stamp
   * (`getSubsurfaceState`)로 fallback한다. true + intermediate면 GPS 거리 검증을 우회해
   * 지하 stale/spoof GPS로 인한 out-of-range 오거부를 막는다. 구 backend 호환 위해 optional.
   */
  subsurface?: boolean;
  /**
   * #1322 — backend lock-path fire가 실어 보내는 boardingLock 노선 (server-authoritative).
   * 로컬 lock이 없을 때(지하 auto-lock hydration window) 이 line으로 sanity-guard를 돌려
   * non-intermediate push도 발사한다 (`fireWithGate`). backend가 선택해 발사한 push이므로
   * authoritative — 디바이스는 자체 lock 없이도 honor한다. 구 backend 호환 위해 optional —
   * 누락 시 기존 보수 동작(lock 없으면 non-intermediate skip)으로 fallback.
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
 * Reschedule push channel discriminator (#918 A3 PR4). Backend `types.ts`의 `RescheduleChannel`과 정렬.
 *
 *  - 'bl' — boarding-lock scheduler (`bl:` prefix). #585 경로. `rescheduleHopForLock` 호출.
 *  - 'tba' — trip-bound scheduler (`tba:` prefix). lock-free. `rescheduleTripBoundAlarm` 호출.
 *
 * 한 payload는 두 채널을 동시에 정정할 수 있다 (둘 다 호출).
 */
export type RescheduleChannel = 'bl' | 'tba';

/** 구 backend 호환 default — `channels` 누락 시 'bl' 단독으로 해석 (기존 동작 보존). */
const DEFAULT_RESCHEDULE_CHANNELS: ReadonlyArray<RescheduleChannel> = ['bl'];

/** 신규 backend(#918 A3 PR4) default — 'bl' + 'tba' 동시 정정. payload 검증/테스트에서 재사용. */
export const ALL_RESCHEDULE_CHANNELS: ReadonlyArray<RescheduleChannel> = ['bl', 'tba'];

/**
 * Reschedule silent push payload (#725). 백엔드 `sendReschedulePush`가 일반 silent push와
 * 다른 schema(`nextStation` / `newArrivalTimeEpoch` / `trainCode`)를 보낸다 — 별도 인터페이스로
 * 모델링하고 `kind: 'reschedule'`을 discriminator로 사용해 union narrowing.
 *
 * `channels` (#918 A3 PR4): 정정 대상 scheduler 채널 배열. 누락 시 구 backend 호환을 위해
 * `DEFAULT_RESCHEDULE_CHANNELS`(=['bl'])로 해석한다. 신규 backend는 ['bl','tba']를 보낸다.
 */
export interface RescheduleSilentPushPayload {
  kind: 'reschedule';
  nextStation: string;
  newArrivalTimeEpoch: number;
  trainCode: string;
  sentAt?: number;
  pushId?: string;
  channels?: ReadonlyArray<RescheduleChannel>;
  /**
   * #1193 — `tba:` 채널 정정 시, 같은 stationName이 route에 중복 등장하는 경우 정정 대상
   * occurrence(0-based). 미지정 시 0(첫 등장)으로 해석 — 구 backend 호환 및 중복 없는 trip 동작 보존.
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
  kind: 'boarding-prompt';
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
 * 취침모드 환승 알람 silent push payload (#2036 Issue I γ).
 *
 * 사용자 확정 flow: "환승역 → 분기 → 취침모드 시 알람 발사, 일반모드는 일반 상황과 동일".
 * 즉 취침모드에서 환승 임박 시 소리+진동+잠금화면 알림이 필요.
 *
 * 정책 (ADR-023 정합):
 *  - **Backend는 취침 무관 발사** (기존 arvlCd/vanish/lockless 발사기가 취침 상태 조회하지 않음).
 *  - **Device가 sleepMode=true 확인 후 발사 결정** (`SLEEP_MODE_KEY` AsyncStorage read).
 *  - **destination은 별 채널** — 기존 station-passed dedup으로 처리, 본 payload는 transfer 전용.
 *  - gate 무관 (location / silence / motion / dedup 모두 skip) — 도달률 우선. boarding-prompt와 같은 정책.
 *
 * Critical alert entitlement 없이 최대 UX 근사: `interruptionLevel: 'timeSensitive'` + `sound: 'alarm.wav'`
 * + `vibrateAlarm(sleepMode=true)`(반복 진동). Focus/DND 완전 우회는 Apple entitlement 승인 필요 — 별 track.
 *
 * dedup: `${tripToken}::${nextStation}` 조합 — 같은 hop의 backend cron 재시도만 차단, trip 안의 다른
 * 환승 hop(강남→성수→내방 같은 케이스)은 각각 발사.
 */
export interface SleepTransferAlarmSilentPushPayload {
  kind: 'sleep-transfer-alarm';
  /** 사용자가 지금 있는 역(환승 waypoint 도달 시점). 사용자 컨텍스트/dedup 기록용. */
  originStation: string;
  /** 환승 후 다음 leg의 노선. 알림 본문에 노출. */
  nextLine: string;
  /** 환승 후 첫 도착역. 알림 본문 + dedup key로 사용. */
  nextStation: string;
  /** trip 토큰 — dedup key. backend cron retry 차단용. */
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
  kind: 'trip-ended';
  reason: TripEndedReason;
  sentAt?: number;
  pushId?: string;
  /**
   * race 가드용 trip 식별자(#868 P1-2). backend가 보낸 trip의 token — 클라가 현재
   * ACTIVE_TRIP_KEY와 비교해 불일치 시 cleanup skip. 구버전 backend 호환을 위해 optional.
   */
  tripToken?: string;
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

/** extractPayload 결과 — standard silent push / reschedule / trip-ended / boarding-prompt / sleep-transfer-alarm. */
export type ExtractedPayload =
  | SilentPushPayload
  | RescheduleSilentPushPayload
  | TripEndedSilentPushPayload
  | BoardingPromptSilentPushPayload
  | SleepTransferAlarmSilentPushPayload;

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
 * #1337 — APNs alert payload 여부 판정.
 *
 * Swift `BackgroundEventTransformer`가 `aps.alert`를 동반한 push를 받으면
 * `taskData.data.notification`을 non-null로 채워 BG task에 전달한다(silent push는 null).
 * trip-ended는 #1337 PR1에서 silent→alert로 전환됐고, alert 수신 시 iOS가 시스템 banner를
 * 직접 표시하므로 디바이스가 `presentTripEndedNotification`을 추가 발사하면 중복이 된다.
 * 이 판정 함수는 surface skip 게이트 단일 출처(SSOT).
 *
 * Swift transformer 출력 위치는 `taskData.data.notification`(L202 기존 주석과 동일).
 */
function isAlertPayload(input: NotificationBackgroundTaskData): boolean {
  const data = asPlainObject(input.data);
  return data != null && data.notification != null;
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

function isSleepTransferAlarmCandidate(rec: Record<string, unknown>): boolean {
  return rec.kind === 'sleep-transfer-alarm';
}

function findFieldsLayer(
  taskData: NotificationBackgroundTaskData['data'],
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
    if (
      isStandardCandidate(rec) ||
      isRescheduleCandidate(rec) ||
      isTripEndedCandidate(rec) ||
      isBoardingPromptCandidate(rec) ||
      isSleepTransferAlarmCandidate(rec)
    ) {
      return rec;
    }
  }
  return null;
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
  // sleep-transfer-alarm 분기 (#2036 Issue I γ) — 취침 시 환승 알람. discriminator는 kind === 'sleep-transfer-alarm'.
  if (obj.kind === 'sleep-transfer-alarm') return extractSleepTransferAlarmPayload(obj);
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
  if (typeof etaSeconds !== 'number' || !Number.isFinite(etaSeconds)) return null;
  if (phase !== 'early' && phase !== 'imminent') return null;
  const validKind =
    kind === 'transfer' || kind === 'destination' || kind === 'intermediate' ? kind : undefined;
  return {
    nextWaypoint,
    etaSeconds,
    phase,
    kind: validKind,
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
 * backend는 lock-path fire에서만 wire하므로 누락/형식 오류는 undefined로 정규화 →
 * `fireWithGate`가 lock 없을 때 기존 보수 동작(non-intermediate skip)으로 fallback.
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
  const { nextStation, newArrivalTimeEpoch, trainCode, sentAt, pushId, channels, occurrenceIdx } =
    obj;
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
    channels: validChannels(channels),
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
 * payload.channels 검증. Array of 'bl'|'tba' 만 통과 — 그 외(누락/형식 오류/빈 배열)는 undefined로 정규화.
 * undefined 결과는 `resolveChannels`에서 `DEFAULT_RESCHEDULE_CHANNELS`로 fallback (구 backend 호환).
 */
function validChannels(value: unknown): ReadonlyArray<RescheduleChannel> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const filtered: RescheduleChannel[] = [];
  for (const v of value) {
    if (v === 'bl' || v === 'tba') filtered.push(v);
  }
  return filtered.length > 0 ? filtered : undefined;
}

/** 누락된 channels는 구 backend 호환 default(['bl'])로 해석. */
function resolveChannels(
  channels: ReadonlyArray<RescheduleChannel> | undefined,
): ReadonlyArray<RescheduleChannel> {
  return channels ?? DEFAULT_RESCHEDULE_CHANNELS;
}

/**
 * trip-ended payload 추출 (#868). schema 최소 — discriminator(kind)와 reason만.
 * reason이 known set에 없으면 'unknown'으로 정규화 (구버전 backend / 신규 reason 호환).
 */
function extractTripEndedPayload(
  obj: Record<string, unknown>,
): TripEndedSilentPushPayload | null {
  const { reason, sentAt, pushId, tripToken } = obj;
  return {
    kind: 'trip-ended',
    reason: normalizeTripEndedReason(reason),
    sentAt: validSentAt(sentAt),
    pushId: validPushId(pushId),
    tripToken: typeof tripToken === 'string' && tripToken.length > 0 ? tripToken : undefined,
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
 * sleep-transfer-alarm payload 추출 (#2036 Issue I γ). schema — kind + originStation + nextLine +
 * nextStation + tripToken은 필수. pushId / sentAt / title / body 는 optional (구 backend 호환).
 *
 * 필수 필드(originStation/nextLine/nextStation/tripToken) 중 하나라도 비어 있으면 null → 발사 skip.
 * 발사에 필요한 최소 정보(사용자 컨텍스트/dedup)를 갖추지 못한 payload는 backend 정상 wire 문제로
 * 판정 — device는 조용히 drop.
 */
function extractSleepTransferAlarmPayload(
  obj: Record<string, unknown>,
): SleepTransferAlarmSilentPushPayload | null {
  const { originStation, nextLine, nextStation, tripToken, pushId, sentAt, title, body } = obj;
  if (typeof originStation !== 'string' || originStation.length === 0) return null;
  if (typeof nextLine !== 'string' || nextLine.length === 0) return null;
  if (typeof nextStation !== 'string' || nextStation.length === 0) return null;
  if (typeof tripToken !== 'string' || tripToken.length === 0) return null;
  return {
    kind: 'sleep-transfer-alarm',
    originStation,
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

/**
 * #1323 — trip 종료 user-facing 알림 1회 present.
 *
 * backend trip-ended push는 silent(`content-available`)라 수신해도 알림이 뜨지 않는다.
 * cleanup/sentinel 직후 이 함수가 reason-gated 알림을 발사해 사용자가 종료를 인지하게 한다.
 *
 * dedup: 동일 pushId의 trip-ended push가 backend retry로 재도달하면 중복 present를 차단한다
 * (FIRED_PUSH_IDS 공유 — alert fallback dedup과 동일 store). pushId 부재(구버전 backend)면
 * dedup 없이 present — trip 종료는 1회성 이벤트라 회귀 위험이 낮고, 미표시가 더 나쁜 회귀다.
 *
 * 알림 발사 실패는 swallow — 측정/cleanup 흐름(호출자)을 차단하지 않는다.
 */
async function surfaceTripEnded(
  reason: TripEndedReason,
  pushId: string | undefined,
): Promise<void> {
  try {
    if (pushId && (await hasFiredPushId(pushId))) {
      logger.info(`trip-ended surface skip: pushId already surfaced ${pushId}`);
      return;
    }
    await sendTripEndedNotification(reason);
    if (pushId) await addFiredPushId(pushId);
  } catch (e) {
    logger.error('trip-ended surface 실패:', e);
  }
}

function validSentAt(sentAt: unknown): number | undefined {
  return typeof sentAt === 'number' && Number.isFinite(sentAt) ? sentAt : undefined;
}

function validPushId(pushId: unknown): string | undefined {
  return typeof pushId === 'string' && pushId.length > 0 ? pushId : undefined;
}

/**
 * 게이트 skip reason → alarmLog reason 매핑.
 * 1:1 매핑 — 다른 곳에서 재사용하지 않으므로 silentPushTask 내부에 둔다.
 */
function mapGateReason(reason: GateSkipReason): AlarmLogReason {
  switch (reason) {
    case 'unknown-station':
      return 'gate-unknown-station';
    case 'no-location':
      return 'gate-no-location';
    case 'stale-location':
      return 'gate-stale-location';
    case 'out-of-range':
      return 'gate-out-of-range';
    case 'line-mismatch':
      return 'gate-line-mismatch';
  }
}

/**
 * intermediate(중간역 통과) 알림 content. AlarmEvent 모델에 없는 종류라
 * buildAlarmContent를 못 쓰고 별도 i18n 키로 빌드한다.
 */
function buildIntermediateContent(stationName: string): { title: string; body: string } {
  // SILENT_PUSH_SOURCE=positionTrain은 #327 UX 정책상 자백 대상이 아님 → suffix 미부착.
  // shouldDiscloseNotificationSource이 false라 라벨 노이즈 회피.
  return {
    title: i18next.t('route.intermediatePassedTitle'),
    body: i18next.t('route.intermediatePassedBody', { name: stationName }),
  };
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
  // #735 — BG task 시간 제약. 모든 종료 경로(early return, fire-with-gate, error)에서 적재된
  // alarmLog pending이 OS suspend로 손실되지 않도록 try/finally로 명시 flush.
  try {
    if (input.error) {
      logger.error('silent push task error:', input.error.message);
      return;
    }

    payload = extractPayload(input.data);
    if (!payload) {
      logger.info('payload missing or invalid — skip');
      return;
    }
    const receivedAt = Date.now();
    addDomainBreadcrumb('push', 'silent-push', { kind: payload.kind ?? 'fire' });
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
    if (payload.kind === 'reschedule') {
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
    if (payload.kind === 'trip-ended') {
      // #1337 PR1 — backend가 alert payload(`aps.alert`)로 발사하면 iOS가 killed 앱에도
      // 시스템 banner를 직접 표시한다. 디바이스가 `presentTripEndedNotification`을 또 발사하면
      // 중복이 되므로 alert path에서는 surface를 skip한다(cleanup/sentinel/ack는 그대로).
      const isAlert = isAlertPayload(input);
      logger.info(
        `trip-ended received: reason=${payload.reason} tripToken=${payload.tripToken?.slice(0, 8) ?? 'unknown'} sentAt=${payload.sentAt ?? 'unknown'} pushId=${payload.pushId ?? 'unknown'} alert=${isAlert}`,
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
      await setTripEndedSentinel(receivedAt);
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
      // #1323 — trip 종료 user-facing surface. running/backgrounded 앱 backstop 경로.
      // #1337 PR1 — alert payload는 iOS가 시스템 banner를 직접 표시하므로 surface skip;
      // 단 동일 pushId의 silent backstop이 race로 도달해도 중복 surface 안 되도록 dedup store에는 기록.
      if (isAlert) {
        if (payload.pushId) await addFiredPushId(payload.pushId);
      } else {
        // backend가 모든 종료 경로(도착/환승 후 도착/eta-missing/만료)에서 동일 push를
        // 발사하므로, 여기서 reason-gated 알림 1회 present로 BG/취침/환승 종료를 모두 커버.
        // 동일 push 재전송(backend retry) 시 pushId 기준 dedup으로 중복 알림 차단.
        await surfaceTripEnded(payload.reason, payload.pushId);
      }
      void ackOutcome(payload.pushId, apnsToken, 'fired', `trip-ended:${payload.reason}`);
      return;
    }

    // boarding-prompt 분기 (#2028) — Layer 2 사용자 도달 채널. gate 무관 즉시 local notification schedule.
    //
    // 배경: backend는 boarding-prompt를 alert push로 발사하지만 사용자 Focus / DND / 취침 등으로
    // OS가 alert를 사용자에게 노출하지 않으면 boardingPrompt 응답률이 0% (7일 evidence). silent push
    // 채널로도 fallback을 받아 gate 무관 로컬 알림 schedule해 도달률을 확보한다.
    //
    // 정책: gate skip 없음 (location / silence / dedup 모두 우회). 사용자에게 UI 노출이 최우선 —
    // ADR-022 boardingPrompt 도달률 우선 정합. dedup은 tripToken 세션 스코프 in-memory Set으로
    // 관리해 backend cron 재시도(3회)의 중복 알림만 차단.
    if (payload.kind === 'boarding-prompt') {
      logger.info(
        `boarding-prompt received: originStation=${payload.originStation} line=${payload.line} tripToken=${payload.tripToken.slice(0, 8)} sentAt=${payload.sentAt ?? 'unknown'} pushId=${payload.pushId ?? 'unknown'}`,
      );
      await fireBoardingPromptLocalNotification(payload, apnsToken);
      return;
    }

    // sleep-transfer-alarm 분기 (#2036 Issue I γ) — 취침모드 환승 알람. gate 무관 로컬 알림 발사.
    //
    // 정책 (ADR-023 정합):
    //  - Backend는 취침 무관 발사 (기존 arvlCd/vanish 경로는 sleep 조회 없음).
    //  - Device가 `SLEEP_MODE_KEY` AsyncStorage read로 sleepMode=true 확인 후에만 발사.
    //  - sleepMode=false면 일반모드 = 기존 station-passed silent push가 처리 → 본 분기는 no-op skip.
    //  - dedup: `${tripToken}::${nextStation}` — 같은 hop의 backend cron retry 차단, trip 안 다른 환승 hop은 각각 발사.
    if (payload.kind === 'sleep-transfer-alarm') {
      logger.info(
        `sleep-transfer-alarm received: originStation=${payload.originStation} nextLine=${payload.nextLine} nextStation=${payload.nextStation} tripToken=${payload.tripToken.slice(0, 8)} sentAt=${payload.sentAt ?? 'unknown'} pushId=${payload.pushId ?? 'unknown'}`,
      );
      await fireSleepTransferAlarmLocalNotification(payload, apnsToken);
      return;
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

    try {
      await fireWithGate(
        payload as Required<Pick<SilentPushPayload, 'kind'>> & SilentPushPayload,
        apnsToken,
      );
    } catch (e) {
      logger.error('silent push fire 실패:', e);
    }
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
 * 해당 hop의 사전 예약을 cancel + 재예약한다. 본 함수는 SLA 게이트가 아니라 정정 신호이므로
 * 결과 무관 ack(`reschedule-received`)는 호출자가 처리한다.
 *
 * 사전 조건 누락(`lock`/`route`/`destination` 중 하나라도 없음, 또는 newArrivalTimeEpoch 과거)은
 * 모두 graceful no-op — 신호가 도달했어도 SLA를 깨지 않는다(원본 사전 예약 유지).
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
    // route/destination은 두 채널 모두 사용 — 한 번만 read.
    const [routeRaw, destRaw] = await Promise.all([
      AsyncStorage.getItem(ROUTE_KEY),
      AsyncStorage.getItem(DESTINATION_KEY),
    ]);
    const route = parseRoute(routeRaw);
    const destinationName = parseDestinationName(destRaw);
    if (!route || !destinationName) {
      logger.info(
        `reschedule skip: route=${route ? 'ok' : 'null'} destination=${destinationName ?? 'null'}`,
      );
      return;
    }
    const channels = resolveChannels(payload.channels);
    // bl 채널 — 기존 lock-기반 hop 정정. lock 부재/trainCode mismatch 시 graceful skip.
    if (channels.includes('bl')) {
      await applyRescheduleBl(payload, route, destinationName, receivedAt);
    }
    // tba 채널 (#918 A3 PR4) — lock-free trip-bound 사전 예약 정정.
    if (channels.includes('tba')) {
      await applyRescheduleTba(payload, route, destinationName, receivedAt);
    }
  } catch (e) {
    logger.error('reschedule apply 실패:', e);
  }
}

/**
 * bl(boarding-lock) 채널 정정 — lock + route + destination 필요. 사전 조건 미충족 시
 * graceful skip (정정 신호 폐기). tba 채널과 독립적으로 동작 — bl skip이 tba 정정을 막지 않는다.
 */
async function applyRescheduleBl(
  payload: RescheduleSilentPushPayload,
  route: NonNullable<Route>,
  destinationName: string,
  receivedAt: number,
): Promise<void> {
  const lock = await getBoardingLock();
  if (!lock) {
    logger.info('reschedule bl skip: no boarding lock');
    return;
  }
  if (lock.trainCode !== payload.trainCode) {
    logger.info(
      `reschedule bl skip: trainCode mismatch lock=${lock.trainCode} payload=${payload.trainCode}`,
    );
    return;
  }
  // #1355 D1 — cross-channel cancel: 같은 station+phase의 `tba:` 사전 예약 제거.
  // bl 채널이 정정 신호의 source-of-truth가 되므로 반대 채널의 stale 항목이 OS 큐에 잔존해
  // 같은 ETA에 중복 banner fire되는 회귀를 차단한다.
  for (const phase of ALARM_PHASES) {
    await cancelTbaByStationPhase(payload.nextStation, phase.id);
  }
  await rescheduleHopForLock({
    lock,
    route,
    destinationName,
    nextStation: payload.nextStation,
    newArrivalMs: payload.newArrivalTimeEpoch,
    now: receivedAt,
  });
}

/**
 * tba(trip-bound) 채널 정정 — lock 의존 없음. cross-channel `bl:` 사전 예약을 먼저 cleanup하고
 * `rescheduleTripBoundAlarm`에 위임한다.
 */
async function applyRescheduleTba(
  payload: RescheduleSilentPushPayload,
  route: NonNullable<Route>,
  destinationName: string,
  receivedAt: number,
): Promise<void> {
  // #1355 D1 — cross-channel cancel: 같은 station+phase의 `bl:` 사전 예약 제거.
  for (const phase of ALARM_PHASES) {
    await cancelBlByStationPhase(payload.nextStation, phase.id);
  }
  await rescheduleTripBoundAlarm({
    stationName: payload.nextStation,
    newArrivalMs: payload.newArrivalTimeEpoch,
    route,
    destinationName,
    now: receivedAt,
    // #1193 — 중복역 trip은 backend가 occurrenceIdx를 명시. 미지정 시 0(첫 등장).
    occurrenceIdx: payload.occurrenceIdx,
  });
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
 * #2034 — hop-end (환승역 하차) prompt 의 device fallback body. backend title/body 가 없을 때만
 * 사용. nextLine/nextStation 이 있으면 "다음: N호선 S 방면" 포함, 없으면 하차 안내만.
 */
function buildHopEndFallbackBody(payload: BoardingPromptSilentPushPayload): string {
  const from = `${payload.line}호선 ${payload.originStation}에서 내려주세요.`;
  if (!payload.nextLine) return from;
  const next = payload.nextStation
    ? `${payload.nextLine}호선 ${payload.nextStation}`
    : `${payload.nextLine}호선`;
  return `${from} 다음은 ${next} 방면입니다.`;
}

/**
 * #2028 — boarding-prompt silent push 수신 시 gate 무관 local notification schedule.
 *
 * 도달률 우선 — location / silence / motion / FIRED_ALARMS dedup 모두 skip. 사용자에게 UI가
 * 노출되지 않는 회귀가 gate false positive보다 크므로 무조건 발사.
 *
 * 유일한 dedup: tripToken 세션 스코프 in-memory Set. 같은 tripToken으로 backend cron 재시도
 * (3회)가 도달해도 로컬 알림 1건만 노출. 앱 재시작 시 자연 초기화되지만 backend가 사용자 응답
 * 후 재발사하지 않으므로 사용자 반복 노출 회귀 없음.
 *
 * data payload는 `useBoardingPromptResponder`가 `extractBoardingPromptPayload`로 파싱해
 * [탑승]/[미탑승]/banner tap 응답을 분기 처리. `categoryIdentifier: BOARDING_PROMPT_CATEGORY`로
 * 응답 액션 버튼을 노출 (iOS UNNotificationCategory 등록 필요 — `setupBoardingPromptCategory`).
 *
 * title/body는 backend payload에서 우선 사용 (backend가 사용자 locale로 i18n resolve).
 * 미지정 시 device fallback — "탑승하셨나요?" 정적 문자열. graceful — 어떤 값이 오든 알림 발사 보장.
 *
 * #2034 — hop-end (환승역 하차) 분기. payload.hopEndKind === 'disembark' 이면 title/body/dedup-key
 * 를 hop-end 시나리오로 분기. 응답 처리는 `useBoardingPromptResponder` 가 hopEndKind 필드로 분기.
 */
async function fireBoardingPromptLocalNotification(
  payload: BoardingPromptSilentPushPayload,
  apnsToken: string | null,
): Promise<void> {
  // dedup key — hop-end 는 leg 단위이므로 tripToken 만으로는 다중 환승을 놓친다. hopEndKind
  // 필드가 있으면 `${tripToken}|hop-end|${line}` 를 사용해 leg 별 dedup, 없으면 tripToken 그대로.
  const dedupKey = payload.hopEndKind === 'disembark'
    ? `${payload.tripToken}|hop-end|${payload.line}`
    : payload.tripToken;
  // tripToken (혹은 leg key) 세션 dedup — 이미 발사됐으면 skip. dedup 목적: backend cron 재시도(3회) 시 중복 방지.
  if (boardingPromptFiredTripTokens.has(dedupKey)) {
    logger.info(
      `boarding-prompt dedup: key=${dedupKey.slice(0, 24)} already fired in session — skip`,
    );
    void ackOutcome(payload.pushId, apnsToken, 'skipped', 'boarding-prompt-dedup');
    return;
  }

  // dedup 등록 먼저 — scheduleNotificationAsync 실패해도 재시도로 반복 발사되지 않도록.
  boardingPromptFiredTripTokens.add(dedupKey);

  // 사용자 표시 문구. backend 우선 → device fallback (backend가 locale resolve해서 넘겨줌).
  const isHopEnd = payload.hopEndKind === 'disembark';
  const fallbackTitle = isHopEnd
    ? `${payload.originStation}에서 하차하셨나요?`
    : '탑승하셨나요?';
  const fallbackBody = isHopEnd
    ? buildHopEndFallbackBody(payload)
    : `${payload.line}호선 ${payload.originStation}에서 열차가 곧 도착합니다.`;
  const title = payload.title ?? fallbackTitle;
  const body = payload.body ?? fallbackBody;

  // data payload는 `useBoardingPromptResponder`의 extractBoardingPromptPayload가 파싱하는 schema.
  // kind + originStation + line + tripToken 필수, destinationDirection + hopEndKind + nextLine + nextStation optional.
  const data: Record<string, unknown> = {
    kind: 'boarding-prompt',
    originStation: payload.originStation,
    line: payload.line,
    tripToken: payload.tripToken,
  };
  if (payload.destinationDirection !== undefined) {
    data.destinationDirection = payload.destinationDirection;
  }
  if (payload.hopEndKind !== undefined) {
    data.hopEndKind = payload.hopEndKind;
  }
  if (payload.nextLine !== undefined) {
    data.nextLine = payload.nextLine;
  }
  if (payload.nextStation !== undefined) {
    data.nextStation = payload.nextStation;
  }

  try {
    await Notifications.scheduleNotificationAsync({
      identifier: BOARDING_PROMPT_NOTIFICATION_ID,
      content: {
        title,
        body,
        sound: 'default',
        // BOARDING_PROMPT category로 [탑승]/[미탑승] 액션 버튼 노출 (setupBoardingPromptCategory 등록).
        categoryIdentifier: BOARDING_PROMPT_CATEGORY,
        data,
        // Focus / DND 관통 — 사용자 명시 의향 확인 UI라 timeSensitive 등급.
        interruptionLevel: 'timeSensitive',
      },
      trigger: null,
    });
    // #1021 Acceptance 채널 — Layer 2 발사 카운트가 dashboard에 반영되도록 적재.
    // useBoardingPromptDisplayLogger가 native alert push 발사분을 적재하는 것과 동일 채널이라
    // silent push fallback 발사분도 boarding-prompt fired 카운트에 누적된다.
    logBoardingPromptFired({
      originStation: payload.originStation,
      line: payload.line,
    });
    addDomainBreadcrumb('push', 'boarding-prompt-silent-fired', {
      line: payload.line,
      originStation: payload.originStation,
    });
    logger.info(
      `boarding-prompt fired: line=${payload.line} originStation=${payload.originStation} tripToken=${payload.tripToken.slice(0, 8)}`,
    );
    void ackOutcome(payload.pushId, apnsToken, 'fired', 'boarding-prompt');
  } catch (e) {
    logger.error('boarding-prompt local notification schedule 실패:', e);
    void ackOutcome(payload.pushId, apnsToken, 'skipped', 'boarding-prompt-schedule-failed');
  }
}

/**
 * #2036 (Issue I γ) — AsyncStorage에서 sleepMode 값 읽기 (BG-safe).
 *
 * silent push handler는 BG task라 zustand store 접근 불가 — AsyncStorage 직접 read.
 * `useSettingsStore.setSleepMode`가 JSON.stringify(boolean)으로 저장하므로 그대로 파싱.
 * 저장값 부재 / 파싱 실패는 false 반환 — 취침 아님으로 판정해 발사 skip (보수적).
 */
async function readSleepModeFromStorage(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(SLEEP_MODE_KEY);
    if (!raw) return false;
    return JSON.parse(raw) === true;
  } catch {
    return false;
  }
}

/**
 * #2036 (Issue I γ) — 취침모드 환승 알람 silent push 수신 시 로컬 알림 발사.
 *
 * 절차:
 *   1. sleepMode=false → 일반모드 = 기존 station-passed silent push가 이미 처리 → skip.
 *   2. dedup key(`${tripToken}::${nextStation}`) 확인 → 이미 발사 시 skip (backend cron retry 차단).
 *   3. dedup 등록 + Notifications.scheduleNotificationAsync 발사.
 *      - sound: 'alarm.wav' (loud, boarding-prompt의 'default'보다 강함)
 *      - interruptionLevel: 'timeSensitive' (Focus 관통, DND 부분 관통)
 *      - vibrateAlarm(true) — 반복 진동 (사용자 확정 flow: 소리+진동)
 *   4. 실패 시 dedup 유지 + ack skipped — cron retry가 재발사하지 않도록 함.
 *
 * gate 무관 (location / silence / motion / dedup 모두 skip) — boarding-prompt와 같은 도달률 우선 정책.
 * 사용자 확정 flow (`project_2026_07_03_user_manual_action_flow`): "환승역 → 취침 시 알람 발사".
 *
 * ADR-023 정합: backend는 취침 무관 발사, device가 필터 → 본 함수가 device 필터의 결정 지점.
 */
async function fireSleepTransferAlarmLocalNotification(
  payload: SleepTransferAlarmSilentPushPayload,
  apnsToken: string | null,
): Promise<void> {
  // sleepMode=false → 일반모드. 기존 경로가 처리 — 본 채널은 no-op.
  const sleepMode = await readSleepModeFromStorage();
  if (!sleepMode) {
    logger.info(
      `sleep-transfer-alarm skip: sleepMode=false (일반모드는 기존 station-passed 경로 처리)`,
    );
    void ackOutcome(payload.pushId, apnsToken, 'skipped', 'sleep-transfer-not-sleep-mode');
    return;
  }

  // dedup — tripToken + nextStation 조합. 같은 hop의 backend cron retry만 차단.
  const dedupKey = sleepTransferAlarmDedupKey(payload.tripToken, payload.nextStation);
  if (sleepTransferAlarmFiredKeys.has(dedupKey)) {
    logger.info(
      `sleep-transfer-alarm dedup: tripToken=${payload.tripToken.slice(0, 8)} nextStation=${payload.nextStation} already fired in session — skip`,
    );
    void ackOutcome(payload.pushId, apnsToken, 'skipped', 'sleep-transfer-dedup');
    return;
  }

  // dedup 등록 먼저 — scheduleNotificationAsync 실패해도 재시도로 반복 발사되지 않도록.
  sleepTransferAlarmFiredKeys.add(dedupKey);

  // 사용자 표시 문구. backend 우선 → device fallback.
  const title = payload.title ?? '곧 환승역입니다';
  const body =
    payload.body ??
    `${payload.originStation}에서 ${payload.nextLine}호선 ${payload.nextStation}으로 환승`;

  const data: Record<string, unknown> = {
    kind: 'sleep-transfer-alarm',
    originStation: payload.originStation,
    nextLine: payload.nextLine,
    nextStation: payload.nextStation,
    tripToken: payload.tripToken,
  };

  try {
    await Notifications.scheduleNotificationAsync({
      identifier: SLEEP_TRANSFER_ALARM_NOTIFICATION_ID,
      content: {
        title,
        body,
        // 취침모드 알람 — loud sound. 일반 알람과 동일한 파일(`stationNotification.ts:602`) 사용.
        sound: 'alarm.wav',
        data,
        // Focus 관통 (Sleep Focus 부분 관통). Critical alert entitlement 승인 시 'critical'로 승격 예정.
        interruptionLevel: 'timeSensitive',
      },
      trigger: null,
    });
    // 사용자 확정 flow: 소리+진동. sleepMode=true → repeat 진동.
    vibrateAlarm(true);
    // #2036 Acceptance dashboard — sleep-transfer-alarm fired 카운트.
    logSleepTransferAlarmFired({
      originStation: payload.originStation,
      nextStation: payload.nextStation,
      nextLine: payload.nextLine,
    });
    addDomainBreadcrumb('push', 'sleep-transfer-alarm-fired', {
      nextLine: payload.nextLine,
      originStation: payload.originStation,
      nextStation: payload.nextStation,
    });
    logger.info(
      `sleep-transfer-alarm fired: originStation=${payload.originStation} nextLine=${payload.nextLine} nextStation=${payload.nextStation} tripToken=${payload.tripToken.slice(0, 8)}`,
    );
    void ackOutcome(payload.pushId, apnsToken, 'fired', 'sleep-transfer-alarm');
  } catch (e) {
    logger.error('sleep-transfer-alarm local notification schedule 실패:', e);
    void ackOutcome(payload.pushId, apnsToken, 'skipped', 'sleep-transfer-schedule-failed');
  }
}

/**
 * 위치 게이트 통과 시 즉시 발사, 실패 시 logSilentPushSkipped.
 * kind/dedup/i18n을 한 곳에서 처리.
 */
async function fireWithGate(
  payload: SilentPushPayload & { kind: NonNullable<SilentPushPayload['kind']> },
  apnsToken: string | null,
): Promise<void> {
  // #1399 — 좀비 알림 cleanup. backend가 push 발사 시점에 stamp한 active trip token이 device의
  // ACTIVE_TRIP_KEY와 mismatch면 만료 token push로 판정해 drop. 시나리오: backend vanish + GPS
  // 동결 + 트립 종료 → 종료 push 도착 → device cleanup → 지상 재진입 후 OS queue/네트워크에 잔존
  // 하던 stale silent push가 늦게 도착해도 ACTIVE_TRIP_KEY가 null 또는 다른 token이면 발사 차단
  // (S8 14:19 회귀). 구 backend(payload.tripToken 누락) 호환 — undefined면 가드 skip.
  if (payload.tripToken !== undefined) {
    const activeTripToken = await AsyncStorage.getItem(ACTIVE_TRIP_KEY);
    if (activeTripToken === null || activeTripToken !== payload.tripToken) {
      const logKind = payload.kind === 'intermediate' ? 'station-passed' : payload.kind;
      logSilentPushSkipped({
        stationName: payload.nextWaypoint,
        kind: logKind,
        phaseId: payload.phase,
        reason: 'trip-token-mismatch',
      });
      void ackOutcome(payload.pushId, apnsToken, 'skipped', 'trip-token-mismatch');
      logger.info(
        `trip-token mismatch skip: payload=${payload.tripToken.slice(0, 8)} active=${activeTripToken?.slice(0, 8) ?? 'null'} station=${payload.nextWaypoint}`,
      );
      return;
    }
  }

  // #707/#1322: line sanity-guard. nextWaypoint가 boarding 노선에 정차하는지 검증한다.
  // 노선 출처는 (1) 로컬 BoardingLock, 또는 (2) #1322 — backend lock-path fire가 실어 보낸
  // payload.boardingLine (지하 auto-lock hydration window 등으로 로컬 lock이 없는 경우).
  // 환승역 등에서 같은 nextWaypoint name이 여러 line stop을 가질 수 있다 — stations.json 매칭으로
  // 다른 line stop만 존재하면 다른 leg/노선의 silent push로 판정해 차단.
  // station name 자체가 stations.json에 없으면 line 가드는 통과시키고 일반 게이트의 unknown-station로 위임.
  const lock = await getBoardingLock();
  // guardLine 출처가 로컬 lock(LineNumber)이거나 wire payload(string)라 타입은 string으로 합쳐진다.
  // findStationByNameAndLine은 `s.line === line` 엄격 비교라 LineNumber가 아닌 임의 문자열은
  // 어떤 station에도 매칭되지 않아 안전하게 no-match(null)된다 → LineNumber로 좁혀도 무해.
  const guardLine = (lock ? lock.boardingLine : payload.boardingLine) as LineNumber | undefined;
  if (guardLine !== undefined) {
    const onBoardingLine = findStationByNameAndLine(payload.nextWaypoint, guardLine);
    if (!onBoardingLine && findStationByName(payload.nextWaypoint)) {
      const logKind = payload.kind === 'intermediate' ? 'station-passed' : payload.kind;
      logSilentPushSkipped({
        stationName: payload.nextWaypoint,
        kind: logKind,
        phaseId: payload.phase,
        reason: 'lock-line-mismatch',
      });
      void ackOutcome(payload.pushId, apnsToken, 'skipped', 'lock-line-mismatch');
      logger.info(
        `lock line mismatch skip: nextWaypoint=${payload.nextWaypoint} boardingLine=${guardLine}`,
      );
      return;
    }
    // #1322 — 로컬 lock 없이 payload.boardingLine만으로 통과한 경우: backend가 train을 선택해
    // 발사한 lock-path push이므로 authoritative. lockless opt-in 토글은 lock 없는 trip 전용이라
    // 적용하지 않고(backend lock 보유) line 가드 통과 후 바로 위치/movement 게이트로 진행한다.
  } else {
    // #1810 — paradigm shift Phase 1+2: 사용자 명시 의향(lock 활성)만 알림.
    // lockless trip에서는 station-passed silent push를 항상 skip.
    logSilentPushSkipped({
      stationName: payload.nextWaypoint,
      kind: 'station-passed',
      phaseId: payload.phase,
      reason: 'lockless-opt-out',
    });
    void ackOutcome(payload.pushId, apnsToken, 'skipped', 'lockless-opt-out');
    logger.info(`lockless skip (paradigm shift #1810): station=${payload.nextWaypoint}`);
    return;
  }

  // #1572 (T9, ADR-017) — backend SSoT 권위 게이트 (Path E silent push). BG 경로가 backend가
  // 이미 결정한 alarmId/stationId를 재발사하는 회귀 차단. lock/lockless 분기 통과 후 dismiss silence
  // 게이트 진입 직전 평가 — silence/위치/movement 게이트 전에 위치해 가장 강한 권위 정책 적용.
  // intermediate payload는 'station-passed'로 매핑(device convention과 일치). fireWithGate signature
  // 가 payload.kind NonNullable 강제 — undefined 케이스 없음.
  const ssotGateKind: 'station-passed' | 'transfer' | 'destination' | 'imminent' =
    payload.kind === 'intermediate' ? 'station-passed' : payload.kind;
  const ssotGateOutcome = await evaluateSsotFireGate({
    alarmId: `${ssotGateKind}:${payload.nextWaypoint}`,
    stationId: payload.nextWaypoint,
    type: ssotGateKind,
  });
  if (ssotGateOutcome.blocked) {
    const logKind = payload.kind === 'intermediate' ? 'station-passed' : payload.kind;
    const reason = ssotGateOutcome.reason as
      | 'gate-alarm-already-decided'
      | 'gate-station-already-passed';
    logSilentPushSkipped({
      stationName: payload.nextWaypoint,
      kind: logKind,
      phaseId: payload.phase,
      reason,
    });
    void ackOutcome(payload.pushId, apnsToken, 'skipped', reason);
    logger.info(`SSoT fire gate skip reason=${reason} station=${payload.nextWaypoint}`);
    return;
  }

  // #746 — dismiss silence 게이트. BG path는 좌표 신뢰성이 낮아 시간 조건만 평가
  //   (currentPosition=null). lock/lockless 분기 통과 후 위치 게이트보다 위에 위치해
  //   사용자 정책이 데이터 정확성보다 우선되도록 한다.
  const dismissSilenceState = await getDismissSilence();
  const silenceDecision = evaluateDismissSilence(dismissSilenceState, Date.now(), null);
  if (!silenceDecision.silenced && silenceDecision.expired) {
    await clearDismissSilence();
  }
  if (silenceDecision.silenced) {
    const logKind = payload.kind === 'intermediate' ? 'station-passed' : payload.kind;
    logSilentPushSkipped({
      stationName: payload.nextWaypoint,
      kind: logKind,
      phaseId: payload.phase,
      reason: 'dismiss-silence',
    });
    void ackOutcome(payload.pushId, apnsToken, 'skipped', 'dismiss-silence');
    logger.info(`dismiss-silence skip: station=${payload.nextWaypoint}`);
    return;
  }

  // #1209 D3 — lockless 경로는 sticky station 좌표 drift 수용 위해 widened 임계값 사용.
  // #1273 D3 — payloadHopIndex는 백엔드 silent push payload의 절대 시퀀스 SSOT. wire.
  // currentHopIndex는 D1(#1207) hop estimator 미연결 단계라 undefined — 둘 중 하나라도
  // 없으면 gate가 거리 기반 widened fallback 경로로 동작한다.
  // #1307 — subsurface는 server flag(payload.subsurface)를 우선하고, 부재 시 디바이스
  // 로컬 stamp로 fallback한다. server flag가 이겨야 FG-only stamp가 BG에서 stale 되어도
  // 지하 intermediate 우회가 동작한다.
  const subsurface = payload.subsurface ?? (await getSubsurfaceState());
  // #1365 — estimatorLine. lock 활성 시 lock.boardingLine을 신뢰(사용자 명시 탭). lock 부재 시
  // 디바이스에 결정적 line SSOT가 없으므로 undefined — gate cross-check 자연 skip(graceful).
  // 추후 lockless도 fusion result line이 BG로 전파되면 그 값을 사용.
  const estimatorLine = lock?.boardingLine;
  const gate = await checkSilentPushLocationGate({
    stationName: payload.nextWaypoint,
    kind: payload.kind,
    phase: payload.phase,
    isLockless: !lock,
    payloadHopIndex: payload.hopIndex,
    subsurface,
    occupiedLine: payload.occupiedLine,
    estimatorLine,
  });

  if (!gate.pass) {
    const reason = mapGateReason(gate.reason!);
    logSilentPushSkipped({
      stationName: payload.nextWaypoint,
      kind: payload.kind === 'intermediate' ? 'station-passed' : payload.kind,
      phaseId: payload.phase,
      reason,
      distanceM: gate.distanceM,
      thresholdM: gate.thresholdM,
      locationSource: gate.locationSource,
      locationAgeMs: gate.locationAgeMs,
    });
    void ackOutcome(payload.pushId, apnsToken, 'skipped', reason);
    logger.info(`gate skip reason=${gate.reason} distance=${gate.distanceM ?? '-'}`);
    // #1356 E1 — silent fire가 suppress되는 동안 같은 station의 사전 예약(`tba:`/`bl:`)도 OS queue
    // 에서 cancel. backend는 정적/out-of-range를 인식해 다음 silent push를 발사하지 않지만, OS queue에
    // 잔존한 사전 예약은 시간이 되면 자체 발사 → stale "다음 역" 알람. nextWaypoint/phase는 본 분기
    // 에서 항상 존재(SilentPushPayload 필수 필드).
    await cancelTbaByStationPhase(payload.nextWaypoint, payload.phase);
    await cancelBlByStationPhase(payload.nextWaypoint, payload.phase);
    return;
  }

  // #727 — 정적 misfire 가드. gate는 거리/freshness만 검증하지만 사용자가 정적이면 잘못된
  // trainCode/fusion lock으로 잘못 발사될 수 있다. expo-location LocationObject의 speed/
  // accuracy가 있으면 평가 — 미측정(`speed === -1` 등)이면 skip하고 graceful pass.
  // #728 — CMMotionActivity motion=stationary 신호 동시 적용. BG에선 hook 못쓰니 직접 호출 — native
  // module이 startUpdates된 상태(FG에서 useMotionActivity가 시작)에서 latest cache된 값을 반환.
  // 권한 미부여/미지원/native fault 시 false → 기존 가드만 동작 (graceful fallback).
  const motionStationary = getCurrentMotionStationary();
  const movement = evaluateMovement(
    {
      speedMps: gate.speedMps,
      accuracyM: gate.accuracyM,
    },
    undefined,
    undefined,
    motionStationary,
  );
  if (!movement.reliable && movement.reason) {
    const movementReason = MOVEMENT_TO_ALARM_LOG_REASON[movement.reason];
    logSilentPushSkipped({
      stationName: payload.nextWaypoint,
      kind: payload.kind === 'intermediate' ? 'station-passed' : payload.kind,
      phaseId: payload.phase,
      reason: movementReason,
      distanceM: gate.distanceM,
      thresholdM: gate.thresholdM,
      locationSource: gate.locationSource,
      locationAgeMs: gate.locationAgeMs,
    });
    void ackOutcome(payload.pushId, apnsToken, 'skipped', movementReason);
    logger.info(
      `movement skip: reason=${movementReason} speed=${gate.speedMps ?? '-'} accuracy=${gate.accuracyM ?? '-'}`,
    );
    // #1356 E1 — motion=stationary suppress 동안 같은 station 사전 예약도 cancel. (gate 분기와 동일 의도)
    await cancelTbaByStationPhase(payload.nextWaypoint, payload.phase);
    await cancelBlByStationPhase(payload.nextWaypoint, payload.phase);
    return;
  }

  // FIRED_ALARMS dedup — destination scope. intermediate는 dedup 대상 아님(통과는 1회성).
  // dedup 키는 alarmKey({phaseId, stationName, occurrenceIdx}) — FG GPS·OS scheduled fire와 동일
  // 출처 공유. #1367 — payload.hopIndex로 같은 stationName이 route에 중복 등장하는 trip에서
  // hop별 dedup이 collide하지 않도록 occurrenceIdx로 분리. backend가 hopIndex를 보내지 않는 구
  // 호환 분기는 occurrenceIdx=0 (legacy 동작 보존).
  const destinationId = await loadDestinationId();
  const dedupKey =
    payload.kind === 'intermediate'
      ? null
      : alarmKey({
          phaseId: payload.phase,
          stationName: payload.nextWaypoint,
          occurrenceIdx: payload.hopIndex ?? 0,
        });

  if (dedupKey && destinationId) {
    const fired = await getFiredAlarms(destinationId);
    if (fired.has(dedupKey)) {
      // 다른 채널(FG GPS 등)이 이미 발사 — backend 입장에선 fallback 불필요. ACK로 정리.
      void ackOutcome(payload.pushId, apnsToken, 'skipped', 'dedup-already-fired');
      // P2e — 동일 pushId의 alert가 race로 도달하면 FG에서 중복 표시 차단되도록 기록.
      if (payload.pushId) void addFiredPushId(payload.pushId);
      logger.info(`dedup: ${dedupKey} already fired — skip`);
      return;
    }
    fired.add(dedupKey);
    await setFiredAlarms(destinationId, fired);
  }

  // #1901/#1900 (RC-7/RC-10a) — channel-agnostic 8분 backstop. FIRED_ALARMS dedup은
  // `phaseId + stationName + hopIndex` 기반이라 backend가 같은 station-pass 1건에 silent state
  // push + LA dirty update 2채널을 발사하거나 phase만 다른 cross-channel 중복을 통과시킨다.
  // (lastFire) Map은 FG fireAndLog / stationPipeline 모두에서 markStationFired로 적재되므로
  // 본 게이트가 silent push도 station-level 8분 backstop으로 cross-channel 중복을 차단한다.
  // intermediate(station-passed) 분기는 dedupKey=null이라 destinationId만으로도 보호 필요 —
  // intermediate도 같은 station 8분 차 cross-channel 중복 evidence(2026-06-26 trip-3 동대문역사문화공원).
  const channelAgnosticKind: 'destination' | 'transfer' | 'station-passed' =
    payload.kind === 'intermediate' ? 'station-passed' : payload.kind;
  if (
    destinationId &&
    isAnyChannelRecentlyFired(
      destinationId,
      payload.nextWaypoint,
      channelAgnosticKind,
      Date.now(),
      payload.phase,
    )
  ) {
    logSuppressedChannelAgnosticDedup({
      source: 'silent-push-skipped',
      stationName: payload.nextWaypoint,
      kind: channelAgnosticKind,
      phaseId: payload.phase,
    });
    void ackOutcome(payload.pushId, apnsToken, 'skipped', 'dedup-already-fired');
    if (payload.pushId) void addFiredPushId(payload.pushId);
    logger.info(
      `dedup channel-agnostic: ${payload.nextWaypoint} fired within 8m — skip`,
    );
    return;
  }

  const content =
    payload.kind === 'intermediate'
      ? buildIntermediateContent(payload.nextWaypoint)
      : buildAlarmContent(
          {
            phaseId: payload.phase,
            type: payload.kind,
            stationName: payload.nextWaypoint,
          } as AlarmEvent,
          SILENT_PUSH_SOURCE,
        );

  await Notifications.scheduleNotificationAsync({
    content: { title: content.title, body: content.body },
    trigger: null,
  });

  // #1901/#1900 (RC-7/RC-10a) — channel-agnostic dedup window 갱신. silent push fire를 lastFire
  // Map에 적재해 후속 FG fireAndLog / stationPipeline 발사가 같은 station+kind+phase 8분 backstop
  // 으로 차단됨. intermediate는 'station-passed' 카테고리로 마킹(기존 cross-category dedup 의미 유지).
  // phaseId(payload.phase)도 stamp해 정상 phase 진행은 통과시킴.
  if (destinationId) {
    markStationFired(
      destinationId,
      payload.nextWaypoint,
      channelAgnosticKind,
      Date.now(),
      payload.phase,
    );
  }

  logSilentPushFired({
    stationName: payload.nextWaypoint,
    kind: payload.kind === 'intermediate' ? 'station-passed' : payload.kind,
    phaseId: payload.phase,
    distanceM: gate.distanceM!,
    thresholdM: gate.thresholdM!,
    locationSource: gate.locationSource!,
    locationAgeMs: gate.locationAgeMs!,
  });
  void ackOutcome(payload.pushId, apnsToken, 'fired');
  // P2e — alert fallback이 race로 도달해도 FG에서 중복 표시 차단되도록 기록.
  if (payload.pushId) void addFiredPushId(payload.pushId);
  logger.info(
    `fired: kind=${payload.kind} phase=${payload.phase} station=${payload.nextWaypoint} distance=${gate.distanceM}m`,
  );
}

/**
 * AsyncStorage에서 destination.id만 안전하게 꺼낸다.
 * 파싱 실패/구조 손상 시 null — dedup 건너뜀(발사는 진행).
 */
async function loadDestinationId(): Promise<string | null> {
  try {
    const json = await AsyncStorage.getItem(DESTINATION_KEY);
    if (!json) return null;
    const parsed = JSON.parse(json) as Partial<Station> | null;
    return parsed && typeof parsed.id === 'string' ? parsed.id : null;
  } catch {
    return null;
  }
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
