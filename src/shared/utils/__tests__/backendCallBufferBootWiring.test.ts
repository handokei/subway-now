/**
 * #3055 PR-0b — `hydrateBackendCallBuffer`는 boot(`app/_layout.tsx`)에서 호출돼야 한다.
 *
 * 프로덕션 호출자가 0건이던 동안 cold launch 후 첫 push가 직전 세션 기록을 덮었다. 배선 줄이 사라지면
 * (다른 hydrate들처럼 module top-level fire-and-forget) 이 가드가 red가 된다.
 * (`registerHealthSingleWriter.test.ts`와 같은 정적 소스 스캔 패턴, 주석 줄 제외)
 */
import * as fs from 'fs';
import * as path from 'path';

const LAYOUT_FILE = path.resolve(__dirname, '../../../../app/_layout.tsx');

function codeLines(source: string): string[] {
  return source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
}

describe('backendCallBuffer boot wiring (#3055 PR-0b)', () => {
  const lines = codeLines(fs.readFileSync(LAYOUT_FILE, 'utf8'));

  it('app/_layout.tsx가 hydrateBackendCallBuffer를 import한다', () => {
    expect(
      lines.some((l) => l.includes('hydrateBackendCallBuffer') && l.includes('shared/utils/backendCallBuffer')),
    ).toBe(true);
  });

  it('module top-level에서 hydrateBackendCallBuffer()를 호출한다(들여쓰기 없음 = boot 시 1회)', () => {
    expect(lines.filter((l) => l.startsWith('hydrateBackendCallBuffer()'))).toHaveLength(1);
  });
});
