import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, radius, typography } from '../../../shared/theme';
import {
  useTripGroundTruthStore,
  type TripGroundTruthOutcome,
} from '../store/useTripGroundTruthStore';

const THANKS_AUTO_CLOSE_MS = 1500;

/**
 * Trip ground truth (사용자 정답지) 자동 prompt — #1502 (M2).
 *
 * `useTripGroundTruthStore.pendingPrompt`가 non-null인 동안 modal로 자동 노출.
 * 사용자가 [좋았어요]/[틀린 알람] 응답 또는 [나중에] dismiss하면 store 갱신.
 *
 * trigger source = `triggerTripGroundTruthPrompt(corrIdSnapshot)` — 4 trip-end 경로에서
 * 명시 호출(FG setDestination(prev !== null) switch / BG silent push trip-ended /
 * useLaunchTripReconciliation cold-launch / useStateRehydration sentinel+force-end).
 * #1597 — TRIP_BOUND_CLEANUPS 배열에서 분리. trip 시작 시 false fire 회귀 차단.
 * issue 본문 정책: dismiss 후에도 다음 trip 종료 시 다시 노출 (one-time opt-out X).
 *
 * 본 컴포넌트는 cross-feature observer로서 DebugModal과 분리 — DebugModal 토글과 무관하게
 * 항상 마운트되어야 trip 종료 직후 즉시 노출 가능. 호출자는 app root 또는 DebugModal 부근
 * 어디든 1회 마운트.
 */
export function TripGroundTruthPrompt() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const pendingPrompt = useTripGroundTruthStore((s) => s.pendingPrompt);
  const respond = useTripGroundTruthStore((s) => s.respond);
  const hydrated = useTripGroundTruthStore((s) => s.hydrated);
  const hydrate = useTripGroundTruthStore((s) => s.hydrate);

  // boot 시 1회 hydrate — 앱 cold launch 직후 pendingPrompt 복원.
  useEffect(() => {
    if (hydrated) return;
    void hydrate();
  }, [hydrated, hydrate]);

  // thanks toast 짧게(THANKS_AUTO_CLOSE_MS) 노출 후 자동 close.
  const [thanksVisible, setThanksVisible] = useState(false);
  const thanksTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (thanksTimerRef.current !== null) clearTimeout(thanksTimerRef.current);
    };
  }, []);

  const handleRespond = useCallback(
    async (outcome: TripGroundTruthOutcome) => {
      await respond(outcome);
      setThanksVisible(true);
      if (thanksTimerRef.current !== null) clearTimeout(thanksTimerRef.current);
      thanksTimerRef.current = setTimeout(() => {
        setThanksVisible(false);
        thanksTimerRef.current = null;
      }, THANKS_AUTO_CLOSE_MS);
    },
    [respond],
  );

  const visible = pendingPrompt !== null || thanksVisible;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => void handleRespond('unanswered')}
    >
      <View style={styles.backdrop}>
        <View
          testID="trip-ground-truth-card"
          style={[
            styles.card,
            { backgroundColor: colors.bg, borderColor: colors.hair },
          ]}
        >
          {pendingPrompt === null && thanksVisible ? (
            <Text
              testID="trip-ground-truth-thanks"
              style={[typography.body, { color: colors.ink, textAlign: 'center' }]}
            >
              {t('debug.tripGroundTruth.thanks')}
            </Text>
          ) : (
            <>
              <Text style={[typography.label, { color: colors.ink, fontWeight: '700' }]}>
                {t('debug.tripGroundTruth.title')}
              </Text>
              <Text
                style={[typography.bodySm, { color: colors.muted, marginTop: spacing.xs }]}
              >
                {t('debug.tripGroundTruth.body')}
              </Text>
              <View style={styles.actions}>
                <Pressable
                  testID="trip-ground-truth-accurate"
                  onPress={() => void handleRespond('accurate')}
                  style={[styles.button, { backgroundColor: colors.accent }]}
                  accessibilityRole="button"
                  accessibilityLabel={t('debug.tripGroundTruth.accurate')}
                >
                  <Text style={[typography.body, { color: colors.bg, fontWeight: '700' }]}>
                    {t('debug.tripGroundTruth.accurate')}
                  </Text>
                </Pressable>
                <Pressable
                  testID="trip-ground-truth-inaccurate"
                  onPress={() => void handleRespond('inaccurate')}
                  style={[
                    styles.button,
                    { backgroundColor: 'transparent', borderColor: colors.warn, borderWidth: 1 },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={t('debug.tripGroundTruth.inaccurate')}
                >
                  <Text style={[typography.body, { color: colors.warn, fontWeight: '700' }]}>
                    {t('debug.tripGroundTruth.inaccurate')}
                  </Text>
                </Pressable>
                <Pressable
                  testID="trip-ground-truth-dismiss"
                  onPress={() => void handleRespond('unanswered')}
                  style={styles.dismiss}
                  accessibilityRole="button"
                  accessibilityLabel={t('debug.tripGroundTruth.dismiss')}
                >
                  <Text style={[typography.bodySm, { color: colors.muted }]}>
                    {t('debug.tripGroundTruth.dismiss')}
                  </Text>
                </Pressable>
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  card: {
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.lg,
  },
  actions: {
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  button: {
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
  },
  dismiss: {
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
});
