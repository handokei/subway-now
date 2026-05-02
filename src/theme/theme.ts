// theme.ts — 디자인 토큰 (라이트/다크)
// 앱 전체에서 import하여 사용. 색/폰트/간격을 한 곳에서 관리.

import type { LineNumber } from '../types/station';
import { LINE_COLORS } from '../constants/lineColors';

// 테마 불변 토큰
const sharedColors = {
  warn:   '#ff9f43',                   // 경고 (mock 데이터 등)
  line: { ...LINE_COLORS } as Record<LineNumber, string>,
};

// Editorial Light (B) — 핸드오프 원본
export const lightColors = {
  ...sharedColors,
  bg:       '#F5F2EC',                 // 따뜻한 페이퍼 배경
  card:     '#ffffff',                 // 카드, 입력창
  ink:      '#1A1814',                 // 본문 (near-black warm)
  muted:    '#6B6459',                 // 보조 텍스트
  subtle:   '#A8A197',                 // 메타 정보
  hair:     'rgba(26,24,20,0.08)',     // divider
  overlay:       'rgba(0,0,0,0.4)',      // 모달 배경
  bgTranslucent: 'rgba(245,242,236,0.92)', // 반투명 bg (헤더 등)
  accent:        '#C8553D',             // CTA (어스 레드)
  onAccent:      '#ffffff',             // accent 위 텍스트
};

// C · Focus — 다크모드
export const darkColors = {
  ...sharedColors,
  bg:            '#0A0A0A',             // 거의 퓨어블랙
  card:          '#1A1A1A',             // 다크 카드
  ink:           '#ffffff',             // 순백 텍스트
  muted:         '#888888',             // 보조 텍스트
  subtle:        '#666666',             // 메타 정보
  hair:          '#2A2A2A',             // divider
  overlay:       'rgba(0,0,0,0.8)',      // 모달 배경
  bgTranslucent: 'rgba(10,10,10,0.92)', // 반투명 bg (헤더 등)
  accent:        '#C8E600',             // CTA (라임그린)
  onAccent: '#000000',                 // accent 위 텍스트
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
