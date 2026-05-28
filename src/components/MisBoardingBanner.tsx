import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, typography, spacing, radius } from '../theme';

interface Props {
  onReselect: () => void;
}

/**
 * BoardingLock의 trainCode가 실시간 위치 API에서 사라졌을 때 노출되는 경고 배너 (#584 PR D3).
 *
 * 사용자에게 잘못된 열차에 lock 되어 있을 가능성을 알리고, [재선택] 탭으로 lock 해제 진입점 제공.
 * 표시 조건/감지 로직은 useMisBoardingDetector가 담당 — 이 컴포넌트는 순수 표시 + 액션.
 */
export function MisBoardingBanner({ onReselect }: Props) {
  const { colors } = useTheme();
  return (
    <View
      style={[styles.container, { backgroundColor: colors.card, borderColor: colors.warn }]}
      testID="mis-boarding-banner"
    >
      <View style={styles.info}>
        <Text style={[typography.label, { color: colors.warn }]}>탑승 열차 미확인</Text>
        <Text style={[typography.body, { color: colors.muted }]}>
          선택한 열차를 찾을 수 없어요. 다른 열차였다면 다시 선택해주세요.
        </Text>
      </View>
      <Pressable
        onPress={onReselect}
        style={[styles.reselectButton, { borderColor: colors.warn }]}
        testID="mis-boarding-reselect"
      >
        <Text style={[typography.body, { color: colors.warn, fontWeight: '600' }]}>재선택</Text>
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
    // BoardingLockBanner와 수직으로 붙지 않도록 분리 margin.
    marginBottom: spacing.md,
  },
  info: {
    flex: 1,
    gap: spacing.xs,
  },
  reselectButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
  },
});
