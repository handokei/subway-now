/**
 * MetricDrillDownView (#1753, #1503 Sub 3).
 *
 * metric 1건 클릭 시 expanded view로 전환된다.
 * rawSignalBuffer entries를 corrId 기준으로 그룹화해 해당 metric과 연관된
 * 원본 trip raw signal을 "원본 trip 보기" 형태로 노출한다.
 *
 * corrId join 흐름:
 *   MetricDrillDownView props.metricKey
 *     → rawSignalBuffer.getRawSignalEntries() snapshot
 *     → corrId별 그룹화 → 최신 trip 순 정렬
 *     → 각 trip: corrId / entry 수 / 첫·마지막 ts 표시
 *
 * Sub 1 확장 원칙 (surgical):
 *   - MetricRow에 onPress 추가만 — 기존 RatioBar/MetricRow 로직 변경 0.
 *   - 별도 component로 분리 — OperationDashboardSection.tsx 수정 최소화.
 */

import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme, spacing, typography } from '../../../shared/theme';
import { getRawSignalEntries, type RawSignalEntry } from '../../observability/utils/rawSignalBuffer';
import { formatClockTimeWithSeconds } from '../../../shared/utils/formatTime';

// ─── 타입 ─────────────────────────────────────────────────────────────────────

export type DrillDownMetricKey =
  | 'alarmAccuracy'
  | 'silentPushReach'
  | 'locklessMiss'
  | 'boardableMiss';

export interface MetricDrillDownViewProps {
  metricKey: DrillDownMetricKey;
  onClose: () => void;
}

interface TripGroup {
  corrId: string;
  entryCount: number;
  firstTs: number;
  lastTs: number;
  entries: readonly RawSignalEntry[];
}

// ─── 내부 함수 ────────────────────────────────────────────────────────────────

/**
 * rawSignalBuffer 전체를 corrId별로 그룹화.
 * corrId=null 항목은 'unknown' 버킷으로 합산.
 * 반환: lastTs 내림차순 (최신 trip 먼저).
 */
function groupByCorrId(entries: readonly RawSignalEntry[]): TripGroup[] {
  const map = new Map<string, RawSignalEntry[]>();
  for (const e of entries) {
    const key = e.corrId ?? 'unknown';
    const group = map.get(key);
    if (group) {
      group.push(e);
    } else {
      map.set(key, [e]);
    }
  }

  const groups: TripGroup[] = [];
  for (const [corrId, groupEntries] of map) {
    const timestamps = groupEntries.map((e) => e.ts);
    const firstTs = Math.min(...timestamps);
    const lastTs = Math.max(...timestamps);
    groups.push({ corrId, entryCount: groupEntries.length, firstTs, lastTs, entries: groupEntries });
  }

  // 최신 trip 먼저
  groups.sort((a, b) => b.lastTs - a.lastTs);
  return groups;
}

/** metric key → 사람이 읽을 수 있는 레이블. */
const METRIC_LABELS: Record<DrillDownMetricKey, string> = {
  alarmAccuracy: '알람 정확성 (24h)',
  silentPushReach: 'Silent push 도달률 (24h)',
  locklessMiss: 'Lockless miss (24h)',
  boardableMiss: 'Boardable train miss (24h)',
};

// ─── 컴포넌트 ─────────────────────────────────────────────────────────────────

function TripGroupRow({
  group,
  colors,
}: {
  group: TripGroup;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  const corrIdShort = group.corrId === 'unknown' ? 'unknown' : group.corrId.slice(0, 16);
  return (
    <View style={styles.tripRow} testID={`drilldown-trip-${group.corrId}`}>
      <Text style={[typography.mono, { color: colors.ink, flex: 1 }]} numberOfLines={1}>
        {corrIdShort}
      </Text>
      <Text style={[typography.mono, { color: colors.subtle, width: 40, textAlign: 'right' }]}>
        {group.entryCount}
      </Text>
      <Text style={[typography.mono, { color: colors.muted, width: 72, textAlign: 'right' }]}>
        {formatClockTimeWithSeconds(group.firstTs)}
      </Text>
      <Text style={[typography.mono, { color: colors.muted, width: 72, textAlign: 'right' }]}>
        {formatClockTimeWithSeconds(group.lastTs)}
      </Text>
    </View>
  );
}

/**
 * MetricDrillDownView — 단일 metric의 corrId ↔ rawSignalBuffer join 뷰.
 *
 * `onClose` 로 호출자가 닫을 수 있게 한다.
 */
export function MetricDrillDownView({ metricKey, onClose }: MetricDrillDownViewProps) {
  const { colors } = useTheme();
  const entries = getRawSignalEntries();
  const groups = groupByCorrId(entries);
  const label = METRIC_LABELS[metricKey];

  return (
    <View style={[styles.container, { backgroundColor: colors.card }]} testID="metric-drilldown-view">
      {/* 헤더 */}
      <View style={styles.header}>
        <Text style={[typography.label, { color: colors.muted, flex: 1 }]} numberOfLines={1}>
          {label}
        </Text>
        <TouchableOpacity onPress={onClose} testID="metric-drilldown-close">
          <Text style={[typography.bodySm, { color: colors.accent, fontWeight: '700' }]}>
            닫기
          </Text>
        </TouchableOpacity>
      </View>

      {/* 컬럼 헤더 */}
      <View style={styles.tripRow}>
        <Text style={[typography.mono, { color: colors.subtle, flex: 1 }]}>corrId</Text>
        <Text style={[typography.mono, { color: colors.subtle, width: 40, textAlign: 'right' }]}>n</Text>
        <Text style={[typography.mono, { color: colors.subtle, width: 72, textAlign: 'right' }]}>first</Text>
        <Text style={[typography.mono, { color: colors.subtle, width: 72, textAlign: 'right' }]}>last</Text>
      </View>

      {/* trip 목록 */}
      {groups.length === 0 ? (
        <Text
          style={[typography.mono, { color: colors.muted, marginTop: spacing.xs }]}
          testID="metric-drilldown-empty"
        >
          (rawSignal 없음)
        </Text>
      ) : (
        <ScrollView style={styles.scroll} testID="metric-drilldown-list">
          {groups.map((group) => (
            <TripGroupRow key={group.corrId} group={group} colors={colors} />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: spacing.sm,
    borderRadius: 6,
    padding: spacing.sm,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  tripRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  scroll: {
    maxHeight: 180,
  },
});
