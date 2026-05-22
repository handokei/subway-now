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
import { DESTINATION_KEY } from '../constants/storageKeys';
import { createLogger } from '../utils/logger';
import {
  logSilentPushReceived,
  logSilentPushFired,
  logSilentPushSkipped,
  type AlarmLogReason,
} from '../utils/alarmLog';
import {
  checkSilentPushLocationGate,
  type GateSkipReason,
} from '../utils/silentPushLocationGate';
import { alarmKey, type AlarmEvent } from '../utils/stationAlarm';
import { buildAlarmContent } from '../utils/stationNotification';
import { getFiredAlarms, setFiredAlarms } from '../utils/notificationState';

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
}

interface NotificationBackgroundTaskData {
  data?: {
    notification?: {
      data?: Record<string, unknown>;
      request?: { content?: { data?: Record<string, unknown> } };
    };
  };
  error?: { message: string } | null;
}

/**
 * 알림 raw payload → 검증된 SilentPushPayload.
 */
export function extractPayload(
  data: NotificationBackgroundTaskData['data'],
): SilentPushPayload | null {
  const notif = data?.notification;
  if (!notif) return null;
  const raw = notif.data ?? notif.request?.content?.data;
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const { nextWaypoint, etaSeconds, phase, kind, sentAt } = obj;
  if (typeof nextWaypoint !== 'string' || nextWaypoint.length === 0) return null;
  if (typeof etaSeconds !== 'number' || !Number.isFinite(etaSeconds)) return null;
  if (phase !== 'early' && phase !== 'imminent') return null;
  const validKind =
    kind === 'transfer' || kind === 'destination' || kind === 'intermediate' ? kind : undefined;
  const validSentAt =
    typeof sentAt === 'number' && Number.isFinite(sentAt) ? sentAt : undefined;
  return { nextWaypoint, etaSeconds, phase, kind: validKind, sentAt: validSentAt };
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
  return {
    title: i18next.t('route.intermediatePassedTitle'),
    body: i18next.t('route.intermediatePassedBody', { name: stationName }),
  };
}

/**
 * Task 콜백 본체 — 단위 테스트가 직접 호출할 수 있도록 export.
 */
export async function handleSilentPush(input: NotificationBackgroundTaskData): Promise<void> {
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
  logger.info(
    `received: kind=${payload.kind ?? 'unknown'} phase=${payload.phase} station=${payload.nextWaypoint} eta=${payload.etaSeconds} sentAt=${payload.sentAt ?? 'unknown'}`,
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
    logger.info('kind missing — skip fire');
    return;
  }

  try {
    await fireWithGate(payload as Required<Pick<SilentPushPayload, 'kind'>> & SilentPushPayload);
  } catch (e) {
    logger.error('silent push fire 실패:', e);
  }
}

/**
 * 위치 게이트 통과 시 즉시 발사, 실패 시 logSilentPushSkipped.
 * kind/dedup/i18n을 한 곳에서 처리.
 */
async function fireWithGate(
  payload: SilentPushPayload & { kind: NonNullable<SilentPushPayload['kind']> },
): Promise<void> {
  const gate = await checkSilentPushLocationGate({
    stationName: payload.nextWaypoint,
    kind: payload.kind,
    phase: payload.phase,
  });

  if (!gate.pass) {
    logSilentPushSkipped({
      stationName: payload.nextWaypoint,
      kind: payload.kind === 'intermediate' ? 'station-passed' : payload.kind,
      phaseId: payload.phase,
      reason: mapGateReason(gate.reason!),
      distanceM: gate.distanceM,
      thresholdM: gate.thresholdM,
      locationSource: gate.locationSource,
      locationAgeMs: gate.locationAgeMs,
    });
    logger.info(`gate skip reason=${gate.reason} distance=${gate.distanceM ?? '-'}`);
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
      logger.info(`dedup: ${dedupKey} already fired — skip`);
      return;
    }
    fired.add(dedupKey);
    await setFiredAlarms(destinationId, fired);
  }

  const content =
    payload.kind === 'intermediate'
      ? buildIntermediateContent(payload.nextWaypoint)
      : buildAlarmContent({
          phaseId: payload.phase,
          type: payload.kind,
          stationName: payload.nextWaypoint,
        } as AlarmEvent);

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
