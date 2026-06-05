/**
 * ESLint 경계 룰 — Feature-based + Ports & Adapters 디렉토리 재정비 로드맵 Phase 5 (최종)
 *
 * - ADR (노션): "Feature-based + Ports & Adapters 디렉토리 재정비 로드맵"
 *   https://app.notion.com/p/36e30c0194b68148ba29f2bc4554ce8a
 * - 이슈: #890 (chore: ESLint import/no-restricted-paths error 승격)
 *
 * 현재 상태 — **enforce 모드 (error)**:
 *   ESLint 설치 완료. import/no-restricted-paths가 error로 승격되어 위반 시
 *   CI에서 lint job이 fail한다.
 *
 * 경계 정책 (ADR Phase 1 결정 → Phase 5에서 enforce):
 *   1. `src/features/*` → 다른 `src/features/*`를 직접 import 금지
 *      공통 코드는 `src/shared/` 하위로 추출 (type / util / port).
 *   2. `src/shared/*` → `src/features/*`를 import 금지 (shared는 features 모름)
 *
 * @see docs/adr/ — 도메인 ADR 디렉토리
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['import', '@typescript-eslint', 'react-hooks'],
  // 기존 코드에 `eslint-disable-next-line react-hooks/exhaustive-deps` 주석이 산재해 있어
  // react-hooks 플러그인을 등록한다. 실제 룰 enforce는 본 PR 스코프 밖이므로 off로 두고,
  // disable directive가 unknown 룰로 fail하는 것만 막는다.
  reportUnusedDisableDirectives: false,
  settings: {
    'import/resolver': {
      typescript: { alwaysTryTypes: true, project: './tsconfig.json' },
      node: { extensions: ['.js', '.jsx', '.ts', '.tsx'] },
    },
  },
  ignorePatterns: [
    'node_modules/',
    'ios/',
    'android/',
    'backend/',
    'modules/',
    'targets/',
    'scripts/',
    'coverage/',
    '.expo/',
    'dist/',
    'jest.setup.js',
    '*.config.js',
    'metro.config.js',
    'babel.config.js',
  ],
  rules: {
    // react-hooks 룰은 본 PR에서 enforce하지 않는다 (스코프: 디렉토리 경계만).
    'react-hooks/exhaustive-deps': 'off',
    'react-hooks/rules-of-hooks': 'off',
    'import/no-restricted-paths': [
      'error',
      {
        zones: [
          // shared/는 features/를 모른다 — 역참조 금지
          {
            target: './src/shared',
            from: './src/features',
            message:
              'shared/는 features/를 import 할 수 없습니다 (의존 방향: features → shared).',
          },
          // features/끼리는 직접 의존 금지 — 슬라이스별 zone으로 sibling import 차단.
          // (import/no-restricted-paths는 target == from의 sub-tree 내부 import는 허용하므로,
          //  슬라이스마다 from에 나머지 sibling을 명시한다.)
          {
            target: './src/features/alarm',
            from: [
              './src/features/arrival',
              './src/features/map',
              './src/features/nearest-station',
              './src/features/route',
              './src/features/settings',
              './src/features/widget',
            ],
            message:
              'feature 슬라이스끼리 직접 import 할 수 없습니다. 공통 코드는 shared/로 추출하세요.',
          },
          {
            target: './src/features/arrival',
            from: [
              './src/features/alarm',
              './src/features/map',
              './src/features/nearest-station',
              './src/features/route',
              './src/features/settings',
              './src/features/widget',
            ],
            message:
              'feature 슬라이스끼리 직접 import 할 수 없습니다. 공통 코드는 shared/로 추출하세요.',
          },
          {
            target: './src/features/map',
            from: [
              './src/features/alarm',
              './src/features/arrival',
              './src/features/nearest-station',
              './src/features/route',
              './src/features/settings',
              './src/features/widget',
            ],
            message:
              'feature 슬라이스끼리 직접 import 할 수 없습니다. 공통 코드는 shared/로 추출하세요.',
          },
          {
            target: './src/features/nearest-station',
            from: [
              './src/features/alarm',
              './src/features/arrival',
              './src/features/map',
              './src/features/route',
              './src/features/settings',
              './src/features/widget',
            ],
            message:
              'feature 슬라이스끼리 직접 import 할 수 없습니다. 공통 코드는 shared/로 추출하세요.',
          },
          {
            target: './src/features/route',
            from: [
              './src/features/alarm',
              './src/features/arrival',
              './src/features/map',
              './src/features/nearest-station',
              './src/features/settings',
              './src/features/widget',
            ],
            message:
              'feature 슬라이스끼리 직접 import 할 수 없습니다. 공통 코드는 shared/로 추출하세요.',
          },
          {
            target: './src/features/settings',
            from: [
              './src/features/alarm',
              './src/features/arrival',
              './src/features/map',
              './src/features/nearest-station',
              './src/features/route',
              './src/features/widget',
            ],
            message:
              'feature 슬라이스끼리 직접 import 할 수 없습니다. 공통 코드는 shared/로 추출하세요.',
          },
          {
            target: './src/features/widget',
            from: [
              './src/features/alarm',
              './src/features/arrival',
              './src/features/map',
              './src/features/nearest-station',
              './src/features/route',
              './src/features/settings',
            ],
            message:
              'feature 슬라이스끼리 직접 import 할 수 없습니다. 공통 코드는 shared/로 추출하세요.',
          },
        ],
      },
    ],
  },
};
