import React from 'react';
import { View, Text } from 'react-native';
import { typography } from '../shared/theme';
import { LINE_COLORS, LINE_NAMES } from '../shared/constants/lineColors';
import type { LineNumber } from '../shared/types/station';

interface LineBadgeProps {
  line: string;
  color?: string;
}

export function getLineColor(line: string): string {
  return LINE_COLORS[line as LineNumber] ?? '#888888';
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
