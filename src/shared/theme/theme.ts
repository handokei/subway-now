// theme.ts — 디자인 토큰 (라이트/다크) · Line Glass
// 기존 키(bg/card/ink/...)는 전부 유지 — 기존 화면은 import 변경 없이 새 톤을 받는다.
// 신규 키(glass*, segment*, tab*)는 GlassCard / GlassTabBar / 세그먼트 컨트롤에서 사용.

import type { LineNumber } from '../types/station';
import { LINE_COLORS } from '../constants/lineColors';

const sharedColors = {
  warn: '#ff9f43',
  line: { ...LINE_COLORS } as Record<LineNumber, string>,
};

// Line Glass · Light
export const lightColors = {
  ...sharedColors,
  bg:            '#F3F5F4',                 // 쿨 오프화이트 (노선 글로우가 이 위에 깔림)
  card:          'rgba(255,255,255,0.55)',  // 글래스 카드 채움 (blur 미지원 시에도 읽히는 농도)
  ink:           '#0E1512',
  muted:         '#55605B',
  subtle:        '#8A948F',
  hair:          'rgba(14,21,18,0.07)',
  overlay:       'rgba(0,0,0,0.35)',
  bgTranslucent: 'rgba(243,245,244,0.85)',
  accent:        '#0E1512',                 // 주 CTA = 잉크 블랙 알약 (노선색은 lineTint로)
  onAccent:      '#ffffff',
  success:       '#22c55e',
  danger:        '#D43B2A',
  // ── Line Glass 신규 토큰
  glass:          'rgba(255,255,255,0.55)',
  glassStrong:    'rgba(255,255,255,0.66)', // 지도 위 카드처럼 배경이 복잡할 때
  glassBorder:    'rgba(255,255,255,0.90)',
  glassHighlight: 'rgba(255,255,255,1)',    // 카드 상단 1px 하이라이트
  segmentTrack:   'rgba(14,21,18,0.06)',
  segmentActive:  '#ffffff',
  fieldFill:      'rgba(14,21,18,0.05)',    // 카드 안 보조 버튼/칩
  blurTint:       'light' as 'light' | 'dark',
};

// Line Glass · Night
export const darkColors: typeof lightColors = {
  ...sharedColors,
  bg:            '#07090A',
  card:          'rgba(255,255,255,0.06)',
  ink:           '#F2F5F3',
  muted:         '#8C9A93',
  subtle:        '#6E7A74',
  hair:          'rgba(255,255,255,0.08)',
  overlay:       'rgba(0,0,0,0.7)',
  bgTranslucent: 'rgba(7,9,10,0.85)',
  accent:        '#F2F5F3',                 // 주 CTA = 화이트 알약
  onAccent:      '#07090A',
  success:       '#22c55e',
  danger:        '#FF7F70',
  glass:          'rgba(255,255,255,0.06)',
  glassStrong:    'rgba(22,26,24,0.62)',
  glassBorder:    'rgba(255,255,255,0.10)',
  glassHighlight: 'rgba(255,255,255,0.14)',
  segmentTrack:   'rgba(0,0,0,0.35)',
  segmentActive:  'rgba(255,255,255,0.14)',
  fieldFill:      'rgba(255,255,255,0.08)',
  blurTint:       'dark',
};

export type ThemeColors = typeof lightColors;

/** @deprecated useTheme().colors 사용 권장. 역호환용. See #126, #127 */
export const colors = lightColors;

// ── 노선 틴트 ──────────────────────────────────────────────
// 화면 배경 글로우·진행 강조색을 "지금 보고 있는 노선"에 맞춘다.
// 라이트: 텍스트용은 노선색을 어둡게(대비 4.5:1↑), 다크: 밝게(빛나는 느낌).

function hexToRgb(h: string): [number, number, number] {
  const x = h.replace('#', '');
  return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
}
function mixHex(a: string, b: string, w: number): string {
  const pa = hexToRgb(a), pb = hexToRgb(b);
  const c = pa.map((v, i) => Math.round(v * (1 - w) + pb[i] * w));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

export interface LineTint {
  base: string;      // 공식 노선색 (점·트랙)
  glow: string;      // 배경 메인 글로우
  glowSoft: string;  // 배경 보조 글로우
  text: string;      // 노선명·강조 텍스트
  lit: string;       // 진행 중 강조 (카운트다운, 토글 등)
  tabActiveBg: string;
}

export function lineTint(line: LineNumber | null | undefined, isDark: boolean): LineTint {
  const base = (line && LINE_COLORS[line]) || '#009D3E';
  return isDark
    ? {
        base,
        glow: rgba(base, 0.55),
        glowSoft: rgba(mixHex(base, '#000000', 0.35), 0.6),
        text: mixHex(base, '#ffffff', 0.55),
        lit: mixHex(base, '#ffffff', 0.3),
        tabActiveBg: rgba(mixHex(base, '#ffffff', 0.3), 0.16),
      }
    : {
        base,
        glow: rgba(base, 0.5),
        glowSoft: rgba(mixHex(base, '#ffffff', 0.6), 0.7),
        text: mixHex(base, '#000000', 0.45),
        lit: mixHex(base, '#000000', 0.2),
        tabActiveBg: rgba(base, 0.14),
      };
}

export const font = {
  regular:  undefined as string | undefined,
  medium:   undefined as string | undefined,
  semibold: undefined as string | undefined,
  bold:     undefined as string | undefined,
  mono:     'Menlo' as string | undefined,
};

export const typography = {
  hero:      { fontFamily: font.bold,     fontSize: 64, letterSpacing: -3, lineHeight: 68 },
  title:     { fontFamily: font.bold,     fontSize: 28, letterSpacing: -0.8, lineHeight: 32 },
  titleSm:   { fontFamily: font.bold,     fontSize: 22, letterSpacing: -0.5 },
  titleXs:   { fontFamily: font.bold,     fontSize: 20 },
  screen:    { fontFamily: font.bold,     fontSize: 34, letterSpacing: -1.2 },  // 탭 화면 제목
  etaBig:    { fontFamily: font.regular,  fontSize: 56, letterSpacing: -3, fontWeight: '300' as const },
  countMM:   { fontFamily: font.regular,  fontSize: 32, letterSpacing: -1.5, fontWeight: '300' as const },
  countSS:   { fontFamily: font.regular,  fontSize: 24, letterSpacing: -0.8, fontWeight: '300' as const },
  body:      { fontFamily: font.medium,   fontSize: 17, letterSpacing: -0.3 },
  bodyLg:    { fontFamily: font.medium,   fontSize: 18 },
  bodyMd:    { fontFamily: font.medium,   fontSize: 16 },
  bodyBase:  { fontFamily: font.medium,   fontSize: 15 },
  bodySm:    { fontFamily: font.medium,   fontSize: 14 },
  caption:   { fontFamily: font.medium,   fontSize: 13 },
  captionSm: { fontFamily: font.medium,   fontSize: 12 },
  micro:     { fontFamily: font.medium,   fontSize: 11 },
  badge:     { fontFamily: font.medium,   fontSize: 10 },
  // 대문자 라벨 톤 폐기 → 작은 세미볼드 라벨 (한글에 uppercase/자간이 어색했음)
  label:     { fontFamily: font.semibold, fontSize: 12, fontWeight: '600' as const },
  mono:      { fontFamily: font.mono,     fontSize: 11, letterSpacing: 0.6 },
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 };

export const radius = {
  sm: 12,
  md: 16,
  lg: 26,     // 섹션 글래스 카드
  xl: 30,     // 히어로/경로 카드
  pill: 999,
};
