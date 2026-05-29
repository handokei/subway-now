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
 * "탑승" 라벨 + 노선/trainCode + 탑승 시각(HH:mm) + "하차" 액션.
 * 시간은 0분/1분 같은 상대 표기 대신 사용자가 익숙한 절대 시각(#625) — 자기 시계와 매칭 용이.
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
        <Text style={[typography.mono, { color: colors.ink }]}>{lock.trainCode}</Text>
        <Text style={[typography.mono, { color: colors.muted }]}>·</Text>
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
