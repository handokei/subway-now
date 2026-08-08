/**
 * stationPrescheduler (#918 → 퇴역 #2202) — OS-level 매역 사전 예약 채널.
 *
 * **#2202 (ADR-026 Decision 2)** — 매역(destination/transfer/station-passed) 로컬 발사
 * (`scheduleNotificationAsync`)를 제거했다. 본 채널은 iOS 로컬/remote 식별자 분리로 backend
 * 매역 push(#2201 단일 emitter)와 이중 발사하던 중복 emitter였다 — backend가 유일한 emitter로
 * 확정되며 device-side 사전 예약/재예약 로직(`registerPrescheduledStationAlarms`,
 * `reschedulePrescheduledAlarm`)은 전량 삭제됐다.
 *
 * 아래 3개 함수는 채널 퇴역 후에도 **다른 소비자가 남아있어 유지**한다(퇴역 PR 스펙 — 사용
 * 중인 유틸은 orphan 제거 대상이 아님):
 *  - `cancelAllPrescheduledAlarms` — `tripBoundCleanups`가 trip 종료 시 이전 버전에서 이미
 *    예약된 pending/delivered 잔여물을 정리(구버전 앱 잔존 예약 대비 defensive cleanup).
 *  - `cancelPrescheduledByStationKind` — `silentPushTask`/`scheduledAlarmReceiver`가 backend
 *    push(원격) 도착 시 동명 잔여 pending을 dedup 정리.
 *  - `readPrescheduledData` — `scheduledAlarmReceiver`가 fire-time 재검증 대상(구버전 앱이
 *    예약한 잔여 알람)을 판별.
 */
import * as Notifications from 'expo-notifications';
import { cancelIdentifiersWithRetry } from './safetyNetScheduler';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('StationPrescheduler');

/** OS 예약 identifier 접두 — `presched-<tripToken.slice(0,16)>-<station>-<kind>#<occurrence>`. */
export const PRESCHED_ALARM_PREFIX = 'presched-';

/**
 * 역별 알림 종류. 경로의 마지막 역은 'destination', line이 바뀌는 경계 역은 'transfer',
 * 그 외 모든 중간역은 'station-passed'.
 */
export type PrescheduledKind = 'transfer' | 'destination' | 'station-passed';

export interface PrescheduledNotificationData {
  channel: 'presched-station';
  tripToken: string;
  station: string;
  kind: PrescheduledKind;
  occurrenceIdx: number;
  /** #2122 규칙 재사용 — 실제 OS collapsing 용도가 아니라 관측/향후 확장용 메타데이터. */
  collapseId?: string;
}

/** trip 종료 시 호출 — `tripToken`의 모든 사전예약을 pending queue + delivered tray에서 제거. */
export async function cancelAllPrescheduledAlarms(tripToken: string): Promise<void> {
  const prefix = `${PRESCHED_ALARM_PREFIX}${tripToken.slice(0, 16)}-`;
  const all = await Notifications.getAllScheduledNotificationsAsync();
  const targets = all.filter((req) => req.identifier.startsWith(prefix));
  const cancelled = await cancelIdentifiersWithRetry(targets.map((req) => req.identifier));

  let dismissedCount = 0;
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    const delivered = presented.filter((n) => n.request.identifier.startsWith(prefix));
    if (delivered.length > 0) {
      const results = await Promise.allSettled(
        delivered.map((n) => Notifications.dismissNotificationAsync(n.request.identifier)),
      );
      for (const r of results) {
        if (r.status === 'fulfilled') dismissedCount++;
      }
    }
  } catch (e) {
    logger.warn(`cancelAllPrescheduledAlarms: delivered tray 조회 실패, pending cancel만 적용: ${e}`);
  }

  if (cancelled > 0 || dismissedCount > 0) {
    logger.info(`cancelled ${cancelled} pending + dismissed ${dismissedCount} prescheduled alarms`);
  }
}

/**
 * OS 알림 request에서 사전예약 메타데이터를 안전하게 추출.
 * `scheduledAlarmReceiver`(fire-time revalidation) + `stationNotification`(원격 도착 시
 * pending 취소)이 재사용한다.
 */
export function readPrescheduledData(
  req: Notifications.NotificationRequest,
): PrescheduledNotificationData | null {
  if (!req.identifier.startsWith(PRESCHED_ALARM_PREFIX)) return null;
  const data = req.content.data as Partial<PrescheduledNotificationData> | null | undefined;
  if (!data || data.channel !== 'presched-station') return null;
  if (typeof data.station !== 'string' || typeof data.tripToken !== 'string') return null;
  if (data.kind !== 'transfer' && data.kind !== 'destination' && data.kind !== 'station-passed') {
    return null;
  }
  const occurrenceIdx = typeof data.occurrenceIdx === 'number' ? data.occurrenceIdx : 0;
  return {
    channel: 'presched-station',
    tripToken: data.tripToken,
    station: data.station,
    kind: data.kind,
    occurrenceIdx,
  };
}

/**
 * 3-소스 dedup — 같은 (station, kind)의 사전예약 pending을 전부 취소한다.
 *
 * 호출자:
 *  - FG: `scheduledAlarmReceiver`가 원격(backend) station-notif 도착을 감지하면 즉시 호출
 *    ("remote 선표시 → 해당 역 pending 로컬 cancel").
 *  - BG: `silentPushTask`가 backend push wake 시점에 호출.
 *
 * occurrence는 무관하게 전부 취소 — 같은 (station, kind)가 route에 중복 등장해도(순환 노선)
 * backend push 시점엔 이미 그 역을 지나는 순간이므로 어느 occurrence든 유효기간이 끝난다.
 */
export async function cancelPrescheduledByStationKind(
  stationName: string,
  kind: PrescheduledKind,
): Promise<void> {
  const all = await Notifications.getAllScheduledNotificationsAsync();
  const targets = all.filter((req) => {
    const data = readPrescheduledData(req);
    return data !== null && data.kind === kind && data.station === stationName;
  });
  if (targets.length === 0) return;
  const cancelled = await cancelIdentifiersWithRetry(targets.map((req) => req.identifier));
  if (cancelled > 0) {
    logger.info(`cancelled ${cancelled} prescheduled alarms (remote arrival) station=${stationName} kind=${kind}`);
  }
}
