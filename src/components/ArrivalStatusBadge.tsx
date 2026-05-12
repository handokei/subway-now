import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../theme';
import { ARRIVAL_CODE } from '../constants/arrivalCodes';
import { TRAIN_TYPE_LABEL, type TrainType } from '../constants/trainTypes';

interface Props {
  isLastTrain?: boolean;
  trainType?: TrainType;
  arrivalCode?: number;
}

/**
 * Arrival 메타데이터(막차/급행/진입 상태)를 작은 배지로 표시.
 * 표시할 배지가 없으면 null 반환해 row 시각 무게 보존.
 */
export function ArrivalStatusBadge({ isLastTrain, trainType, arrivalCode }: Props) {
  const { colors } = useTheme();

  // 표시 우선순위: 막차 > 도착/진입 상태 > 급행/특급/ITX
  // 막차는 사용자 안전성 직결이라 항상 가장 두드러지게.
  const badges: { label: string; color: string }[] = [];

  if (isLastTrain) {
    badges.push({ label: '막차', color: colors.danger });
  }
  if (arrivalCode === ARRIVAL_CODE.ARRIVED) {
    badges.push({ label: '도착', color: colors.accent });
  } else if (arrivalCode === ARRIVAL_CODE.ENTERING) {
    badges.push({ label: '진입', color: colors.accent });
  }
  if (trainType && trainType !== 'normal') {
    badges.push({ label: TRAIN_TYPE_LABEL[trainType], color: colors.accent });
  }

  if (badges.length === 0) return null;

  return (
    <View style={styles.row} testID="arrival-status-badge">
      {badges.map((b) => (
        <View key={b.label} style={[styles.badge, { borderColor: b.color }]}>
          <Text style={[styles.text, { color: b.color }]}>{b.label}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 4, marginTop: 2 },
  badge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
    borderWidth: 1,
  },
  // 한글/영문 혼용(ITX)이라 typography.label의 uppercase/letterSpacing은 적용하지 않는다.
  text: { fontSize: 10, fontWeight: '700', letterSpacing: 0 },
});
