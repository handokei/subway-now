import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme, typography, spacing } from '../../../shared/theme';

interface StatusChipProps {
  label: string;
  name: string;
  onClear: () => void;
  testID: string;
}

export function StatusChip({ label, name, onClear, testID }: StatusChipProps) {
  const { colors } = useTheme();

  return (
    <View style={styles.chip}>
      <Text style={[styles.label, { color: colors.accent }]}>{label}</Text>
      <Text style={[styles.name, { color: colors.ink }]} numberOfLines={1}>{name}</Text>
      <TouchableOpacity onPress={onClear} testID={testID}>
        <Text style={[styles.close, { color: colors.muted }]}>✕</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flex: 1,
  },
  label: {
    ...typography.captionSm,
    fontWeight: '700',
  },
  name: {
    ...typography.bodySm,
    fontWeight: '600',
    flex: 1,
  },
  close: {
    ...typography.bodyMd,
    paddingHorizontal: spacing.xs,
  },
});
