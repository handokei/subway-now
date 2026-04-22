import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, typography, spacing } from '../theme';
import { LINE_NAMES } from '../constants/lineColors';
import type { LineNumber } from '../types/station';
import { useCountdown } from '../hooks/useCountdown';
import type { ArrivalTrain } from '../utils/journeyAdapter';

interface Props {
  train: ArrivalTrain;
}

export function EditorialArrivalRow({ train }: Props) {
  const { mm, ss } = useCountdown(train.arrivalAtMs);
  const lineC = colors.line[train.line as LineNumber] ?? colors.accent;
  const lineLabel = LINE_NAMES[train.line as LineNumber] ?? `LINE ${train.line}`;

  return (
    <View style={styles.arrivalRow} testID="editorial-arrival-row">
      <View style={{ minWidth: 90 }}>
        <Text>
          <Text style={{ ...typography.countMM, color: colors.ink }}>{mm}</Text>
          <Text style={{ fontSize: 20, color: colors.subtle }}> : </Text>
          <Text style={{ ...typography.countSS, color: colors.muted }}>{ss}</Text>
        </Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[typography.bodySm, { color: colors.ink, fontWeight: '600' }]}>
          {train.direction}
        </Text>
        {train.subtext != null && (
          <Text style={[typography.mono, { color: colors.subtle, marginTop: 2 }]}>
            {train.subtext}
          </Text>
        )}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: lineC }} />
        <Text style={[typography.mono, { color: lineC, fontWeight: '600' }]}>{lineLabel}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  arrivalRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.lg,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.hair,
  },
});
