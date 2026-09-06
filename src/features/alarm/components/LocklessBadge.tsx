import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';
import { useTheme, typography, spacing, radius } from '../../../shared/theme';
import { withAlpha } from '../../../shared/theme/colorUtils';

interface Props {
  /** 탭 시 BoardingTrainList / boardingPrompt 수동 진입 (Path A). */
  onPress: () => void;
}

/**
 * Lockless 상태(lock=null && trip 활성)임을 사용자에게 알리는 배지 (#1755).
 *
 * 탭하면 BoardingTrainList가 포커스되어 사용자가 직접 탑승 열차를 선택할 수 있다
 * (Path A 수동 진입). lock 부착 시 호출자(HomeScreen)가 이 컴포넌트를 렌더하지 않는다.
 */
export function LocklessBadge({ onPress }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  const handlePress = (): void => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress();
  };

  return (
    <Pressable
      onPress={handlePress}
      style={[styles.badge, { backgroundColor: withAlpha(colors.warn, 0.13), borderColor: colors.warn }]}
      testID="lockless-badge"
      accessibilityRole="button"
      accessibilityLabel={t('lockless.tapToConfirm')}
    >
      <View style={styles.inner}>
        <Text style={[typography.bodySm, { color: colors.warn, fontWeight: '700' }]}>
          {t('lockless.badge')}
        </Text>
        <Text style={[typography.bodySm, { color: colors.warn, marginLeft: spacing.xs }]}>
          {t('lockless.tapToConfirm')}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  badge: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    alignSelf: 'flex-start',
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
