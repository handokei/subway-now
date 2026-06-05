import { useEffect } from 'react';
import type { Station } from '../../../shared/types/station';
import {
  registerAlarmRefreshTask,
  unregisterAlarmRefreshTask,
} from '../tasks/alarmRefreshTask';
import { createLogger } from '../../../utils/logger';

const logger = createLogger('useAlarmRefreshTask');

/**
 * 활성 트립(destination set)에 한해 BGAppRefreshTask 등록.
 * 트립 종료 / 언마운트 시 해제.
 *
 * #505: 핸들러는 no-op(즉시 self-unregister). 등록은 호환을 위해 유지하나
 * OS가 깨워도 알람 발사 없음. 훅 자체는 #411에서 일괄 제거 예정 (호출처 없음).
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
