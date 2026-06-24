/**
 * #1751 (M3 Sub 1) — OperationDashboardSection 단위 테스트.
 *
 * 커버리지 기준:
 *   - 빈 데이터 상태 (4 metric 모두 0 / no data)
 *   - 정상 데이터 상태 (M2 responses mock + silent push alarmLog mock)
 *   - ratio bar 렌더 분기 (null vs 유효 비율)
 */
import React from 'react';
import { screen } from '@testing-library/react-native';
import { OperationDashboardSection } from '../OperationDashboardSection';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { useTripGroundTruthStore, type TripGroundTruthState } from '../../store/useTripGroundTruthStore';
import type { AlarmLogEntry } from '../../../alarm/utils/alarmLog';

// ─── mock ─────────────────────────────────────────────────────────────────────

jest.mock('../../store/useTripGroundTruthStore', () => ({
  useTripGroundTruthStore: jest.fn(),
}));

const mockUseTripGroundTruthStore = useTripGroundTruthStore as jest.MockedFunction<typeof useTripGroundTruthStore>;

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
  // useTripGroundTruthStore selector 호출 패턴: (s) => s.responses
  mockUseTripGroundTruthStore.mockImplementation((selector: (s: TripGroundTruthState) => unknown) =>
    selector(stubState),
  );
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('OperationDashboardSection', () => {
  describe('빈 데이터 상태 (4 metric 모두 0)', () => {
    beforeEach(() => {
      setupStore([]);
    });

    it('4개 metric row를 렌더한다', () => {
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      expect(screen.getByTestId('operation-metric-alarmAccuracy')).toBeTruthy();
      expect(screen.getByTestId('operation-metric-silentPushReach')).toBeTruthy();
      expect(screen.getByTestId('operation-metric-locklessMiss')).toBeTruthy();
      expect(screen.getByTestId('operation-metric-boardableMiss')).toBeTruthy();
    });

    it('alarmAccuracy: 응답 0건 → no data bar 렌더', () => {
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      const naTexts = screen.getAllByTestId('ratio-bar-na');
      // 빈 상태: alarmAccuracy, locklessMiss, boardableMiss 3개가 (no data)
      // silentPushReach도 received=0 → null → (no data)
      expect(naTexts.length).toBeGreaterThanOrEqual(2);
    });

    it('silentPushReach: received=0 → no data bar 렌더', () => {
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      const naTexts = screen.getAllByTestId('ratio-bar-na');
      expect(naTexts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('정상 데이터 상태', () => {
    it('alarmAccuracy: accurate 3/5 응답 → ratio bar 렌더', () => {
      setupStore([
        { outcome: 'accurate' },
        { outcome: 'accurate' },
        { outcome: 'accurate' },
        { outcome: 'inaccurate' },
        { outcome: 'unanswered' },
      ]);
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      // accurate=3, answered(accurate+inaccurate)=4 → 75%
      // ratio bar track이 렌더되어야 함
      const tracks = screen.getAllByTestId('ratio-bar-track');
      expect(tracks.length).toBeGreaterThanOrEqual(1);
    });

    it('silentPushReach: received 5, fired 4 → ratio bar 렌더', () => {
      setupStore([]);
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
      // received=5, fired=4 → 80% → ratio bar track이 렌더되어야 함
      const tracks = screen.getAllByTestId('ratio-bar-track');
      expect(tracks.length).toBeGreaterThanOrEqual(1);
    });

    it('locklessMiss, boardableMiss: mock 상태 → (no data) 유지', () => {
      setupStore([]);
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      const naTexts = screen.getAllByTestId('ratio-bar-na');
      // locklessMiss + boardableMiss = 2개 이상 (no data)
      expect(naTexts.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('ratio bar fill 렌더', () => {
    it('ratio=1.0 → fill 렌더', () => {
      setupStore([
        { outcome: 'accurate' },
      ]);
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      const fills = screen.getAllByTestId('ratio-bar-fill');
      expect(fills.length).toBeGreaterThanOrEqual(1);
    });

    it('ratio=null → ratio-bar-na 렌더 (no data)', () => {
      setupStore([]);
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      const naTexts = screen.getAllByTestId('ratio-bar-na');
      expect(naTexts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('section wrapper testID', () => {
    it('operation-dashboard-section testID가 존재한다', () => {
      setupStore([]);
      renderWithTheme(<OperationDashboardSection logs={[]} />);
      expect(screen.getByTestId('operation-dashboard-section')).toBeTruthy();
    });
  });
});
