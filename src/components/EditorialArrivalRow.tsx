import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, typography, spacing } from '../theme';
import { useCountdown } from '../hooks/useCountdown';
import type { ArrivalTrain } from '../utils/journeyAdapter';
import { LineBadge, getLineColor } from './LineBadge';

interface Props {
  train: ArrivalTrain;
}

export function EditorialArrivalRow({ train }: Props) {
  const { mm, ss } = useCountdown(train.arrivalAtMs);
  const lineC = getLineColor(train.line);

  return (
    <View style={styles.arrivalRow} testID="editorial-arrival-row">
      <View style={{ minWidth: 90 }}>
        <Text>
          <Text style={[typography.countMM, { color: colors.ink }]}>{mm}</Text>
          <Text style={{ fontSize: 20, color: colors.subtle }}> : </Text>
          <Text style={[typography.countSS, { color: colors.muted }]}>{ss}</Text>
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
      <LineBadge line={train.line} color={lineC} />
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
