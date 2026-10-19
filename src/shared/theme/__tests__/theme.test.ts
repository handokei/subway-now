import { colors, lightColors, darkColors, font, typography, spacing, radius, lineTint, rgba } from '../theme';
import type { ThemeColors } from '../theme';
import type { LineNumber } from '../../types/station';

const ALL_LINES: LineNumber[] = [
  '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'airport', 'gyeongui', 'bundang', 'sinbundang',
];

describe('theme', () => {
  describe('colors', () => {
    it('should have all base color tokens', () => {
      // 디자인 결정(#3065): Editorial Light → Line Glass Light 토큰
      expect(colors.bg).toBe('#F3F5F4');
      expect(colors.ink).toBe('#0E1512');
      expect(colors.muted).toBe('#55605B');
      expect(colors.subtle).toBe('#8A948F');
      expect(colors.hair).toBe('rgba(14,21,18,0.07)');
      expect(colors.accent).toBe('#0E1512');
      expect(colors.warn).toBe('#ff9f43');
    });

    it('should have line colors for all LineNumber values', () => {
      for (const line of ALL_LINES) {
        expect(colors.line[line]).toBeDefined();
        expect(typeof colors.line[line]).toBe('string');
        expect(colors.line[line].length).toBeGreaterThan(0);
      }
    });

    it('should have correct Seoul Metro official colors for lines 1-9', () => {
      expect(colors.line['1']).toBe('#0052A4');
      expect(colors.line['2']).toBe('#009D3E');
      expect(colors.line['3']).toBe('#EF7C1C');
      expect(colors.line['4']).toBe('#00A2D1');
      expect(colors.line['5']).toBe('#996CAC');
      expect(colors.line['6']).toBe('#CD7C2F');
      expect(colors.line['7']).toBe('#747F00');
      expect(colors.line['8']).toBe('#E6186C');
      expect(colors.line['9']).toBe('#BDB092');
    });

    it('should have colors for special lines', () => {
      expect(colors.line.airport).toBe('#4B81BF');
      expect(colors.line.gyeongui).toBe('#77C4A3');
      expect(colors.line.bundang).toBe('#F5A200');
      expect(colors.line.sinbundang).toBe('#D4003B');
    });

    it('should have new theme tokens (card, onAccent, overlay)', () => {
      // 디자인 결정(#3065): card = 반투명 글래스 채움, overlay/danger 값 갱신
      expect(colors.card).toBe('rgba(255,255,255,0.55)');
      expect(colors.onAccent).toBe('#ffffff');
      expect(colors.overlay).toBe('rgba(0,0,0,0.35)');
      expect(colors.success).toBe('#22c55e');
      expect(colors.danger).toBe('#D43B2A');
    });
  });

  describe('lightColors / darkColors', () => {
    it('colors는 lightColors와 동일하다 (역호환)', () => {
      expect(colors).toBe(lightColors);
    });

    it('lightColors와 darkColors는 동일한 키를 가진다', () => {
      const lightKeys = Object.keys(lightColors).sort();
      const darkKeys = Object.keys(darkColors).sort();
      expect(lightKeys).toEqual(darkKeys);
    });

    it('darkColors는 Line Glass 나이트 테마 값을 가진다', () => {
      // 디자인 결정(#3065): C·Focus(퓨어블랙+라임) → Line Glass Night
      expect(darkColors.bg).toBe('#07090A');
      expect(darkColors.card).toBe('rgba(255,255,255,0.06)');
      expect(darkColors.ink).toBe('#F2F5F3');
      expect(darkColors.muted).toBe('#8C9A93');
      expect(darkColors.subtle).toBe('#6E7A74');
      expect(darkColors.hair).toBe('rgba(255,255,255,0.08)');
      expect(darkColors.overlay).toBe('rgba(0,0,0,0.7)');
      expect(darkColors.accent).toBe('#F2F5F3');
      expect(darkColors.onAccent).toBe('#07090A');
    });

    it('글래스 토큰과 blurTint가 라이트/나이트에서 정의된다', () => {
      expect(lightColors.blurTint).toBe('light');
      expect(darkColors.blurTint).toBe('dark');
      for (const key of ['glass', 'glassStrong', 'glassBorder', 'glassHighlight', 'segmentTrack', 'segmentActive', 'fieldFill'] as const) {
        expect(typeof lightColors[key]).toBe('string');
        expect(typeof darkColors[key]).toBe('string');
      }
    });

    it('테마 불변 토큰은 양쪽 동일하다', () => {
      expect(lightColors.warn).toBe(darkColors.warn);
      expect(lightColors.line).toEqual(darkColors.line);
    });

    it('ThemeColors 타입이 존재한다', () => {
      const themed: ThemeColors = lightColors;
      expect(themed.bg).toBeDefined();
    });
  });

  describe('font', () => {
    it('should use system fallback (undefined) for text fonts before Pretendard', () => {
      expect(font.regular).toBeUndefined();
      expect(font.medium).toBeUndefined();
      expect(font.semibold).toBeUndefined();
      expect(font.bold).toBeUndefined();
    });

    it('should use Menlo for monospace', () => {
      expect(font.mono).toBe('Menlo');
    });
  });

  describe('typography', () => {
    it('should define all type scales', () => {
      const scales = ['hero', 'title', 'countMM', 'countSS', 'body', 'bodySm', 'label', 'mono'] as const;
      for (const scale of scales) {
        expect(typography[scale]).toBeDefined();
        expect(typeof typography[scale].fontSize).toBe('number');
      }
    });

    it('should have correct hero style', () => {
      // 디자인 결정(#3065): hero 44 → 64
      expect(typography.hero.fontSize).toBe(64);
      expect(typography.hero.letterSpacing).toBe(-3);
    });

    it('label은 대문자 변환 없는 작은 세미볼드 라벨이다', () => {
      // 디자인 결정(#3065): 대문자 라벨 톤 폐기(한글에 어색)
      expect(typography.label).not.toHaveProperty('textTransform');
      expect(typography.label.fontSize).toBe(12);
      expect(typography.label.fontWeight).toBe('600');
    });

    it('should use mono font for mono style', () => {
      expect(typography.mono.fontFamily).toBe('Menlo');
    });
  });

  describe('spacing', () => {
    it('should define all spacing values in ascending order', () => {
      expect(spacing.xs).toBe(4);
      expect(spacing.sm).toBe(8);
      expect(spacing.md).toBe(12);
      expect(spacing.lg).toBe(16);
      expect(spacing.xl).toBe(20);
      expect(spacing.xxl).toBe(24);
      expect(spacing.xxxl).toBe(32);
    });
  });

  describe('radius', () => {
    it('should define all radius values', () => {
      // 디자인 결정(#3065): 글래스 카드용 라운드 확대 + xl 신설
      expect(radius.sm).toBe(12);
      expect(radius.md).toBe(16);
      expect(radius.lg).toBe(26);
      expect(radius.xl).toBe(30);
      expect(radius.pill).toBe(999);
    });
  });

  describe('rgba', () => {
    it('hex를 rgba 문자열로 변환한다', () => {
      expect(rgba('#009D3E', 0.5)).toBe('rgba(0,157,62,0.5)');
    });
  });

  describe('lineTint', () => {
    it('라이트: 노선 base는 공식 색, text는 어둡게 섞고 tabActiveBg는 base 14%', () => {
      const t = lineTint('2', false);
      expect(t.base).toBe('#009D3E');
      expect(t.glow).toBe('rgba(0,157,62,0.5)');
      expect(t.tabActiveBg).toBe('rgba(0,157,62,0.14)');
      expect(t.text).toBe('#005622');
      expect(t.lit).toBe('#007e32');
      expect(t.glowSoft).toMatch(/^rgba\(/);
    });

    it('나이트: text/lit은 밝게 섞고 glow는 0.55', () => {
      const t = lineTint('2', true);
      expect(t.base).toBe('#009D3E');
      expect(t.glow).toBe('rgba(0,157,62,0.55)');
      expect(t.text).toBe('#8cd3a8');
      expect(t.lit).toBe('#4dba78');
      expect(t.tabActiveBg).toMatch(/^rgba\(.*0\.16\)$/);
      expect(t.glowSoft).toMatch(/0\.6\)$/);
    });

    it('line이 null/undefined면 기본 초록(#009D3E)', () => {
      expect(lineTint(null, false).base).toBe('#009D3E');
      expect(lineTint(undefined, true).base).toBe('#009D3E');
    });

    it('line이 바뀌면 base가 해당 노선색으로 바뀐다', () => {
      expect(lineTint('1', false).base).toBe('#0052A4');
    });
  });
});
