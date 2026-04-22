// theme.ts — Editorial Light (B) 디자인 토큰
// 앱 전체에서 import하여 사용. 색/폰트/간격을 한 곳에서 관리.

import type { LineNumber } from '../types/station';
import { LINE_COLORS } from '../constants/lineColors';

export const colors = {
  bg:     '#F5F2EC',                   // 따뜻한 페이퍼 배경
  ink:    '#1A1814',                   // 본문 (near-black warm)
  muted:  '#6B6459',                   // 보조 텍스트
  subtle: '#A8A197',                   // 더 연한 메타 정보
  hair:   'rgba(26,24,20,0.08)',       // divider

  accent: '#C8553D',                   // CTA, 강조 (earth red)
  warn:   '#ff9f43',                   // 경고 (mock 데이터 등)

  // 노선 색 — LineNumber 키 사용, LINE_COLORS에서 가져옴
  line: { ...LINE_COLORS } as Record<LineNumber, string>,
};

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
