import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, typography, spacing, radius } from '../theme';
import { LineBadge } from './LineBadge';
import type { BoardingLock } from '../types/boardingLock';

interface Props {
  lock: BoardingLock;
  onRelease: () => void;
}

/**
 * BoardingLock 활성 시 노출되는 배너 (#584 PR B).
 *
 * 사용자에게 어떤 열차/노선에 lock 되어 있는지 명시. "하차" 탭으로 즉시 release.
 * 이 PR에서는 lock 정보만 표시 — 알람과의 연결은 PR C/D에서 활성화.
 */
export function BoardingLockBanner({ lock, onRelease }: Props) {
  const { colors } = useTheme();
  return (
    <View
      style={[styles.container, { backgroundColor: colors.card, borderColor: colors.accent }]}
      testID="boarding-lock-banner"
    >
      <View style={styles.info}>
        <Text style={[typography.label, { color: colors.muted }]}>탑승 중</Text>
        <View style={styles.row}>
          <LineBadge line={lock.boardingLine} />
          <Text style={[typography.mono, { color: colors.ink }]}>{lock.trainCode}</Text>
        </View>
      </View>
      <Pressable
        onPress={onRelease}
        style={[styles.releaseButton, { borderColor: colors.accent }]}
        testID="boarding-lock-release"
      >
        <Text style={[typography.body, { color: colors.accent, fontWeight: '600' }]}>하차</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.md,
  },
  info: {
    gap: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  releaseButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
  },
});
