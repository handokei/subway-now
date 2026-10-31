/**
 * #3177 PR-7c — 이름 키 하차문 조회 경로가 구조적으로 존재하지 않는다.
 * 하차문은 역 id(stationId) 조회(resolveExitSideForStation)만 허용한다. 이름 키 모듈·데이터·타입이
 * 되살아나면 환승역에서 다른 노선의 문 방향을 집는 오안내가 재발할 수 있어 파일/키 존재로 막는다.
 */
import fs from 'fs';
import path from 'path';
import ko from '../../shared/i18n/locales/ko.json';
import en from '../../shared/i18n/locales/en.json';
import ja from '../../shared/i18n/locales/ja.json';
import zh from '../../shared/i18n/locales/zh.json';

const ROOT = path.resolve(__dirname, '../../..');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

describe('이름 키 하차문 경로 제거 (#3177 PR-7c)', () => {
  it.each([
    'src/features/route/utils/exitSide.ts',
    'src/features/route/utils/__tests__/exitSide.test.ts',
    'src/data/exitSide.json',
    'scripts/fetch-exit-side.js',
  ])('%s 는 존재하지 않는다', (rel) => {
    expect(exists(rel)).toBe(false);
  });

  it("shared/types/exitSide.ts 는 TravelDirection만 내보낸다 ('left'|'right'|'both' ExitSide 타입 없음)", () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/shared/types/exitSide.ts'), 'utf8');
    expect(src).toContain('TravelDirection');
    expect(src).not.toMatch(/ExitSideEntry|ExitSideMap|type ExitSide\b/);
  });

  it.each([
    ['ko', ko],
    ['en', en],
    ['ja', ja],
    ['zh', zh],
  ])("%s locale 에 'both' 안내(alarms.exitSideBoth)가 없다 — 어떤 하차문도 양쪽이 아니다", (_lang, locale) => {
    expect(Object.keys((locale as { alarms: Record<string, string> }).alarms)).not.toContain('exitSideBoth');
  });
});
