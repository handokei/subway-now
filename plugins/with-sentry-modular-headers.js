// @sentry/react-native 8.x + sentry-cocoa 8.x는 _SentryPrivate Swift 서브모듈을
// CocoaPods 기본(non-modular) 헤더 모드에서 찾지 못해 빌드 실패한다
// (`Module '_SentryPrivate' not found`). Sentry/SentryPrivate에 modular_headers를
// 명시적으로 켜서 해소한다.
//
// Expo CNG라 ios/는 매 prebuild마다 재생성되므로 plugin으로 영구화.

const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SENTINEL = '# [sentry-modular-headers]';

const PATCH_SNIPPET = `
  ${SENTINEL} Sentry _SentryPrivate Swift 모듈 해소.
  pod 'Sentry', :modular_headers => true
  pod 'SentryPrivate', :modular_headers => true
`;

module.exports = function withSentryModularHeaders(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      let contents = fs.readFileSync(podfilePath, 'utf8');
      if (contents.includes(SENTINEL)) return cfg;

      // target 'subwaynow' do ... use_expo_modules! 직후에 삽입.
      const anchor = /use_expo_modules!\n/;
      const match = anchor.exec(contents);
      if (!match) {
        throw new Error(
          '[sentry-modular-headers] use_expo_modules! 앵커를 찾지 못함 — Podfile 구조 변경 확인',
        );
      }
      const insertAt = match.index + match[0].length;
      contents = contents.slice(0, insertAt) + PATCH_SNIPPET + contents.slice(insertAt);
      fs.writeFileSync(podfilePath, contents);
      return cfg;
    },
  ]);
};
