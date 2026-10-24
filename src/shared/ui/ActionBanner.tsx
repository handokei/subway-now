import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, typography, spacing, radius } from '../theme';

interface Props {
  /** border + 액션 텍스트/테두리 색. accent(보통) 또는 warn(경고) 등 의도 색. */
  accent: string;
  /** 좌측 info 슬롯 — 헤더 라벨/메타 정보/추가 콘텐츠. */
  children: ReactNode;
  /** 우측 액션 버튼 라벨 (예: "하차", "재선택"). */
  actionLabel: string;
  onActionPress: () => void;
  testID: string;
  actionTestID: string;
  /** 다음 요소와 분리 margin. 미전달 시 0. */
  marginBottom?: number;
  /**
   * 컨테이너용 스크린리더 라벨(#1077 후속). 미전달 시 children의 텍스트를 그대로 읽도록 둔다.
   * 배너 등장을 alert로 알리고 싶을 때 호출자가 의미 있는 요약문을 전달한다.
   */
  accessibilityLabel?: string;
  /**
   * 액션 버튼 스크린리더 라벨(#1077 후속). 미전달 시 `actionLabel`을 사용한다.
   * 시각 라벨이 짧을 때(예: "하차") 더 풍부한 음성 라벨이 필요하면 override.
   */
  actionAccessibilityLabel?: string;
  /** 액션 버튼 스크린리더 힌트(#1077 후속). 액션 결과를 한 줄로 설명. */
  actionAccessibilityHint?: string;
}

/**
 * 좌측 info + 우측 action 버튼 구조의 공통 배너 (#584 PR D3 — Sonar 중복 감소).
 *
 * BoardingLockBanner / MisBoardingBanner 등 같은 레이아웃을 공유. children 슬롯으로
 * info 영역을 자유롭게 채우고, 버튼은 라벨/색만 prop으로 받는다.
 */
export function ActionBanner({
  accent,
  children,
  actionLabel,
  onActionPress,
  testID,
  actionTestID,
  marginBottom,
  accessibilityLabel,
  actionAccessibilityLabel,
  actionAccessibilityHint,
}: Props) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.card, borderColor: accent, marginBottom: marginBottom ?? 0 },
      ]}
      testID={testID}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      accessibilityLabel={accessibilityLabel}
    >
      <View style={styles.info}>{children}</View>
      <Pressable
        onPress={onActionPress}
        style={[styles.actionButton, { borderColor: accent }]}
        testID={actionTestID}
        accessibilityRole="button"
        accessibilityLabel={actionAccessibilityLabel ?? actionLabel}
        accessibilityHint={actionAccessibilityHint}
      >
        <Text style={[typography.body, { color: accent, fontWeight: '600' }]}>{actionLabel}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.md,
  },
  info: {
    flex: 1,
    gap: spacing.xs,
  },
  actionButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
  },
});
