/**
 * #3100 PR-2 — MAX=4 변형. 최대치 상수만 4로 mock해 sync 경로 table을 end-to-end 재실행한다.
 * 칸 수 / 점프 / 접미사가 특정 최대치(3)에 묶여 있으면 여기서 red가 된다.
 */
import { vi } from 'vitest';
import { useApnsHarness } from './helpers/sleepAlarmHarness';
import { registerSleepAlarmSyncTable } from './helpers/sleepAlarmSyncTable';

vi.mock('../../../../src/shared/constants/sleepAlarm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/shared/constants/sleepAlarm')>()),
  SLEEP_ALARM_MAX_STOPS_BEFORE: 4,
}));

useApnsHarness();
registerSleepAlarmSyncTable();
