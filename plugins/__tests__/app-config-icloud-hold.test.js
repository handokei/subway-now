// #3340 — Portal App ID에 iCloud capability가 없는 동안 with-icloud-kv 플러그인을 등록하지 않는다.
// 등록 시 EAS provisioning profile에 ubiquity-kvstore-identifier가 없어 iOS 빌드가 실패한다.
// 복구: Portal iCloud 활성화 후 plugins 재등록 + 이 테스트 갱신.

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const PLUGIN = 'with-icloud-kv';
const UBIQUITY_KEY = 'com.apple.developer.ubiquity-kvstore-identifier';
const ASC_APP_ID = '6763243862';

const { expo } = require(path.join(ROOT, 'app.config.js'));
const easJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));

describe('app.config.js — iCloud 플러그인 보류 (#3340)', () => {
  it('plugins에 with-icloud-kv가 등록되어 있지 않다', () => {
    const names = expo.plugins.map((entry) => (Array.isArray(entry) ? entry[0] : entry));
    expect(names.filter((name) => String(name).includes(PLUGIN))).toEqual([]);
  });

  it('ios.entitlements에 ubiquity-kvstore-identifier가 없다', () => {
    expect(Object.keys(expo.ios.entitlements)).not.toContain(UBIQUITY_KEY);
  });
});

describe('eas.json — submit (#3340)', () => {
  it('submit.production.ios.ascAppId가 설정되어 있다', () => {
    expect(easJson.submit.production.ios.ascAppId).toBe(ASC_APP_ID);
  });
});
