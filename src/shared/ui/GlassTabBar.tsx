import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useTheme, lineTint, useLineTintStore } from '../theme';
import { ShadowCaster } from './ShadowCaster';

const BAR_HEIGHT = 62;
const BAR_MIN_BOTTOM_MARGIN = 12;
/** 탭바 위쪽으로 화면 콘텐츠(지도 카드 등)가 비워야 하는 높이 (safe-area bottom 제외) */
export const GLASS_TAB_BAR_CLEARANCE = BAR_HEIGHT + BAR_MIN_BOTTOM_MARGIN + 12;
/** 스크롤 화면 하단 여백 (플로팅 탭바에 마지막 콘텐츠가 가리지 않도록) */
export const GLASS_SCREEN_BOTTOM_PADDING = 120;

/** 화면 위에 떠 있는 글래스 캡슐 탭바. 활성 탭 배경은 현재 노선 틴트. 이모지 아이콘 제거, 텍스트 라벨만. */
export function GlassTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const line = useLineTintStore((s) => s.line);
  const tint = lineTint(line, isDark);
  const useBlur = Platform.OS === 'ios';

  return (
    <View pointerEvents="box-none" style={[styles.host, { bottom: Math.max(insets.bottom, BAR_MIN_BOTTOM_MARGIN) }]}>
      <View style={styles.bar}>
        <ShadowCaster kind="tabBar" r={BAR_HEIGHT / 2} />
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            styles.clip,
            { borderColor: colors.glassBorder, backgroundColor: useBlur ? colors.glassBar : colors.glassFallback },
          ]}
        >
          {useBlur && <BlurView intensity={50} tint={colors.blurTint} style={StyleSheet.absoluteFill} />}
        </View>
        {state.routes.map((route, index) => {
          const focused = state.index === index;
          const { options } = descriptors[route.key];
          const label = typeof options.title === 'string' ? options.title : route.name;
          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={label}
              testID={options.tabBarButtonTestID}
              onPress={() => {
                const e = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
                if (!focused && !e.defaultPrevented) navigation.navigate(route.name);
              }}
              style={[styles.item, focused && { flex: 1.2, backgroundColor: tint.tabActiveBg }]}
            >
              <Text style={[styles.label, { color: focused ? tint.text : colors.muted, fontWeight: focused ? '700' : '500' }]}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', left: 22, right: 22 },
  bar: { height: BAR_HEIGHT, borderRadius: BAR_HEIGHT / 2, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6 },
  clip: { borderRadius: BAR_HEIGHT / 2, borderWidth: 1, overflow: 'hidden' },
  item: { flex: 1, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 13 },
});
