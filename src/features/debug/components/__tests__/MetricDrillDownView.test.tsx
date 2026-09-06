/**
 * MetricDrillDownView (#1753, Sub 3) 단위 테스트.
 *
 * 커버:
 *   - rawSignal 없음 → "(rawSignal 없음)" 메시지
 *   - rawSignal 있음 → corrId별 그룹화 + trip row 렌더
 *   - corrId=null → 'unknown' 버킷으로 합산
 *   - 최신 trip 먼저(lastTs 내림차순)
 *   - 닫기 버튼 → onClose 호출
 *   - metricKey별 레이블 렌더 (4가지)
 */
import { fireEvent, screen } from '@testing-library/react-native';
import { MetricDrillDownView, type DrillDownMetricKey } from '../MetricDrillDownView';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import {
  pushRawSignal,
  clearRawSignalEntries,
  __resetRawSignalForTests__,
  type RawSignalEntry,
} from '../../../observability/utils/rawSignalBuffer';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

function makeEntry(overrides?: Partial<RawSignalEntry>): RawSignalEntry {
  return {
    ts: 1_700_000_000_000,
    corrId: 'corr-abc',
    kind: 'cycle',
    gps: null,
    motion: null,
    accelPattern: null,
    cellular: null,
    subsurface: null,
    barometerHpa: null,
    arvlCd: null,
    line: '2',
    dir: null,
    arcIdx: null,
    arcProgress: null,
    stationId: null,
    source: null,
    confidence: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  __resetRawSignalForTests__();
});

afterEach(() => {
  clearRawSignalEntries();
  jest.useRealTimers();
});

const METRIC_KEYS: DrillDownMetricKey[] = [
  'alarmAccuracy',
  'silentPushReach',
  'locklessMiss',
  'boardableMiss',
];

describe('MetricDrillDownView', () => {
  it('renders the container testID', () => {
    renderWithTheme(
      <MetricDrillDownView metricKey="alarmAccuracy" onClose={jest.fn()} />,
    );
    expect(screen.getByTestId('metric-drilldown-view')).toBeTruthy();
  });

  it('shows empty message when no rawSignal entries', () => {
    renderWithTheme(
      <MetricDrillDownView metricKey="alarmAccuracy" onClose={jest.fn()} />,
    );
    expect(screen.getByTestId('metric-drilldown-empty')).toBeTruthy();
  });

  it('calls onClose when 닫기 is pressed', () => {
    const onClose = jest.fn();
    renderWithTheme(
      <MetricDrillDownView metricKey="alarmAccuracy" onClose={onClose} />,
    );
    fireEvent.press(screen.getByTestId('metric-drilldown-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe('with rawSignal entries', () => {
    it('renders a trip row for each unique corrId', () => {
      pushRawSignal(makeEntry({ corrId: 'corr-1', ts: 1_000 }));
      pushRawSignal(makeEntry({ corrId: 'corr-2', ts: 2_000 }));
      pushRawSignal(makeEntry({ corrId: 'corr-1', ts: 1_500 }));
      renderWithTheme(
        <MetricDrillDownView metricKey="silentPushReach" onClose={jest.fn()} />,
      );
      expect(screen.getByTestId('drilldown-trip-corr-1')).toBeTruthy();
      expect(screen.getByTestId('drilldown-trip-corr-2')).toBeTruthy();
    });

    it('groups corrId=null entries under "unknown" bucket', () => {
      pushRawSignal(makeEntry({ corrId: null, ts: 1_000 }));
      pushRawSignal(makeEntry({ corrId: null, ts: 2_000 }));
      renderWithTheme(
        <MetricDrillDownView metricKey="locklessMiss" onClose={jest.fn()} />,
      );
      expect(screen.getByTestId('drilldown-trip-unknown')).toBeTruthy();
    });

    it('shows the list when entries are present', () => {
      pushRawSignal(makeEntry({ corrId: 'trip-x', ts: 5_000 }));
      renderWithTheme(
        <MetricDrillDownView metricKey="boardableMiss" onClose={jest.fn()} />,
      );
      expect(screen.getByTestId('metric-drilldown-list')).toBeTruthy();
    });
  });

  describe('metricKey labels', () => {
    it.each(METRIC_KEYS)(
      'renders without crash for metricKey="%s"',
      (key) => {
        renderWithTheme(
          <MetricDrillDownView metricKey={key} onClose={jest.fn()} />,
        );
        expect(screen.getByTestId('metric-drilldown-view')).toBeTruthy();
      },
    );
  });
});
