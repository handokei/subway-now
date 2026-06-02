import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, typography, spacing, radius } from '../theme';
import { BoardingTrainList } from './BoardingTrainList';
import type { ArrivalInfo } from '../api/arrivalApi';
import type { LineNumber } from '../types/station';

interface Props {
  visible: boolean;
  /** 현재역 도착 list (route 방향 필터 후). 빈 배열이면 placeholder. */
  arrivals: ArrivalInfo[];
  /** 현재역 노선. BoardingTrainList 헤더의 LineBadge에 사용. */
  line: LineNumber | null;
  /** 사용자가 train 탭 시 — caller가 새 lock 생성 + modal close 처리. */
  onSelect: (train: ArrivalInfo) => void;
  /** 모달 자체 닫기 (취소 등). */
  onClose: () => void;
  /**
   * 다음 인접역 라벨(#749). BoardingTrainList에 forward — "{destination}행 · {label}방면" 표기.
   * 호출자가 resolveNextAdjacentStationName으로 도출해 전달. null/미전달이면 종착만 노출.
   */
  nextStationLabel?: string | null;
}

/**
 * 잘못 탑승 감지 시 노출되는 재선택 모달 (#603).
 *
 * BoardingTrainList를 재사용해 현재역 도착 list를 다시 노출. 사용자가 train 탭 →
 * onSelect 콜백 → caller가 createLockFromTrain 호출 + 모달 close 처리.
 * 모달 자체 dismiss는 헤더의 [닫기] 버튼.
 */
export function MisBoardingReselectModal({
  visible,
  arrivals,
  line,
  onSelect,
  onClose,
  nextStationLabel = null,
}: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      testID="mis-boarding-reselect-modal"
    >
      <View style={[styles.backdrop, { backgroundColor: colors.overlay }]}>
        <View
          style={[
            styles.sheet,
            { backgroundColor: colors.bg, paddingTop: spacing.lg, paddingBottom: insets.bottom + spacing.lg },
          ]}
        >
          <View style={[styles.header, { borderBottomColor: colors.hair }]}>
            <Text style={[typography.label, { color: colors.warn }]}>탑승 열차 재선택</Text>
            <Pressable onPress={onClose} testID="mis-boarding-reselect-close">
              <Text style={[typography.body, { color: colors.accent, fontWeight: '600' }]}>닫기</Text>
            </Pressable>
          </View>
          <Text style={[typography.bodySm, styles.help, { color: colors.muted }]}>
            현재역의 도착 list에서 실제 탑승한 열차를 선택해주세요.
          </Text>
          {line && (
            <BoardingTrainList
              arrivals={arrivals}
              line={line}
              onSelect={onSelect}
              nextStationLabel={nextStationLabel}
            />
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
  help: {
    paddingVertical: spacing.xs,
  },
});
