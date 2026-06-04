import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, typography, spacing, radius } from '../shared/theme';

interface Props {
  /** true일 때 노출. false면 unmount 또는 즉시 숨김. */
  visible: boolean;
  message: string;
  /** auto-dismiss 시간(ms). 0이면 자동 해제 안 함. 기본 5000. */
  durationMs?: number;
  /** auto-dismiss 또는 사용자 탭 시 호출. caller가 visible state를 false로 내려야 함. */
  onDismiss: () => void;
  /** accent color. warn/danger/accent 등 의도 색. 기본 accent. */
  accent?: string;
  testID?: string;
}

/**
 * 화면 상단에 띄우는 floating 알림 (#603).
 *
 * controlled component — caller가 visible state를 관리. durationMs 후 자동 onDismiss 호출.
 * Pressable 전체가 dismiss 버튼이라 사용자가 어디든 탭하면 닫힘.
 * 외부 토스트 라이브러리 회피 — 의존성 최소 + 테마 토큰 직접 사용.
 */
export function Toast({
  visible,
  message,
  durationMs = 5000,
  onDismiss,
  accent,
  testID,
}: Props) {
  const { colors } = useTheme();
  const tone = accent ?? colors.accent;

  useEffect(() => {
    if (!visible || durationMs <= 0) return;
    const handle = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(handle);
  }, [visible, durationMs, onDismiss]);

  if (!visible) return null;

  return (
    <Pressable
      onPress={onDismiss}
      style={[styles.container, { backgroundColor: colors.card, borderColor: tone }]}
      testID={testID}
    >
      <View style={[styles.accentStripe, { backgroundColor: tone }]} />
      <Text style={[typography.body, styles.message, { color: colors.ink }]}>{message}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: spacing.xxl,
    left: spacing.lg,
    right: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.lg,
    borderWidth: 1,
    overflow: 'hidden',
    zIndex: 1000,
  },
  accentStripe: {
    width: 4,
    alignSelf: 'stretch',
  },
  message: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
});
