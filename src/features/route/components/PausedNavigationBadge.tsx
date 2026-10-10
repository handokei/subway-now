import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, typography, spacing, radius } from '../../../shared/theme';
import { withAlpha } from '../../../shared/theme/colorUtils';
import { useCountdown } from '../../../shared/hooks/useCountdown';
import { PAUSE_AUTO_END_MS } from '../../../shared/constants/realtime';

interface Props {
  /** useNavigationStore.pausedAt — 일시정지 진입 시각(epoch ms). */
  pausedAt: number;
  /** PAUSE_AUTO_END_MS 경과 시(카운트다운 만료) 1회 호출. 확인 다이얼로그 없이 즉시 종료. */
  onExpire: () => void;
}

/**
 * "일시정지" 상태(navigationActive=false && destination 존재)임을 알리는 배지
 * (#2293, Part of #2285 결정 ①+③).
 *
 * 기존 `useCountdown`(신규 타이머 아님, `src/shared/hooks/useCountdown.ts` 재사용)으로
 * pausedAt + PAUSE_AUTO_END_MS까지 남은 시간을 표시하고, 만료(countdown.done) 시 onExpire를
 * 호출해 자동 종료 cleanup chain을 발사한다. 이 컴포넌트는 호출자(HomeScreen)가 일시정지
 * 상태일 때만 마운트하므로, 재개/trip 종료 시 자연히 unmount되어 interval도 함께 정리된다.
 */
export function PausedNavigationBadge({ pausedAt, onExpire }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const countdown = useCountdown(pausedAt + PAUSE_AUTO_END_MS);

  useEffect(() => {
    if (countdown.done) onExpire();
  }, [countdown.done, onExpire]);

  const minutesRemaining = Math.max(0, Math.ceil(countdown.totalSec / 60));
  const label = t('navigation.pausedBadge', { minutes: minutesRemaining });

  return (
    <View
      style={[styles.badge, { backgroundColor: withAlpha(colors.muted, 0.13), borderColor: colors.muted }]}
      testID="paused-navigation-badge"
      accessibilityLabel={label}
      accessible
    >
      <Text style={[typography.bodySm, { color: colors.muted, fontWeight: '600' }]}>{label}</Text>
    </View>
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
});
