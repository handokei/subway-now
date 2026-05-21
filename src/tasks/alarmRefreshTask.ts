import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';
import { createLogger } from '../utils/logger';

const logger = createLogger('AlarmRefreshTask');

export const ALARM_REFRESH_TASK = 'alarm-refresh-task';

// #505: 이전 빌드(useScheduledAlarms 시절)에서 OS에 등록된 BGAppRefreshTask가
// 새 빌드 부팅 후에도 한동안 살아남아 scheduleAlarmsForRoute를 호출, 알람 폭주를 유발했다.
// 핸들러는 즉시 self-unregister만 수행한다. 알람 발사 경로는 silent push 단독(#478).
// register/unregister export는 useAlarmRefreshTask 호환을 위해 유지 — #411에서 일괄 제거.
TaskManager.defineTask(ALARM_REFRESH_TASK, async () => {
  await BackgroundTask.unregisterTaskAsync(ALARM_REFRESH_TASK).catch((e) =>
    logger.warn('self-unregister 실패:', e),
  );
  return BackgroundTask.BackgroundTaskResult.Success;
});

export async function registerAlarmRefreshTask(): Promise<void> {
  const isRegistered = await TaskManager.isTaskRegisteredAsync(ALARM_REFRESH_TASK);
  if (isRegistered) return;
  await BackgroundTask.registerTaskAsync(ALARM_REFRESH_TASK, { minimumInterval: 15 });
  logger.info('AlarmRefreshTask 등록');
}

export async function unregisterAlarmRefreshTask(): Promise<void> {
  const isRegistered = await TaskManager.isTaskRegisteredAsync(ALARM_REFRESH_TASK);
  if (!isRegistered) return;
  await BackgroundTask.unregisterTaskAsync(ALARM_REFRESH_TASK);
  logger.info('AlarmRefreshTask 해제');
}
