/**
 * OperationDashboardSection (#1751 Sub 1 + #1753 Sub 3) 단위 테스트.
 *
 * Sub 1 커버리지:
 *   - 빈 데이터 상태 (4 metric 모두 0 / no data)
 *   - 정상 데이터 상태 (M2 responses mock + silent push alarmLog mock)
 *   - ratio bar 렌더 분기 (null vs 유효 비율)
 *
 * Sub 3 추가 커버리지:
 *   - 마운트 시 fetchObservabilityMetrics 1회 호출
 *   - ADMIN_TOKEN 미설정 → unconfigured 상태 메시지
 *   - fetch 성공 → locklessMiss/boardableMiss isMock 해제 + ratio 반영
 *   - fetch 오류 → error 상태 메시지
 *   - Refresh 버튼 클릭 → 재호출 (rate-limit 제어 포함)
 *   - metric 클릭 → drill-down view 토글 (열기/닫기)
 */
import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { OperationDashboardSection } from '../OperationDashboardSection';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { useTripGroundTruthStore, type TripGroundTruthState } from '../../store/useTripGroundTruthStore';
import type { AlarmLogEntry } from '../../../alarm/utils/alarmLog';
import * as observabilityClient from '../../../observability/api/observabilityMetricsClient';
import { __resetRawSignalForTests__ } from '../../../observability/utils/rawSignalBuffer';

// ─── mock ─────────────────────────────────────────────────────────────────────

jest.mock('../../store/useTripGroundTruthStore', () => ({
  useTripGroundTruthStore: jest.fn(),
}));

jest.mock('../../../observability/api/observabilityMetricsClient', () => ({
  fetchObservabilityMetrics: jest.fn(),
}));

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const mockUseTripGroundTruthStore = useTripGroundTruthStore as jest.MockedFunction<typeof useTripGroundTruthStore>;
const mockFetchMetrics = observabilityClient.fetchObservabilityMetrics as jest.MockedFunction<
  typeof observabilityClient.fetchObservabilityMetrics
>;

// AlarmLogEntry 최소 픽스처
function makeLogEntry(
  source: AlarmLogEntry['source'],
  outcome: AlarmLogEntry['outcome'],
  ts = Date.now(),
): AlarmLogEntry {
  return { source, outcome, ts };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function setupStore(responses: { outcome: 'accurate' | 'inaccurate' | 'unanswered' }[]) {
  const mapped = responses.map((r, i) => ({
    corrId: `c${i}`,
    endedAt: i,
    respondedAt: i,
    outcome: r.outcome,
  }));
  const stubState: TripGroundTruthState = {
    hydrated: true,
    pendingPrompt: null,
    responses: mapped,
    enqueuePrompt: jest.fn(),
    respond: jest.fn(),
    hydrate: jest.fn(),
  };
  mockUseTripGroundTruthStore.mockImplementation((selector: (s: TripGroundTruthState) => unknown) =>
    selector(stubState),
  );
}

const DEFAULT_ACCEL_PATTERN: observabilityClient.AccelPatternBucket = {
  automotive: { count: 5, ratio: 0.5 },
  walking: { count: 2, ratio: 0.2 },
  stationary: { count: 2, ratio: 0.2 },
  unknown: { count: 1, ratio: 0.1 },
};

function makeSuccessResult(
  locklessValue = 2,
  locklessTotal = 10,
  boardableValue = 0,
  boardableTotal = 0,
  accelPattern: observabilityClient.AccelPatternBucket = DEFAULT_ACCEL_PATTERN,
  pushLatency: { p50: number; p95: number; totalSamples: number } | null = null,
): observabilityClient.FetchMetricsResult {
  return {
    kind: 'ok',
    metrics: {
      accuracyRatio: { value: 8, total: 10, ratio: 0.8 },
      silentPushDeliveryRatio: { value: 5, total: 6, ratio: 0.833 },
      locklessMissRatio: { value: locklessValue, total: locklessTotal, ratio: locklessValue / locklessTotal },
      boardableMissRatio: { value: boardableValue, total: boardableTotal, ratio: boardableTotal === 0 ? 0 : boardableValue / boardableTotal },
      accelPatternHitRatio: accelPattern,
      silentPushLatency: pushLatency,
      window: '24h',
      timestamp: 1_700_000_000_000,
    },
  };
}

// ─── setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.useFakeTimers();
  __resetRawSignalForTests__();
  setupStore([]);
  // 기본: unconfigured 반환
  mockFetchMetrics.mockResolvedValue({ kind: 'unconfigured' });
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

// ─── tests ────────────────────────────────────────────────────────────────────

describe('OperationDashboardSection', () => {
  describe('Sub 1 — 빈 데이터 상태 (4 metric 모두 0)', () => {
    it('4개 metric row를 렌더한다', async () => {
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });
      expect(screen.getByTestId('operation-metric-alarmAccuracy')).toBeTruthy();
      expect(screen.getByTestId('operation-metric-silentPushReach')).toBeTruthy();
      expect(screen.getByTestId('operation-metric-locklessMiss')).toBeTruthy();
      expect(screen.getByTestId('operation-metric-boardableMiss')).toBeTruthy();
    });

    it('alarmAccuracy: 응답 0건 → no data bar 렌더', async () => {
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });
      const naTexts = screen.getAllByTestId('ratio-bar-na');
      expect(naTexts.length).toBeGreaterThanOrEqual(2);
    });

    it('silentPushReach: received=0 → no data bar 렌더', async () => {
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });
      const naTexts = screen.getAllByTestId('ratio-bar-na');
      expect(naTexts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Sub 1 — 정상 데이터 상태', () => {
    it('alarmAccuracy: accurate 3/5 응답 → ratio bar 렌더', async () => {
      setupStore([
        { outcome: 'accurate' },
        { outcome: 'accurate' },
        { outcome: 'accurate' },
        { outcome: 'inaccurate' },
        { outcome: 'unanswered' },
      ]);
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });
      const tracks = screen.getAllByTestId('ratio-bar-track');
      expect(tracks.length).toBeGreaterThanOrEqual(1);
    });

    it('silentPushReach: received 5, fired 4 → ratio bar 렌더', async () => {
      const logs: AlarmLogEntry[] = [
        makeLogEntry('silent-push-received', 'fired'),
        makeLogEntry('silent-push-received', 'fired'),
        makeLogEntry('silent-push-received', 'fired'),
        makeLogEntry('silent-push-received', 'fired'),
        makeLogEntry('silent-push-received', 'suppressed'),
        makeLogEntry('silent-push-fired', 'fired'),
        makeLogEntry('silent-push-fired', 'fired'),
        makeLogEntry('silent-push-fired', 'fired'),
        makeLogEntry('silent-push-fired', 'fired'),
      ];
      renderWithTheme(<OperationDashboardSection logs={logs} />);
      await act(async () => { jest.runAllTimers(); });
      const tracks = screen.getAllByTestId('ratio-bar-track');
      expect(tracks.length).toBeGreaterThanOrEqual(1);
    });

    it('locklessMiss, boardableMiss: unconfigured 상태 → (no data) 유지', async () => {
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });
      const naTexts = screen.getAllByTestId('ratio-bar-na');
      expect(naTexts.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Sub 1 — ratio bar fill 렌더', () => {
    it('ratio=1.0 → fill 렌더', async () => {
      setupStore([{ outcome: 'accurate' }]);
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });
      const fills = screen.getAllByTestId('ratio-bar-fill');
      expect(fills.length).toBeGreaterThanOrEqual(1);
    });

    it('ratio=null → ratio-bar-na 렌더 (no data)', async () => {
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });
      const naTexts = screen.getAllByTestId('ratio-bar-na');
      expect(naTexts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Sub 1 — section wrapper testID', () => {
    it('operation-dashboard-section testID가 존재한다', async () => {
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });
      expect(screen.getByTestId('operation-dashboard-section')).toBeTruthy();
    });
  });

  // ── Sub 3 ──────────────────────────────────────────────────────────────────

  describe('Sub 3 — polling', () => {
    it('마운트 시 fetchObservabilityMetrics를 1회 호출한다', async () => {
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });
      expect(mockFetchMetrics).toHaveBeenCalledTimes(1);
    });

    it('ADMIN_TOKEN 미설정(unconfigured) → 상태 메시지 렌더', async () => {
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });
      await waitFor(() => {
        const status = screen.getByTestId('operation-dashboard-status');
        expect(status.props.children).toBe('ADMIN_TOKEN 미설정');
      });
    });

    it('fetch 성공 → locklessMiss/boardableMiss isMock 해제 (ratio bar 노출)', async () => {
      mockFetchMetrics.mockResolvedValue(makeSuccessResult(2, 10));
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });
      // locklessMiss: 2/10 = 20% → ratio bar track이 렌더되어야 함
      await waitFor(() => {
        const tracks = screen.getAllByTestId('ratio-bar-track');
        expect(tracks.length).toBeGreaterThanOrEqual(1);
      });
    });

    it('fetch 성공 시 status label이 없다 (ok 상태는 메시지 없음)', async () => {
      mockFetchMetrics.mockResolvedValue(makeSuccessResult(2, 10));
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });
      await waitFor(() => {
        expect(screen.queryByTestId('operation-dashboard-status')).toBeNull();
      });
    });

    it('fetch 오류 → error 상태 메시지 렌더', async () => {
      mockFetchMetrics.mockResolvedValue({ kind: 'error', message: 'HTTP 503' });
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });
      await waitFor(() => {
        const status = screen.getByTestId('operation-dashboard-status');
        expect(status.props.children).toBe('HTTP 503');
      });
    });
  });

  describe('Sub 3 — Refresh 버튼', () => {
    it('Refresh 버튼이 렌더된다', async () => {
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });
      expect(screen.getByTestId('operation-dashboard-refresh')).toBeTruthy();
    });

    it('Refresh 버튼 클릭 후 rate-limit 해제되면 재호출된다', async () => {
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });
      expect(mockFetchMetrics).toHaveBeenCalledTimes(1);

      // rate-limit(5s) 경과 시뮬레이션
      await act(async () => { jest.advanceTimersByTime(6000); });

      // Refresh 버튼 클릭
      await act(async () => {
        fireEvent.press(screen.getByTestId('operation-dashboard-refresh'));
        jest.runAllTimers();
      });
      await waitFor(() => {
        expect(mockFetchMetrics).toHaveBeenCalledTimes(2);
      });
    });

    it('rate-limit 이내 Refresh → 추가 호출 없음', async () => {
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });
      expect(mockFetchMetrics).toHaveBeenCalledTimes(1);

      // rate-limit 이내 (1s만 경과)
      await act(async () => { jest.advanceTimersByTime(1000); });

      await act(async () => {
        fireEvent.press(screen.getByTestId('operation-dashboard-refresh'));
        jest.runAllTimers();
      });
      // 추가 호출 없어야 함
      expect(mockFetchMetrics).toHaveBeenCalledTimes(1);
    });
  });

  describe('Sub 3 — drill-down', () => {
    it('metric 클릭 → MetricDrillDownView 표시', async () => {
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });

      fireEvent.press(screen.getByTestId('operation-metric-alarmAccuracy'));
      expect(screen.getByTestId('metric-drilldown-view')).toBeTruthy();
    });

    it('같은 metric 다시 클릭 → drill-down 닫힘 (토글)', async () => {
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });

      fireEvent.press(screen.getByTestId('operation-metric-alarmAccuracy'));
      expect(screen.getByTestId('metric-drilldown-view')).toBeTruthy();

      fireEvent.press(screen.getByTestId('operation-metric-alarmAccuracy'));
      expect(screen.queryByTestId('metric-drilldown-view')).toBeNull();
    });

    it('drill-down 닫기 버튼 → drill-down 사라짐', async () => {
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });

      fireEvent.press(screen.getByTestId('operation-metric-silentPushReach'));
      expect(screen.getByTestId('metric-drilldown-view')).toBeTruthy();

      fireEvent.press(screen.getByTestId('metric-drilldown-close'));
      expect(screen.queryByTestId('metric-drilldown-view')).toBeNull();
    });

    it('다른 metric 클릭 → drill-down key 전환 (view 유지)', async () => {
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });

      fireEvent.press(screen.getByTestId('operation-metric-alarmAccuracy'));
      expect(screen.getByTestId('metric-drilldown-view')).toBeTruthy();

      // 다른 metric 클릭 → 여전히 view 보임 (key만 바뀜)
      fireEvent.press(screen.getByTestId('operation-metric-locklessMiss'));
      expect(screen.getByTestId('metric-drilldown-view')).toBeTruthy();
    });
  });

  // ── #1769 Accel pattern section ──────────────────────────────────────────────

  describe('#1769 — accelPattern section', () => {
    it('backend 미수신 상태에서 accelPattern row가 렌더되며 (no data) 표시', async () => {
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });
      expect(screen.getByTestId('operation-metric-accelPattern')).toBeTruthy();
      expect(screen.getByTestId('accel-pattern-na')).toBeTruthy();
    });

    it('fetch 성공 → 4 pattern bar가 렌더된다', async () => {
      mockFetchMetrics.mockResolvedValue(makeSuccessResult());
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });
      await waitFor(() => {
        expect(screen.getByTestId('accel-pattern-bar-automotive')).toBeTruthy();
        expect(screen.getByTestId('accel-pattern-bar-walking')).toBeTruthy();
        expect(screen.getByTestId('accel-pattern-bar-stationary')).toBeTruthy();
        expect(screen.getByTestId('accel-pattern-bar-unknown')).toBeTruthy();
      });
    });

    it('fetch 성공 시 accel-pattern-na는 사라진다', async () => {
      mockFetchMetrics.mockResolvedValue(makeSuccessResult());
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });
      await waitFor(() => {
        expect(screen.queryByTestId('accel-pattern-na')).toBeNull();
      });
    });

    it('unconfigured 상태에서 accelPattern row가 (no data) 유지', async () => {
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });
      await waitFor(() => {
        expect(screen.getByTestId('accel-pattern-na')).toBeTruthy();
      });
    });
  });

  // ── #1772 Push Latency section ────────────────────────────────────────────────

  describe('#1772 — pushLatency section', () => {
    it('backend 미수신 상태에서 pushLatency row가 렌더되며 (no data) 표시', async () => {
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });
      expect(screen.getByTestId('operation-metric-pushLatency')).toBeTruthy();
      expect(screen.getByTestId('push-latency-na')).toBeTruthy();
    });

    it('fetch 성공 but silentPushLatency=null → (no samples yet) 표시', async () => {
      mockFetchMetrics.mockResolvedValue(makeSuccessResult(2, 10, 0, 0, DEFAULT_ACCEL_PATTERN, null));
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });
      await waitFor(() => {
        expect(screen.getByTestId('push-latency-empty')).toBeTruthy();
      });
    });

    it('fetch 성공 + silentPushLatency 있음 → p50/p95/n 표시', async () => {
      mockFetchMetrics.mockResolvedValue(
        makeSuccessResult(2, 10, 0, 0, DEFAULT_ACCEL_PATTERN, { p50: 350, p95: 800, totalSamples: 42 }),
      );
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });
      await waitFor(() => {
        expect(screen.getByTestId('push-latency-values')).toBeTruthy();
      });
    });

    it('unconfigured 상태에서 pushLatency row (no data) 유지', async () => {
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      await act(async () => { jest.runAllTimers(); });
      await waitFor(() => {
        expect(screen.getByTestId('push-latency-na')).toBeTruthy();
      });
    });
  });
});
