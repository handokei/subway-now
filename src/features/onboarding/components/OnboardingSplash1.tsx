import { Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, typography } from '../../../shared/theme';
import { OnboardingSplashBase } from './OnboardingSplashBase';

interface Props {
  readonly onNext: () => void;
  readonly onSkip: () => void;
}

/**
 * 온보딩 Splash 1 — 앱 가치 안내.
 * 앱이 무엇을 하는지 설명하고 "다음" CTA로 Splash 2로 진행.
 */
export function OnboardingSplash1({ onNext, onSkip }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <OnboardingSplashBase
      testID="onboarding-splash1"
      emoji={t('onboarding.splash1.emoji')}
      title={t('onboarding.splash1.title')}
      primaryButtonTestID="onboarding-splash1-next"
      primaryButtonLabel={t('onboarding.splash1.next')}
      onPrimaryAction={onNext}
      onSkip={onSkip}
    >
      <Text style={[typography.body, { color: colors.muted, textAlign: 'center', lineHeight: 26 }]}>
        {t('onboarding.splash1.description')}
      </Text>
    </OnboardingSplashBase>
  );
}
