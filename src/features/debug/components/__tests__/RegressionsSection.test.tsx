/**
 * RegressionsSection (#1263, Epic #1204 그룹 0 PR C) 단위 테스트.
 *
 * 커버:
 *   - KNOWN_REGRESSION_IDS 순회로 모든 id 행이 렌더됨
 *   - ADMIN_TOKEN 미설정 → 안내 메시지 + backend fetch skip
 *   - ALARM_BACKEND_URL 미설정 → 안내 메시지
 *   - 200 성공 → 윈도우 카운트 표시
 *   - 빈 데이터(counts={}) → 모든 행이 0
 *   - non-200 → "HTTP <status>" error 메시지
 *   - fetch throw → error.message 노출
 *   - refresh 버튼 → fetch 재호출 + 로컬 snapshot 재반영
 */
import { Text } from 'react-native';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { RegressionsSection, __test__ } from '../RegressionsSection';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import {
  KNOWN_REGRESSION_IDS,
  recordRegression,
  __waitForPendingPersists,
} from '../../../../shared/utils/regressionMetrics';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.EXPO_PUBLIC_ADMIN_TOKEN = 'tok-test';
  process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://alarm.example.test';
  global.fetch = jest.fn() as unknown as typeof fetch;
});

afterEach(() => {
  // env keys may be deleted by individual tests — restore both keys explicitly.
  process.env.EXPO_PUBLIC_ADMIN_TOKEN = ORIGINAL_ENV.EXPO_PUBLIC_ADMIN_TOKEN;
  process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = ORIGINAL_ENV.EXPO_PUBLIC_ALARM_BACKEND_URL;
});

function mockFetchOk(body: unknown) {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

function mockFetchStatus(status: number) {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: false,
    status,
    json: async () => ({}),
  });
}

function mockFetchThrow(message: string) {
  (global.fetch as jest.Mock).mockRejectedValue(new Error(message));
}

function rowCells(testID: string): string[] {
  const row = screen.getByTestId(testID);
  // 각 row는 Text 6개(id + local + 4 windows) — UNSAFE_getAllByType 으로 모두 추출.
  const texts = within(row).UNSAFE_getAllByType(Text);
  return texts.map((t) => String(t.props.children));
}

describe('RegressionsSection', () => {
  it('renders a row for every KNOWN_REGRESSION_IDS', async () => {
    mockFetchOk({ ids: KNOWN_REGRESSION_IDS, counts: {} });
    renderWithTheme(<RegressionsSection />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    for (const id of KNOWN_REGRESSION_IDS) {
      expect(screen.getByTestId(`debug-regressions-row-${id}`)).toBeTruthy();
    }
  });

  it('shows admin token missing message and skips fetch when token unset', async () => {
    process.env.EXPO_PUBLIC_ADMIN_TOKEN = '';
    renderWithTheme(<RegressionsSection />);
    await waitFor(() => {
      expect(screen.getByTestId('debug-regressions-status').props.children).toBe(
        __test__.TOKEN_MISSING_LABEL,
      );
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('shows backend url missing message when ALARM_BACKEND_URL unset', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = '';
    renderWithTheme(<RegressionsSection />);
    await waitFor(() => {
      expect(screen.getByTestId('debug-regressions-status').props.children).toBe(
        __test__.BACKEND_URL_MISSING_LABEL,
      );
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('renders window counts from a 200 response', async () => {
    mockFetchOk({
      ids: KNOWN_REGRESSION_IDS,
      counts: {
        '8': { last5m: 1, lastHour: 2, today: 3, last7d: 4 },
        '10': { last5m: 5, lastHour: 6, today: 7, last7d: 8 },
        '11': { last5m: 0, lastHour: 0, today: 0, last7d: 0 },
        '12': { last5m: 9, lastHour: 9, today: 9, last7d: 9 },
      },
    });
    renderWithTheme(<RegressionsSection />);
    await waitFor(() => {
      expect(rowCells('debug-regressions-row-8')).toEqual([
        'regression_8',
        '0',
        '1',
        '2',
        '3',
        '4',
      ]);
    });
  });

  it('falls back to zeros when counts is empty', async () => {
    mockFetchOk({ ids: KNOWN_REGRESSION_IDS, counts: {} });
    renderWithTheme(<RegressionsSection />);
    await waitFor(() => {
      expect(rowCells('debug-regressions-row-10')).toEqual([
        'regression_10',
        '0',
        '0',
        '0',
        '0',
        '0',
      ]);
    });
  });

  it('shows HTTP status message on non-2xx response', async () => {
    mockFetchStatus(403);
    renderWithTheme(<RegressionsSection />);
    await waitFor(() => {
      expect(screen.getByTestId('debug-regressions-status').props.children).toBe(
        'HTTP 403',
      );
    });
  });

  it('shows error message when fetch throws', async () => {
    mockFetchThrow('network down');
    renderWithTheme(<RegressionsSection />);
    await waitFor(() => {
      expect(screen.getByTestId('debug-regressions-status').props.children).toBe(
        'network down',
      );
    });
  });

  it('treats response body without counts key as empty (zeros for all rows)', async () => {
    // body.counts undefined → `?? {}` branch covered.
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ids: KNOWN_REGRESSION_IDS }),
    });
    renderWithTheme(<RegressionsSection />);
    await waitFor(() => {
      expect(rowCells('debug-regressions-row-12')).toEqual([
        'regression_12',
        '0',
        '0',
        '0',
        '0',
        '0',
      ]);
    });
  });

  it('handles non-Error throw values by coercing to string', async () => {
    // fetch rejects with a plain string — covers `e instanceof Error` false branch.
    (global.fetch as jest.Mock).mockRejectedValue('socket reset');
    renderWithTheme(<RegressionsSection />);
    await waitFor(() => {
      expect(screen.getByTestId('debug-regressions-status').props.children).toBe(
        'socket reset',
      );
    });
  });

  it('refresh button re-fetches and updates the local snapshot', async () => {
    mockFetchOk({ ids: KNOWN_REGRESSION_IDS, counts: {} });
    renderWithTheme(<RegressionsSection />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));

    // record a local count then refresh — local column should reflect it.
    recordRegression('8');
    await __waitForPendingPersists();

    await act(async () => {
      fireEvent.press(screen.getByTestId('debug-regressions-refresh'));
    });
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));

    // index 1 is the local column (after id text)
    expect(rowCells('debug-regressions-row-8')[1]).toBe('1');
  });
});
