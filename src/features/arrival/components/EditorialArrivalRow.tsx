import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, typography, spacing } from '../../../shared/theme';
import { useCountdown } from '../../../shared/hooks/useCountdown';
import type { ArrivalTrain } from '../../../shared/types/journey';
import { getLineLabel } from '../../../shared/ui/LineBadge';
import { ArrivalStatusBadge } from './ArrivalStatusBadge';

interface Props {
  train: ArrivalTrain;
}

export function EditorialArrivalRow({ train }: Props) {
  const { mm, ss } = useCountdown(train.arrivalAtMs);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const rowLabel = t('arrival.rowLabel', {
    line: getLineLabel(train.line),
    direction: train.direction,
    mm,
    ss,
  });

  return (
    <View
      style={[styles.arrivalRow, { borderBottomColor: colors.hair }]}
      testID="editorial-arrival-row"
      accessibilityLabel={rowLabel}
      accessible
    >
      <View style={{ flex: 1 }}>
        <Text style={[typography.bodyBase, { color: colors.ink, fontWeight: '600' }]}>
          {train.direction}
        </Text>
        {train.subtext != null && (
          <Text style={[typography.micro, { color: colors.muted, marginTop: 2 }]}>
            {train.subtext}
          </Text>
        )}
        <ArrivalStatusBadge
          isLastTrain={train.isLastTrain}
          trainType={train.trainType}
          arrivalCode={train.arrivalCode}
          stationName={train.stationName}
          line={train.lineNumber}
          direction={train.directionKey}
        />
      </View>
      {/* Line Glass — 우측 mm:ss (300 weight). 노선 배지는 카드 문맥상 중복이라 제거, 접근성 라벨엔 유지. */}
      <Text style={[typography.countMM, { color: colors.ink }]}>
        {mm}
        <Text style={{ color: colors.subtle }}>:</Text>
        {ss}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  arrivalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 10,
    borderBottomWidth: 0,
  },
});
