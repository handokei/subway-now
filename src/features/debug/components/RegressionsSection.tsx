/**
 * Regressions 섹션 (#1263, Epic #1204 그룹 0 PR C).
 *
 * Plan v7 Slide 0 박제 회귀 4개(id 8/10/11/12)의 발생 추이를 DebugModal에 노출한다.
 * 로컬 누적은 `getRegressionCountsSnapshot()`(#1267 PR B SSOT) 호출,
 * backend `GET /admin/telemetry/regressions` 응답으로 5분/시간/오늘/7일 윈도우를 보강한다.
 *
 * 3가지 graceful 상태:
 *   - `EXPO_PUBLIC_ADMIN_TOKEN` 미설정 → backend fetch skip + 안내 메시지
 *   - loading → "(loading...)"
 *   - error → 응답 status 또는 fetch 실패 메시지
 *
 * 회귀 id는 `KNOWN_REGRESSION_IDS`(SSOT) 순회 — 새 id 추가 시 별도 수정 불필요.
 * 빈 데이터(count=0)도 행은 항상 표시 — "측정 인프라가 동작 중인데 발생 0건"과
 * "측정 인프라 미동작"을 사용자가 구분할 수 있게 한다.
 */
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  KNOWN_REGRESSION_IDS,
  getRegressionCountsSnapshot,
  type RegressionId,
} from '../../../shared/utils/regressionMetrics';
import {
  fetchWithTelemetryTimeout,
  getAlarmBackendUrl,
} from '../../../shared/utils/telemetryHttp';
import { spacing, radius, typography, useTheme } from '../../../shared/theme';

/** Backend `GET /admin/telemetry/regressions` 응답 윈도우. 백엔드 readRegressionCounters와 SSOT. */
export interface RegressionWindowCounts {
  last5m: number;
  lastHour: number;
  today: number;
  last7d: number;
}

export interface RegressionsAdminResponse {
  ids: readonly string[];
  counts: Record<string, RegressionWindowCounts>;
}

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; data: Record<string, RegressionWindowCounts> }
  | { kind: 'error'; message: string };

const TOKEN_MISSING_LABEL =
  'EXPO_PUBLIC_ADMIN_TOKEN 미설정 — backend 윈도우 조회 불가';
const BACKEND_URL_MISSING_LABEL =
  'EXPO_PUBLIC_ALARM_BACKEND_URL 미설정 — backend 윈도우 조회 불가';
const EMPTY_WINDOW: RegressionWindowCounts = {
  last5m: 0,
  lastHour: 0,
  today: 0,
  last7d: 0,
};

/**
 * SSOT의 컬럼 정의 — UI 헤더와 row value 추출을 함께 구동한다.
 * 새 윈도우 추가 시 본 배열 한 곳만 갱신.
 */
const WINDOW_COLUMNS: readonly {
  key: keyof RegressionWindowCounts;
  label: string;
}[] = [
  { key: 'last5m', label: '5m' },
  { key: 'lastHour', label: '1h' },
  { key: 'today', label: 'today' },
  { key: 'last7d', label: '7d' },
];

function getAdminToken(): string | null {
  const token = process.env.EXPO_PUBLIC_ADMIN_TOKEN;
  if (!token) return null;
  return token;
}

export function RegressionsSection() {
  const { colors } = useTheme();
  const [localCounts, setLocalCounts] = useState<Record<RegressionId, number>>(
    () => getRegressionCountsSnapshot(),
  );
  const [state, setState] = useState<LoadState>({ kind: 'idle' });

  const refresh = useCallback(async () => {
    setLocalCounts(getRegressionCountsSnapshot());
    const token = getAdminToken();
    if (!token) {
      setState({ kind: 'error', message: TOKEN_MISSING_LABEL });
      return;
    }
    const base = getAlarmBackendUrl();
    if (!base) {
      setState({ kind: 'error', message: BACKEND_URL_MISSING_LABEL });
      return;
    }
    setState({ kind: 'loading' });
    try {
      const res = await fetchWithTelemetryTimeout(
        `${base}/admin/telemetry/regressions`,
        {
          method: 'GET',
          headers: { authorization: `Bearer ${token}` },
        },
      );
      if (!res.ok) {
        setState({ kind: 'error', message: `HTTP ${res.status}` });
        return;
      }
      const body = (await res.json()) as RegressionsAdminResponse;
      setState({ kind: 'success', data: body.counts ?? {} });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setState({ kind: 'error', message });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <View
      style={[styles.section, { backgroundColor: colors.card }]}
      testID="debug-regressions-section"
    >
      <View style={styles.sectionHeader}>
        <Text style={[typography.label, { color: colors.muted }]}>
          Regressions
        </Text>
        <Pressable onPress={refresh} testID="debug-regressions-refresh">
          <Text style={[typography.bodySm, { color: colors.accent }]}>
            Refresh
          </Text>
        </Pressable>
      </View>

      <StatusLine state={state} colors={colors} />

      <View style={styles.row}>
        <Text
          style={[typography.mono, styles.idCol, { color: colors.subtle }]}
        >
          id
        </Text>
        <Text style={[typography.mono, styles.localCol, { color: colors.subtle }]}>
          local
        </Text>
        {WINDOW_COLUMNS.map(({ key, label }) => (
          <Text
            key={key}
            style={[typography.mono, styles.dataCol, { color: colors.subtle }]}
          >
            {label}
          </Text>
        ))}
      </View>

      {KNOWN_REGRESSION_IDS.map((id) => {
        const window = pickWindow(state, id);
        return (
          <View
            key={id}
            style={styles.row}
            testID={`debug-regressions-row-${id}`}
          >
            <Text style={[typography.mono, styles.idCol, { color: colors.ink }]}>
              {`regression_${id}`}
            </Text>
            <Text
              style={[typography.mono, styles.localCol, { color: colors.ink }]}
            >
              {String(localCounts[id])}
            </Text>
            {WINDOW_COLUMNS.map(({ key }) => (
              <Text
                key={key}
                style={[typography.mono, styles.dataCol, { color: colors.ink }]}
              >
                {String(window[key])}
              </Text>
            ))}
          </View>
        );
      })}
    </View>
  );
}

function pickWindow(state: LoadState, id: RegressionId): RegressionWindowCounts {
  if (state.kind !== 'success') return EMPTY_WINDOW;
  return state.data[id] ?? EMPTY_WINDOW;
}

function StatusLine({
  state,
  colors,
}: Readonly<{
  state: LoadState;
  colors: ReturnType<typeof useTheme>['colors'];
}>) {
  if (state.kind === 'idle') return null;
  if (state.kind === 'loading') {
    return (
      <Text
        style={[typography.mono, { color: colors.muted, marginBottom: spacing.xs }]}
        testID="debug-regressions-status"
      >
        (loading...)
      </Text>
    );
  }
  if (state.kind === 'error') {
    return (
      <Text
        style={[typography.mono, { color: colors.warn, marginBottom: spacing.xs }]}
        testID="debug-regressions-status"
      >
        {state.message}
      </Text>
    );
  }
  return null;
}

const styles = StyleSheet.create({
  section: {
    padding: spacing.lg,
    borderRadius: radius.md,
    marginBottom: spacing.md,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    marginBottom: 2,
  },
  idCol: {
    width: 110,
  },
  localCol: {
    width: 50,
    textAlign: 'right',
    marginRight: spacing.sm,
  },
  dataCol: {
    flex: 1,
    textAlign: 'right',
  },
});

// Internal exports for tests — DO NOT use from app code.
export const __test__ = {
  TOKEN_MISSING_LABEL,
  BACKEND_URL_MISSING_LABEL,
  EMPTY_WINDOW,
  WINDOW_COLUMNS,
};
