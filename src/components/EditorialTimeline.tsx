import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, typography, spacing } from '../theme';
import { LINE_NAMES } from '../constants/lineColors';
import type { LineNumber } from '../types/station';
import type { Stop } from '../utils/journeyAdapter';

interface Props {
  stops: Stop[];
}

export function EditorialTimeline({ stops }: Props) {
  return (
    <View>
      {stops.map((s, i) => {
        const isLast = i === stops.length - 1;
        const lineC = s.line != null ? getLineColor(s.line) : colors.accent;
        const nextLineC = !isLast
          ? (stops[i + 1].line != null ? getLineColor(stops[i + 1].line!) : colors.accent)
          : lineC;

        return (
          <View key={i} style={[styles.row, isLast && { minHeight: 36 }]} testID={`timeline-stop-${i}`}>
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
                <View style={[styles.dotRing, { borderColor: lineC }]} testID="transfer-dot" />
              )}
              {s.mark === 'dest' && (
                <View style={[styles.dotDest, { backgroundColor: lineC }]} testID="dest-dot" />
              )}
            </View>

            <View style={{ flex: 1 }}>
              <Text style={[typography.body, { fontWeight: '600', color: colors.ink }]}>
                {s.station}
              </Text>
              {s.note != null && (
                <Text style={[typography.label, { color: colors.subtle, marginTop: 2 }]}>
                  {s.note}
                </Text>
              )}
            </View>

            <View style={{ alignItems: 'flex-end' }}>
              {s.line != null && <LineTag line={s.line} color={lineC} />}
              {s.stopsFromPrev != null && (
                <Text style={[typography.mono, { color: colors.subtle, marginTop: 2 }]}>
                  {s.stopsFromPrev}
                </Text>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function LineTag({ line, color }: { line: string; color: string }) {
  const label = LINE_NAMES[line as LineNumber] ?? `LINE ${line}`;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
      <Text style={[typography.mono, { color, fontWeight: '600' }]}>{label}</Text>
    </View>
  );
}

function getLineColor(line: string): string {
  return colors.line[line as LineNumber] ?? colors.accent;
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
  dotRing: { width: 12, height: 12, borderRadius: 6, borderWidth: 2, backgroundColor: colors.bg },
  dotDest: { width: 12, height: 12, borderRadius: 6 },
});
