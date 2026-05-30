import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, typography, spacing } from '../theme';
import type { Stop, StopArrivalContext } from '../utils/journeyAdapter';
import { LineBadge, getLineColor } from './LineBadge';
import { useAppStore } from '../store/useAppStore';
import { resolveQuickExit } from '../utils/quickExit';
import { resolveTravelDirection } from '../utils/travelDirection';
import { resolveTransferDoor } from '../utils/transferExit';
import { findStationByNameAndLine } from '../utils/stationRoute';
import type { LineNumber } from '../types/station';

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
    const transfer = resolveTransferDoor({
      stationName: ctx.toName,
      fromLine: ctx.line,
      toLine: transferToLine,
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
  const { colors } = useTheme();
  const { t } = useTranslation();
  const accessibilityMode = useAppStore((s) => s.accessibilityMode);
  return (
    <View>
      {stops.map((s, i) => {
        const isLast = i === stops.length - 1;
        const lineC = s.line != null ? getLineColor(s.line) : colors.accent;
        const nextLineC = !isLast
          ? (stops[i + 1].line != null ? getLineColor(stops[i + 1].line!) : colors.accent)
          : lineC;
        const quickExitDoor = doorFor(s, accessibilityMode);
        // #635 — 출발역(첫 mark='filled')에서 탑승 시 어느 칸·문에 타야 다음 hop(환승/도착)에서
        // 빠르게 내릴 수 있는지 표시. 같은 열차 = 같은 문 번호이므로 다음 hop stop의 도어를 그대로 재사용.
        // 의미만 다름: 다음 stop에선 "내리는 위치", 출발역에선 "타는 위치".
        // expanded 모드에선 origin과 첫 hop 사이에 intermediate stop들이 끼므로 인접 [i+1] 대신
        // arrivalContext가 있는 첫 후속 stop을 찾는다 (review P1-1).
        const isOrigin = i === 0 && s.mark === 'filled';
        const nextHopStop = isOrigin
          ? stops.slice(i + 1).find((st) => st.arrivalContext != null) ?? null
          : null;
        const boardingDoor = doorFor(nextHopStop, accessibilityMode);

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
                style={[
                  styles.connector,
                  { backgroundColor: mix(lineC, nextLineC, 0.5), opacity: 0.35 },
                ]}
              />
            )}

            <View style={styles.markerCol}>
              {s.mark === 'filled' && (
                <View style={[styles.dot, { backgroundColor: lineC }]} testID="filled-dot" />
              )}
              {s.mark === 'transfer' && (
                <View style={[styles.dotRing, { borderColor: lineC, backgroundColor: colors.bg }]} testID="transfer-dot" />
              )}
              {s.mark === 'dest' && (
                <View style={[styles.dotDest, { backgroundColor: lineC }]} testID="dest-dot" />
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
                <Text style={[typography.label, { color: colors.subtle, marginTop: 2 }]}>
                  {s.note}
                </Text>
              )}
            </View>

            <View style={{ alignItems: 'flex-end' }}>
              {!isIntermediate && s.line != null && <LineBadge line={s.line} color={lineC} />}
              {s.stopsFromPrev != null && (
                <Text style={[typography.mono, { color: colors.subtle, marginTop: 2 }]}>
                  {s.stopsFromPrev}
                </Text>
              )}
              {quickExitDoor != null && (
                <Text
                  style={[typography.label, { color: colors.subtle, marginTop: 2 }]}
                  testID={`quick-exit-door-${i}`}
                >
                  {t('route.quickExitDoor', { door: quickExitDoor })}
                </Text>
              )}
              {boardingDoor != null && (
                <Text
                  style={[typography.label, { color: colors.subtle, marginTop: 2 }]}
                  testID={`boarding-door-${i}`}
                >
                  {t('route.boardingDoor', { door: boardingDoor })}
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

export function mix(a: string, b: string, w: number): string {
  const pa = hex(a), pb = hex(b);
  const r = Math.round(pa[0] * (1 - w) + pb[0] * w);
  const g = Math.round(pa[1] * (1 - w) + pb[1] * w);
  const bl = Math.round(pa[2] * (1 - w) + pb[2] * w);
  return `rgb(${r},${g},${bl})`;
}

/** #RRGGBB 형식 전용. 비 hex 입력 시 [0,0,0] fallback */
export function hex(h: string): [number, number, number] {
  if (!h.startsWith('#') || h.length < 7) return [0, 0, 0];
  const x = h.replace('#', '');
  return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    position: 'relative',
    gap: spacing.md,
  },
  markerCol: { width: 28, alignItems: 'flex-start', paddingLeft: 7 },
  connector: {
    position: 'absolute',
    left: 13,
    top: 18,
    bottom: -6,
    width: 1,
  },
  dot:     { width: 10, height: 10, borderRadius: 5 },
  dotRing: { width: 12, height: 12, borderRadius: 6, borderWidth: 2 },
  dotDest: { width: 12, height: 12, borderRadius: 6 },
  dotIntermediate: { width: 7, height: 7, borderRadius: 4, borderWidth: 1, marginLeft: 1.5 },
  rowIntermediate: { minHeight: 30 },
  hopSlot: {
    paddingLeft: 28 + spacing.md, // markerCol 폭 + 행 gap — slot이 station label과 좌측 정렬되도록
    paddingBottom: spacing.xs,
  },
});
