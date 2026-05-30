import { StyleSheet, Text, View } from 'react-native';
import { useTheme, typography, spacing } from '../theme';
import { LineBadge } from './LineBadge';
import { ActionBanner } from './ActionBanner';
import type { BoardingLock } from '../types/boardingLock';
import { formatClockTime } from '../utils/formatTime';

interface Props {
  lock: BoardingLock;
  onRelease: () => void;
}

/**
 * BoardingLock 활성 시 노출되는 배너 (#584 PR B / #625 컴팩트 + 절대 시각).
 *
 * "탑승" 라벨 + 노선 + 탑승 시각(HH:mm) + "하차" 액션.
 * trainCode raw 식별자(예: "5048", "SCHED-UP-1")는 사용자에게 무의미하므로 노출 안 함 (#667).
 * 디버그용 trainCode는 DebugModal에서 확인 가능.
 */
export function BoardingLockBanner({ lock, onRelease }: Props) {
  const { colors } = useTheme();
  return (
    <ActionBanner
      accent={colors.accent}
      testID="boarding-lock-banner"
      actionLabel="하차"
      onActionPress={onRelease}
      actionTestID="boarding-lock-release"
    >
      <View style={styles.row}>
        <Text style={[typography.label, { color: colors.muted }]}>탑승</Text>
        <LineBadge line={lock.boardingLine} />
        <Text style={[typography.mono, { color: colors.ink }]} testID="boarding-lock-time">
          {formatClockTime(lock.boardedAt)}
        </Text>
      </View>
    </ActionBanner>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
});
