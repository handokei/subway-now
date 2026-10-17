// with-icloud-kv.js — iCloud KV entitlement 주입 config plugin (#1861).
//
// prebuild 시마다 com.apple.developer.ubiquity-kvstore-identifier 를
// <app>.entitlements 에 자동 추가한다.
//
// 사전 준비 (사용자 책임):
//  - App Store Connect → Identifiers → com.subwaynow.app → iCloud Capability 활성화
//  - KV Store identifier: $(CFBundleIdentifier) 설정
//
// 참고: modules/live-activity/app.plugin.js withEntitlementsPlist 패턴과 동형.

const { withEntitlementsPlist } = require('@expo/config-plugins');

// Apple 권장 식별자: $(CFBundleIdentifier) — 번들 ID와 동일하게 사용.
const ICLOUD_KV_IDENTIFIER = '$(CFBundleIdentifier)';

/** @type {import('@expo/config-plugins').ConfigPlugin} */
module.exports = function withICloudKV(config) {
  return withEntitlementsPlist(config, (mod) => {
    mod.modResults['com.apple.developer.ubiquity-kvstore-identifier'] = ICLOUD_KV_IDENTIFIER;
    return mod;
  });
};
