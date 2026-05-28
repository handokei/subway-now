import { StyleSheet, Text, View } from 'react-native';
import { useTheme, typography, spacing } from '../theme';
import { LineBadge } from './LineBadge';
import { ActionBanner } from './ActionBanner';
import type { BoardingLock } from '../types/boardingLock';

interface Props {
  lock: BoardingLock;
  onRelease: () => void;
}

/**
 * BoardingLock 활성 시 노출되는 배너 (#584 PR B).
 *
 * 사용자에게 어떤 열차/노선에 lock 되어 있는지 명시. "하차" 탭으로 즉시 release.
 * 공통 레이아웃은 ActionBanner 슬롯 패턴으로 위임 (#584 PR D3 Sonar 중복 해소).
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
      <Text style={[typography.label, { color: colors.muted }]}>탑승 중</Text>
      <View style={styles.row}>
        <LineBadge line={lock.boardingLine} />
        <Text style={[typography.mono, { color: colors.ink }]}>{lock.trainCode}</Text>
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
