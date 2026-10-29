/**
 * #3221 PR-5 — Line Glass 토큰 parity. Swift는 jest로 실행할 수 없으므로
 * `targets/subway-widget/LineGlassTokens.swift`의 상수를 소스 텍스트로 파싱해
 * `src/shared/theme/theme.ts`(SSoT)의 lightColors/darkColors/lineTint와 값을 대조한다.
 * 토큰 1개라도 어긋나면 red.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { darkColors, lightColors, lineTint } from '../../../src/shared/theme/theme';
import { mixHex } from '../../../src/shared/theme/colorUtils';
import { LINE_COLORS } from '../../../src/shared/constants/lineColors';

const SWIFT = readFileSync(
  join(__dirname, '..', '..', '..', 'targets', 'subway-widget', 'LineGlassTokens.swift'),
  'utf8',
);

/** Swift가 미러링하는 theme.ts 토큰 키 (LA에서 쓰는 것만). */
const MIRRORED_KEYS = [
  'glassFallback',
  'glassBorder',
  'glassHighlight',
  'segmentActive',
  'inkStrong',
  'onInkStrong',
  'ink',
  'muted',
  'hair',
] as const;

interface Parsed {
  hex: string;
  alpha: number;
}

/** theme.ts 값('#RRGGBB' | 'rgba(r,g,b,a)') -> {hex, alpha}. */
function parseThemeValue(value: string): Parsed {
  const hexMatch = /^#([0-9a-f]{6})$/i.exec(value);
  if (hexMatch) return { hex: hexMatch[1].toUpperCase(), alpha: 1 };
  const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+)\)$/.exec(value);
  if (!rgba) throw new Error(`unparseable theme value: ${value}`);
  const hex = [rgba[1], rgba[2], rgba[3]]
    .map((c) => Number(c).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return { hex, alpha: Number(rgba[4]) };
}

/** `static let <name> = LineGlassPalette(` 블록 본문. */
function paletteBlock(name: 'night' | 'light'): string {
  const start = SWIFT.indexOf(`static let ${name} = LineGlassPalette(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = SWIFT.indexOf('\n    )', start);
  return SWIFT.slice(start, end);
}

function swiftToken(block: string, key: string): Parsed {
  const m = new RegExp(`\\b${key}: LGColor\\(hex: 0x([0-9A-Fa-f]{6}), alpha: ([0-9.]+)\\)`).exec(block);
  if (!m) throw new Error(`Swift token missing: ${key}`);
  return { hex: m[1].toUpperCase(), alpha: Number(m[2]) };
}

describe('Line Glass 토큰 parity (#3221 PR-5): theme.ts <-> LineGlassTokens.swift', () => {
  const cases: Array<['night' | 'light', typeof darkColors]> = [
    ['night', darkColors],
    ['light', lightColors],
  ];

  for (const [name, colors] of cases) {
    it(`${name} 팔레트 ${MIRRORED_KEYS.length}개 토큰이 theme.ts와 일치`, () => {
      const block = paletteBlock(name);
      for (const key of MIRRORED_KEYS) {
        expect({ key, ...swiftToken(block, key) }).toEqual({
          key,
          ...parseThemeValue(colors[key]),
        });
      }
    });
  }

  it('lineTint 수식 상수가 theme.ts lineTint와 일치 (모든 노선, dark/light)', () => {
    const num = (key: string) => {
      const m = new RegExp(`static let ${key} = ([0-9.]+)`).exec(SWIFT);
      if (!m) throw new Error(`Swift tint constant missing: ${key}`);
      return Number(m[1]);
    };
    const spec = {
      darkLitMix: num('darkLitMix'),
      darkTextMix: num('darkTextMix'),
      darkGlowAlpha: num('darkGlowAlpha'),
      lightLitMix: num('lightLitMix'),
      lightTextMix: num('lightTextMix'),
      lightGlowAlpha: num('lightGlowAlpha'),
    };
    for (const line of Object.keys(LINE_COLORS) as Array<keyof typeof LINE_COLORS>) {
      const base = LINE_COLORS[line];
      const dark = lineTint(line, true);
      const light = lineTint(line, false);
      expect(mixHex(base, '#ffffff', spec.darkLitMix)).toBe(dark.lit);
      expect(mixHex(base, '#ffffff', spec.darkTextMix)).toBe(dark.text);
      expect(dark.glow).toContain(`, ${spec.darkGlowAlpha})`);
      expect(mixHex(base, '#000000', spec.lightLitMix)).toBe(light.lit);
      expect(mixHex(base, '#000000', spec.lightTextMix)).toBe(light.text);
      expect(light.glow).toContain(`, ${spec.lightGlowAlpha})`);
    }
  });
});
