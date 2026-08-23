/**
 * #2303 재발 차단 가드.
 *
 * 네이티브(위젯/Live Activity)·알림 코드가 앱 커스텀 스킴(`subwaynow://...`) 딥링크
 * URL 문자열을 만들면, 그 path에 대응하는 expo-router route 파일(`app/**`)이 실재해야
 * 한다. producer(SubwayWidget.swift 등)가 새 딥링크를 추가해도 이 테스트가 자동으로
 * 스캔 대상에 포함되므로 하드코딩된 path 목록을 유지할 필요가 없다(글로벌 규칙 3).
 *
 * 원본 결함(#2303): SubwayWidget.swift가 `subwaynow://current-station`을 위젯 탭 시
 * 딥링크로 방출했지만 `app/current-station.tsx` route가 없어 expo-router가
 * "Unmatched Route"를 표출했다.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');

/** app.config.js에서 등록된 커스텀 URL scheme을 읽는다 (하드코딩 금지, SSoT 참조). */
function readAppScheme(): string {
  const configSrc = fs.readFileSync(path.join(ROOT, 'app.config.js'), 'utf8');
  const match = configSrc.match(/scheme:\s*['"]([a-zA-Z0-9+.-]+)['"]/);
  if (!match) throw new Error('app.config.js에서 scheme 필드를 찾지 못했습니다.');
  return match[1];
}

/** 디렉토리를 재귀 순회하며 주어진 확장자의 파일 경로를 모두 수집한다. */
function collectFiles(dir: string, extensions: string[]): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectFiles(fullPath, extensions);
    if (extensions.some((ext) => entry.name.endsWith(ext))) return [fullPath];
    return [];
  });
}

/** 네이티브/알림 producer 코드가 위치할 수 있는 디렉토리 전수 — 새 producer 추가 시 여기만 확장. */
const PRODUCER_DIRS = [
  path.join(ROOT, 'targets'),
  path.join(ROOT, 'modules'),
  path.join(ROOT, 'src', 'features', 'alarm'),
  path.join(ROOT, 'src', 'features', 'widget'),
];
const PRODUCER_EXTENSIONS = ['.swift', '.ts', '.tsx'];

type DeepLink = { file: string; scheme: string; routePath: string };

/** producer 파일들에서 `scheme://path` 형태의 커스텀 딥링크 URL 문자열을 전수 추출한다. */
function extractDeepLinks(appScheme: string): DeepLink[] {
  const urlPattern = new RegExp(`${appScheme}://([a-zA-Z0-9\\-_/]*)`, 'g');
  const links: DeepLink[] = [];

  for (const dir of PRODUCER_DIRS) {
    for (const file of collectFiles(dir, PRODUCER_EXTENSIONS)) {
      if (file.includes(`${path.sep}__tests__${path.sep}`)) continue;
      const content = fs.readFileSync(file, 'utf8');
      for (const match of content.matchAll(urlPattern)) {
        links.push({ file, scheme: appScheme, routePath: match[1] });
      }
    }
  }
  return links;
}

/** routePath(예: "current-station")에 대응하는 expo-router route 파일 후보가 실재하는지 확인. */
function routeExists(routePath: string): boolean {
  if (routePath === '') return true; // scheme://만 있는 경우 = 앱 루트, 항상 존재
  const candidates = [
    path.join(ROOT, 'app', `${routePath}.tsx`),
    path.join(ROOT, 'app', routePath, 'index.tsx'),
    path.join(ROOT, 'app', '(tabs)', `${routePath}.tsx`),
  ];
  return candidates.some((candidate) => fs.existsSync(candidate));
}

describe('딥링크 producer ↔ expo-router route 대응 (#2303 재발 차단)', () => {
  const appScheme = readAppScheme();
  const deepLinks = extractDeepLinks(appScheme);

  it('앱 scheme으로 최소 1개의 딥링크 producer가 스캔되어야 한다 (가드 자체의 무의미화 방지)', () => {
    expect(deepLinks.length).toBeGreaterThan(0);
  });

  it.each(deepLinks.map((link) => [`${link.scheme}://${link.routePath} (${path.relative(ROOT, link.file)})`, link] as const))(
    '%s → app/ route가 실재해야 한다',
    (_label, link) => {
      expect(routeExists(link.routePath)).toBe(true);
    },
  );
});
