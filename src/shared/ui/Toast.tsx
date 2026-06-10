import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, typography, spacing, radius } from '../theme';

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
  /**
   * 우측 액션 버튼 라벨 (#1058 — 자동 하차 undo). actionLabel과 onAction이 모두
   * 전달돼야 액션 버튼이 렌더된다. 액션 탭은 onDismiss를 호출하지 않는다 — caller가
   * onAction 내에서 dismiss 상태를 직접 정리한다.
   */
  actionLabel?: string;
  /** 액션 버튼 탭 핸들러. actionLabel과 짝으로 전달. */
  onAction?: () => void;
  testID?: string;
}

/**
 * 화면 상단에 띄우는 floating 알림 (#603).
 *
 * controlled component — caller가 visible state를 관리. durationMs 후 자동 onDismiss 호출.
 * Pressable 전체가 dismiss 버튼이라 사용자가 어디든 탭하면 닫힘.
 * 외부 토스트 라이브러리 회피 — 의존성 최소 + 테마 토큰 직접 사용.
 *
 * #1058: optional 액션 버튼(actionLabel + onAction). 액션 영역은 별도 Pressable이라
 * 액션 탭이 컨테이너 onPress(dismiss)로 버블링되지 않는다.
 */
export function Toast({
  visible,
  message,
  durationMs = 5000,
  onDismiss,
  accent,
  actionLabel,
  onAction,
  testID,
}: Props) {
  const { colors } = useTheme();
  const tone = accent ?? colors.accent;
  const hasAction = actionLabel !== undefined && onAction !== undefined;

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
      {hasAction && (
        <Pressable
          onPress={onAction}
          style={styles.action}
          testID={testID ? `${testID}-action` : undefined}
        >
          <Text style={[typography.body, styles.actionLabel, { color: tone }]}>{actionLabel}</Text>
        </Pressable>
      )}
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
  action: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  actionLabel: {
    fontWeight: '600',
  },
});
