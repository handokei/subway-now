/**
 * iOS silent push(BG) 핸들러 — alarm-worker(#338)가 보내는 reschedule 트리거.
 *
 * payload (백엔드 apns.ts SilentPushPayload와 1:1):
 * ```
 * aps: { 'content-available': 1 }
 * data: { nextWaypoint: "강남", etaSeconds: 420, phase: "early" }
 * ```
 *
 * 동작:
 *   1. AsyncStorage에서 현재 route/destination 복원
 *   2. payload의 etaSeconds(다음 도착역까지)로 `scheduleAlarmsForRoute` 재호출
 *   3. 기존 예약을 cancelScheduledAlarms로 정리한 뒤 새 시각으로 다시 예약
 *
 * payload 형식이 맞지 않거나 route/destination이 없으면 graceful no-op.
 */

import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import i18next from 'i18next';
import type { Station } from '../types/station';
import type { Route } from '../utils/stationRoute';
import { scheduleAlarmsForRoute, cancelScheduledAlarms } from '../utils/alarmScheduler';
import { DESTINATION_KEY, ROUTE_KEY } from '../constants/storageKeys';
import { createLogger } from '../utils/logger';
import { logSilentPushReceived } from '../utils/alarmLog';

const logger = createLogger('SilentPushTask');

export const SILENT_PUSH_TASK = 'silent-push-reschedule';

export interface SilentPushPayload {
  nextWaypoint: string;
  etaSeconds: number;
  phase: 'early' | 'imminent';
  /** Waypoint 종류 (#416). intermediate면 통과 즉시 알림, 그 외는 reschedule만. 구 백엔드 호환을 위해 optional. */
  kind?: 'transfer' | 'destination' | 'intermediate';
  /**
   * 백엔드 발사 시점 epoch ms (#478 측정 인프라).
   * 클라 수신 시각과 비교해 silent push 도달 지연 측정. 구 백엔드 호환 위해 optional.
   * 종료 조건: #478 PR 1-2(silent push 단독 발화) 머지 + 신 백엔드 배포 후 required로 승격.
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
 * iOS expo-notifications BG는 APNs JSON의 `data` 필드를 그대로 전달한다.
 * 어디에 들어있든 nextWaypoint/etaSeconds/phase 세 필드 모두 형이 맞아야 통과한다.
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

  // #478 측정 인프라 — 도달 지연 측정용 적재. 동작 변경 없음.
  logSilentPushReceived({
    stationName: payload.nextWaypoint,
    kind: payload.kind,
    phaseId: payload.phase,
    sentAt: payload.sentAt,
    receivedAt,
  });

  try {
    const [destJson, routeJson] = await Promise.all([
      AsyncStorage.getItem(DESTINATION_KEY),
      AsyncStorage.getItem(ROUTE_KEY),
    ]);
    if (!destJson || !routeJson) {
      logger.info('no active destination/route — skip reschedule');
      return;
    }

    let destination: Station;
    let route: Route;
    try {
      destination = JSON.parse(destJson) as Station;
      route = JSON.parse(routeJson) as Route;
    } catch (e) {
      logger.error('failed to parse stored destination/route:', e);
      return;
    }
    if (!route || !destination) return;

    // 중간역 통과(intermediate + imminent)는 통과 시점에 즉시 사용자 알림 표시 (#416).
    // reschedule은 그대로 진행 — 다음 waypoint용 사전 예약을 갱신.
    if (payload.kind === 'intermediate' && payload.phase === 'imminent') {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: i18next.t('route.intermediatePassedTitle'),
          body: i18next.t('route.intermediatePassedBody', { name: payload.nextWaypoint }),
        },
        trigger: null,
      });
      logger.info(`intermediate passed: ${payload.nextWaypoint}`);
    }

    await cancelScheduledAlarms();
    const scheduled = await scheduleAlarmsForRoute({
      route,
      destinationName: destination.name,
      currentStationApproachEtaSeconds: payload.etaSeconds,
    });
    logger.info(`rescheduled ${scheduled.length} alarms via silent push`);
  } catch (e) {
    logger.error('silent push handling failed:', e);
  }
}

/** Task 등록 — 모듈 로드 시점에 한 번 실행. */
TaskManager.defineTask(SILENT_PUSH_TASK, handleSilentPush);

/**
 * 앱 초기화 시 호출 — Notifications가 BG payload를 이 task로 라우팅하도록 등록한다.
 * 이미 등록된 경우 no-op.
 */
export async function registerSilentPushTask(): Promise<void> {
  try {
    await Notifications.registerTaskAsync(SILENT_PUSH_TASK);
    logger.info('silent push task registered');
  } catch (e) {
    logger.warn('failed to register silent push task:', e);
  }
}
