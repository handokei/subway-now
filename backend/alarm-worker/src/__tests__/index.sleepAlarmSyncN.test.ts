/**
 * #3100 PR-2 — sync 경로 N역 전 table (MAX=3 원본). MAX=4 변형은 `index.sleepAlarmSyncN.max4.test.ts`.
 */
import { useApnsHarness } from './helpers/sleepAlarmHarness';
import { registerSleepAlarmSyncTable } from './helpers/sleepAlarmSyncTable';

useApnsHarness();
registerSleepAlarmSyncTable();
