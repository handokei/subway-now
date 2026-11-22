/**
 * 버그 신고 모달 (#1034, docs/requirements/12-cross-cutting.md).
 *
 * SettingsScreen 진입점에서 열림. 사용자가 자유 텍스트로 메시지를 입력해 backend `POST /feedback`에
 * 송신. 송신 결과(ok/실패)에 따라 toast 안내 후 자동 close.
 *
 * Scope 정책:
 *   - 자유 텍스트 + (#3366) "어디서 틀렸나요?" 유형 칩·역 선택(모두 선택 입력). 칩만 골라도 보낼 수 있다 —
 *     서버 계약(빈 message 400)은 그대로라 message를 `"[유형] 역명"`으로 자동 생성한다.
 *   - 디바이스 컨텍스트(앱 버전/플랫폼/로케일)는 `buildFeedbackContext`가 자동 첨부 — 사용자 입력 X.
 *   - (#3366) 보내기 시 진단(dump)을 자동 첨부한다 — 사용자에게 dump를 보여주지 않고 안내 한 줄만.
 *     좌표는 지우고(redact) token은 hash로 치환한다. 수집은 보내기 시점 1회 읽기(훅 마운트 없음).
 *   - 송신 실패는 사용자 친화 toast로 안내하고 입력값은 보존 (재시도 가능).
 */
import { useMemo, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  submitFeedback,
  type FeedbackReport,
  type SubmitFeedbackOptions,
} from '../../../shared/api/feedback';
import { FEEDBACK_CATEGORIES, type FeedbackCategory } from '../../../shared/constants/feedbackCategories';
import { LineBadge } from '../../../shared/ui/LineBadge';
import { searchStations } from '../../../shared/utils/fuzzyStationSearch';
import { createLogger } from '../../../shared/utils/logger';
import { useTheme, typography, spacing, radius } from '../../../shared/theme';
import type { Station } from '../../../shared/types/station';
import stationsData from '../../../data/stations.json';
import { useDestinationStore } from '../../route/store/useDestinationStore';
import { buildDumpText } from '../../debug/components/DebugModal';
import { collectReportDumpInputs } from '../../debug/hooks/useDebugDumpInputs';
import { buildFeedbackMessage } from '../utils/feedbackMessage';

const log = createLogger('feedbackModal');

const allStations = stationsData as Station[];
/** 역 검색 결과 최대 개수. */
const STATION_RESULT_LIMIT = 8;

/** message 최대 길이 — backend FEEDBACK_MAX_MESSAGE_LENGTH와 정합. */
export const FEEDBACK_MAX_LENGTH = 2000;

interface Props {
  readonly visible: boolean;
  readonly onClose: () => void;
}

export function FeedbackModal({ visible, onClose }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const [message, setMessage] = useState('');
  const [category, setCategory] = useState<FeedbackCategory | null>(null);
  const [station, setStation] = useState<Station | null>(null);
  const [stationQuery, setStationQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const tripOrigin = useDestinationStore((s) => s.tripOrigin);
  const destination = useDestinationStore((s) => s.destination);

  const trimmed = message.trim();
  // 메모 또는 유형 칩 중 하나는 있어야 보낼 수 있다(역만 고른 경우는 불가).
  const hasContent = trimmed.length > 0 || category !== null;
  const canSubmit = hasContent && trimmed.length <= FEEDBACK_MAX_LENGTH && !submitting;

  // 진행 중 trip의 출발·도착역을 상단 추천으로 — 역 id 기준 중복 제거.
  const recommended = useMemo(() => {
    const candidates = [tripOrigin, destination].filter((s): s is Station => s !== null);
    return candidates.filter((c, i) => candidates.findIndex((o) => o.id === c.id) === i);
  }, [tripOrigin, destination]);
  const searchResults = useMemo(
    () => searchStations(allStations, stationQuery, STATION_RESULT_LIMIT),
    [stationQuery],
  );

  const resetForm = () => {
    setMessage('');
    setCategory(null);
    setStation(null);
    setStationQuery('');
  };

  const handleClose = () => {
    resetForm();
    setStatusText(null);
    onClose();
  };

  const selectStation = (picked: Station) => {
    setStation(picked);
    setStationQuery('');
  };

  /** 보내기 시점에 1회 수집 — 실패해도 신고 자체는 보낸다(message-only). */
  const buildOptions = async (): Promise<SubmitFeedbackOptions> => {
    const report: FeedbackReport = { occurredAt: Date.now() };
    if (category !== null) report.category = category;
    if (station !== null) report.stationId = station.id;
    try {
      const { args, tokens, tripKey } = await collectReportDumpInputs();
      if (tripKey !== null) report.tripKey = tripKey;
      return { report, diagnostics: buildDumpText(args, { redact: true, tokens }) };
    } catch (e) {
      log.warn('diagnostics collect failed — sending message only', e);
      return { report };
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setStatusText(null);
    const outgoing = buildFeedbackMessage({
      memo: message,
      categoryLabel: category === null ? undefined : t(`feedback.category.${category}`),
      stationName: station?.name,
    });
    const result = await submitFeedback(outgoing, await buildOptions());
    setSubmitting(false);
    if (result.ok) {
      setStatusText(t('feedback.successToast'));
      resetForm();
      // 짧게 보여주고 자동 close — 즉시 닫으면 toast가 사라져 보이지 않음.
      setTimeout(() => handleClose(), 1200);
    } else {
      setStatusText(t('feedback.errorToast'));
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={handleClose}
      testID="feedback-modal"
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={[styles.backdrop, { backgroundColor: colors.overlay }]}
      >
        <Pressable
          style={styles.backdropPressable}
          onPress={Keyboard.dismiss}
          testID="feedback-backdrop"
          accessible={false}
        />
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: colors.card,
              paddingBottom: insets.bottom + spacing.lg,
            },
          ]}
        >
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.scrollContent}
            testID="feedback-scroll"
          >
            <View style={styles.header}>
              <Text style={[styles.title, { color: colors.ink }]}>
                {t('feedback.title')}
              </Text>
              <Pressable
                onPress={handleClose}
                testID="feedback-close"
                accessibilityRole="button"
                accessibilityLabel={t('common.close')}
              >
                <Text style={[styles.close, { color: colors.muted }]}>✕</Text>
              </Pressable>
            </View>

            <Text style={[styles.description, { color: colors.muted }]}>
              {t('feedback.description')}
            </Text>

            <Text style={[styles.sectionLabel, { color: colors.ink }]}>{t('feedback.whereWrong')}</Text>
            <View style={styles.chipRow}>
              {FEEDBACK_CATEGORIES.map((id) => {
                const selected = category === id;
                return (
                  <Pressable
                    key={id}
                    onPress={() => setCategory(selected ? null : id)}
                    style={[
                      styles.chip,
                      {
                        borderColor: selected ? colors.accent : colors.hair,
                        backgroundColor: selected ? colors.accent : colors.bg,
                      },
                    ]}
                    testID={`feedback-chip-${id}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                  >
                    <Text style={[styles.chipText, { color: selected ? colors.onAccent : colors.ink }]}>
                      {t(`feedback.category.${id}`)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {station !== null ? (
              <View style={styles.selectedRow} testID="feedback-station-selected">
                <Text style={[styles.selectedName, { color: colors.ink }]}>{station.name}</Text>
                <LineBadge line={station.line} />
                <Pressable
                  onPress={() => setStation(null)}
                  testID="feedback-station-clear"
                  accessibilityRole="button"
                  accessibilityLabel={t('feedback.stationClear')}
                >
                  <Text style={[styles.close, { color: colors.muted }]}>✕</Text>
                </Pressable>
              </View>
            ) : (
              <>
                {recommended.length > 0 && (
                  <View testID="feedback-station-recommend">
                    <Text style={[styles.recommendLabel, { color: colors.muted }]}>
                      {t('feedback.recommended')}
                    </Text>
                    <View style={styles.chipRow}>
                      {recommended.map((rec) => (
                        <Pressable
                          key={rec.id}
                          onPress={() => selectStation(rec)}
                          style={[styles.chip, { borderColor: colors.hair, backgroundColor: colors.bg }]}
                          testID={`feedback-station-recommend-${rec.id}`}
                          accessibilityRole="button"
                        >
                          <Text style={[styles.chipText, { color: colors.ink }]}>{rec.name}</Text>
                          <LineBadge line={rec.line} />
                        </Pressable>
                      ))}
                    </View>
                  </View>
                )}
                <TextInput
                  style={[
                    styles.stationInput,
                    { color: colors.ink, borderColor: colors.hair, backgroundColor: colors.bg },
                  ]}
                  value={stationQuery}
                  onChangeText={setStationQuery}
                  placeholder={t('feedback.stationSearchPlaceholder')}
                  placeholderTextColor={colors.muted}
                  testID="feedback-station-input"
                />
                {searchResults.length > 0 && (
                  <View testID="feedback-station-results">
                    {searchResults.map((result) => (
                      <Pressable
                        key={result.id}
                        onPress={() => selectStation(result)}
                        style={styles.resultRow}
                        testID={`feedback-station-result-${result.id}`}
                        accessibilityRole="button"
                      >
                        <Text style={[styles.resultName, { color: colors.ink }]}>{result.name}</Text>
                        <LineBadge line={result.line} />
                      </Pressable>
                    ))}
                  </View>
                )}
              </>
            )}

            <TextInput
              style={[
                styles.input,
                { color: colors.ink, borderColor: colors.hair, backgroundColor: colors.bg },
              ]}
              value={message}
              onChangeText={setMessage}
              placeholder={t('feedback.placeholder')}
              placeholderTextColor={colors.muted}
              multiline
              maxLength={FEEDBACK_MAX_LENGTH}
              testID="feedback-input"
              accessibilityLabel={t('feedback.title')}
            />

            <Text style={[styles.counter, { color: colors.muted }]}>
              {trimmed.length}/{FEEDBACK_MAX_LENGTH}
            </Text>

            <Text
              style={[styles.attachNotice, { color: colors.muted }]}
              testID="feedback-attach-notice"
            >
              {t('feedback.attachNotice')}
            </Text>

            {statusText !== null && (
              <Text
                style={[styles.status, { color: colors.muted }]}
                testID="feedback-status"
              >
                {statusText}
              </Text>
            )}

            <Pressable
              onPress={handleSubmit}
              style={[
                styles.submit,
                {
                  backgroundColor: canSubmit ? colors.accent : colors.hair,
                },
              ]}
              testID="feedback-submit"
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSubmit }}
            >
              <Text style={[styles.submitText, { color: colors.onAccent }]}>
                {submitting ? t('feedback.submitting') : t('feedback.submit')}
              </Text>
            </Pressable>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdropPressable: {
    ...StyleSheet.absoluteFillObject,
  },
  sheet: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    maxHeight: '90%',
  },
  scrollContent: {
    flexGrow: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  title: {
    ...typography.bodyLg,
    fontWeight: '700',
  },
  close: {
    ...typography.titleXs,
    padding: spacing.xs,
  },
  description: {
    ...typography.caption,
    lineHeight: 18,
    marginBottom: spacing.md,
  },
  input: {
    minHeight: 120,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    ...typography.bodyBase,
    textAlignVertical: 'top',
  },
  sectionLabel: {
    ...typography.caption,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  chipText: {
    ...typography.caption,
  },
  selectedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  selectedName: {
    ...typography.bodyBase,
    fontWeight: '700',
  },
  recommendLabel: {
    ...typography.captionSm,
    marginBottom: spacing.xs,
  },
  stationInput: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
    ...typography.bodyBase,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
  },
  resultName: {
    ...typography.bodyBase,
  },
  attachNotice: {
    ...typography.captionSm,
    marginTop: spacing.sm,
  },
  counter: {
    ...typography.captionSm,
    textAlign: 'right',
    marginTop: spacing.xs,
  },
  status: {
    ...typography.caption,
    marginTop: spacing.sm,
    textAlign: 'center',
  },
  submit: {
    marginTop: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  submitText: {
    ...typography.bodyBase,
    fontWeight: '700',
  },
});
