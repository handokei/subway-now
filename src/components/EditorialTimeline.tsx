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
import type { LineNumber } from '../types/station';

interface Props {
  stops: Stop[];
}

// 한 stop의 도어번호 라벨을 결정한다.
// - 환승 stop이면 fromLine→toLine 빠른 환승 도어를 우선 사용 (transferExit.json).
// - 매칭 없으면 단조 노선 + quickExit 데이터로 fallback (계단/EV 가까운 도어).
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
  if (!resolution) return null;
  const result = resolveQuickExit(resolution.toStation.id, {
    accessibilityMode,
    direction: resolution.direction,
  });
  return result ? result.entry.doorNumber : null;
}

export function EditorialTimeline({ stops }: Props) {
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
        // transferTarget은 mark === 'transfer'에만 의미가 있다. 환승→도착 흡수된 stop(mark='dest')은
        // transferTarget이 남아 있을 수 있어도 도착 fallback(quickExit)만 적용한다.
        const transferToLine = s.mark === 'transfer' ? s.transferTarget?.toLine ?? null : null;
        const quickExitDoor = s.arrivalContext != null
          ? resolveStopDoor(s.arrivalContext, transferToLine, accessibilityMode)
          : null;

        const isIntermediate = s.mark === 'intermediate';
        return (
          <View
            key={i}
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
            </View>
          </View>
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
});
