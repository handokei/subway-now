import { Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, typography, spacing } from '../../../shared/theme';
import { ActionBanner } from '../../../shared/ui/ActionBanner';

/** 배너가 뜬 이유 — 'absent'(기존, trainCode 미관측) / 'wrong-direction'(#2455, 반대 방향 탑승). */
export type MisBoardingBannerReason = 'absent' | 'wrong-direction';

interface Props {
  onReselect: () => void;
  /** 미전달 시 기존 'absent' copy 유지 (하위호환). */
  reason?: MisBoardingBannerReason;
}

/**
 * BoardingLock의 trainCode가 실시간 위치 API에서 사라졌거나(absent), 반대 방향으로 진행 중인
 * 열차가 관측됐을 때(wrong-direction, #2455 Phase B) 노출되는 경고 배너 (#584 PR D3).
 *
 * 표시 조건/감지 로직은 useMisBoardingDetector가 담당 — 이 컴포넌트는 순수 표시 + 액션.
 * 공통 레이아웃은 ActionBanner 슬롯 패턴으로 위임. reason에 따라 라벨/본문/a11y copy만 분기.
 *
 * a11y(#1077 후속): ActionBanner의 a11y props로 alert role + 액션 라벨/힌트 주입.
 */
export function MisBoardingBanner({ onReselect, reason = 'absent' }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const isWrongDirection = reason === 'wrong-direction';
  return (
    <ActionBanner
      accent={colors.warn}
      testID="mis-boarding-banner"
      actionLabel="재선택"
      onActionPress={onReselect}
      actionTestID="mis-boarding-reselect"
      marginBottom={spacing.md}
      accessibilityLabel={
        isWrongDirection
          ? t('a11y.route.misBoardingWrongDirectionBannerLabel')
          : t('a11y.route.misBoardingBannerLabel')
      }
      actionAccessibilityLabel={t('a11y.route.misBoardingReselectLabel')}
      actionAccessibilityHint={t('a11y.route.misBoardingReselectHint')}
    >
      <Text style={[typography.label, { color: colors.warn }]}>
        {isWrongDirection ? '반대 방향으로 가고 있어요' : '탑승 열차 미확인'}
      </Text>
      <Text style={[typography.body, { color: colors.muted }]}>
        {isWrongDirection
          ? '반대 방향으로 가고 계신 것 같아요. 다음 역에서 내려 반대편에서 타세요.'
          : '선택한 열차를 찾을 수 없어요. 다른 열차였다면 다시 선택해주세요.'}
      </Text>
    </ActionBanner>
  );
}
