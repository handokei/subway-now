// with-icloud-kv.js — iCloud KV entitlement 주입 config plugin (#1861).
//
// prebuild 시마다 com.apple.developer.ubiquity-kvstore-identifier 를
// <app>.entitlements 에 자동 추가한다.
//
// 사전 준비 (사용자 책임):
//  - App Store Connect → Identifiers → com.subwaynow.app → iCloud Capability 활성화
//  - KV Store identifier: $(TeamIdentifierPrefix)$(CFBundleIdentifier) 설정
//
// 참고: modules/live-activity/app.plugin.js withEntitlementsPlist 패턴과 동형.

const { withEntitlementsPlist } = require('@expo/config-plugins');

// Xcode가 iCloud KV 활성 시 쓰는 기본값: $(TeamIdentifierPrefix)$(CFBundleIdentifier).
// 자동 서명 팀 프로파일이 접두 형식(<TeamID>.*)을 기대하므로 접두가 없으면
// "Provisioning profile doesn't match the entitlements file" 로 빌드 실패한다(#3087).
// (이전 주석의 "Apple 권장 = $(CFBundleIdentifier) 단독"은 틀린 전제였다.)
const ICLOUD_KV_IDENTIFIER = '$(TeamIdentifierPrefix)$(CFBundleIdentifier)';

/** @type {import('@expo/config-plugins').ConfigPlugin} */
module.exports = function withICloudKV(config) {
  return withEntitlementsPlist(config, (mod) => {
    mod.modResults['com.apple.developer.ubiquity-kvstore-identifier'] = ICLOUD_KV_IDENTIFIER;
    return mod;
  });
};
