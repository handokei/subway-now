import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme, shadowStyle, type ShadowKind } from '../theme';

interface Props {
  kind: ShadowKind;
  /** 글래스 뷰와 동일한 모서리 */
  r: number;
  /** 글래스 테두리 안쪽으로 들이는 px — 글래스 밖에는 그림자만 보이게 한다 */
  inset?: number;
}

/**
 * 반투명 글래스 뒤에 깔리는 그림자 전용 불투명 뷰.
 * iOS는 alpha<1 뷰의 legacy shadow를 shadowPath 없이 픽셀 기반으로 그려
 * 자식 텍스트마다 그림자가 번지고 offscreen 패스가 늘어난다(RCTView.m).
 * 그래서 그림자는 불투명 캐스터에만 주고 글래스 뷰 자체에는 shadow*를 주지 않는다.
 * pointerEvents none이라 터치에 영향이 없다.
 */
export function ShadowCaster({ kind, r, inset = 2 }: Props) {
  const { colors, isDark } = useTheme();
  return (
    <View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        {
          top: inset,
          left: inset,
          right: inset,
          bottom: inset,
          borderRadius: Math.max(r - inset, 0),
          backgroundColor: colors.shadowCaster,
        },
        shadowStyle(kind, isDark),
      ]}
    />
  );
}
