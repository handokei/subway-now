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
import AsyncStorage from '@react-native-async-storage/async-storage';
import i18next from 'i18next';
import type { Station } from '../types/station';
import {
  APNS_TOKEN_KEY,
  DESTINATION_KEY,
  LOCKLESS_STATION_PASSED_KEY,
} from '../constants/storageKeys';
import { sendPushAck } from '../api/alarmBackend';
import { createLogger } from '../utils/logger';
import {
  flushAlarmLog,
  logSilentPushReceived,
  logSilentPushRescheduleReceived,
  logSilentPushFired,
  logSilentPushSkipped,
  type AlarmLogReason,
} from '../utils/alarmLog';
import { evaluateDismissSilence } from '../utils/dismissSilenceGate';
import { clearDismissSilence, getDismissSilence } from '../utils/dismissSilenceStorage';
import { evaluateMovement, MOVEMENT_TO_ALARM_LOG_REASON } from '../utils/movementGate';
import { getCurrentMotionStationary } from '../utils/motionActivity';
import { addFiredPushId } from '../utils/firedPushIds';
import {
  checkSilentPushLocationGate,
  type GateSkipReason,
} from '../utils/silentPushLocationGate';
import { alarmKey, type AlarmEvent } from '../utils/stationAlarm';
import { buildAlarmContent } from '../utils/stationNotification';
import { type NotificationSource } from '../utils/notificationSource';
import { getFiredAlarms, setFiredAlarms } from '../utils/notificationState';
import { getBoardingLock } from '../utils/boardingLockStorage';
import { findStationByName, findStationByNameAndLine } from '../utils/stationLookup';

// silent push는 서버가 train data 기반으로 발사하므로 라벨도 'positionTrain'으로 고정.
// 향후 GPS 게이트 경로 등 다른 출처가 생기면 인자화 한다.
const SILENT_PUSH_SOURCE: NotificationSource = 'positionTrain';

const logger = createLogger('SilentPushTask');

export const SILENT_PUSH_TASK = 'silent-push-reschedule';

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
}

/**
 * Reschedule silent push payload (#725). 백엔드 `sendReschedulePush`가 일반 silent push와
 * 다른 schema(`nextStation` / `newArrivalTimeEpoch` / `trainCode`)를 보낸다 — 별도 인터페이스로
 * 모델링하고 `kind: 'reschedule'`을 discriminator로 사용해 union narrowing.
 */
export interface RescheduleSilentPushPayload {
  kind: 'reschedule';
  nextStation: string;
  newArrivalTimeEpoch: number;
  trainCode: string;
  sentAt?: number;
  pushId?: string;
}

/** extractPayload 결과 — standard silent push 또는 reschedule push. */
export type ExtractedPayload = SilentPushPayload | RescheduleSilentPushPayload;

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
    if (isStandardCandidate(rec) || isRescheduleCandidate(rec)) return rec;
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
  return extractStandardPayload(obj);
}

function extractStandardPayload(obj: Record<string, unknown>): SilentPushPayload | null {
  // extractPayload가 obj.kind === 'reschedule' 분기를 먼저 처리하므로 여기 도달했다는 것은
  // standard 경로. findFieldsLayer는 isStandardCandidate(nextWaypoint non-empty) 또는
  // isRescheduleCandidate(kind='reschedule') 중 하나로 통과시키지만, kind='reschedule'
  // 케이스는 위 분기에서 잡혔으므로 잔여 케이스는 isStandardCandidate가 보증한 것 — nextWaypoint 보장.
  const { nextWaypoint, etaSeconds, phase, kind, sentAt, pushId } = obj as {
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
  };
}

function extractReschedulePayload(
  obj: Record<string, unknown>,
): RescheduleSilentPushPayload | null {
  const { nextStation, newArrivalTimeEpoch, trainCode, sentAt, pushId } = obj;
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
  };
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
 * 백엔드 P2c fallback에서 이 push가 alert로 재발사되지 않도록 처리 결과를 통보한다 (#568 P2b).
 * fire-and-forget — 실패해도 silent push 본 처리 흐름에는 영향 없음.
 * 누락 입력(pushId/token 중 하나라도 null/undefined)은 그대로 skip한다:
 *   - pushId 누락 = 구 백엔드 호환 경로
 *   - token 누락 = APNs 권한 미부여/저장 실패
 */
function ackOutcome(
  pushId: string | undefined,
  token: string | null,
  outcome: 'fired' | 'skipped',
  reason?: string,
): void {
  if (!pushId || !token) return;
  void sendPushAck({ pushId, token, outcome, reason });
}

async function loadApnsToken(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(APNS_TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * #816 C — 사용자 토글 (lockless station-passed opt-in) 현재값을 AsyncStorage에서 읽는다.
 * BG task에서는 zustand store에 접근 불가하므로 useAppStore.setLocklessStationPassed가
 * 기록한 키를 직접 read. 값이 없거나 파싱 실패면 OFF(false) — default 보수적.
 */
async function loadLocklessOptIn(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(LOCKLESS_STATION_PASSED_KEY);
    if (!raw) return false;
    return JSON.parse(raw) === true;
  } catch {
    return false;
  }
}

/**
 * Task 콜백 본체 — 단위 테스트가 직접 호출할 수 있도록 export.
 */
export async function handleSilentPush(input: NotificationBackgroundTaskData): Promise<void> {
  // #735 — BG task 시간 제약. 모든 종료 경로(early return, fire-with-gate, error)에서 적재된
  // alarmLog pending이 OS suspend로 손실되지 않도록 try/finally로 명시 flush.
  try {
    if (input.error) {
      logger.error('silent push task error:', input.error.message);
      return;
    }

    const payload = extractPayload(input.data);
    if (!payload) {
      logger.info('payload missing or invalid — skip');
      return;
    }
    const receivedAt = Date.now();
    const apnsToken = await loadApnsToken();

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
      ackOutcome(payload.pushId, apnsToken, 'fired', 'reschedule-received');
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

    // kind 미상은 발사 불가 — 알림 본문/dedup 키 결정 불가. 구 백엔드 호환은 received 로그에만.
    if (!payload.kind) {
      logSilentPushSkipped({
        stationName: payload.nextWaypoint,
        kind: undefined,
        phaseId: payload.phase,
        reason: 'payload-missing-kind',
      });
      ackOutcome(payload.pushId, apnsToken, 'skipped', 'payload-missing-kind');
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
    // pending 강제 flush — debounce timer 만료를 기다리면 BG task 종료 후라 손실.
    await flushAlarmLog();
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
  // #707: BoardingLock 활성 시 nextWaypoint가 lock.boardingLine에 정차하는지 검증.
  // 백엔드 SilentPushPayload(alarm-worker/src/apns.ts)는 line/expectedLine 필드를 보내지 않으므로
  // 환승역 등에서 같은 nextWaypoint name이 여러 line stop을 가질 수 있다 — stations.json 매칭으로
  // 다른 line stop만 존재하면 다른 leg/노선의 silent push로 판정해 차단.
  // station name 자체가 stations.json에 없으면 line 가드는 통과시키고 일반 게이트의 unknown-station로 위임.
  const lock = await getBoardingLock();
  if (lock) {
    const onBoardingLine = findStationByNameAndLine(payload.nextWaypoint, lock.boardingLine);
    if (!onBoardingLine && findStationByName(payload.nextWaypoint)) {
      const logKind = payload.kind === 'intermediate' ? 'station-passed' : payload.kind;
      logSilentPushSkipped({
        stationName: payload.nextWaypoint,
        kind: logKind,
        phaseId: payload.phase,
        reason: 'lock-line-mismatch',
      });
      ackOutcome(payload.pushId, apnsToken, 'skipped', 'lock-line-mismatch');
      logger.info(
        `lock line mismatch skip: nextWaypoint=${payload.nextWaypoint} boardingLine=${lock.boardingLine}`,
      );
      return;
    }
  } else {
    // #816 C — lock 없는 trip의 lockless 분기.
    // backend가 lockless trip의 station-passed(intermediate)만 발사하지만, race로 transfer/destination이
    // 도착하거나 토글 OFF로 변경된 직후의 push가 도달할 수 있어 client에서 추가 가드.
    //   1) intermediate가 아니면 skip (trainCode 없이 알람 위치 보장 불가)
    //   2) 토글 OFF면 skip (사용자 명시 동의 부재 → #640 회귀 차단)
    // 둘 다 통과하면 line 가드 우회하고 일반 위치/movement 게이트로 진행.
    if (payload.kind !== 'intermediate') {
      logSilentPushSkipped({
        stationName: payload.nextWaypoint,
        kind: payload.kind,
        phaseId: payload.phase,
        reason: 'lockless-non-intermediate',
      });
      ackOutcome(payload.pushId, apnsToken, 'skipped', 'lockless-non-intermediate');
      logger.info(
        `lockless skip non-intermediate: kind=${payload.kind} station=${payload.nextWaypoint}`,
      );
      return;
    }
    const optedIn = await loadLocklessOptIn();
    if (!optedIn) {
      logSilentPushSkipped({
        stationName: payload.nextWaypoint,
        kind: 'station-passed',
        phaseId: payload.phase,
        reason: 'lockless-opt-out',
      });
      ackOutcome(payload.pushId, apnsToken, 'skipped', 'lockless-opt-out');
      logger.info(`lockless skip opt-out: station=${payload.nextWaypoint}`);
      return;
    }
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
    ackOutcome(payload.pushId, apnsToken, 'skipped', 'dismiss-silence');
    logger.info(`dismiss-silence skip: station=${payload.nextWaypoint}`);
    return;
  }

  const gate = await checkSilentPushLocationGate({
    stationName: payload.nextWaypoint,
    kind: payload.kind,
    phase: payload.phase,
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
    ackOutcome(payload.pushId, apnsToken, 'skipped', reason);
    logger.info(`gate skip reason=${gate.reason} distance=${gate.distanceM ?? '-'}`);
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
    ackOutcome(payload.pushId, apnsToken, 'skipped', movementReason);
    logger.info(
      `movement skip: reason=${movementReason} speed=${gate.speedMps ?? '-'} accuracy=${gate.accuracyM ?? '-'}`,
    );
    return;
  }

  // FIRED_ALARMS dedup — destination scope. intermediate는 dedup 대상 아님(통과는 1회성).
  // dedup 키는 alarmKey({phaseId, stationName}) — FG GPS 발화와 동일 출처 공유.
  const destinationId = await loadDestinationId();
  const dedupKey =
    payload.kind === 'intermediate'
      ? null
      : alarmKey({ phaseId: payload.phase, stationName: payload.nextWaypoint });

  if (dedupKey && destinationId) {
    const fired = await getFiredAlarms(destinationId);
    if (fired.has(dedupKey)) {
      // 다른 채널(FG GPS 등)이 이미 발사 — backend 입장에선 fallback 불필요. ACK로 정리.
      ackOutcome(payload.pushId, apnsToken, 'skipped', 'dedup-already-fired');
      // P2e — 동일 pushId의 alert가 race로 도달하면 FG에서 중복 표시 차단되도록 기록.
      if (payload.pushId) void addFiredPushId(payload.pushId);
      logger.info(`dedup: ${dedupKey} already fired — skip`);
      return;
    }
    fired.add(dedupKey);
    await setFiredAlarms(destinationId, fired);
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

  logSilentPushFired({
    stationName: payload.nextWaypoint,
    kind: payload.kind === 'intermediate' ? 'station-passed' : payload.kind,
    phaseId: payload.phase,
    distanceM: gate.distanceM!,
    thresholdM: gate.thresholdM!,
    locationSource: gate.locationSource!,
    locationAgeMs: gate.locationAgeMs!,
  });
  ackOutcome(payload.pushId, apnsToken, 'fired');
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
