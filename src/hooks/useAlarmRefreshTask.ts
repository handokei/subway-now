import { useEffect } from 'react';
import type { Station } from '../types/station';
import {
  registerAlarmRefreshTask,
  unregisterAlarmRefreshTask,
} from '../tasks/alarmRefreshTask';
import { createLogger } from '../utils/logger';

const logger = createLogger('useAlarmRefreshTask');

/**
 * 활성 트립(destination set)에 한해 BGAppRefreshTask 등록.
 * 트립 종료 / 언마운트 시 해제.
 *
 * Phase 1 fallback: silent push(Phase 2)를 받지 못하는 사용자도 OS가 앱을 깨워주는
 * 시점에 사전 예약 알람이 갱신된다.
 */
export function useAlarmRefreshTask(destination: Station | null): void {
  useEffect(() => {
    if (!destination) {
      unregisterAlarmRefreshTask().catch((e) =>
        logger.error('해제 실패:', e),
      );
      return;
    }

    registerAlarmRefreshTask().catch((e) =>
      logger.error('등록 실패:', e),
    );

    return () => {
      unregisterAlarmRefreshTask().catch((e) =>
        logger.error('해제 실패:', e),
      );
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination?.id]);
}
