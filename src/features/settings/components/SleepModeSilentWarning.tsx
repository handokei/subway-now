import { StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, typography, spacing } from '../../../shared/theme';

interface Props {
  /** 취침모드가 켜진 컨텍스트인지 여부. false면 아무것도 렌더하지 않는다. */
  visible: boolean;
}

/**
 * 취침모드 사용 시 "휴대폰 소리를 켜두세요" 안내 (#2807).
 *
 * Critical Alerts entitlement이 애플에 거부되어 iOS는 무음 모드로 자는 폰을
 * 배경 알림으로 깨울 수 없다(플랫폼 제약). CallKit 등 우회 대신 안내로 대응 —
 * 취침 발사 로직은 변경하지 않는다. 취침모드 토글/trip 시작 지점에서 sleepMode가
 * true인 컨텍스트에서만 노출한다.
 */
export function SleepModeSilentWarning({ visible }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  if (!visible) {
    return null;
  }

  return (
    <Text
      style={[typography.mono, styles.text, { color: colors.warn }]}
      testID="sleep-mode-silent-warning"
    >
      {t('sleepModeGuide.silentModeWarning')}
    </Text>
  );
}

const styles = StyleSheet.create({
  text: {
    marginTop: spacing.xs,
  },
});
