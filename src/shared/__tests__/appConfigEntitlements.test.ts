/**
 * #3373 — 취침 알람 backend push는 `interruption-level: time-sensitive`를 요청하지만, 앱에
 * Time Sensitive entitlement가 없으면 iOS가 active로 낮춰 수면/방해금지 집중모드에서 배너·소리가 묻힌다.
 * app.config.js 산출 entitlements가 키를 가져야 prebuild가 반영한다.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const appConfig = require('../../../app.config.js');

describe('app.config.js ios.entitlements (#3373)', () => {
  const { ios } = appConfig.expo;
  const { entitlements } = ios;

  it('Time Sensitive Notifications entitlement가 true다 (빠지면 취침 알람이 집중모드에서 묻힘)', () => {
    expect(entitlements['com.apple.developer.usernotifications.time-sensitive']).toBe(true);
  });

  it('기존 entitlement(aps-environment, wifi-info)는 유지된다', () => {
    expect(entitlements['aps-environment']).toEqual(expect.stringMatching(/^(development|production)$/));
    expect(entitlements['com.apple.developer.networking.wifi-info']).toBe(true);
  });
});
