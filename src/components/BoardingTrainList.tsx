import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, typography, spacing, radius } from '../theme';
import { LineBadge } from './LineBadge';
import type { ArrivalInfo } from '../api/arrivalApi';
import type { LineNumber, Station } from '../types/station';
import { formatClockTime } from '../utils/formatTime';
import { isScheduleFallbackTrainCode } from '../utils/scheduleFallback';
import { buildDirectionMeta } from '../utils/trainLineDirection';
import { parseArrivalDistance } from '../utils/arrivalStatusDistance';
import { LINE_COLORS } from '../constants/lineColors';
import stationsData from '../data/stations.json';

const allStations = stationsData as Station[];

/** row 좌측 호선 색 stripe 두께(#664). 시각적 구분을 헤더 외에도 row마다 즉시 인지 가능하게. */
const LINE_STRIPE_WIDTH = 3;

interface Props {
  arrivals: ArrivalInfo[];
  line: LineNumber;
  onSelect: (train: ArrivalInfo) => void;
  /**
   * 도착 시각이 이 값보다 빠른 열차는 disabled로 렌더 (#584 PR E). 단위: 초.
   * 환승 list에서 도보 buffer 표현용. 미전달 시 모든 열차 활성.
   */
  walkingBufferSeconds?: number;
  /** 헤더 라벨 커스텀 (환승 list 등). 미전달 시 기본 "탑승할 열차 선택". compact=true면 무시. */
  title?: string;
  /**
   * 다음 인접역 라벨(#649, #749). 종착과 같이 "{destination}행 · {label}방면" 형태로 노출.
   * 호출자가 resolveNextAdjacentStationName으로 계산해 전달. null/미전달이면 종착만 표기.
   */
  nextStationLabel?: string | null;
  /**
   * Timeline hop slot 안 inline 배치용 컴팩트 모드(#649). 헤더/카드 배경 제거,
   * row padding 축소, 폰트 한 단계 다운, trainCode 라인 생략.
   */
  compact?: boolean;
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
 *       비어있는 statusMessage(주로 mock/schedule fallback)는 기존 `${index+1}번째 전`로 fallback.
 * #792: 종착 표기는 `parseTrainLineDirection`로 i18n 정규화한다 (기존 하드코딩 "행" 부착 제거).
 *       종착에 이미 다음역 명이 포함된 경우(예: "어린이대공원(세종대)방면"+"어린이대공원") "방면"
 *       접미사를 생략해 라벨 중복("…방면행 · …방면")을 차단한다.
 */
export function BoardingTrainList({
  arrivals,
  line,
  onSelect,
  walkingBufferSeconds,
  title = '탑승할 열차 선택',
  nextStationLabel = null,
  compact = false,
}: Props) {
  const { colors } = useTheme();
  const isUnreachable = (train: ArrivalInfo): boolean =>
    walkingBufferSeconds != null && train.arrivalSeconds < walkingBufferSeconds;

  // #664: 환승역 statnNm 응답에 같은 이름 다른 노선 열차가 섞여 들어오므로 헤더 line 기준 필터.
  // train.line은 어댑터가 subwayId로 row마다 정확히 결정한 값(#663). 일치하는 row만 표시.
  const filteredArrivals = arrivals.filter((train) => train.line === line);

  if (filteredArrivals.length === 0) {
    return (
      <View
        style={compact ? styles.emptyCompact : styles.empty}
        testID="boarding-train-list-empty"
      >
        <Text style={[typography.bodySm, { color: colors.muted }]}>도착 예정 열차가 없습니다.</Text>
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
          <Text style={[typography.label, { color: colors.muted }]}>{title}</Text>
        </View>
      )}
      {filteredArrivals.map((train, index) => {
        const unreachable = isUnreachable(train);
        // #792: 종착·방면 라벨을 i18n 정규화 + dedup. nextStationLabel 미전달이면 종착만.
        const metaText = buildDirectionMeta(train.destination, nextStationLabel, allStations);
        // #790: API arvlMsg2 기반 진짜 거리 표시. 비어있으면 배열 인덱스 fallback(이전 동작 유지 —
        // 주로 mock/schedule fallback 경로). 실 응답에서는 항상 [N]번째 전역 패턴이 들어와
        // 사용자 의도(역 개수)와 일치한다.
        const parsedDistance = parseArrivalDistance(train.statusMessage);
        const sequenceText = parsedDistance.length > 0 ? parsedDistance : `${index + 1}번째 전`;
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
              <View style={styles.rowDetailLine}>
                <Text
                  style={[typography.bodySm, { color: colors.muted }]}
                  testID={`boarding-train-sequence-${train.trainCode}`}
                >
                  {sequenceText}
                </Text>
                <Text style={[typography.bodySm, { color: colors.subtle }]}>·</Text>
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
  rowDetailLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  empty: {
    padding: spacing.lg,
    alignItems: 'center',
  },
  emptyCompact: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
});
