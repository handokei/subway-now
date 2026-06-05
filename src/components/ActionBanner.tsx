import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, typography, spacing, radius } from '../shared/theme';

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
}: Props) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.card, borderColor: accent, marginBottom: marginBottom ?? 0 },
      ]}
      testID={testID}
    >
      <View style={styles.info}>{children}</View>
      <Pressable
        onPress={onActionPress}
        style={[styles.actionButton, { borderColor: accent }]}
        testID={actionTestID}
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
