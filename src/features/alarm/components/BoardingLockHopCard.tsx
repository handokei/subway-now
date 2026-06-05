import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, typography, spacing, radius } from '../../../shared/theme';
import { LINE_COLORS, LINE_NAMES } from '../../../shared/constants/lineColors';
import { formatClockTime } from '../../../shared/utils/formatTime';
import type { BoardingLock } from '../../../shared/types/boardingLock';

/** BoardingTrainList compact row와 동일한 좌측 stripe 두께 (#664/#758). */
const LINE_STRIPE_WIDTH = 3;

/** 지연 노출 임계값(초) — Seam A (#897). BoardingTrainList의 동명 상수와 동일 정책. */
const DELAY_NOTICE_THRESHOLD_SECONDS = 180;

interface Props {
  lock: BoardingLock;
  onRelease: () => void;
  /**
   * 현재 폴링의 lock.trainCode에 매칭되는 train의 잔여 ETA(초) — Epic #896 Seam A (#897).
   *
   * `lock.initialEtaSeconds`와 비교해 차이가 임계값 이상이면 "+N분 지연" 칩 노출. 미전달이면 칩 미노출.
   * 매칭되는 train이 응답에 없으면(예: 다음 도착이 다른 trainCode) 호출자가 undefined를 전달한다.
   */
  currentEtaSeconds?: number;
}

/**
 * BoardingLock 활성 시 origin hop slot 안에 inline으로 렌더되는 컴팩트 카드(#758).
 *
 * BoardingTrainList의 compact row와 시각적으로 동일한 호선색 stripe + 한 줄 메타 형태로,
 * timeline hop 사이에 자연스럽게 녹아 "탑승 정보 + 하차 액션"을 노출한다.
 *
 * 메타: "탑승 · {lineName} · {HH:mm}". trainCode raw 식별자는 비노출(#667, BoardingLockBanner 정신 유지).
 */
export function BoardingLockHopCard({ lock, onRelease, currentEtaSeconds }: Props) {
  const { colors } = useTheme();
  const lineName = LINE_NAMES[lock.boardingLine];
  const timeText = formatClockTime(lock.boardedAt);
  const metaText = `탑승 · ${lineName} · ${timeText}`;
  const delayMinutes = computeDelayMinutes(lock.initialEtaSeconds, currentEtaSeconds);
  return (
    <View
      style={[
        styles.row,
        { borderLeftWidth: LINE_STRIPE_WIDTH, borderLeftColor: LINE_COLORS[lock.boardingLine] },
      ]}
      testID="boarding-lock-hop-card"
    >
      <Text
        style={[typography.bodySm, { color: colors.ink, flex: 1 }]}
        testID="boarding-lock-hop-meta"
      >
        {metaText}
      </Text>
      {delayMinutes != null && (
        <View
          style={[styles.delayChip, { borderColor: colors.danger }]}
          testID="boarding-lock-hop-delay-chip"
        >
          <Text style={[styles.delayChipText, { color: colors.danger }]}>{`+${delayMinutes}분 지연`}</Text>
        </View>
      )}
      <Pressable
        onPress={onRelease}
        style={[styles.releaseButton, { borderColor: colors.accent }]}
        testID="boarding-lock-hop-release"
      >
        <Text style={[typography.bodySm, { color: colors.accent, fontWeight: '600' }]}>하차</Text>
      </Pressable>
    </View>
  );
}

/**
 * 지연(분) 계산 — Seam A (#897). 같은 정책을 BoardingTrainList와 공유한다.
 *
 * 의도적으로 util로 추출하지 않은 이유: 두 호출처가 input 형태(arrivals[0] vs scalar pair)가 달라
 * 공통화 시 인터페이스가 어색해진다. 같은 임계값 상수만 공유한다.
 */
function computeDelayMinutes(
  initialEtaSeconds: number | undefined,
  currentEtaSeconds: number | undefined,
): number | null {
  if (initialEtaSeconds == null || initialEtaSeconds <= 0) return null;
  if (currentEtaSeconds == null) return null;
  const diff = currentEtaSeconds - initialEtaSeconds;
  if (diff < DELAY_NOTICE_THRESHOLD_SECONDS) return null;
  return Math.ceil(diff / 60);
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    gap: spacing.sm,
  },
  releaseButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  // #897 — ArrivalStatusBadge outline 컨벤션과 동일 외형(borderWidth 1 + radius 3).
  delayChip: {
    paddingHorizontal: spacing.xs,
    paddingVertical: 1,
    borderRadius: 3,
    borderWidth: 1,
  },
  delayChipText: { fontSize: 11, fontWeight: '700', letterSpacing: 0 },
});
