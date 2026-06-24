import { StyleSheet, Text, View, Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, radius, typography } from '../../../shared/theme';
import type { PermissionStep } from '../hooks/useOnboardingPermissions';

interface Props {
  step: PermissionStep;
  onGrantPermissions: () => void;
  onSkip: () => void;
}

/**
 * 온보딩 Splash 2 — 권한 사전 맥락 안내.
 * 위치 + 알림 권한이 왜 필요한지 설명하고 직렬 요청을 시작한다.
 */
export function OnboardingSplash2({ step, onGrantPermissions, onSkip }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  const isRequesting = step === 'requesting-location' || step === 'requesting-notification';

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]} testID="onboarding-splash2">
      <View style={styles.content}>
        <Text style={[typography.hero, { color: colors.accent }]}>
          {t('onboarding.splash2.emoji')}
        </Text>
        <Text style={[typography.title, styles.title, { color: colors.ink }]}>
          {t('onboarding.splash2.title')}
        </Text>

        <View style={[styles.permissionCard, { backgroundColor: colors.card }]}>
          <Text style={[typography.bodySm, styles.permissionLabel, { color: colors.muted }]}>
            {t('onboarding.permissions.locationLabel')}
          </Text>
          <Text style={[typography.bodySm, { color: colors.ink }]}>
            {t('onboarding.permissions.locationReason')}
          </Text>
        </View>

        <View style={[styles.permissionCard, { backgroundColor: colors.card }]}>
          <Text style={[typography.bodySm, styles.permissionLabel, { color: colors.muted }]}>
            {t('onboarding.permissions.notificationLabel')}
          </Text>
          <Text style={[typography.bodySm, { color: colors.ink }]}>
            {t('onboarding.permissions.notificationReason')}
          </Text>
        </View>
      </View>

      <View style={styles.actions}>
        <Pressable
          style={[
            styles.primaryButton,
            { backgroundColor: isRequesting ? colors.muted : colors.accent },
          ]}
          onPress={onGrantPermissions}
          disabled={isRequesting}
          testID="onboarding-splash2-grant"
        >
          <Text style={[typography.body, { color: colors.onAccent }]}>
            {isRequesting
              ? t('onboarding.permissions.requesting')
              : t('onboarding.permissions.grant')}
          </Text>
        </Pressable>
        <Pressable onPress={onSkip} testID="onboarding-splash2-skip">
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
  permissionCard: {
    width: '100%',
    padding: spacing.lg,
    borderRadius: spacing.md,
    gap: spacing.xs,
  },
  permissionLabel: {
    fontWeight: '600',
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
