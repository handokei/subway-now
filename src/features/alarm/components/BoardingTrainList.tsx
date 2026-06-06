/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, typography, spacing, radius } from '../../../shared/theme';
import { LineBadge } from '../../../shared/ui/LineBadge';
import type { ArrivalInfo } from '../../../shared/types/arrival';
import type { LineNumber, Station } from '../../../shared/types/station';
import { formatClockTime } from '../../../shared/utils/formatTime';
import { arrivalAt } from '../../../shared/utils/arrivalClock';
import { isScheduleFallbackTrainCode } from '../utils/scheduleFallback';
import { buildDirectionMeta } from '../../route/utils/trainLineDirection';
import { parseArrivalDistance } from '../../arrival/utils/arrivalStatusDistance';
import { LINE_COLORS } from '../../../shared/constants/lineColors';
import { buildFallbackSequenceLabel } from '../../../shared/constants/labels';
import stationsData from '../../../data/stations.json';

const allStations = stationsData as Station[];

/** row 좌측 호선 색 stripe 두께(#664). 시각적 구분을 헤더 외에도 row마다 즉시 인지 가능하게. */
const LINE_STRIPE_WIDTH = 3;

/**
 * 지연 노출 임계값(초) — Epic #896 Seam A (#897).
 *
 * BoardingLock이 잡힌 시점의 ETA(initialEtaSeconds)와 현재 폴의 가장 가까운 도착 ETA 차이가
 * 이 값 이상이면 "+N분 지연" 칩을 노출. 30s 폴링 jitter + 약간의 정상 변동을 흡수하면서 사용자가
 * 체감 가능한 단위(3분)를 첫 신호로 잡는다.
 */
const DELAY_NOTICE_THRESHOLD_SECONDS = 180;

interface Props {
  arrivals: ArrivalInfo[];
  line: LineNumber;
  onSelect: (train: ArrivalInfo) => void;
  /**
   * 도착 시각이 이 값보다 빠른 열차는 disabled로 렌더 (#584 PR E). 단위: 초.
   * 환승 list에서 도보 buffer 표현용. 미전달 시 모든 열차 활성.
   */
  walkingBufferSeconds?: number;
  /** 헤더 라벨 커스텀 (환승 list 등). 미전달 시 home.boardingTrainListTitle i18n 키. compact=true면 무시. */
  title?: string;
  /**
   * 다음 인접역 라벨(#649, #749, #807). 있으면 "<label>방면"만 노출(종착 제거).
   * 호출자가 resolveNextAdjacentStationName으로 계산해 전달. null/미전달이면 종착 fallback.
   */
  nextStationLabel?: string | null;
  /**
   * Timeline hop slot 안 inline 배치용 컴팩트 모드(#649). 헤더/카드 배경 제거,
   * row padding 축소, 폰트 한 단계 다운, trainCode 라인 생략.
   */
  compact?: boolean;
  /**
   * 활성 BoardingLock의 탑승 시점 ETA 스냅샷(초) — Epic #896 Seam A (#897).
   *
   * 가장 가까운 도착 train의 arrivalSeconds가 이 값보다 DELAY_NOTICE_THRESHOLD_SECONDS 이상 늘었다면
   * 같은 trainCode 유지 동안 누적 지연이 발생한 것으로 보고 "+N분 지연" 칩을 노출한다.
   * 미전달이면 칩 미노출 — lock 없는 상태(예: misBoarding 재선택)나 레거시 lock에서도 안전.
   */
  initialEtaSeconds?: number;
}

/**
 * 현재역 도착 list — 사용자가 탑승할 열차를 명시적으로 선택하는 진입점 (#584 PR B).
 *
 * 호출자는 route 방향으로 필터링된 arrivals를 전달한다. 노선(line) 필터는 컴포넌트가 내부에서 수행
 * (#664): 환승역 statnNm 응답이 다른 노선 열차를 섞어 보내므로 헤더 line 기준으로 한 번 더 걸러
 * caller 세 곳(index/MisBoardingReselectModal/useTransferTrainList)이 동일 보호를 받는다.
 *
 * 각 row를 탭하면 onSelect 콜백이 발화 → 호출자가 BoardingLock 생성.
 *
 * #634: 도착 시각을 "분" 상대 표기 → "HH:mm" 절대 표기.
 * #649: compact + nextStationLabel — Timeline hop slot 안에 inline 배치되는 형태 지원.
 *       compact 모드는 hop slot 안 inline이라 row borderRadius 없음(직각). stripe도 같은 정신으로
 *       직각 유지 — 일반 모드는 카드 radius와 어울리는 둥근 코너 stripe로 자연스럽게 처리됨.
 * #749: 2줄 row 레이아웃 — 첫째 줄 "{종착}{방면?}" (방면은 옵셔널), 둘째 줄 "{거리} · {HH:mm} 도착 예정".
 *       카운터는 호출자가 전달한 배열 순서를 1-indexed로 변환. 같은 trainCode가 유지되는 동안
 *       카운터 안정 → "같은 열차 지연" 신호.
 * #790: 거리 표기를 API `arvlMsg2`에서 정규식 파싱한 실거리로 변경 (`parseArrivalDistance`).
 *       비어있는 statusMessage(주로 mock/schedule fallback)는 `${index+1}번째 전`로 fallback.
 * #855: fallback 라벨을 "약 N정거장 전 (약 M분 후)"로 변경. 단위(정거장/분) 명시로 mock/schedule
 *       fallback 시 사용자가 거리/시간을 인지할 수 있게 함. 라벨 텍스트는 `constants/labels.ts`
 *       에 분리하여 JSX 하드코딩 금지(글로벌 룰 3).
 * #792: 종착 표기는 `parseTrainLineDirection`로 i18n 정규화한다 (기존 하드코딩 "행" 부착 제거).
 * #805: "곧 도착"/"전역 출발"/"당역 도착" 등 statusMessage가 sequence 슬롯을 차지하는 임박 상태에서
 *       도착 예정 HH:mm 시간 라벨이 같은 줄에서 가려지는 회귀가 있었다. 시간 라벨을 항상 별도 라인
 *       으로 분리해 "상태 텍스트(또는 거리) → 시간"이 위아래로 명확히 보이도록 한다.
 * #807: 첫째 줄은 종착(마천행/방화행 등)이 아니라 **다음 인접역 방면**만 표시(`buildDirectionMeta`).
 *       nextStationLabel 미전달 시에만 종착 fallback. 종착 분기 누락 회귀(5호선 등) 완전 차단.
 */
export function BoardingTrainList({
  arrivals,
  line,
  onSelect,
  walkingBufferSeconds,
  title,
  nextStationLabel = null,
  compact = false,
  initialEtaSeconds,
}: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  // #915 후속: 헤더 라벨/empty placeholder를 i18n으로 분리.
  // 4 locales(ko/en/ja/zh) 비-한국어 사용자가 핵심 baseline UX("탑승할 열차 선택")를 모국어로 본다.
  const headerTitle = title ?? t('home.boardingTrainListTitle');
  const isUnreachable = (train: ArrivalInfo): boolean =>
    walkingBufferSeconds != null && train.arrivalSeconds < walkingBufferSeconds;

  // #664: 환승역 statnNm 응답에 같은 이름 다른 노선 열차가 섞여 들어오므로 헤더 line 기준 필터.
  // train.line은 어댑터가 subwayId로 row마다 정확히 결정한 값(#663). 일치하는 row만 표시.
  const filteredArrivals = arrivals.filter((train) => train.line === line);

  // #897 Seam A: 가장 가까운 도착 ETA가 lock 시점보다 +180s 이상이면 누적 지연(분) 노출.
  // arrivals는 호출자가 도착시간 오름차순으로 전달한다는 컨벤션을 따른다(#749 카운터와 동일 가정).
  const delayMinutes = computeDelayMinutes(filteredArrivals, initialEtaSeconds);

  if (filteredArrivals.length === 0) {
    return (
      <View
        style={compact ? styles.emptyCompact : styles.empty}
        testID="boarding-train-list-empty"
      >
        <Text style={[typography.bodySm, { color: colors.muted }]}>{t('home.boardingTrainListEmpty')}</Text>
      </View>
    );
  }

  return (
    <View
      style={compact ? styles.containerCompact : styles.container}
      testID="boarding-train-list"
    >
      {!compact && (
        <View style={styles.header}>
          <LineBadge line={line} />
          <Text style={[typography.label, { color: colors.muted }]}>{headerTitle}</Text>
        </View>
      )}
      {delayMinutes != null && (
        <View
          style={[styles.delayChip, { borderColor: colors.danger }]}
          testID="boarding-train-delay-chip"
        >
          <Text style={[styles.delayChipText, { color: colors.danger }]}>{`+${delayMinutes}분 지연`}</Text>
        </View>
      )}
      {filteredArrivals.map((train, index) => {
        const unreachable = isUnreachable(train);
        // #792: 종착·방면 라벨을 i18n 정규화 + dedup. nextStationLabel 미전달이면 종착만.
        const metaText = buildDirectionMeta(train.destination, nextStationLabel, allStations);
        // #790: API arvlMsg2 기반 진짜 거리 표시. 비어있으면 mock/schedule fallback 경로 —
        // #855에서 fallback 라벨을 "약 N정거장 전 (약 M분 후)"로 단위 명시. arrivalSeconds가 0
        // 이하면 분 라벨 생략.
        const parsedDistance = parseArrivalDistance(train.statusMessage);
        const sequenceText =
          parsedDistance.length > 0
            ? parsedDistance
            : buildFallbackSequenceLabel(index, train.arrivalSeconds);
        const arrivalText = `${formatArrivalClock(train)} 도착 예정`;
        return (
          <Pressable
            key={train.trainCode}
            onPress={() => onSelect(train)}
            disabled={unreachable}
            style={[
              compact ? styles.rowCompact : styles.row,
              compact ? null : { backgroundColor: colors.card },
              { borderLeftWidth: LINE_STRIPE_WIDTH, borderLeftColor: LINE_COLORS[train.line] },
              { opacity: unreachable ? 0.4 : 1 },
            ]}
            testID={`boarding-train-row-${train.trainCode}`}
          >
            <View style={styles.rowContent}>
              <View style={styles.rowMetaLine}>
                <Text
                  style={[
                    compact ? typography.bodySm : typography.body,
                    { color: colors.ink, flex: 1 },
                  ]}
                  testID={`boarding-train-meta-${train.trainCode}`}
                >
                  {metaText}
                </Text>
                {/* trainCode/시간표 배지는 일반 모드에서만 노출. compact는 timeline hop slot 안 inline이라 정보 밀도 최소화. */}
                {!compact &&
                  (isScheduleFallbackTrainCode(train.trainCode) ? (
                    <Text style={[typography.mono, { color: colors.subtle }]}>시간표</Text>
                  ) : (
                    <Text style={[typography.mono, { color: colors.muted }]}>{train.trainCode}</Text>
                  ))}
              </View>
              {/* #805: sequence(거리/상태)와 시간 라벨은 별도 라인으로 분리.
                  sequenceText가 "전역 출발"/"당역 도착"/"4번째 전" 등 어떤 길이여도 시간 라벨이
                  같은 줄에서 가려지지 않는다. sequenceText가 비어 있으면 그 라인은 미렌더하지만
                  시간 라벨 라인은 항상 표시한다. */}
              {sequenceText.length > 0 && (
                <View style={styles.rowSequenceLine}>
                  <Text
                    style={[typography.bodySm, { color: colors.muted }]}
                    testID={`boarding-train-sequence-${train.trainCode}`}
                  >
                    {sequenceText}
                  </Text>
                </View>
              )}
              <View style={styles.rowArrivalLine}>
                <Text
                  style={[typography.bodySm, { color: colors.accent, fontWeight: '600' }]}
                  testID={`boarding-train-arrival-${train.trainCode}`}
                >
                  {arrivalText}
                </Text>
              </View>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * 도착 시각 절대 표기(HH:mm) — #634, #897.
 *
 * #897 Seam A: anchor를 receivedAtMs+arrivalSeconds → `arrivalAt(train)` (현재 시각 + 남은 초)로 통일.
 * useArrivalCountdown이 tick마다 arrivalSeconds를 1씩 줄이는 동안 시계도 1초 흐르므로 anchor가 stable.
 * ArrivalRow(useCountdown 기반)와 같은 row의 시각이 항상 일치한다.
 */
function formatArrivalClock(train: ArrivalInfo): string {
  return formatClockTime(arrivalAt(train));
}

/**
 * 지연(분) 계산 — Epic #896 Seam A (#897).
 *
 * 가장 가까운 도착의 arrivalSeconds가 초기 ETA보다 임계값(180초) 이상 늘면 그 차이를 분 단위 올림으로 반환.
 * 미만이면 null(칩 미노출). initialEta 미전달이나 0 이하(임박/baseline 없음)도 null.
 * 호출자가 정렬을 보장하지 않을 수 있으므로 본 함수가 arrivalSeconds 오름차순 정렬 후 nearest 선택.
 */
function computeDelayMinutes(
  arrivals: ArrivalInfo[],
  initialEtaSeconds: number | undefined,
): number | null {
  if (initialEtaSeconds == null || initialEtaSeconds <= 0) return null;
  if (arrivals.length === 0) return null;
  const [head, ...rest] = arrivals;
  const nearest = rest.reduce(
    (min, cur) => (cur.arrivalSeconds < min.arrivalSeconds ? cur : min),
    head,
  );
  const diff = nearest.arrivalSeconds - initialEtaSeconds;
  if (diff < DELAY_NOTICE_THRESHOLD_SECONDS) return null;
  return Math.ceil(diff / 60);
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  },
  containerCompact: {
    gap: spacing.xs,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.lg,
    borderRadius: radius.md,
  },
  rowCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  rowContent: {
    flex: 1,
    gap: spacing.xs,
  },
  rowMetaLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  rowSequenceLine: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowArrivalLine: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  empty: {
    padding: spacing.lg,
    alignItems: 'center',
  },
  emptyCompact: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  // #897 — outline 칩. ArrivalStatusBadge의 outline variant와 동일 외형(borderWidth 1 + radius 3).
  delayChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.xs,
    paddingVertical: 1,
    borderRadius: 3,
    borderWidth: 1,
  },
  delayChipText: { fontSize: 11, fontWeight: '700', letterSpacing: 0 },
});
