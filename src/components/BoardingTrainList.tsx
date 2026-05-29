import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, typography, spacing, radius } from '../theme';
import { LineBadge } from './LineBadge';
import type { ArrivalInfo } from '../api/arrivalApi';
import type { LineNumber } from '../types/station';
import { formatClockTime } from '../utils/formatTime';

interface Props {
  arrivals: ArrivalInfo[];
  line: LineNumber;
  onSelect: (train: ArrivalInfo) => void;
  /**
   * 도착 시각이 이 값보다 빠른 열차는 disabled로 렌더 (#584 PR E). 단위: 초.
   * 환승 list에서 도보 buffer 표현용. 미전달 시 모든 열차 활성.
   */
  walkingBufferSeconds?: number;
  /** 헤더 라벨 커스텀 (환승 list 등). 미전달 시 기본 "탑승할 열차 선택". */
  title?: string;
}

/**
 * 현재역 도착 list — 사용자가 탑승할 열차를 명시적으로 선택하는 진입점 (#584 PR B).
 *
 * 호출자는 이미 route 방향으로 필터링된 arrivals를 전달한다 — 이 컴포넌트는 디스플레이/탭 처리만 담당.
 * 각 row를 탭하면 onSelect 콜백이 발화 → 호출자가 BoardingLock 생성.
 * 빈 list면 placeholder 안내 텍스트.
 *
 * #634: 도착 시각을 "분" 상대 표기 → "HH:mm" 절대 표기로 전환. 사용자 시계와 직접 매칭.
 */
export function BoardingTrainList({
  arrivals,
  line,
  onSelect,
  walkingBufferSeconds,
  title = '탑승할 열차 선택',
}: Props) {
  const { colors } = useTheme();
  const isUnreachable = (train: ArrivalInfo): boolean =>
    walkingBufferSeconds != null && train.arrivalSeconds < walkingBufferSeconds;

  if (arrivals.length === 0) {
    return (
      <View style={styles.empty} testID="boarding-train-list-empty">
        <Text style={[typography.bodySm, { color: colors.muted }]}>도착 예정 열차가 없습니다.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="boarding-train-list">
      <View style={styles.header}>
        <LineBadge line={line} />
        <Text style={[typography.label, { color: colors.muted }]}>{title}</Text>
      </View>
      {arrivals.map((train) => {
        const unreachable = isUnreachable(train);
        return (
          <Pressable
            key={train.trainCode}
            onPress={() => onSelect(train)}
            disabled={unreachable}
            style={[styles.row, { backgroundColor: colors.card, opacity: unreachable ? 0.4 : 1 }]}
            testID={`boarding-train-row-${train.trainCode}`}
          >
            <View style={styles.rowInfo}>
              <Text style={[typography.body, { color: colors.ink }]}>{train.destination} 행</Text>
              <Text style={[typography.mono, { color: colors.muted }]}>{train.trainCode}</Text>
            </View>
            <Text
              style={[typography.body, { color: colors.accent, fontWeight: '600' }]}
              testID={`boarding-train-arrival-${train.trainCode}`}
            >
              {formatArrivalClock(train)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * 도착 시각 절대 표기(HH:mm) — #634.
 * receivedAtMs(API fetch 시점) + arrivalSeconds로 절대 도착 시각 산출.
 * receivedAtMs 0(mock/stale)이면 현재 시각 기준 fallback — 한 사이클 내에서는 결정적.
 */
function formatArrivalClock(train: ArrivalInfo): string {
  const baseMs = train.receivedAtMs > 0 ? train.receivedAtMs : Date.now();
  return formatClockTime(baseMs + train.arrivalSeconds * 1000);
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.lg,
    borderRadius: radius.md,
  },
  rowInfo: {
    gap: spacing.xs,
  },
  empty: {
    padding: spacing.lg,
    alignItems: 'center',
  },
});
