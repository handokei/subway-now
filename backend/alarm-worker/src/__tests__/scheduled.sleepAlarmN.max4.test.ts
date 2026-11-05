/**
 * #3100 PR-1 — MAX=4 변형. 최대치 상수만 4로 mock해 같은 table을 end-to-end 재실행한다.
 * 칸 수 / 점프 / 접미사 / 문구가 특정 최대치(3)에 묶여 있으면 여기서 red가 된다 — 리터럴 가드가
 * 못 보는 의미 하드코딩을 잡는 장치다.
 */
import { vi } from 'vitest';
import { useApnsHarness } from './helpers/sleepAlarmHarness';
import { registerSleepAlarmNTable } from './helpers/sleepAlarmNTable';

vi.mock('../../../../src/shared/constants/sleepAlarm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/shared/constants/sleepAlarm')>()),
  SLEEP_ALARM_MAX_STOPS_BEFORE: 4,
}));

useApnsHarness();
registerSleepAlarmNTable();
