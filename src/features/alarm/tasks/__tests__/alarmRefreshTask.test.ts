jest.mock('expo-task-manager', () => ({
  defineTask: (name: string, callback: Function) => {
    (global as any).__bgRefreshCallback = callback;
    (global as any).__bgRefreshTaskName = name;
  },
  isTaskRegisteredAsync: jest.fn(),
}));

jest.mock('expo-background-task', () => ({
  registerTaskAsync: jest.fn(),
  unregisterTaskAsync: jest.fn(),
  BackgroundTaskResult: { Success: 1, Failed: 2 },
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';
import {
  ALARM_REFRESH_TASK,
  registerAlarmRefreshTask,
  unregisterAlarmRefreshTask,
} from '../alarmRefreshTask';

function getCallback(): () => Promise<number> {
  return (global as any).__bgRefreshCallback;
}

describe('alarmRefreshTask', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('defineTask가 ALARM_REFRESH_TASK 이름으로 호출된다', () => {
    expect((global as any).__bgRefreshTaskName).toBe(ALARM_REFRESH_TASK);
    expect((global as any).__bgRefreshCallback).toBeDefined();
  });

  describe('태스크 콜백 (#505 no-op)', () => {
    it('호출되면 즉시 self-unregister를 시도하고 Success를 반환한다', async () => {
      (BackgroundTask.unregisterTaskAsync as jest.Mock).mockResolvedValueOnce(undefined);
      const result = await getCallback()();
      expect(BackgroundTask.unregisterTaskAsync).toHaveBeenCalledWith(ALARM_REFRESH_TASK);
      expect(result).toBe(BackgroundTask.BackgroundTaskResult.Success);
    });

    it('self-unregister가 실패해도 Success를 반환한다', async () => {
      (BackgroundTask.unregisterTaskAsync as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      const result = await getCallback()();
      expect(result).toBe(BackgroundTask.BackgroundTaskResult.Success);
    });
  });

  describe('registerAlarmRefreshTask', () => {
    it('이미 등록되어 있으면 재등록하지 않는다', async () => {
      (TaskManager.isTaskRegisteredAsync as jest.Mock).mockResolvedValueOnce(true);
      await registerAlarmRefreshTask();
      expect(BackgroundTask.registerTaskAsync).not.toHaveBeenCalled();
    });

    it('등록되어 있지 않으면 minimumInterval=15로 등록한다', async () => {
      (TaskManager.isTaskRegisteredAsync as jest.Mock).mockResolvedValueOnce(false);
      await registerAlarmRefreshTask();
      expect(BackgroundTask.registerTaskAsync).toHaveBeenCalledWith(
        ALARM_REFRESH_TASK,
        { minimumInterval: 15 },
      );
    });
  });

  describe('unregisterAlarmRefreshTask', () => {
    it('등록되어 있지 않으면 unregister를 호출하지 않는다', async () => {
      (TaskManager.isTaskRegisteredAsync as jest.Mock).mockResolvedValueOnce(false);
      await unregisterAlarmRefreshTask();
      expect(BackgroundTask.unregisterTaskAsync).not.toHaveBeenCalled();
    });

    it('등록되어 있으면 unregister를 호출한다', async () => {
      (TaskManager.isTaskRegisteredAsync as jest.Mock).mockResolvedValueOnce(true);
      await unregisterAlarmRefreshTask();
      expect(BackgroundTask.unregisterTaskAsync).toHaveBeenCalledWith(ALARM_REFRESH_TASK);
    });
  });
});
