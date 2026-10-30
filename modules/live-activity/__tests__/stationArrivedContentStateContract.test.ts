/**
 * #3221 PR-3 — 매역 도착 DI 축소 표시 필드(arrivedStationName / arrivedUntilEpochSec)의 native MIRROR 2벌 + JS 타입 +
 * backend 산출 + 위젯 compact 렌더 참조 계약. Swift는 jest 실행 불가라 소스 텍스트로 고정한다.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const stripComments = (s: string) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const POD_ATTRS = read('modules/live-activity/ios/SubwayActivityAttributes.swift');
const SHARED_ATTRS = read('targets/subway-widget/_shared/SubwayActivityAttributes.swift');
const JS_TYPES = read('modules/live-activity/index.ts');
const WIDGET = stripComments(read('targets/subway-widget/SubwayLiveActivityWidget.swift'));
const BACKEND = read('backend/alarm-worker/src/liveActivity.ts');

const FIELDS: Array<[string, string, string]> = [
  ['arrivedStationName', 'String', 'string'],
  ['arrivedUntilEpochSec', 'Int', 'number'],
];

describe('매역 도착 DI 축소 표시 필드 계약 (#3221 PR-3)', () => {
  for (const [field, swiftType, tsType] of FIELDS) {
    it(`${field}: Swift MIRROR 2벌 optional 선언 + JS optional 타입 + backend가 같은 키로 산출`, () => {
      const swiftDecl = new RegExp(`var ${field}: ${swiftType}\\?`);
      expect(POD_ATTRS).toMatch(swiftDecl);
      expect(SHARED_ATTRS).toMatch(swiftDecl);
      expect(JS_TYPES).toMatch(new RegExp(`${field}\\?: ${tsType};`));
      expect(BACKEND).toContain(`${field}:`);
    });

    it(`${field}: 위젯이 실제로 참조한다 (선언만 있고 미소비 금지)`, () => {
      expect(WIDGET).toMatch(new RegExp(`\\b${field}\\b`));
    });
  }

  it('위젯 compact: 도착 표시는 만료 시각(epoch 초)과 현재 시각을 비교한다 (만료 후 기존 표시로 복귀)', () => {
    expect(WIDGET).toMatch(/timeIntervalSince1970/);
  });

  it('위젯: 도착 문구 3개 키를 쓰고 Localizable.xcstrings에 4개 언어로 존재한다', () => {
    const keys = [
      'widget.la.journey.islandArrived',
      'widget.la.journey.islandArrivedEtaTransfer',
      'widget.la.journey.islandArrivedEtaDestination',
    ];
    const catalog = JSON.parse(read('targets/subway-widget/Localizable.xcstrings')) as {
      strings: Record<string, { localizations: Record<string, unknown> }>;
    };
    for (const key of keys) {
      expect(WIDGET).toContain(`"${key}"`);
      expect(Object.keys(catalog.strings[key]?.localizations ?? {}).sort()).toEqual(['en', 'ja', 'ko', 'zh-Hans']);
    }
  });

  it('MIRROR 2벌의 코드(주석 제외)가 byte 동일하다', () => {
    expect(stripComments(POD_ATTRS)).toBe(stripComments(SHARED_ATTRS));
  });
});
