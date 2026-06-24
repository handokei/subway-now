import * as Notifications from 'expo-notifications';
import {
  ALARM_ACTION_ACKNOWLEDGE,
  ALARM_ACTION_END_TRIP,
  ALARM_CATEGORY,
  BOARDING_PROMPT_ACTION_BOARDED,
  BOARDING_PROMPT_ACTION_NOT_BOARDED,
  BOARDING_PROMPT_CATEGORY,
  setupAlarmCategory,
  setupBoardingPromptCategory,
  setupTripEndedCategory,
  TRIP_ENDED_ACTION_NEXT_TRIP,
  TRIP_ENDED_CATEGORY,
} from '../notificationCategory';

jest.mock('expo-notifications', () => ({
  setNotificationCategoryAsync: jest.fn(),
}));

describe('setupBoardingPromptCategory (#819)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('BOARDING_PROMPT 식별자로 [탑승]/[미탑승] 액션 등록', async () => {
    await setupBoardingPromptCategory();
    expect(Notifications.setNotificationCategoryAsync).toHaveBeenCalledWith(
      BOARDING_PROMPT_CATEGORY,
      expect.arrayContaining([
        expect.objectContaining({
          identifier: BOARDING_PROMPT_ACTION_BOARDED,
          options: expect.objectContaining({ opensAppToForeground: true }),
        }),
        expect.objectContaining({
          identifier: BOARDING_PROMPT_ACTION_NOT_BOARDED,
          options: expect.objectContaining({ opensAppToForeground: false, isDestructive: true }),
        }),
      ]),
    );
  });

  it('Notifications가 throw해도 graceful (no throw)', async () => {
    (Notifications.setNotificationCategoryAsync as jest.Mock).mockRejectedValueOnce(
      new Error('not supported'),
    );
    await expect(setupBoardingPromptCategory()).resolves.toBeUndefined();
  });
});

describe('setupAlarmCategory (#1798 P2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('ALARM_CATEGORY 식별자로 [확인]/[trip 종료] 액션 등록', async () => {
    await setupAlarmCategory();
    expect(Notifications.setNotificationCategoryAsync).toHaveBeenCalledWith(
      ALARM_CATEGORY,
      expect.arrayContaining([
        expect.objectContaining({
          identifier: ALARM_ACTION_ACKNOWLEDGE,
          options: expect.objectContaining({ opensAppToForeground: false }),
        }),
        expect.objectContaining({
          identifier: ALARM_ACTION_END_TRIP,
          options: expect.objectContaining({ opensAppToForeground: false, isDestructive: true }),
        }),
      ]),
    );
  });

  it('Notifications가 throw해도 graceful (no throw)', async () => {
    (Notifications.setNotificationCategoryAsync as jest.Mock).mockRejectedValueOnce(
      new Error('not supported'),
    );
    await expect(setupAlarmCategory()).resolves.toBeUndefined();
  });
});

describe('setupTripEndedCategory (#1798 P2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('TRIP_ENDED_CATEGORY 식별자로 [다음 여정 시작] 액션 등록', async () => {
    await setupTripEndedCategory();
    expect(Notifications.setNotificationCategoryAsync).toHaveBeenCalledWith(
      TRIP_ENDED_CATEGORY,
      expect.arrayContaining([
        expect.objectContaining({
          identifier: TRIP_ENDED_ACTION_NEXT_TRIP,
          options: expect.objectContaining({ opensAppToForeground: true }),
        }),
      ]),
    );
  });

  it('Notifications가 throw해도 graceful (no throw)', async () => {
    (Notifications.setNotificationCategoryAsync as jest.Mock).mockRejectedValueOnce(
      new Error('not supported'),
    );
    await expect(setupTripEndedCategory()).resolves.toBeUndefined();
  });
});
