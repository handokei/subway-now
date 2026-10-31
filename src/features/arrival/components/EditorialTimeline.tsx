/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, typography, spacing, shadowStyle } from '../../../shared/theme';
import type { Stop, StopArrivalContext } from '../../../shared/types/journey';
import { LineBadge, getLineColor } from '../../../shared/ui/LineBadge';
import { useSettingsStore } from '../../settings/store/useSettingsStore';
import { resolveQuickExit } from '../../route/utils/quickExit';
import { resolveProgressingTerminal, resolveTravelDirection } from '../../route/utils/travelDirection';
import { resolveTransferDoor } from '../../route/utils/transferExit';
import { findStationByNameAndLine } from '../../../shared/utils/stationRoute';
import { LINE_NAMES } from '../../../shared/constants/lineColors';
import type { LineNumber } from '../../../shared/types/station';

interface Props {
  stops: Stop[];
  /**
   * 각 hop row 직후에 inline 노드를 끼울 수 있는 slot 콜백(#649). null 반환 시 slot 미렌더.
   * BoardingTrainList 등 hop별 보조 정보를 timeline 흐름 안쪽에 배치할 때 사용.
   */
  renderHopSlot?: (stop: Stop, index: number) => React.ReactNode;
}

// 한 stop의 도어번호 라벨을 결정한다.
// - 환승 stop이면 fromLine→toLine 빠른 환승 도어를 우선 사용 (transferExit.json).
// - 매칭 없으면 quickExit 데이터로 fallback (계단/EV 가까운 도어).
//   · 단조 노선(MONOTONIC_LINES): direction 필터로 방면별 정확한 도어 선택.
//   · 비단조 노선(1·2·5·6호선, 경의중앙선 등 — #676): direction 없이 station_id만으로 조회.
//     좌/우 안내는 정확성 보장 불가라 생략되지만 도어 번호는 노선 무관 표시 가능.
// - 둘 다 없으면 null — 라벨 미표시.
function resolveStopDoor(
  ctx: StopArrivalContext,
  transferToLine: LineNumber | null,
  accessibilityMode: boolean,
): string | null {
  if (transferToLine) {
    // #788: 단조 노선의 진행 방면 운영 종점을 fromTerminal로 전달 — 같은 환승역의 양 방향
    // row(예: 7→2 장암행 8-4 vs 석남행 1-1) 중 사용자가 가는 쪽을 정확히 선택. 비단조/매핑
    // 미보유 노선은 null이라 기존 동작(첫 매치) 유지.
    const fromTerminal = resolveProgressingTerminal(ctx.line, ctx.fromName, ctx.toName) ?? undefined;
    const transfer = resolveTransferDoor({
      stationName: ctx.toName,
      fromLine: ctx.line,
      toLine: transferToLine,
      fromTerminal,
    });
    if (transfer) return transfer.doorNumber;
  }
  const resolution = resolveTravelDirection(ctx.line, ctx.fromName, ctx.toName);
  if (resolution) {
    const result = resolveQuickExit(resolution.toStation.id, {
      accessibilityMode,
      direction: resolution.direction,
    });
    return result ? result.entry.doorNumber : null;
  }
  // 비단조 노선 fallback: line + toName으로 station 직접 매칭 (stationRoute의 SSOT helper 재사용).
  const station = findStationByNameAndLine(ctx.toName, ctx.line);
  if (!station) return null;
  const result = resolveQuickExit(station.id, { accessibilityMode });
  return result ? result.entry.doorNumber : null;
}

/**
 * 한 stop의 도어 라벨(arrivalContext + transfer target 종합). 공통 래퍼 — boardingDoor/quickExitDoor
 * 양쪽 결정 시 transferToLine 분기 중복을 제거 (#635 review P2-1).
 */
function doorFor(stop: Stop | null, accessibilityMode: boolean): string | null {
  if (!stop?.arrivalContext) return null;
  const toLine = stop.mark === 'transfer' ? stop.transferTarget?.toLine ?? null : null;
  return resolveStopDoor(stop.arrivalContext, toLine, accessibilityMode);
}

export function EditorialTimeline({ stops, renderHopSlot }: Props) {
  const { colors, isDark } = useTheme();
  const { t } = useTranslation();
  const accessibilityMode = useSettingsStore((s) => s.accessibilityMode);
  return (
    <View>
      {stops.map((s, i) => {
        const isLast = i === stops.length - 1;
        const lineC = s.line != null ? getLineColor(s.line) : colors.inkStrong;
        // #3073 — connector 색 = 다음 stop으로 타고 들어온 노선(adapter가 방출한 connectorLine).
        const nextStop = stops[i + 1] ?? null;
        const nextConnectorLine = nextStop?.connectorLine ?? nextStop?.line ?? null;
        const nextLineC = nextConnectorLine != null ? getLineColor(nextConnectorLine) : colors.inkStrong;
        // #3258 — 노드 칸 정보 = "그 역에서 탈 칸". 출발(filled)/환승(transfer) 노드만 갖고, 값은 다음 hop의
        // 도어(환승이면 환승 빠른 칸, 도착이면 하차 빠른 칸)를 재사용한다(#635). 도착 노드는 칸 없음.
        // expanded 모드에선 intermediate stop이 끼므로 arrivalContext가 있는 첫 후속 stop을 찾는다.
        const boardsHere = s.mark === 'filled' || s.mark === 'transfer';
        const nextHopStop = boardsHere
          ? stops.slice(i + 1).find((st) => st.arrivalContext != null) ?? null
          : null;
        const boardingDoor = doorFor(nextHopStop, accessibilityMode);
        const boardingDoorNote =
          boardingDoor != null && nextHopStop != null
            ? t(nextHopStop.mark === 'transfer' ? 'route.boardingDoorTransfer' : 'route.boardingDoorExit', {
                station: nextHopStop.station,
              })
            : null;
        const { segmentToNext } = s;
        const segmentChip =
          segmentToNext != null
            ? t('journey.segmentChip', {
                line: LINE_NAMES[segmentToNext.line],
                stops: t('route.stops', { count: segmentToNext.stops }),
              })
            : null;

        const isIntermediate = s.mark === 'intermediate';
        const slot = renderHopSlot ? renderHopSlot(s, i) : null;
        return (
          <React.Fragment key={i}>
          <View
            style={[styles.row, isLast && { minHeight: 36 }, isIntermediate && styles.rowIntermediate]}
            testID={`timeline-stop-${i}`}
          >
            {!isLast && (
              <View
                testID={`timeline-connector-${i}`}
                style={[
                  styles.connector,
                  { backgroundColor: nextLineC },
                ]}
              />
            )}

            <View style={styles.markerCol}>
              {s.mark === 'filled' && (
                <View style={[styles.dot, { backgroundColor: lineC, ...shadowStyle('ring', isDark, lineC) }]} testID="filled-dot" />
              )}
              {s.mark === 'transfer' && (
                <View style={[styles.dotRing, { borderColor: lineC, backgroundColor: colors.bg }]} testID="transfer-dot" />
              )}
              {s.mark === 'dest' && (
                <View style={[styles.dotDest, { backgroundColor: lineC, ...shadowStyle('ring', isDark, lineC) }]} testID="dest-dot" />
              )}
              {s.mark === 'intermediate' && (
                <View
                  style={[styles.dotIntermediate, { borderColor: lineC, backgroundColor: colors.bg }]}
                  testID="intermediate-dot"
                />
              )}
            </View>

            <View style={{ flex: 1 }}>
              <Text
                style={[
                  isIntermediate ? typography.bodySm : typography.body,
                  { fontWeight: isIntermediate ? '400' : '600', color: isIntermediate ? colors.subtle : colors.ink },
                ]}
              >
                {s.station}
              </Text>
              {s.note != null && (
                <Text
                  style={[typography.captionSm, { color: colors.muted, marginTop: 2 }]}
                  testID={`timeline-note-${i}`}
                >
                  {s.note}
                </Text>
              )}
              {segmentChip != null && (
                <Text
                  style={[typography.micro, { color: colors.subtle, marginTop: spacing.xs }]}
                  testID={`timeline-segment-${i}`}
                >
                  {segmentChip}
                </Text>
              )}
            </View>

            <View style={{ alignItems: 'flex-end' }}>
              {!isIntermediate && s.line != null && <LineBadge line={s.line} color={lineC} />}
              {boardingDoor != null && (
                <Text
                  style={[typography.micro, { color: colors.muted, marginTop: 2 }]}
                  testID={`boarding-door-${i}-${boardingDoor}`}
                >
                  {t('route.boardingDoor', { door: boardingDoor })}
                </Text>
              )}
              {boardingDoorNote != null && (
                <Text
                  style={[typography.micro, { color: colors.subtle, marginTop: 1 }]}
                  testID={`boarding-door-note-${i}`}
                >
                  {boardingDoorNote}
                </Text>
              )}
            </View>
          </View>
          {slot != null && (
            <View testID={`timeline-hop-slot-${i}`} style={styles.hopSlot}>
              {slot}
            </View>
          )}
          </React.Fragment>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    position: 'relative',
    gap: spacing.md,
  },
  // #804 — dot 폭(10/12/7px)이 종류별로 달라도 markerCol(width 28) center에 자동 정렬되도록
  // alignItems: 'center'. connector(width 1)도 같은 center(left 14)에 두면 dot/connector 어긋남 없음.
  markerCol: { width: 28, alignItems: 'center' },
  connector: {
    position: 'absolute',
    left: 12.5,
    top: 34,
    bottom: -6,
    width: 3,
    borderRadius: 2,
  },
  dot:     { width: 12, height: 12, borderRadius: 6 },
  dotRing: { width: 12, height: 12, borderRadius: 6, borderWidth: 3 },
  dotDest: { width: 12, height: 12, borderRadius: 6 },
  dotIntermediate: { width: 7, height: 7, borderRadius: 4, borderWidth: 1 },
  rowIntermediate: { minHeight: 30 },
  hopSlot: {
    paddingLeft: 28 + spacing.md, // markerCol 폭 + 행 gap — slot이 station label과 좌측 정렬되도록
    paddingBottom: spacing.xs,
  },
});
