import { StyleSheet, Text, View, Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, radius, typography } from '../../../shared/theme';

interface Props {
  readonly testID: string;
  readonly emoji: string;
  readonly title: string;
  readonly primaryButtonTestID: string;
  readonly primaryButtonLabel: string;
  readonly primaryButtonDisabled?: boolean;
  readonly onPrimaryAction: () => void;
  readonly onSkip: () => void;
  readonly children?: React.ReactNode;
}

/**
 * 온보딩 Splash 공통 스캐폴드.
 * emoji + title + 슬롯(children) + primaryButton + skip CTA 구조를 공유한다.
 * emoji, title, primaryButtonLabel은 호출 측에서 이미 번역된 문자열을 전달한다.
 */
export function OnboardingSplashBase({
  testID,
  emoji,
  title,
  primaryButtonTestID,
  primaryButtonLabel,
  primaryButtonDisabled = false,
  onPrimaryAction,
  onSkip,
  children,
}: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]} testID={testID}>
      <View style={styles.content}>
        <Text style={[typography.hero, { color: colors.accent }]}>{emoji}</Text>
        <Text style={[typography.title, styles.title, { color: colors.ink }]}>{title}</Text>
        {children}
      </View>

      <View style={styles.actions}>
        <Pressable
          style={[
            styles.primaryButton,
            { backgroundColor: primaryButtonDisabled ? colors.muted : colors.accent },
          ]}
          onPress={onPrimaryAction}
          disabled={primaryButtonDisabled}
          testID={primaryButtonTestID}
        >
          <Text style={[typography.body, { color: colors.onAccent }]}>{primaryButtonLabel}</Text>
        </Pressable>
        <Pressable onPress={onSkip} testID={`${testID}-skip`}>
          <Text style={[typography.bodySm, styles.skipText, { color: colors.subtle }]}>
            {t('onboarding.skip')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

export const splashBaseStyles = StyleSheet.create({
  permissionCard: {
    width: '100%',
    padding: spacing.lg,
    borderRadius: spacing.md,
    gap: spacing.xs,
  },
  permissionLabel: {
    fontWeight: '600',
  },
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxxl,
    justifyContent: 'space-between',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.lg,
  },
  title: {
    textAlign: 'center',
    marginTop: spacing.md,
  },
  actions: {
    gap: spacing.md,
    alignItems: 'center',
  },
  primaryButton: {
    width: '100%',
    paddingVertical: spacing.lg,
    borderRadius: radius.pill,
    alignItems: 'center',
  },
  skipText: {
    textDecorationLine: 'underline',
  },
});
