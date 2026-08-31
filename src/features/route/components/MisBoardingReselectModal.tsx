/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, typography, spacing, radius } from '../../../shared/theme';
import { BoardingTrainList } from '../../alarm/components/BoardingTrainList';
import type { ArrivalInfo } from '../../../shared/types/arrival';
import type { LineNumber } from '../../../shared/types/station';

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
  /**
   * #2446 — BoardingTrainList로 forward. #1326 fallback으로 합쳐진 반대 방향 열차 trainCode
   * 집합. 해당 row는 route 방향 nextStationLabel 대신 자신의 실제 방면으로 라벨링된다.
   */
  offRouteTrainCodes?: ReadonlySet<string>;
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
  offRouteTrainCodes,
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
            <Pressable
              onPress={onClose}
              testID="mis-boarding-reselect-close"
              accessibilityRole="button"
              accessibilityLabel="닫기"
              accessibilityHint="재선택을 취소합니다"
            >
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
              offRouteTrainCodes={offRouteTrainCodes}
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
