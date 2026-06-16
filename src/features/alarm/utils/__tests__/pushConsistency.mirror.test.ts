/**
 * backend/frontend pushConsistency.ts mirror 동기화 가드 (#1389 P1-2).
 *
 * 두 파일은 동일 로직을 mirror로 유지해야 한다 (현재 backend/frontend 빌드 분리 정책).
 * 첫 번째 doc 주석 블록만 backend/frontend 경로를 가리키므로 다르고,
 * 그 외 모든 본문(타입 정의 + 함수 본문 + 스텝 주석)은 정확히 동일해야 한다.
 *
 * 한쪽만 수정해서 정합성 게이트 자체가 정합성을 잃는 회귀를 차단.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FRONTEND_PATH = resolve(__dirname, '../pushConsistency.ts');
const BACKEND_PATH = resolve(
  __dirname,
  '../../../../../backend/alarm-worker/src/pushConsistency.ts',
);

// 첫 번째 doc 주석 블록만 잘라낸다. 헤더는 backend/frontend 경로를 가리키므로
// 다르지만 그 외 본문은 동일해야 한다.
const HEADER_DOC_RE = /^\/\*\*[\s\S]*?\*\/\s*/;
function stripHeaderDocComment(src: string): string {
  const match = HEADER_DOC_RE.exec(src);
  return match ? src.slice(match[0].length) : src;
}

describe('pushConsistency — backend/frontend mirror sync (#1389)', () => {
  it('두 파일이 동일한 helper 본문(타입+함수+스텝 주석)을 갖는다', () => {
    const frontendSrc = readFileSync(FRONTEND_PATH, 'utf-8');
    const backendSrc = readFileSync(BACKEND_PATH, 'utf-8');

    const frontendBody = stripHeaderDocComment(frontendSrc);
    const backendBody = stripHeaderDocComment(backendSrc);

    expect(frontendBody).toBe(backendBody);
  });

  it('두 파일 모두 헤더 doc 주석에서 mirror 위치를 명시한다 (개발자 수동 동기 알림)', () => {
    const frontendSrc = readFileSync(FRONTEND_PATH, 'utf-8');
    const backendSrc = readFileSync(BACKEND_PATH, 'utf-8');

    expect(frontendSrc).toContain('backend mirror: backend/alarm-worker/src/pushConsistency.ts');
    expect(backendSrc).toContain('frontend mirror: src/features/alarm/utils/pushConsistency.ts');
  });
});
