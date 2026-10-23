import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, typography, spacing, radiusGlass } from '../../../shared/theme';
import { GlassCard } from '../../../shared/ui/GlassCard';
import { useRegisterHealthStore } from '../store/useRegisterHealthStore';

interface Props {
  /** trip(목적지)이 활성일 때만 표시한다. */
  tripActive: boolean;
}

/**
 * #3006 PR-3 — backend 일시 장애(POST /trips 503 `kv_unavailable`) 안내 배너.
 * `useRegisterHealthStore.degraded`가 켜져 있고 trip이 활성일 때만 보인다(그 외 null).
 * GlassCard에는 a11y prop이 없어 바깥 View에 alert 역할을 붙인다.
 */
export function BackendDegradedBanner({ tripActive }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const degraded = useRegisterHealthStore((s) => s.degraded);
  if (!degraded || !tripActive) return null;

  const title = t('home.backendDegraded.title');
  const body = t('home.backendDegraded.body');
  return (
    <View
      testID="backend-degraded-banner"
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${title}. ${body}`}
      style={{ marginHorizontal: 14, marginTop: spacing.xxl }}
    >
      <GlassCard r={radiusGlass.lg} style={{ padding: spacing.lg }}>
        <View style={styles.row}>
          <View testID="backend-degraded-dot" style={[styles.dot, { backgroundColor: colors.warn }]} />
          <View style={styles.texts}>
            <Text style={[typography.bodySm, { color: colors.ink, fontWeight: '600' }]}>{title}</Text>
            <Text style={[typography.caption, { color: colors.muted, marginTop: spacing.xs }]}>{body}</Text>
          </View>
        </View>
      </GlassCard>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 5, marginRight: spacing.md },
  texts: { flex: 1 },
});
