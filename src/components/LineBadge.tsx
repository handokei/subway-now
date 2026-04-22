import React from 'react';
import { View, Text } from 'react-native';
import { colors, typography } from '../theme';
import { LINE_NAMES } from '../constants/lineColors';
import type { LineNumber } from '../types/station';

interface LineBadgeProps {
  line: string;
  color?: string;
}

export function getLineColor(line: string): string {
  return colors.line[line as LineNumber] ?? colors.accent;
}

export function getLineLabel(line: string): string {
  return LINE_NAMES[line as LineNumber] ?? `LINE ${line}`;
}

export function LineBadge({ line, color }: LineBadgeProps) {
  const c = color ?? getLineColor(line);
  const label = getLineLabel(line);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c }} />
      <Text style={[typography.mono, { color: c, fontWeight: '600' }]}>{label}</Text>
    </View>
  );
}
