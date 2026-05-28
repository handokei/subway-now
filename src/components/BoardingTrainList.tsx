import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, typography, spacing, radius } from '../theme';
import { LineBadge } from './LineBadge';
import type { ArrivalInfo } from '../api/arrivalApi';
import type { LineNumber } from '../types/station';

interface Props {
  arrivals: ArrivalInfo[];
  line: LineNumber;
  onSelect: (train: ArrivalInfo) => void;
}

/**
 * 현재역 도착 list — 사용자가 탑승할 열차를 명시적으로 선택하는 진입점 (#584 PR B).
 *
 * 호출자는 이미 route 방향으로 필터링된 arrivals를 전달한다 — 이 컴포넌트는 디스플레이/탭 처리만 담당.
 * 각 row를 탭하면 onSelect 콜백이 발화 → 호출자가 BoardingLock 생성.
 * 빈 list면 placeholder 안내 텍스트.
 */
export function BoardingTrainList({ arrivals, line, onSelect }: Props) {
  const { colors } = useTheme();

  if (arrivals.length === 0) {
    return (
      <View style={styles.empty} testID="boarding-train-list-empty">
        <Text style={[typography.bodySm, { color: colors.muted }]}>도착 예정 열차가 없습니다.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="boarding-train-list">
      <View style={styles.header}>
        <LineBadge line={line} />
        <Text style={[typography.label, { color: colors.muted }]}>탑승할 열차 선택</Text>
      </View>
      {arrivals.map((train) => (
        <Pressable
          key={train.trainCode}
          onPress={() => onSelect(train)}
          style={[styles.row, { backgroundColor: colors.card }]}
          testID={`boarding-train-row-${train.trainCode}`}
        >
          <View style={styles.rowInfo}>
            <Text style={[typography.body, { color: colors.ink }]}>{train.destination} 행</Text>
            <Text style={[typography.mono, { color: colors.muted }]}>{train.trainCode}</Text>
          </View>
          <Text style={[typography.body, { color: colors.accent, fontWeight: '600' }]}>
            {train.arrivalMinutes}분
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.lg,
    borderRadius: radius.md,
  },
  rowInfo: {
    gap: spacing.xs,
  },
  empty: {
    padding: spacing.lg,
    alignItems: 'center',
  },
});
