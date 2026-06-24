/**
 * 1탭 현재역 확정 모달 (#914, Epic #912 — F4 100% 현재역).
 *
 * 자동 추정으로 현재역을 단정할 수 없는 경우(wifi dead zone, 환승 통로 등)에
 * 후보 1~3개를 카드로 노출하고 사용자가 한 번만 탭해 확정한다.
 *
 * - 후보 0개: "주변 역 없음" + 검색 fallback 버튼
 * - 후보 N개: 거리순 카드 리스트, topPick은 시각적으로 강조
 * - 1탭 = onConfirm(station) — caller가 toast + 현재역 적용
 *
 * 후속 PR:
 *  - HomeScreen wire (cold start + locationUncertain 길어질 때)
 *  - F3 기압계(#920) 신호 통합 — useStationCandidates 입력에 추가
 *  - 검색 fallback 실제 wire (현재는 onSearchFallback prop으로 노출만)
 */
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LINE_NAMES } from '../../../shared/constants/lineColors';
import { getStationDisplayName } from '../../../shared/utils/stationDisplay';
import { useTheme, typography, spacing, radius } from '../../../shared/theme';
import type { Station } from '../../../shared/types/station';

interface Props {
  readonly visible: boolean;
  /** 후보 역 목록(거리순). 빈 배열이면 fallback UI. */
  readonly candidates: readonly Station[];
  /** 강조 표시할 후보. candidates에 포함된 것이어야 한다. null이면 강조 없음. */
  readonly topPick: Station | null;
  /** 카드 탭 시 호출. caller가 현재역 적용 + 모달 close + toast 처리. */
  readonly onConfirm: (station: Station) => void;
  /** 후보가 없을 때 표시되는 fallback 버튼 — caller가 검색 모달 오픈. */
  readonly onSearchFallback: () => void;
  /** 모달 자체 dismiss (헤더 [닫기]). */
  readonly onClose: () => void;
}

export function CurrentStationConfirmModal({
  visible,
  candidates,
  topPick,
  onConfirm,
  onSearchFallback,
  onClose,
}: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();

  const hasCandidates = candidates.length > 0;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      testID="current-station-confirm-modal"
    >
      <View style={[styles.backdrop, { backgroundColor: colors.overlay }]}>
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: colors.bg,
              paddingTop: spacing.lg,
              paddingBottom: insets.bottom + spacing.lg,
            },
          ]}
        >
          <View style={[styles.header, { borderBottomColor: colors.hair }]}>
            <Text style={[typography.label, { color: colors.muted }]}>
              {t('currentStationConfirm.title')}
            </Text>
            <Pressable
              onPress={onClose}
              testID="current-station-confirm-close"
              accessibilityRole="button"
              accessibilityLabel={t('currentStationConfirm.close')}
            >
              <Text style={[typography.body, { color: colors.accent, fontWeight: '600' }]}>
                {t('currentStationConfirm.close')}
              </Text>
            </Pressable>
          </View>

          {hasCandidates && (
            <Text style={[typography.bodySm, { color: colors.muted }]}>
              {t('currentStationConfirm.subtitle')}
            </Text>
          )}

          {hasCandidates ? (
            <View style={styles.list} testID="current-station-confirm-list">
              {candidates.map((station) => {
                const isTopPick = topPick !== null && station.id === topPick.id;
                return (
                  <Pressable
                    key={station.id}
                    onPress={() => onConfirm(station)}
                    style={[
                      styles.card,
                      {
                        backgroundColor: colors.card,
                        borderColor: isTopPick ? colors.accent : colors.hair,
                        borderWidth: isTopPick ? 2 : 1,
                      },
                    ]}
                    testID={`current-station-confirm-item-${station.id}`}
                  >
                    <View style={styles.cardInfo}>
                      <Text style={[typography.body, { color: colors.ink, fontWeight: '600' }]}>
                        {getStationDisplayName(station)}
                      </Text>
                      {isTopPick && (
                        <Text
                          style={[typography.label, { color: colors.accent }]}
                          testID={`current-station-confirm-top-pick-${station.id}`}
                        >
                          {t('currentStationConfirm.topPickHint')}
                        </Text>
                      )}
                    </View>
                    <View style={[styles.lineBadge, { backgroundColor: station.lineColor }]}>
                      <Text style={styles.lineText}>{LINE_NAMES[station.line]}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ) : (
            <View style={styles.empty} testID="current-station-confirm-empty">
              <Text style={[typography.body, { color: colors.muted }]}>
                {t('currentStationConfirm.empty')}
              </Text>
              <Pressable
                onPress={onSearchFallback}
                style={[styles.searchButton, { borderColor: colors.accent }]}
                testID="current-station-confirm-search-fallback"
              >
                <Text style={[typography.body, { color: colors.accent, fontWeight: '600' }]}>
                  {t('currentStationConfirm.searchFallback')}
                </Text>
              </Pressable>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
  },
  list: {
    gap: spacing.sm,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.lg,
    borderRadius: radius.md,
    gap: spacing.md,
  },
  cardInfo: {
    flex: 1,
    gap: spacing.xs,
  },
  lineBadge: {
    borderRadius: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  lineText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  empty: {
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xl,
  },
  searchButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
  },
});
