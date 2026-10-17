import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme, typography } from '../../../shared/theme';
import { ARRIVAL_CODE } from '../../../shared/constants/arrivalCodes';
import {
  TRAIN_TYPE_LABEL,
  TRAIN_TYPE_VARIANT,
  type BadgeVariant,
  type TrainType,
} from '../../../shared/constants/trainTypes';
import type { LineNumber } from '../../../shared/types/station';
import { getLastTrainTime, type Direction } from '../utils/lastTrainTime';

interface Props {
  isLastTrain?: boolean;
  trainType?: TrainType;
  arrivalCode?: number;
  /** 막차 시각 lookup 컨텍스트. 셋 다 제공되면 "막차 HH:mm" 시각 동봉 표시. */
  stationName?: string;
  line?: LineNumber;
  direction?: Direction;
}

const LAST_TRAIN_LABEL = '막차';

function buildLastTrainLabel(
  stationName: string | undefined,
  line: LineNumber | undefined,
  direction: Direction | undefined,
): string {
  if (!stationName || !line || !direction) return LAST_TRAIN_LABEL;
  const time = getLastTrainTime({ stationName, line, direction, now: new Date() });
  return time ? `${LAST_TRAIN_LABEL} ${time}` : LAST_TRAIN_LABEL;
}

interface Badge {
  label: string;
  color: string;
  variant: BadgeVariant;
}

/**
 * Arrival 메타데이터(막차/급행/진입 상태)를 작은 배지로 표시.
 * 표시할 배지가 없으면 null 반환해 row 시각 무게 보존.
 */
export function ArrivalStatusBadge({
  isLastTrain,
  trainType,
  arrivalCode,
  stationName,
  line,
  direction,
}: Props) {
  const { colors } = useTheme();

  // 표시 우선순위: 급행 > 막차 > 도착/진입.
  // 급행은 잘못된 열차 탑승을 방지하는 안전성 직결 정보이므로 filled로 가장 두드러지게.
  const badges: Badge[] = [];

  if (trainType && trainType !== 'normal') {
    badges.push({
      label: TRAIN_TYPE_LABEL[trainType],
      color: colors.accent,
      variant: TRAIN_TYPE_VARIANT[trainType],
    });
  }
  if (isLastTrain) {
    badges.push({
      // stationName/line/direction 컨텍스트가 모두 제공되고 1~9호선 timetable에서
      // 막차 시각이 lookup되면 "막차 HH:mm" 표기, 아니면 기존 "막차" 라벨 fallback.
      label: buildLastTrainLabel(stationName, line, direction),
      color: colors.danger,
      variant: 'outline',
    });
  }
  if (arrivalCode === ARRIVAL_CODE.ARRIVED) {
    badges.push({ label: '도착', color: colors.accent, variant: 'outline' });
  } else if (arrivalCode === ARRIVAL_CODE.ENTERING) {
    badges.push({ label: '진입', color: colors.accent, variant: 'outline' });
  }

  if (badges.length === 0) return null;

  return (
    <View style={styles.row} testID="arrival-status-badge">
      {badges.map((b) => {
        const filled = b.variant === 'filled';
        return (
          <View
            key={b.label}
            style={[
              styles.badge,
              filled
                ? { backgroundColor: b.color, borderColor: b.color }
                : { borderColor: b.color },
            ]}
            testID={`arrival-status-badge-${b.label}`}
          >
            <Text
              style={[
                styles.text,
                filled ? styles.textFilled : null,
                { color: filled ? colors.onAccent : b.color },
              ]}
            >
              {b.label}
            </Text>
          </View>
        );
      })}
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
  text: { ...typography.badge, fontWeight: '700', letterSpacing: 0 },
  // filled variant는 안전성 직결 정보(급행) → 한 단계 더 키워 시선 끌어옴.
  textFilled: { ...typography.micro },
});
