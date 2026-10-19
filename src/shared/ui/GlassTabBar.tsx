import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useTheme } from '../theme';
import { lineTint } from '../theme/theme';
import { useLineTintStore } from '../theme/store/useLineTintStore';

/** 화면 위에 떠 있는 글래스 캡슐 탭바. 활성 탭 배경은 현재 노선 틴트. 이모지 아이콘 제거, 텍스트 라벨만. */
export function GlassTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const line = useLineTintStore((s) => s.line);
  const tint = lineTint(line, isDark);

  return (
    <View pointerEvents="box-none" style={[styles.host, { bottom: Math.max(insets.bottom, 12) }]}>
      <View
        style={[
          styles.bar,
          {
            borderColor: colors.glassBorder,
            backgroundColor: isDark ? 'rgba(30,34,32,0.55)' : 'rgba(255,255,255,0.6)',
            boxShadow: isDark ? '0 16px 34px -10px rgba(0,0,0,0.7)' : '0 12px 30px -10px rgba(0,40,20,0.25)',
          },
        ]}
      >
        <BlurView intensity={50} tint={colors.blurTint} style={StyleSheet.absoluteFill} />
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
  bar: { height: 62, borderRadius: 31, borderWidth: 1, overflow: 'hidden', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6 },
  item: { flex: 1, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 13 },
});
