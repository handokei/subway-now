/**
 * Node가 **직접** 로드하는 src 모듈의 값 상대 import는 `.ts` 확장자를 명시해야 한다.
 *
 * ## 왜 이 테스트가 있나 (실측 사고)
 *
 * `src/checkTripMetricsRegression.ts`가 `from './tripMetricsRegressionQuery'`(확장자 없음)로
 * 쓰여 있어 `npm run check:trip-metrics-regression`이 `ERR_MODULE_NOT_FOUND`로 **실행 자체가
 * 불가능**했다. 그런데 `checkTripMetricsRegression.test.ts` 12건은 **전부 통과**했다 — vitest
 * 리졸버는 확장자를 추론하지만 Node ESM 해석기는 추론하지 않기 때문이다.
 *
 * 그 결과 #2795 회귀 감시 런북이 "코드는 있고 테스트도 green인데 한 번도 돌지 않는" 상태로
 * 남았다. 유닛 테스트로는 원리적으로 못 잡는 종류라 **이 정적 검사로 승격**한다
 * (CLAUDE.md 불변식 승격 룰 — 주석만 남기고 지나가지 않는다).
 *
 * ## 범위
 *
 * `scripts/*.mjs`가 `from '../src/<name>.ts'`로 import하는 모듈 **전체를 파일에서 도출**한다
 * (하드코딩 금지 — 스크립트가 늘면 자동으로 따라간다). 그 모듈들의 **값** 상대 import만 본다.
 * `import type`은 타입 스트리핑에 지워져 Node가 해석하지 않으므로 대상이 아니다
 * (`replayFixture.ts`가 확장자 없이도 동작하는 이유).
 *
 * 번들러/vitest를 경유하는 나머지 src 파일(확장자 없는 상대 import 278건)은 대상이 아니다.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const BACKEND_DIR = path.resolve(__dirname, '../..');
const SCRIPTS_DIR = path.join(BACKEND_DIR, 'scripts');
const SRC_DIR = path.join(BACKEND_DIR, 'src');

/** `scripts/*.mjs` 가 Node로 직접 로드하는 `src/<name>.ts` 목록. */
function findNodeLoadedModules(): string[] {
  const found = new Set<string>();
  for (const entry of readdirSync(SCRIPTS_DIR)) {
    if (!entry.endsWith('.mjs')) continue;
    const source = readFileSync(path.join(SCRIPTS_DIR, entry), 'utf8');
    for (const match of source.matchAll(/from\s+'\.\.\/src\/([A-Za-z0-9_-]+)\.ts'/g)) {
      found.add(match[1]);
    }
  }
  return [...found].sort();
}

/** 해당 모듈의 **값** 상대 import 중 `.ts` 확장자가 없는 것. `import type`은 제외. */
function valueRelativeImportsMissingExtension(moduleName: string): string[] {
  const source = readFileSync(path.join(SRC_DIR, `${moduleName}.ts`), 'utf8');
  const offenders: string[] = [];
  for (const match of source.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+'(\.\.?\/[^']+)';/gm)) {
    const [, typeOnly, specifier] = match;
    if (typeOnly) continue;
    if (specifier.endsWith('.ts')) continue;
    offenders.push(specifier);
  }
  return offenders;
}

describe('Node 직접 로드 모듈의 값 상대 import는 .ts 확장자 필수', () => {
  const modules = findNodeLoadedModules();

  it('scripts/*.mjs가 로드하는 src 모듈을 최소 1개 찾는다 (탐지 자체가 죽으면 이 테스트는 무의미)', () => {
    expect(modules.length).toBeGreaterThan(0);
  });

  it.each(modules)('src/%s.ts — 확장자 없는 값 상대 import가 없다', (moduleName) => {
    expect(valueRelativeImportsMissingExtension(moduleName)).toEqual([]);
  });
});
