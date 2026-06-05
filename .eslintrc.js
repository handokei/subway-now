/**
 * ESLint 경계 룰 — Feature-based + Ports & Adapters 디렉토리 재정비 로드맵 Phase 1
 *
 * - ADR (노션): "Feature-based + Ports & Adapters 디렉토리 재정비 로드맵"
 *   https://app.notion.com/p/36e30c0194b68148ba29f2bc4554ce8a
 * - 이슈: #882 (chore: shared/ 디렉토리 신설 + theme/constants/i18n 이동 + ESLint 경계 룰)
 *
 * 현재 상태 — **허용 모드(선언만, enforce 없음)**:
 *   ESLint 자체가 devDependency로 설치되어 있지 않다.
 *   본 파일은 향후 Phase에서 ESLint를 활성화할 때 적용할 경계 룰을 미리 선언한 것이다.
 *   Phase 5(최종)에서 enforce(error) 승격 예정.
 *
 * 경계 정책 (ADR Phase 1 결정):
 *   1. `src/features/*` → 다른 `src/features/*`를 직접 import 금지
 *      (Phase 1 시점에 features/ 폴더는 미존재 — 룰만 등록)
 *   2. `src/shared/*` → `src/features/*`를 import 금지 (shared는 features 모름)
 *
 * @see docs/decisions/ — 도메인 ADR 디렉토리
 */
module.exports = {
  root: true,
  rules: {
    // 활성화 시 warn 모드로 시작. error 승격은 Phase 5.
    'import/no-restricted-paths': [
      'warn',
      {
        zones: [
          {
            // shared/는 features/를 모른다 — 역참조 금지
            target: './src/shared',
            from: './src/features',
            message:
              'shared/는 features/를 import 할 수 없습니다 (의존 방향: features → shared).',
          },
          {
            // features/끼리는 직접 의존 금지 — 공통은 shared/로 추출
            target: './src/features',
            from: './src/features',
            message:
              'feature 슬라이스끼리 직접 import 할 수 없습니다. 공통 코드는 shared/로 추출하세요.',
          },
        ],
      },
    ],
  },
};
