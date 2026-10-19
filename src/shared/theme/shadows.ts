import type { ViewStyle } from 'react-native';

/**
 * Line Glass 그림자 — 구아키(Paper)에서는 `boxShadow`가 no-op이라
 * iOS legacy shadow props + Android elevation 조합을 쓴다(신아키에서도 동작).
 * 주의: iOS shadow는 overflow:hidden 뷰에서 잘리므로 클리핑 레이어와 그림자 뷰를 분리해야 한다.
 */
export type ShadowKind = 'card' | 'tabBar' | 'floatCard' | 'segment' | 'ring';

interface ShadowSpec {
  color: string;
  opacity: number;
  radius: number;
  offsetY: number;
  elevation: number;
}

const SHADOWS: Record<ShadowKind, { light: ShadowSpec; dark: ShadowSpec }> = {
  card: {
    light: { color: '#003C1E', opacity: 0.14, radius: 15, offsetY: 10, elevation: 4 },
    dark: { color: '#000000', opacity: 0.5, radius: 20, offsetY: 14, elevation: 6 },
  },
  tabBar: {
    light: { color: '#002814', opacity: 0.22, radius: 15, offsetY: 12, elevation: 8 },
    dark: { color: '#000000', opacity: 0.6, radius: 17, offsetY: 14, elevation: 8 },
  },
  floatCard: {
    light: { color: '#000000', opacity: 0.25, radius: 20, offsetY: 16, elevation: 8 },
    dark: { color: '#000000', opacity: 0.25, radius: 20, offsetY: 16, elevation: 8 },
  },
  segment: {
    light: { color: '#000000', opacity: 0.08, radius: 4, offsetY: 2, elevation: 1 },
    dark: { color: '#000000', opacity: 0.08, radius: 4, offsetY: 2, elevation: 1 },
  },
  // 점 주변 후광(색은 호출부가 넘김) — spread 없는 legacy shadow로 근사
  ring: {
    light: { color: '#000000', opacity: 0.3, radius: 4, offsetY: 0, elevation: 0 },
    dark: { color: '#000000', opacity: 0.3, radius: 4, offsetY: 0, elevation: 0 },
  },
};

export function shadowStyle(kind: ShadowKind, isDark: boolean, colorOverride?: string): ViewStyle {
  const { color, opacity, radius, offsetY, elevation } = SHADOWS[kind][isDark ? 'dark' : 'light'];
  return {
    shadowColor: colorOverride ?? color,
    shadowOffset: { width: 0, height: offsetY },
    shadowOpacity: opacity,
    shadowRadius: radius,
    elevation,
  };
}
