import { Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, typography, spacing } from '../../../shared/theme';
import { ActionBanner } from '../../../shared/ui/ActionBanner';

interface Props {
  onReselect: () => void;
}

/**
 * BoardingLock의 trainCode가 실시간 위치 API에서 사라졌을 때 노출되는 경고 배너 (#584 PR D3).
 *
 * 표시 조건/감지 로직은 useMisBoardingDetector가 담당 — 이 컴포넌트는 순수 표시 + 액션.
 * 공통 레이아웃은 ActionBanner 슬롯 패턴으로 위임.
 *
 * a11y(#1077 후속): ActionBanner의 a11y props로 alert role + 액션 라벨/힌트 주입.
 */
export function MisBoardingBanner({ onReselect }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
    <ActionBanner
      accent={colors.warn}
      testID="mis-boarding-banner"
      actionLabel="재선택"
      onActionPress={onReselect}
      actionTestID="mis-boarding-reselect"
      marginBottom={spacing.md}
      accessibilityLabel={t('a11y.route.misBoardingBannerLabel')}
      actionAccessibilityLabel={t('a11y.route.misBoardingReselectLabel')}
      actionAccessibilityHint={t('a11y.route.misBoardingReselectHint')}
    >
      <Text style={[typography.label, { color: colors.warn }]}>탑승 열차 미확인</Text>
      <Text style={[typography.body, { color: colors.muted }]}>
        선택한 열차를 찾을 수 없어요. 다른 열차였다면 다시 선택해주세요.
      </Text>
    </ActionBanner>
  );
}
