import { StyleSheet, Text, View } from 'react-native';
import { LINE_NAMES } from '../constants/lineColors';
import type { JourneyDisplay } from '../utils/stationRoute';
import type { LineNumber } from '../types/station';
import { useTheme, typography, spacing, radius } from '../theme';

interface JourneyTimelineProps {
  journey: JourneyDisplay;
}

export function JourneyTimeline({ journey }: JourneyTimelineProps) {
  const { segments } = journey;
  const { colors } = useTheme();

  return (
    <View style={styles.container}>
      {segments.map((segment, idx) => {
        const isFirst = idx === 0;
        const isLast = idx === segments.length - 1;
        const lineName = LINE_NAMES[segment.line as LineNumber] ?? segment.line;

        return (
          <View key={idx}>
            {isFirst && (
              <View style={styles.stationRow}>
                <View style={[styles.dot, { backgroundColor: segment.lineColor }]} testID="start-dot" />
                <Text style={[styles.stationName, { color: colors.ink }]}>{segment.fromName}</Text>
              </View>
            )}

            <View style={styles.segmentRow}>
              <View style={[styles.segmentLine, { backgroundColor: segment.lineColor }]} />
              <View style={styles.segmentInfo}>
                <View style={[styles.lineBadge, { backgroundColor: segment.lineColor }]}>
                  <Text style={styles.lineBadgeText}>{lineName}</Text>
                </View>
                <Text style={[styles.stopsText, { color: colors.muted }]}>{segment.stops}정거장</Text>
              </View>
            </View>

            {!isLast && (
              <View style={styles.stationRow}>
                <Text style={[styles.transferIcon, { color: colors.accent }]}>⇄</Text>
                <Text style={[styles.transferName, { color: colors.accent }]}>{segment.toName}</Text>
              </View>
            )}

            {isLast && (
              <View style={styles.stationRow}>
                <View style={[styles.dot, { backgroundColor: segment.lineColor }]} testID="end-dot" />
                <Text style={[styles.stationName, { color: colors.ink }]}>{segment.toName}</Text>
              </View>
            )}
          </View>
        );
      })}

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: spacing.md,
  },
  stationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: 10,
  },
  stationName: {
    fontSize: 16,
    fontWeight: '700',
  },
  transferIcon: {
    fontSize: 16,
    width: 12,
    textAlign: 'center',
    marginRight: 10,
  },
  transferName: {
    fontSize: 15,
    fontWeight: '600',
  },
  segmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 4,
    paddingVertical: 4,
  },
  segmentLine: {
    width: 4,
    height: 36,
    borderRadius: 2,
    marginRight: 14,
  },
  segmentInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  lineBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.lg,
  },
  lineBadgeText: {
    color: '#ffffff', // 노선색 배경 위 텍스트 — 항상 흰색 유지
    fontSize: 12,
    fontWeight: '700',
  },
  stopsText: {
    fontSize: 13,
  },
});
