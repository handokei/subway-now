// with-icloud-kv config plugin 출력 테스트 (#3087).
// Xcode 자동 서명 팀 프로파일은 $(TeamIdentifierPrefix) 접두 형식을 기대한다.

const KEY = 'com.apple.developer.ubiquity-kvstore-identifier';

jest.mock('@expo/config-plugins', () => ({
  withEntitlementsPlist: (config, action) => action({ ...config, modResults: config.modResults }),
}));

const withICloudKV = require('../with-icloud-kv');

describe('with-icloud-kv', () => {
  it('ubiquity-kvstore-identifier에 TeamIdentifierPrefix 접두 값을 주입한다', () => {
    const result = withICloudKV({ modResults: {} });
    expect(result.modResults[KEY]).toBe('$(TeamIdentifierPrefix)$(CFBundleIdentifier)');
  });

  it('기존 entitlements를 보존한다', () => {
    const result = withICloudKV({ modResults: { 'aps-environment': 'production' } });
    expect(result.modResults['aps-environment']).toBe('production');
  });
});
