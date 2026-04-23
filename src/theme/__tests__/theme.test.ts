import { colors, font, typography, spacing, radius } from '../theme';
import type { LineNumber } from '../../types/station';

const ALL_LINES: LineNumber[] = [
  '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'airport', 'gyeongui', 'bundang', 'sinbundang',
];

describe('theme', () => {
  describe('colors', () => {
    it('should have all base color tokens', () => {
      expect(colors.bg).toBe('#F5F2EC');
      expect(colors.ink).toBe('#1A1814');
      expect(colors.muted).toBe('#6B6459');
      expect(colors.subtle).toBe('#A8A197');
      expect(colors.hair).toBe('rgba(26,24,20,0.08)');
      expect(colors.accent).toBe('#C8553D');
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
      expect(typography.hero.fontSize).toBe(44);
      expect(typography.hero.letterSpacing).toBe(-1.4);
    });

    it('should have uppercase label', () => {
      expect(typography.label.textTransform).toBe('uppercase');
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
      expect(radius.sm).toBe(6);
      expect(radius.md).toBe(10);
      expect(radius.lg).toBe(14);
      expect(radius.pill).toBe(999);
    });
  });
});
