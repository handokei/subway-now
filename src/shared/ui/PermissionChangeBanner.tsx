import { Linking, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, typography, spacing } from '../theme';
import { ActionBanner } from './ActionBanner';
import { createLogger } from '../utils/logger';
import type { LocationPermissionChange } from '../hooks/useLocationPermissionWatcher';

const logger = createLogger('PermissionChangeBanner');

interface Props {
  /**
   * 직전 권한 상태 대비 변화 종류. 'none'이면 banner를 렌더링하지 않는다.
   * 호출자는 useLocationPermissionWatcher().change를 그대로 전달한다.
   */
  readonly change: LocationPermissionChange;
  /** 사용자가 dismiss/액션 시 watcher의 acknowledge를 호출하기 위한 콜백. */
  readonly onAcknowledge: () => void;
}

/**
 * #1454 — 위치 권한이 회수되거나 Always→WhileInUse로 강등된 직후 노출되는 사용자 알림 배너.
 *
 * 사용자가 시스템 설정에서 변경한 직후 앱 foreground 진입 시점에 표시되며, 액션 버튼은
 * iOS 설정 앱 deep link로 연결된다. dismiss/액션 모두 onAcknowledge를 호출해 같은
 * change 상태로 재노출되지 않도록 한다(노출은 변화 이벤트 단위, dismiss 후 다음 변화까지 침묵).
 *
 * 표시 정책은 호출자가 결정한다 — 본 컴포넌트는 change 값에 따라 메시지만 분기한다.
 */
export function PermissionChangeBanner({ change, onAcknowledge }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  if (change === 'none') return null;

  const titleKey =
    change === 'revoked'
      ? 'permissions.changeRevokedTitle'
      : 'permissions.changeDowngradedTitle';
  const bodyKey =
    change === 'revoked'
      ? 'permissions.changeRevokedBody'
      : 'permissions.changeDowngradedBody';

  const handlePress = () => {
    onAcknowledge();
    // Linking.openSettings()는 Promise를 반환한다.
    // 실패해도 사용자에게 추가로 안내할 수단이 없으므로 logger.warn만 남기고 종결한다(SonarCloud S3735).
    Linking.openSettings().catch((e: unknown) => logger.warn('설정 앱 열기 실패', e));
  };

  return (
    <ActionBanner
      accent={colors.warn}
      testID="permission-change-banner"
      actionLabel={t('permissions.openSettings')}
      onActionPress={handlePress}
      actionTestID="permission-change-open-settings"
      marginBottom={spacing.md}
      accessibilityLabel={t(titleKey)}
    >
      <Text style={[typography.label, { color: colors.warn }]}>{t(titleKey)}</Text>
      <Text style={[typography.body, { color: colors.muted }]}>{t(bodyKey)}</Text>
    </ActionBanner>
  );
}
