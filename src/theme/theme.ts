// theme.ts — 디자인 토큰 (라이트/다크)
// 앱 전체에서 import하여 사용. 색/폰트/간격을 한 곳에서 관리.

import type { LineNumber } from '../types/station';
import { LINE_COLORS } from '../constants/lineColors';

// 테마 불변 토큰
const sharedColors = {
  accent:   '#00D4FF',                 // CTA, 강조 (시안)
  warn:     '#ff9f43',                 // 경고 (mock 데이터 등)
  onAccent: '#000000',                 // accent 배경 위 텍스트
  line: { ...LINE_COLORS } as Record<LineNumber, string>,
};

export const lightColors = {
  ...sharedColors,
  bg:      '#1a1a2e',                  // 딥 네이비 배경
  card:    '#16213e',                  // 네이비 카드
  ink:     '#ffffff',                  // 순백 텍스트
  muted:   '#8888aa',                  // 보조 텍스트
  subtle:  '#aaaacc',                  // 메타 정보
  hair:    '#2a2a4a',                  // divider
  overlay: 'rgba(0,0,0,0.6)',          // 모달 배경
};

export const darkColors = {
  ...sharedColors,
  bg:      '#000000',                  // AMOLED 퓨어 블랙
  card:    '#111111',                  // 약간 밝은 카드
  ink:     '#ffffff',                  // 순백 텍스트
  muted:   '#888888',                  // 보조 텍스트
  subtle:  '#666666',                  // 메타 정보
  hair:    '#222222',                  // divider
  overlay: 'rgba(0,0,0,0.8)',          // 모달 배경
};

export type ThemeColors = typeof lightColors;

/** @deprecated useTheme().colors 사용 권장. 역호환용. See #126, #127 */
export const colors = lightColors;

export const font = {
  // Pretendard 폰트 적용 전까지 시스템 기본 폰트 사용
  regular:  undefined as string | undefined,
  medium:   undefined as string | undefined,
  semibold: undefined as string | undefined,
  bold:     undefined as string | undefined,
  mono:     'Menlo' as string | undefined,
};

export const typography = {
  hero:    { fontFamily: font.bold,     fontSize: 44, letterSpacing: -1.4, lineHeight: 44 * 0.95 },
  title:   { fontFamily: font.bold,     fontSize: 26, letterSpacing: -0.7, lineHeight: 26 },
  countMM: { fontFamily: font.bold,     fontSize: 32, letterSpacing: -0.8 },
  countSS: { fontFamily: font.semibold, fontSize: 24, letterSpacing: -0.8 },
  body:    { fontFamily: font.medium,   fontSize: 17, letterSpacing: -0.3 },
  bodySm:  { fontFamily: font.medium,   fontSize: 14 },
  label:   { fontFamily: font.medium,   fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase' as const },
  mono:    { fontFamily: font.mono,     fontSize: 11, letterSpacing: 0.6 },
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
};

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  pill: 999,
};
