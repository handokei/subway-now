import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, typography, spacing, radius } from '../theme';
import { LINE_COLORS, LINE_NAMES } from '../constants/lineColors';
import { formatClockTime } from '../utils/formatTime';
import type { BoardingLock } from '../types/boardingLock';

/** BoardingTrainList compact row와 동일한 좌측 stripe 두께 (#664/#758). */
const LINE_STRIPE_WIDTH = 3;

interface Props {
  lock: BoardingLock;
  onRelease: () => void;
}

/**
 * BoardingLock 활성 시 origin hop slot 안에 inline으로 렌더되는 컴팩트 카드(#758).
 *
 * BoardingTrainList의 compact row와 시각적으로 동일한 호선색 stripe + 한 줄 메타 형태로,
 * timeline hop 사이에 자연스럽게 녹아 "탑승 정보 + 하차 액션"을 노출한다.
 *
 * 메타: "탑승 · {lineName} · {HH:mm}". trainCode raw 식별자는 비노출(#667, BoardingLockBanner 정신 유지).
 */
export function BoardingLockHopCard({ lock, onRelease }: Props) {
  const { colors } = useTheme();
  const lineName = LINE_NAMES[lock.boardingLine];
  const timeText = formatClockTime(lock.boardedAt);
  const metaText = `탑승 · ${lineName} · ${timeText}`;
  return (
    <View
      style={[
        styles.row,
        { borderLeftWidth: LINE_STRIPE_WIDTH, borderLeftColor: LINE_COLORS[lock.boardingLine] },
      ]}
      testID="boarding-lock-hop-card"
    >
      <Text
        style={[typography.bodySm, { color: colors.ink, flex: 1 }]}
        testID="boarding-lock-hop-meta"
      >
        {metaText}
      </Text>
      <Pressable
        onPress={onRelease}
        style={[styles.releaseButton, { borderColor: colors.accent }]}
        testID="boarding-lock-hop-release"
      >
        <Text style={[typography.bodySm, { color: colors.accent, fontWeight: '600' }]}>하차</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    gap: spacing.sm,
  },
  releaseButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
});
