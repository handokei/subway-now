import {
  LAST_TRAIN_ALARM_THRESHOLD_MINUTES,
  LAST_TRAIN_CHANNEL_ID,
  LAST_TRAIN_FIRED_KEY_PREFIX,
  LAST_TRAIN_NOTIFICATION_ID,
  LAST_TRAIN_PAST_GRACE_MINUTES,
} from '../lastTrainAlarm';

describe('lastTrainAlarm 상수', () => {
  it('임계값은 양의 분 단위', () => {
    expect(LAST_TRAIN_ALARM_THRESHOLD_MINUTES).toBeGreaterThan(0);
    expect(Number.isInteger(LAST_TRAIN_ALARM_THRESHOLD_MINUTES)).toBe(true);
  });

  it('past grace는 음수 잔여시간을 일부 허용하는 양의 분', () => {
    expect(LAST_TRAIN_PAST_GRACE_MINUTES).toBeGreaterThan(0);
  });

  it('storage prefix는 subway-now namespaced', () => {
    expect(LAST_TRAIN_FIRED_KEY_PREFIX).toMatch(/^subway-now:/);
  });

  it('notification + channel id 정의', () => {
    expect(LAST_TRAIN_NOTIFICATION_ID).toBeTruthy();
    expect(LAST_TRAIN_CHANNEL_ID).toBeTruthy();
  });
});
