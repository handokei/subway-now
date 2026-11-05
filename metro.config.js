// Metro 설정 — Expo 기본값 + `.claude/` 제외.
//
// #build-hygiene — `.claude/worktrees/`에 생성되는 agent 격리 워크트리는 `src/` 전체
// 복사본을 담는다. metro.config가 없으면 Metro 기본값이 repo 루트 전체를 haste-map으로
// 스캔해 중복 모듈("jest-haste-map: Haste module naming collision")로 번들이 실패한다
// (2026-09-27 실기기 빌드 실패 root). `.claude`를 blockList에 넣어 워크트리 복사본을
// 해석/watch 대상에서 제외한다. 워크트리 유무와 무관하게 안전(정상 소스는 `.claude` 밖).
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

const excludeClaude = /[/\\]\.claude[/\\].*/;
const existing = config.resolver.blockList;
config.resolver.blockList = Array.isArray(existing)
  ? [...existing, excludeClaude]
  : existing
    ? [existing, excludeClaude]
    : [excludeClaude];

module.exports = config;
