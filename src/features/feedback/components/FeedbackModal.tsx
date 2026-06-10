/**
 * 버그 신고 모달 (#1034, docs/requirements/12-cross-cutting.md).
 *
 * SettingsScreen 진입점에서 열림. 사용자가 자유 텍스트로 메시지를 입력해 backend `POST /feedback`에
 * 송신. 송신 결과(ok/실패)에 따라 toast 안내 후 자동 close.
 *
 * Scope 정책:
 *   - 자유 텍스트 한 필드만 — 카테고리/이메일 등 추가 입력은 후속 PR.
 *   - 디바이스 컨텍스트(앱 버전/플랫폼/로케일)는 `buildFeedbackContext`가 자동 첨부 — 사용자 입력 X.
 *   - 송신 실패는 사용자 친화 toast로 안내하고 입력값은 보존 (재시도 가능).
 */
import { useState } from 'react';
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
import { submitFeedback } from '../../../shared/api/feedback';
import { useTheme, spacing, radius } from '../../../shared/theme';

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
  const [submitting, setSubmitting] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);

  const trimmed = message.trim();
  const canSubmit = trimmed.length > 0 && trimmed.length <= FEEDBACK_MAX_LENGTH && !submitting;

  const handleClose = () => {
    setMessage('');
    setStatusText(null);
    onClose();
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setStatusText(null);
    const result = await submitFeedback(trimmed);
    setSubmitting(false);
    if (result.ok) {
      setStatusText(t('feedback.successToast'));
      setMessage('');
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
    fontSize: 18,
    fontWeight: '700',
  },
  close: {
    fontSize: 20,
    padding: spacing.xs,
  },
  description: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: spacing.md,
  },
  input: {
    minHeight: 120,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    fontSize: 15,
    textAlignVertical: 'top',
  },
  counter: {
    fontSize: 12,
    textAlign: 'right',
    marginTop: spacing.xs,
  },
  status: {
    fontSize: 13,
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
    fontSize: 15,
    fontWeight: '700',
  },
});
