/**
 * #3221 — LA 반투명 55% 배경 계약. theme.ts에 대응 값이 없는 "LA 전용 토큰"을 Swift 상수로 고정하고,
 * 여정/탑승 LA 위젯이 그 토큰을 참조하는지 소스 텍스트로 강제한다 (Swift는 jest로 실행 불가).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const WIDGET_DIR = join(__dirname, '..', '..', '..', 'targets', 'subway-widget');
const read = (name: string) => readFileSync(join(WIDGET_DIR, name), 'utf8');
const TOKENS = read('LineGlassTokens.swift');
const JOURNEY = read('SubwayLiveActivityWidget.swift');
const BOARDING = read('BoardingLiveActivityWidget.swift');

const BACKGROUND_ALPHA = 0.55;

function paletteBlock(name: 'night' | 'light'): string {
  const start = TOKENS.indexOf(`static let ${name} = LineGlassPalette(`);
  expect(start).toBeGreaterThanOrEqual(0);
  return TOKENS.slice(start, TOKENS.indexOf('\n    )', start));
}

function token(block: string, key: string) {
  const m = new RegExp(`\\b${key}: LGColor\\(hex: 0x([0-9A-Fa-f]{6}), alpha: ([0-9.]+)\\)`).exec(block);
  if (!m) throw new Error(`Swift token missing: ${key}`);
  return { hex: m[1].toUpperCase(), alpha: Number(m[2]) };
}

describe('LA 전용 반투명 토큰 (#3221)', () => {
  it('투명도 상수는 LineGlassLA.backgroundAlpha 1곳에서만 정의 (0.55)', () => {
    const m = /enum LineGlassLA \{\s*static let backgroundAlpha = ([0-9.]+)/.exec(TOKENS);
    expect(Number(m?.[1])).toBe(BACKGROUND_ALPHA);
    expect(TOKENS.match(/laBackground: LGColor\([^)]*\)/g)).toEqual([
      'laBackground: LGColor(hex: 0x181C1A, alpha: LineGlassLA.backgroundAlpha)',
      'laBackground: LGColor(hex: 0xFFFFFF, alpha: LineGlassLA.backgroundAlpha)',
    ]);
  });

  it('하이라이트·테두리가 시안(Wallpaper.dc 반투명 55%) 값', () => {
    const night = paletteBlock('night');
    const light = paletteBlock('light');
    expect(token(night, 'laHighlight')).toEqual({ hex: 'FFFFFF', alpha: 0.18 });
    expect(token(night, 'laBorder')).toEqual({ hex: 'FFFFFF', alpha: 0.12 });
    expect(token(light, 'laHighlight')).toEqual({ hex: 'FFFFFF', alpha: 1 });
    expect(token(light, 'laBorder')).toEqual({ hex: '0E1512', alpha: 0.08 });
  });

  it.each([
    ['여정 LA', JOURNEY],
    ['탑승 LA', BOARDING],
  ])('%s 위젯이 반투명 토큰을 배경·테두리·하이라이트로 쓴다', (_name, src) => {
    expect(src).toMatch(/\.activityBackgroundTint\(\w+\.laBackground\.color\)/);
    expect(src).toContain('.laBorder.color');
    expect(src).toContain('.laHighlight.color');
    expect(src).not.toMatch(/activityBackgroundTint\([^)]*(glassFallback|opacity)/);
  });

  it('탑승 LA의 private BoardingGlass는 LineGlassTokens로 통합됐다', () => {
    expect(BOARDING).not.toContain('BoardingGlass');
    expect(BOARDING).not.toContain('TODO(#3221 PR-5');
    expect(BOARDING).toContain('LineGlassPalette');
  });
});
