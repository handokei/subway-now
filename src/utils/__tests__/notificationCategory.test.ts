import * as Notifications from 'expo-notifications';
import {
  BOARDING_PROMPT_ACTION_BOARDED,
  BOARDING_PROMPT_ACTION_NOT_BOARDED,
  BOARDING_PROMPT_CATEGORY,
  setupBoardingPromptCategory,
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
