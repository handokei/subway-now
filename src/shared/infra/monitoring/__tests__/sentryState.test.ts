import { isSentryEnabled, setSentryEnabled } from '../sentryState';

afterEach(() => {
  setSentryEnabled(false);
});

describe('sentryState', () => {
  it('기본값은 false', () => {
    expect(isSentryEnabled()).toBe(false);
  });

  it('setSentryEnabled(true) 후 isSentryEnabled가 true 반환', () => {
    setSentryEnabled(true);
    expect(isSentryEnabled()).toBe(true);
  });

  it('setSentryEnabled(false)로 비활성화 가능', () => {
    setSentryEnabled(true);
    setSentryEnabled(false);
    expect(isSentryEnabled()).toBe(false);
  });
});
