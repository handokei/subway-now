/**
 * #3221 PR-5 — 여정 LA 진행 막대 필드(legStopsTotal / nextLegStopsTotal / nextLineColorHex)의
 * native MIRROR 2벌 + JS 타입 + 위젯 렌더 참조 계약. Swift는 jest 실행 불가라 소스 텍스트로 고정.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..', '..');
const POD_ATTRS = readFileSync(join(ROOT, 'modules/live-activity/ios/SubwayActivityAttributes.swift'), 'utf8');
const SHARED_ATTRS = readFileSync(join(ROOT, 'targets/subway-widget/_shared/SubwayActivityAttributes.swift'), 'utf8');
const JS_TYPES = readFileSync(join(ROOT, 'modules/live-activity/index.ts'), 'utf8');
const WIDGET = readFileSync(join(ROOT, 'targets/subway-widget/SubwayLiveActivityWidget.swift'), 'utf8');

const FIELDS: Array<[string, string, string]> = [
  ['legStopsTotal', 'Int', 'number'],
  ['nextLegStopsTotal', 'Int', 'number'],
  ['nextLineColorHex', 'String', 'string'],
  ['nextStationName', 'String', 'string'],
  ['nextLineName', 'String', 'string'],
  ['nextLineDirection', 'String', 'string'],
];

const stripComments = (s: string) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

describe('여정 LA 진행 막대 필드 계약 (#3221 PR-5)', () => {
  for (const [field, swiftType, tsType] of FIELDS) {
    it(`${field}: Swift MIRROR 2벌 optional 선언 + JS optional 타입`, () => {
      const swiftDecl = new RegExp(`var ${field}: ${swiftType}\\?`);
      expect(POD_ATTRS).toMatch(swiftDecl);
      expect(SHARED_ATTRS).toMatch(swiftDecl);
      expect(JS_TYPES).toMatch(new RegExp(`${field}\\?: ${tsType};`));
    });

    it(`${field}: 위젯 렌더가 실제로 참조한다 (선언만 있고 미소비 금지)`, () => {
      expect(stripComments(WIDGET)).toMatch(new RegExp(`\\b${field}\\b`));
    });
  }

  it('위젯: Night/Light(colorScheme) + AOD(isLuminanceReduced) 분기, glassFallback 배경 tint, 구 주황/빨강 전체 배경 제거', () => {
    const code = stripComments(WIDGET);
    expect(code).toMatch(/@Environment\(\\\.colorScheme\)/);
    expect(code).toMatch(/@Environment\(\\\.isLuminanceReduced\)/);
    expect(code).toMatch(/\.activityBackgroundTint\(/);
    expect(code).toMatch(/glassHighlight/);
    expect(code).not.toMatch(/Color\.orange|Color\.red|\.orange\.opacity|\.red\.opacity/);
  });

  it('위젯: 환승 진입=[환승] 알약 / 목적지 진입=[하차] inkStrong 알약 (alarmType 분기)', () => {
    const code = stripComments(WIDGET);
    expect(code).toContain('widget.la.journey.transferBadge');
    expect(code).toContain('widget.la.journey.alightBadge');
    expect(code).toMatch(/inkStrong/);
  });

  it('위젯: "다음 {역}" 라벨 + 환승 카드 "지금 내려서 {노선} {방면} 방면으로" 키를 쓴다 (없으면 기존 폴백 유지)', () => {
    const code = stripComments(WIDGET);
    expect(code).toContain('widget.la.journey.nextStation');
    expect(code).toContain('widget.la.journey.transferHintTo');
    expect(code).toContain('widget.la.journey.currentStation'); // nextStationName 없을 때 폴백
    expect(code).toContain('widget.la.journey.transferHint'); // nextLineName 없을 때 폴백
  });

  it('위젯: deviceFallback 칩을 만들지 않는다 (U6 — sourceLabel은 기존 텍스트 그대로)', () => {
    expect(stripComments(WIDGET)).not.toMatch(/deviceFallback/);
  });

  it('위젯이 쓰는 widget.la.journey.* 키가 Localizable.xcstrings에 4개 언어로 존재한다', () => {
    const catalog = JSON.parse(
      readFileSync(join(ROOT, 'targets/subway-widget/Localizable.xcstrings'), 'utf8'),
    ) as { strings: Record<string, { localizations: Record<string, unknown> }> };
    const used = Array.from(new Set(WIDGET.match(/widget\.la\.journey\.\w+/g) ?? []));
    expect(used.length).toBeGreaterThan(0);
    for (const key of used) {
      expect(Object.keys(catalog.strings[key]?.localizations ?? {}).sort()).toEqual(['en', 'ja', 'ko', 'zh-Hans']);
    }
  });

  it('MIRROR 2벌의 코드(주석 제외)가 byte 동일하다', () => {
    expect(stripComments(POD_ATTRS)).toBe(stripComments(SHARED_ATTRS));
  });
});
