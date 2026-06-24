import { StyleSheet, Text, View, Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, radius, typography } from '../../../shared/theme';

interface Props {
  onNext: () => void;
  onSkip: () => void;
}

/**
 * 온보딩 Splash 1 — 앱 가치 안내.
 * 앱이 무엇을 하는지 설명하고 "다음" CTA로 Splash 2로 진행.
 */
export function OnboardingSplash1({ onNext, onSkip }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]} testID="onboarding-splash1">
      <View style={styles.content}>
        <Text style={[typography.hero, { color: colors.accent }]}>
          {t('onboarding.splash1.emoji')}
        </Text>
        <Text style={[typography.title, styles.title, { color: colors.ink }]}>
          {t('onboarding.splash1.title')}
        </Text>
        <Text style={[typography.body, styles.description, { color: colors.muted }]}>
          {t('onboarding.splash1.description')}
        </Text>
      </View>

      <View style={styles.actions}>
        <Pressable
          style={[styles.primaryButton, { backgroundColor: colors.accent }]}
          onPress={onNext}
          testID="onboarding-splash1-next"
        >
          <Text style={[typography.body, { color: colors.onAccent }]}>
            {t('onboarding.splash1.next')}
          </Text>
        </Pressable>
        <Pressable onPress={onSkip} testID="onboarding-splash1-skip">
          <Text style={[typography.bodySm, styles.skipText, { color: colors.subtle }]}>
            {t('onboarding.skip')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

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
  description: {
    textAlign: 'center',
    lineHeight: 26,
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
