import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme, typography, spacing } from '../../../shared/theme';
import { useCountdown } from '../../../shared/hooks/useCountdown';
import type { ArrivalTrain } from '../../../shared/types/journey';
import { LineBadge, getLineColor } from '../../../shared/ui/LineBadge';
import { ArrivalStatusBadge } from './ArrivalStatusBadge';

interface Props {
  train: ArrivalTrain;
}

export function EditorialArrivalRow({ train }: Props) {
  const { mm, ss } = useCountdown(train.arrivalAtMs);
  const lineC = getLineColor(train.line);
  const { colors } = useTheme();

  return (
    <View style={[styles.arrivalRow, { borderBottomColor: colors.hair }]} testID="editorial-arrival-row">
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
        <ArrivalStatusBadge
          isLastTrain={train.isLastTrain}
          trainType={train.trainType}
          arrivalCode={train.arrivalCode}
        />
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
  },
});
