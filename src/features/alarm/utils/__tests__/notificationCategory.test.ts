import * as Notifications from 'expo-notifications';
import i18next from 'i18next';
import { setLang, installLanguageRestoreHook } from '../../../../testUtils/i18nLanguageOverride';
import {
  ALARM_ACTION_ACKNOWLEDGE,
  ALARM_ACTION_END_TRIP,
  ALARM_CATEGORY,
  BOARDING_PROMPT_ACTION_BOARDED,
  BOARDING_PROMPT_ACTION_NOT_BOARDED,
  BOARDING_PROMPT_CATEGORY,
  DISEMBARK_ACTION_DISEMBARKED,
  DISEMBARK_ACTION_NOT_YET,
  DISEMBARK_PROMPT_CATEGORY,
  setupAlarmCategory,
  setupBoardingPromptCategory,
  setupDisembarkPromptCategory,
  setupTripEndedCategory,
  TRIP_ENDED_ACTION_NEXT_TRIP,
  TRIP_ENDED_CATEGORY,
} from '../notificationCategory';

jest.mock('expo-notifications', () => ({
  setNotificationCategoryAsync: jest.fn(),
}));
jest.mock('../alarmLog', () => ({
  logCategoryRegistrationSucceeded: jest.fn(),
  logCategoryRegistrationFailed: jest.fn(),
}));

const { logCategoryRegistrationSucceeded, logCategoryRegistrationFailed } = jest.requireMock(
  '../alarmLog',
);

installLanguageRestoreHook();

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

  // #2282 — 버튼 라벨이 영어로 하드코딩돼 한국어 질문에도 "Boarded"/"Not boarded"로 표시되던 결함.
  it('버튼 라벨이 i18next 번역 키로 로컬라이즈된다 (#2282)', async () => {
    await setupBoardingPromptCategory();
    const [, actions] = (Notifications.setNotificationCategoryAsync as jest.Mock).mock
      .calls[0] as [string, { identifier: string; buttonTitle: string }[]];
    const boarded = actions.find((a) => a.identifier === BOARDING_PROMPT_ACTION_BOARDED);
    const notBoarded = actions.find((a) => a.identifier === BOARDING_PROMPT_ACTION_NOT_BOARDED);
    expect(boarded?.buttonTitle).toBe(i18next.t('notifications.actions.boardingConfirm'));
    expect(notBoarded?.buttonTitle).toBe(i18next.t('notifications.actions.notYet'));
    expect(boarded?.buttonTitle).not.toBe('Boarded');
    expect(notBoarded?.buttonTitle).not.toBe('Not boarded');
  });

  it('Notifications가 throw해도 graceful (no throw)', async () => {
    (Notifications.setNotificationCategoryAsync as jest.Mock).mockRejectedValueOnce(
      new Error('not supported'),
    );
    await expect(setupBoardingPromptCategory()).resolves.toBeUndefined();
  });

  // #2398 — 진단 계측: 등록 성공/실패 로그 호출 검증.
  it('등록 성공 시 logCategoryRegistrationSucceeded 호출 (#2398)', async () => {
    await setupBoardingPromptCategory();
    expect(logCategoryRegistrationSucceeded).toHaveBeenCalledWith({
      categoryId: BOARDING_PROMPT_CATEGORY,
      buttonTitles: [
        i18next.t('notifications.actions.boardingConfirm'),
        i18next.t('notifications.actions.notYet'),
      ],
    });
    expect(logCategoryRegistrationFailed).not.toHaveBeenCalled();
  });

  it('등록 실패 시 logCategoryRegistrationFailed 호출 (#2398)', async () => {
    (Notifications.setNotificationCategoryAsync as jest.Mock).mockRejectedValueOnce(
      new Error('not supported'),
    );
    await setupBoardingPromptCategory();
    expect(logCategoryRegistrationFailed).toHaveBeenCalledWith({
      categoryId: BOARDING_PROMPT_CATEGORY,
      errorMessage: 'not supported',
    });
    expect(logCategoryRegistrationSucceeded).not.toHaveBeenCalled();
  });

  it('non-Error throw도 문자열로 변환해 기록 (#2398)', async () => {
    (Notifications.setNotificationCategoryAsync as jest.Mock).mockRejectedValueOnce('boom');
    await setupBoardingPromptCategory();
    expect(logCategoryRegistrationFailed).toHaveBeenCalledWith({
      categoryId: BOARDING_PROMPT_CATEGORY,
      errorMessage: 'boom',
    });
  });
});

describe('setupDisembarkPromptCategory (#2282)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('DISEMBARK_PROMPT 식별자로 [하차했어요]/[아직이요] 액션 등록', async () => {
    await setupDisembarkPromptCategory();
    expect(Notifications.setNotificationCategoryAsync).toHaveBeenCalledWith(
      DISEMBARK_PROMPT_CATEGORY,
      expect.arrayContaining([
        expect.objectContaining({
          identifier: DISEMBARK_ACTION_DISEMBARKED,
          buttonTitle: i18next.t('notifications.actions.disembarkConfirm'),
          options: expect.objectContaining({ opensAppToForeground: true }),
        }),
        expect.objectContaining({
          identifier: DISEMBARK_ACTION_NOT_YET,
          buttonTitle: i18next.t('notifications.actions.notYet'),
          options: expect.objectContaining({ opensAppToForeground: false, isDestructive: true }),
        }),
      ]),
    );
  });

  it('Notifications가 throw해도 graceful (no throw)', async () => {
    (Notifications.setNotificationCategoryAsync as jest.Mock).mockRejectedValueOnce(
      new Error('not supported'),
    );
    await expect(setupDisembarkPromptCategory()).resolves.toBeUndefined();
  });

  // #2398 — 진단 계측: 등록 성공/실패 로그 호출 검증.
  it('등록 성공 시 logCategoryRegistrationSucceeded 호출 (#2398)', async () => {
    await setupDisembarkPromptCategory();
    expect(logCategoryRegistrationSucceeded).toHaveBeenCalledWith({
      categoryId: DISEMBARK_PROMPT_CATEGORY,
      buttonTitles: [
        i18next.t('notifications.actions.disembarkConfirm'),
        i18next.t('notifications.actions.notYet'),
      ],
    });
  });

  it('등록 실패 시 logCategoryRegistrationFailed 호출 (#2398)', async () => {
    (Notifications.setNotificationCategoryAsync as jest.Mock).mockRejectedValueOnce(
      new Error('not supported'),
    );
    await setupDisembarkPromptCategory();
    expect(logCategoryRegistrationFailed).toHaveBeenCalledWith({
      categoryId: DISEMBARK_PROMPT_CATEGORY,
      errorMessage: 'not supported',
    });
  });

  it('non-Error throw도 문자열로 변환해 기록 (#2398)', async () => {
    (Notifications.setNotificationCategoryAsync as jest.Mock).mockRejectedValueOnce('boom');
    await setupDisembarkPromptCategory();
    expect(logCategoryRegistrationFailed).toHaveBeenCalledWith({
      categoryId: DISEMBARK_PROMPT_CATEGORY,
      errorMessage: 'boom',
    });
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

  // #2374 — 하드코딩 한국어('확인'/'trip 종료')를 i18next.t() 키로 전환. 언어별 라벨 검증.
  it.each(['ko', 'en', 'ja', 'zh'])('%s 언어에서 버튼 라벨이 i18next 번역 키로 로컬라이즈된다 (#2374)', async (lang) => {
    setLang(lang);
    await setupAlarmCategory();
    const [, actions] = (Notifications.setNotificationCategoryAsync as jest.Mock).mock
      .calls[0] as [string, { identifier: string; buttonTitle: string }[]];
    const acknowledge = actions.find((a) => a.identifier === ALARM_ACTION_ACKNOWLEDGE);
    const endTrip = actions.find((a) => a.identifier === ALARM_ACTION_END_TRIP);
    expect(acknowledge?.buttonTitle).toBe(i18next.t('notifications.actions.acknowledge'));
    expect(endTrip?.buttonTitle).toBe(i18next.t('notifications.actions.endTrip'));
  });

  it('Notifications가 throw해도 graceful (no throw)', async () => {
    (Notifications.setNotificationCategoryAsync as jest.Mock).mockRejectedValueOnce(
      new Error('not supported'),
    );
    await expect(setupAlarmCategory()).resolves.toBeUndefined();
  });

  // #2398 — 진단 계측: 등록 성공/실패 로그 호출 검증.
  it('등록 성공 시 logCategoryRegistrationSucceeded 호출 (#2398)', async () => {
    await setupAlarmCategory();
    expect(logCategoryRegistrationSucceeded).toHaveBeenCalledWith({
      categoryId: ALARM_CATEGORY,
      buttonTitles: [
        i18next.t('notifications.actions.acknowledge'),
        i18next.t('notifications.actions.endTrip'),
      ],
    });
  });

  it('등록 실패 시 logCategoryRegistrationFailed 호출 (#2398)', async () => {
    (Notifications.setNotificationCategoryAsync as jest.Mock).mockRejectedValueOnce(
      new Error('not supported'),
    );
    await setupAlarmCategory();
    expect(logCategoryRegistrationFailed).toHaveBeenCalledWith({
      categoryId: ALARM_CATEGORY,
      errorMessage: 'not supported',
    });
  });

  it('non-Error throw도 문자열로 변환해 기록 (#2398)', async () => {
    (Notifications.setNotificationCategoryAsync as jest.Mock).mockRejectedValueOnce('boom');
    await setupAlarmCategory();
    expect(logCategoryRegistrationFailed).toHaveBeenCalledWith({
      categoryId: ALARM_CATEGORY,
      errorMessage: 'boom',
    });
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

  // #2374 — 하드코딩 한국어('다음 여정 시작')를 i18next.t() 키로 전환. 언어별 라벨 검증.
  it.each(['ko', 'en', 'ja', 'zh'])('%s 언어에서 버튼 라벨이 i18next 번역 키로 로컬라이즈된다 (#2374)', async (lang) => {
    setLang(lang);
    await setupTripEndedCategory();
    const [, actions] = (Notifications.setNotificationCategoryAsync as jest.Mock).mock
      .calls[0] as [string, { identifier: string; buttonTitle: string }[]];
    const nextTrip = actions.find((a) => a.identifier === TRIP_ENDED_ACTION_NEXT_TRIP);
    expect(nextTrip?.buttonTitle).toBe(i18next.t('notifications.actions.nextTrip'));
  });

  it('Notifications가 throw해도 graceful (no throw)', async () => {
    (Notifications.setNotificationCategoryAsync as jest.Mock).mockRejectedValueOnce(
      new Error('not supported'),
    );
    await expect(setupTripEndedCategory()).resolves.toBeUndefined();
  });

  // #2398 — 진단 계측: 등록 성공/실패 로그 호출 검증.
  it('등록 성공 시 logCategoryRegistrationSucceeded 호출 (#2398)', async () => {
    await setupTripEndedCategory();
    expect(logCategoryRegistrationSucceeded).toHaveBeenCalledWith({
      categoryId: TRIP_ENDED_CATEGORY,
      buttonTitles: [i18next.t('notifications.actions.nextTrip')],
    });
  });

  it('등록 실패 시 logCategoryRegistrationFailed 호출 (#2398)', async () => {
    (Notifications.setNotificationCategoryAsync as jest.Mock).mockRejectedValueOnce(
      new Error('not supported'),
    );
    await setupTripEndedCategory();
    expect(logCategoryRegistrationFailed).toHaveBeenCalledWith({
      categoryId: TRIP_ENDED_CATEGORY,
      errorMessage: 'not supported',
    });
  });

  it('non-Error throw도 문자열로 변환해 기록 (#2398)', async () => {
    (Notifications.setNotificationCategoryAsync as jest.Mock).mockRejectedValueOnce('boom');
    await setupTripEndedCategory();
    expect(logCategoryRegistrationFailed).toHaveBeenCalledWith({
      categoryId: TRIP_ENDED_CATEGORY,
      errorMessage: 'boom',
    });
  });
});
