import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, typography } from '../../../shared/theme';
import { OnboardingSplashBase, splashBaseStyles } from './OnboardingSplashBase';
import type { PermissionStep } from '../hooks/useOnboardingPermissions';

interface Props {
  readonly step: PermissionStep;
  readonly onGrantPermissions: () => void;
  readonly onSkip: () => void;
}

/**
 * 온보딩 Splash 2 — 권한 사전 맥락 안내.
 * 위치 + 알림 권한이 왜 필요한지 설명하고 직렬 요청을 시작한다.
 */
export function OnboardingSplash2({ step, onGrantPermissions, onSkip }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  const isRequesting = step === 'requesting-location' || step === 'requesting-notification';
  const buttonLabel = isRequesting
    ? t('onboarding.permissions.requesting')
    : t('onboarding.permissions.grant');

  return (
    <OnboardingSplashBase
      testID="onboarding-splash2"
      emoji={t('onboarding.splash2.emoji')}
      title={t('onboarding.splash2.title')}
      primaryButtonTestID="onboarding-splash2-grant"
      primaryButtonLabel={buttonLabel}
      primaryButtonDisabled={isRequesting}
      onPrimaryAction={onGrantPermissions}
      onSkip={onSkip}
    >
      <View style={[splashBaseStyles.permissionCard, { backgroundColor: colors.card }]}>
        <Text style={[typography.bodySm, splashBaseStyles.permissionLabel, { color: colors.muted }]}>
          {t('onboarding.permissions.locationLabel')}
        </Text>
        <Text style={[typography.bodySm, { color: colors.ink }]}>
          {t('onboarding.permissions.locationReason')}
        </Text>
      </View>

      <View style={[splashBaseStyles.permissionCard, { backgroundColor: colors.card }]}>
        <Text style={[typography.bodySm, splashBaseStyles.permissionLabel, { color: colors.muted }]}>
          {t('onboarding.permissions.notificationLabel')}
        </Text>
        <Text style={[typography.bodySm, { color: colors.ink }]}>
          {t('onboarding.permissions.notificationReason')}
        </Text>
      </View>
    </OnboardingSplashBase>
  );
}
