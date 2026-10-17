/**
 * Phase 6.1 (#1842) Sub-step 4 — cold start 다중 후보 선택 UI.
 *
 * candidate count 분기:
 *  - 0개 : 표시하지 않음 (caller가 visible=false 보장)
 *  - 1개 : 기존 boardingPrompt 흐름 트리거 → onSingleCandidate 콜백 호출
 *  - 2~5개: 역 카드 목록 — 역명 + LineBadge(호선) + 거리(km) 표시
 *  - 6+개: 노선 검색 fallback 안내 메시지 + 버튼
 *
 * 선택 시 → onSelectCandidate(ColdStartCandidate) 호출.
 * caller(HomeScreen)가 선택된 candidate의 stations[0]으로 setCustomOrigin을 수행해 trip chain을 시작한다.
 */
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, typography, spacing, radius } from '../../../shared/theme';
import { LineBadge } from '../../../shared/ui/LineBadge';
import type { ColdStartCandidate } from '../hooks/useColdStartCandidates';

/** 다중 목록 표시 상한. 이 수 이상이면 fallback UI를 노출한다. */
export const COLD_START_LIST_MAX = 5;

interface Props {
  readonly visible: boolean;
  /** useColdStartCandidates 반환값 (null이면 표시 안 함 — caller가 visible=false로 제어). */
  readonly candidates: readonly ColdStartCandidate[];
  /** 후보 탭 시 호출. caller가 setCustomOrigin으로 연결. */
  readonly onSelectCandidate: (candidate: ColdStartCandidate) => void;
  /**
   * 후보 1개일 때 호출 — 기존 boardingPrompt 흐름을 트리거하도록 caller에게 위임.
   * candidates.length === 1 이면 컴포넌트가 자동으로 onSingleCandidate()를 호출하고 닫힌다.
   */
  readonly onSingleCandidate: (candidate: ColdStartCandidate) => void;
  /** 6+개 fallback에서 노선 검색 버튼 탭 시 호출 — caller가 검색 피커를 열어야 한다. */
  readonly onSearchFallback: () => void;
  /** 모달 닫기 (헤더 닫기 버튼). */
  readonly onClose: () => void;
}

export function ColdStartCandidatePicker({
  visible,
  candidates,
  onSelectCandidate,
  onSingleCandidate,
  onSearchFallback,
  onClose,
}: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();

  const count = candidates.length;
  const isFallback = count > COLD_START_LIST_MAX;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      testID="cold-start-picker-modal"
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
          {/* Header */}
          <View style={[styles.header, { borderBottomColor: colors.hair }]}>
            <Text style={[typography.label, { color: colors.muted }]}>
              {t('coldStartPicker.title')}
            </Text>
            <Pressable
              onPress={onClose}
              testID="cold-start-picker-close"
              accessibilityRole="button"
              accessibilityLabel={t('coldStartPicker.close')}
            >
              <Text style={[typography.body, { color: colors.accent, fontWeight: '600' }]}>
                {t('coldStartPicker.close')}
              </Text>
            </Pressable>
          </View>

          {isFallback ? (
            /* 6+개 fallback UI */
            <View style={styles.fallback} testID="cold-start-picker-fallback">
              <Text style={[typography.body, { color: colors.muted, textAlign: 'center' }]}>
                {t('coldStartPicker.tooManyCandidates')}
              </Text>
              <Pressable
                onPress={onSearchFallback}
                style={[styles.searchButton, { borderColor: colors.accent }]}
                testID="cold-start-picker-search-fallback"
                accessibilityRole="button"
              >
                <Text style={[typography.body, { color: colors.accent, fontWeight: '600' }]}>
                  {t('coldStartPicker.searchFallback')}
                </Text>
              </Pressable>
            </View>
          ) : (
            /* 2~5개 목록 UI */
            <ScrollView
              style={styles.list}
              testID="cold-start-picker-list"
              showsVerticalScrollIndicator={false}
            >
              {candidates.map((candidate) => (
                <Pressable
                  key={candidate.stationName}
                  onPress={() => onSelectCandidate(candidate)}
                  style={[
                    styles.card,
                    {
                      backgroundColor: colors.card,
                      borderColor: colors.hair,
                    },
                  ]}
                  testID={`cold-start-picker-item-${candidate.stationName}`}
                  accessibilityRole="button"
                >
                  <View style={styles.cardInfo}>
                    <Text style={[typography.body, { color: colors.ink, fontWeight: '600' }]}>
                      {candidate.stationName}
                    </Text>
                    <View style={styles.lineBadges}>
                      {candidate.lines.map((line) => (
                        <LineBadge key={line} line={line} />
                      ))}
                    </View>
                  </View>
                  <Text style={[typography.bodySm, { color: colors.muted }]}>
                    {t('coldStartPicker.distanceKm', {
                      km: candidate.distanceKm.toFixed(2),
                    })}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

// 1개 케이스는 caller(useColdStartPickerController)가 처리. 컴포넌트는 순수 표시 전용.

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
    maxHeight: '70%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
  },
  list: {
    // gap은 ScrollView 하위라 StyleSheet.create에 쓸 수 없음 — card margin으로 처리
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    marginBottom: spacing.sm,
  },
  cardInfo: {
    flex: 1,
    gap: spacing.xs,
  },
  lineBadges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  fallback: {
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
