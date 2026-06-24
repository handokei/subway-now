/**
 * #1751 (M3 Sub 1) — DebugModal "Operation Dashboard" 섹션.
 * #1753 (M3 Sub 3) — Device polling + drill-down 확장.
 *
 * 4개 metric을 chart-library 없이 순수 RN View(ratio bar)로 시각화.
 * 이유: Expo SDK 54 환경에서 추가 CocoaPods 없이 즉시 동작 + bundle size 0 추가 +
 * DebugModal은 개발·진단 도구이므로 "정확한 숫자 + 비율 bar"이면 충분.
 *
 * ADR-mini (차트 라이브러리 결정):
 *   후보: victory-native(peer react-native-svg 필요), recharts(RN 미지원), react-native-chart-kit
 *   → victory-native: react-native-svg peer dep 추가 필요, EAS rebuild 트리거, Sub 1 scope 초과
 *   → react-native-chart-kit: 마지막 릴리스 2021년, 유지보수 정지 위험
 *   → 결정: native View 기반 비율 bar(inline) — 외부 dep 0, Expo SDK 54 호환 100%, 빌드 변경 없음
 *
 * Sub 3 확장 (surgical):
 *   - DebugModal 진입(마운트) 시 1회 polling → backend metric으로 Metric 3/4 isMock 해제
 *   - Refresh 버튼 (rate-limit: 마지막 요청 후 5s 이내 재요청 차단)
 *   - ADMIN_TOKEN 미설정 → placeholder 유지 + 안내 메시지
 *   - metric row 클릭 → MetricDrillDownView expanded view (corrId join)
 *
 * Metric 1 — 알람 정확성: useTripGroundTruthStore(M2 구현) 기반
 * Metric 2 — Silent push 도달률: countSilentPushOutcomes (received vs fired)
 * Metric 3 — Lockless miss: backend polling (ADMIN_TOKEN 미설정 시 mock 유지)
 * Metric 4 — Boardable train miss: backend polling (backend placeholder: 0/0)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme, spacing, typography } from '../../../shared/theme';
import { useTripGroundTruthStore } from '../store/useTripGroundTruthStore';
import { countSilentPushOutcomes, type AlarmLogEntry } from '../../alarm/utils/alarmLog';
import {
  fetchObservabilityMetrics,
  type ObservabilityMetricsBucket,
  type FetchMetricsResult,
} from '../../observability/api/observabilityMetricsClient';
import {
  MetricDrillDownView,
  type DrillDownMetricKey,
} from './MetricDrillDownView';

// ─── 상수 ─────────────────────────────────────────────────────────────────────

/** Refresh rate-limit — 마지막 요청 후 이 시간(ms) 이내 재요청 차단. */
const REFRESH_RATE_LIMIT_MS = 5000;

// ─── 내부 타입 ───────────────────────────────────────────────────────────────

interface MetricData {
  key: DrillDownMetricKey;
  label: string;
  /** 0.0 ~ 1.0 비율. null이면 "데이터 없음" 표시. */
  ratio: number | null;
  /** ratio에 해당하는 성공 건수. */
  numerator: number;
  /** 전체 건수. */
  denominator: number;
  /** mock 여부 — backend 데이터 수신 전까지 true. */
  isMock?: boolean;
}

type BackendLoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; locklessMiss: ObservabilityMetricsBucket; boardableMiss: ObservabilityMetricsBucket }
  | { kind: 'unconfigured' }
  | { kind: 'error'; message: string };

// ─── 내부 함수 ────────────────────────────────────────────────────────────────

function computeRatio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
}

function formatPct(ratio: number | null): string {
  if (ratio === null) return '—';
  return `${Math.round(ratio * 100)}%`;
}

function bucketToMetric(
  key: DrillDownMetricKey,
  label: string,
  bucket: ObservabilityMetricsBucket,
): MetricData {
  return {
    key,
    label,
    ratio: computeRatio(bucket.value, bucket.total),
    numerator: bucket.value,
    denominator: bucket.total,
    isMock: false,
  };
}

// ─── 컴포넌트 ─────────────────────────────────────────────────────────────────

/**
 * 수평 ratio bar — `ratio`(0~1)를 가득 찬 비율로 표시.
 * null이면 "N/A" 텍스트만 렌더.
 */
function RatioBar({
  ratio,
  isMock,
  colors,
}: {
  ratio: number | null;
  isMock?: boolean;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  const fillColor = isMock ? colors.muted : colors.accent;
  if (ratio === null) {
    return (
      <Text style={[typography.mono, { color: colors.muted }]} testID="ratio-bar-na">
        (no data)
      </Text>
    );
  }
  const clampedRatio = Math.min(1, Math.max(0, ratio));
  return (
    <View style={barStyles.track} testID="ratio-bar-track">
      <View
        style={[barStyles.fill, { width: `${Math.round(clampedRatio * 100)}%`, backgroundColor: fillColor }]}
        testID="ratio-bar-fill"
      />
    </View>
  );
}

const barStyles = StyleSheet.create({
  track: {
    height: 8,
    borderRadius: 4,
    backgroundColor: '#E0E0E0',
    overflow: 'hidden',
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  },
  fill: {
    height: 8,
    borderRadius: 4,
  },
});

/** 단일 metric 행 — label / 수치 / ratio bar. 클릭 시 drill-down 전환. */
function MetricRow({
  metric,
  onPress,
  colors,
}: {
  metric: MetricData;
  onPress: (key: DrillDownMetricKey) => void;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  const pctLabel = formatPct(metric.ratio);
  const countLabel =
    metric.denominator === 0 ? '0/0' : `${metric.numerator}/${metric.denominator}`;
  const mockLabel = metric.isMock ? ' [mock]' : '';
  return (
    <Pressable
      onPress={() => onPress(metric.key)}
      style={rowStyles.container}
      testID={`operation-metric-${metric.label}`}
    >
      <View style={rowStyles.header}>
        <Text style={[typography.mono, { color: colors.ink }]}>
          {metric.label}
          {mockLabel ? (
            <Text style={{ color: colors.muted }}>{mockLabel}</Text>
          ) : null}
        </Text>
        <Text style={[typography.mono, { color: colors.subtle }]}>
          {pctLabel} ({countLabel})
        </Text>
      </View>
      <RatioBar ratio={metric.ratio} isMock={metric.isMock} colors={colors} />
    </Pressable>
  );
}

const rowStyles = StyleSheet.create({
  container: {
    marginBottom: spacing.sm,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
});

// ─── Props ────────────────────────────────────────────────────────────────────

export interface OperationDashboardSectionProps {
  /** alarmLog entries — Silent push 도달률 계산에 사용. */
  logs: readonly AlarmLogEntry[];
}

// ─── 메인 컴포넌트 ────────────────────────────────────────────────────────────

/**
 * DebugModal "Operation Dashboard" 섹션.
 *
 * 4 metric을 ratio bar로 표시.
 * Sub 3: 마운트 시 backend polling + Refresh 버튼 + metric 클릭 drill-down.
 */
export function OperationDashboardSection({ logs }: OperationDashboardSectionProps) {
  const { colors } = useTheme();
  const responses = useTripGroundTruthStore((s) => s.responses);
  const [backendState, setBackendState] = useState<BackendLoadState>({ kind: 'idle' });
  const [drillDownKey, setDrillDownKey] = useState<DrillDownMetricKey | null>(null);
  const lastFetchAtRef = useRef<number>(0);

  const doFetch = useCallback(async () => {
    const now = Date.now();
    if (now - lastFetchAtRef.current < REFRESH_RATE_LIMIT_MS) return;
    lastFetchAtRef.current = now;
    setBackendState({ kind: 'loading' });
    const result: FetchMetricsResult = await fetchObservabilityMetrics();
    if (result.kind === 'ok') {
      setBackendState({
        kind: 'ok',
        locklessMiss: result.metrics.locklessMissRatio,
        boardableMiss: result.metrics.boardableMissRatio,
      });
    } else if (result.kind === 'unconfigured') {
      setBackendState({ kind: 'unconfigured' });
    } else {
      setBackendState({ kind: 'error', message: result.message });
    }
  }, []);

  // 마운트 시 1회 polling
  useEffect(() => {
    void doFetch();
  }, [doFetch]);

  // Metric 1 — 알람 정확성 (M2 구현 기반)
  const accurateCount = responses.filter((r) => r.outcome === 'accurate').length;
  const answeredCount = responses.filter((r) => r.outcome !== 'unanswered').length;
  const alarmAccuracy: MetricData = {
    key: 'alarmAccuracy',
    label: 'alarmAccuracy',
    ratio: computeRatio(accurateCount, answeredCount),
    numerator: accurateCount,
    denominator: answeredCount,
  };

  // Metric 2 — Silent push 도달률 (received 중 fired 비율)
  const silentCounts = countSilentPushOutcomes(logs);
  const silentPushReach: MetricData = {
    key: 'silentPushReach',
    label: 'silentPushReach',
    ratio: computeRatio(silentCounts.fired, silentCounts.received),
    numerator: silentCounts.fired,
    denominator: silentCounts.received,
  };

  // Metric 3 — Lockless miss (backend polling 결과 또는 mock 유지)
  const locklessMiss: MetricData =
    backendState.kind === 'ok'
      ? bucketToMetric('locklessMiss', 'locklessMiss', backendState.locklessMiss)
      : { key: 'locklessMiss', label: 'locklessMiss', ratio: null, numerator: 0, denominator: 0, isMock: true };

  // Metric 4 — Boardable train miss (backend polling 결과 또는 mock 유지)
  const boardableMiss: MetricData =
    backendState.kind === 'ok'
      ? bucketToMetric('boardableMiss', 'boardableMiss', backendState.boardableMiss)
      : { key: 'boardableMiss', label: 'boardableMiss', ratio: null, numerator: 0, denominator: 0, isMock: true };

  const metrics: MetricData[] = [alarmAccuracy, silentPushReach, locklessMiss, boardableMiss];

  const handleMetricPress = useCallback((key: DrillDownMetricKey) => {
    setDrillDownKey((prev) => (prev === key ? null : key));
  }, []);

  const handleDrillDownClose = useCallback(() => {
    setDrillDownKey(null);
  }, []);

  return (
    <View testID="operation-dashboard-section">
      {/* Refresh + 상태 라인 */}
      <View style={headerStyles.row}>
        <TouchableOpacity onPress={doFetch} testID="operation-dashboard-refresh">
          <Text style={[typography.bodySm, { color: colors.accent }]}>Refresh</Text>
        </TouchableOpacity>
        <BackendStatusLabel state={backendState} colors={colors} />
      </View>

      {/* Metric rows */}
      {metrics.map((metric) => (
        <MetricRow
          key={metric.label}
          metric={metric}
          onPress={handleMetricPress}
          colors={colors}
        />
      ))}

      {/* Drill-down expanded view */}
      {drillDownKey !== null && (
        <MetricDrillDownView
          metricKey={drillDownKey}
          onClose={handleDrillDownClose}
        />
      )}
    </View>
  );
}

const headerStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
});

function BackendStatusLabel({
  state,
  colors,
}: Readonly<{
  state: BackendLoadState;
  colors: ReturnType<typeof useTheme>['colors'];
}>) {
  if (state.kind === 'idle') return null;
  if (state.kind === 'loading') {
    return (
      <Text
        style={[typography.mono, { color: colors.muted }]}
        testID="operation-dashboard-status"
      >
        loading...
      </Text>
    );
  }
  if (state.kind === 'unconfigured') {
    return (
      <Text
        style={[typography.mono, { color: colors.muted }]}
        testID="operation-dashboard-status"
      >
        ADMIN_TOKEN 미설정
      </Text>
    );
  }
  if (state.kind === 'error') {
    return (
      <Text
        style={[typography.mono, { color: colors.warn }]}
        testID="operation-dashboard-status"
      >
        {state.message}
      </Text>
    );
  }
  // ok
  return null;
}
