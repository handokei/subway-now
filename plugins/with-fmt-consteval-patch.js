// Xcode 16+ clang의 엄격한 consteval 검증이 RN 0.81에 묶인 구버전 fmt(base.h)와
// 충돌해 빌드 실패한다. -DFMT_USE_CONSTEVAL=0는 base.h 내부 #elif 체인이 무조건
// 재정의하므로 무력. Podfile post_install 훅에서 base.h를 직접 sed 패치하여
// FMT_CONSTEVAL을 consteval → constexpr로 강제한다.
//
// CNG 프로젝트라 ios/는 매 prebuild마다 재생성되므로 plugin으로 영구화.

const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SENTINEL = '# [fmt-consteval-patch]';

const PATCH_SNIPPET = `
    ${SENTINEL} Xcode 16+ clang의 엄격한 consteval 검증과 RN 0.81 fmt 충돌 우회.
    # FMT_USE_CONSTEVAL은 fmt 내부 #elif 체인이 무조건 재정의하므로 -D로는 안 됨 → 헤더 직접 패치.
    fmt_base_h = File.join(installer.sandbox.root, 'fmt', 'include', 'fmt', 'base.h')
    if File.exist?(fmt_base_h)
      content = File.read(fmt_base_h)
      patched = content.gsub('#  define FMT_CONSTEVAL consteval', '#  define FMT_CONSTEVAL constexpr')
      if patched != content
        File.chmod(0644, fmt_base_h)
        File.write(fmt_base_h, patched)
        Pod::UI.puts "[fmt-consteval-patch] fmt/base.h: FMT_CONSTEVAL consteval → constexpr"
      end
    end
`;

module.exports = function withFmtConstevalPatch(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      let contents = fs.readFileSync(podfilePath, 'utf8');
      if (contents.includes(SENTINEL)) return cfg;

      // Expo의 기본 Podfile은 target 'subwaynow' 내부에 단일 post_install 블록을 갖는다.
      // 그 블록 내부 react_native_post_install 호출 직후에 패치 스니펫을 삽입한다.
      const anchor = /react_native_post_install\([\s\S]*?\)\n/;
      const match = anchor.exec(contents);
      if (!match) {
        throw new Error(
          '[fmt-consteval-patch] react_native_post_install 앵커를 찾지 못함 — Podfile 구조 변경 확인',
        );
      }
      const insertAt = match.index + match[0].length;
      contents = contents.slice(0, insertAt) + PATCH_SNIPPET + contents.slice(insertAt);
      fs.writeFileSync(podfilePath, contents);
      return cfg;
    },
  ]);
};
