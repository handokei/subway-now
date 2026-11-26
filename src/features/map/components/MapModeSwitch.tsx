import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, typography, spacing, radius } from '../../../shared/theme';
import type { MapMode } from '../hooks/useMapMode';

const MODES: readonly MapMode[] = ['map', 'schematic'];

interface Props {
  readonly mode: MapMode;
  readonly onChange: (mode: MapMode) => void;
}

/** #3371 — 지도 탭 상단 segmented "지도 | 노선도". */
export function MapModeSwitch({ mode, onChange }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
    <View style={[styles.container, { backgroundColor: colors.fieldFill, borderColor: colors.hair }]} testID="map-mode-switch">
      {MODES.map((value) => {
        const selected = value === mode;
        return (
          <Pressable
            key={value}
            style={[styles.segment, { backgroundColor: selected ? colors.inkStrong : 'transparent' }]}
            onPress={() => onChange(value)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            testID={`map-mode-${value}`}
          >
            <Text style={[styles.label, { color: selected ? colors.onInkStrong : colors.ink }]}>{t(`map.mode.${value}`)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    padding: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  segment: {
    flex: 1,
    minHeight: 36,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    ...typography.bodySm,
    fontWeight: '700',
  },
});
