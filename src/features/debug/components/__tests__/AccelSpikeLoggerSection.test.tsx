/**
 * SPIKE→영구 캡처 도구 승격 (#2268 promotion) — AccelSpikeLoggerSection.tsx 컴포넌트 테스트.
 *
 * accelSpikeLogger 모듈은 jest.mock으로 격리 — 이 테스트는 UI wiring(버튼 탭 → 함수 호출,
 * 상태 전환에 따른 렌더 분기, Share/Alert 경로)만 검증한다. 로거 자체 로직은
 * accelSpikeLogger.test.ts가 담당.
 */
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { Alert, Share } from 'react-native';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { AccelSpikeLoggerSection } from '../AccelSpikeLoggerSection';
import {
  getSpikeLoggingCounts,
  isSpikeLoggingActive,
  markSpikeEvent,
  startSpikeLogging,
  stopSpikeLoggingAndExport,
} from '../../utils/accelSpikeLogger';

jest.mock('../../utils/accelSpikeLogger', () => ({
  getSpikeLoggingCounts: jest.fn(),
  isSpikeLoggingActive: jest.fn(),
  markSpikeEvent: jest.fn(),
  startSpikeLogging: jest.fn(),
  stopSpikeLoggingAndExport: jest.fn(),
}));

const mockGetSpikeLoggingCounts = getSpikeLoggingCounts as jest.Mock;
const mockIsSpikeLoggingActive = isSpikeLoggingActive as jest.Mock;
const mockMarkSpikeEvent = markSpikeEvent as jest.Mock;
const mockStartSpikeLogging = startSpikeLogging as jest.Mock;
const mockStopSpikeLoggingAndExport = stopSpikeLoggingAndExport as jest.Mock;

describe('AccelSpikeLoggerSection (#2268 promotion)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockIsSpikeLoggingActive.mockReturnValue(false);
    mockGetSpikeLoggingCounts.mockReturnValue({ samples: 0, marks: 0 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('시작 전: ride/line 입력 + placement 선택 UI를 렌더한다', () => {
    const { getByTestId, queryByTestId } = renderWithTheme(<AccelSpikeLoggerSection />);
    expect(getByTestId('debug-spike-ride-input')).toBeTruthy();
    expect(getByTestId('debug-spike-line-input')).toBeTruthy();
    expect(getByTestId('debug-spike-placement-pocket')).toBeTruthy();
    expect(getByTestId('debug-spike-placement-hand')).toBeTruthy();
    expect(getByTestId('debug-spike-placement-bag')).toBeTruthy();
    expect(getByTestId('debug-spike-toggle')).toBeTruthy();
    expect(queryByTestId('debug-spike-counts')).toBeNull();
    expect(queryByTestId('debug-spike-mark-arrive')).toBeNull();
  });

  it('ride/line 텍스트 입력 상태가 반영된다', () => {
    const { getByTestId } = renderWithTheme(<AccelSpikeLoggerSection />);
    const rideInput = getByTestId('debug-spike-ride-input');
    const lineInput = getByTestId('debug-spike-line-input');
    fireEvent.changeText(rideInput, '2호선 강남-역삼');
    fireEvent.changeText(lineInput, '2');
    expect(rideInput.props.value).toBe('2호선 강남-역삼');
    expect(lineInput.props.value).toBe('2');
  });

  it('placement chip 탭 시 선택 상태가 전환된다', () => {
    const { getByTestId } = renderWithTheme(<AccelSpikeLoggerSection />);
    fireEvent.press(getByTestId('debug-spike-placement-hand'));
    // 선택된 chip은 accent 배경 — style 배열의 backgroundColor로 검증
    const handChip = getByTestId('debug-spike-placement-hand');
    const style = Array.isArray(handChip.props.style)
      ? Object.assign({}, ...handChip.props.style)
      : handChip.props.style;
    expect(style.backgroundColor).not.toBe('transparent');
  });

  it('로깅 시작 버튼 탭 시 startSpikeLogging에 trim된 ride/line + placement 전달', async () => {
    const { getByTestId } = renderWithTheme(<AccelSpikeLoggerSection />);
    fireEvent.changeText(getByTestId('debug-spike-ride-input'), '  2호선 강남-역삼  ');
    fireEvent.changeText(getByTestId('debug-spike-line-input'), '  2  ');
    fireEvent.press(getByTestId('debug-spike-placement-bag'));

    await act(async () => {
      fireEvent.press(getByTestId('debug-spike-toggle'));
    });

    expect(mockStartSpikeLogging).toHaveBeenCalledWith({
      ride: '2호선 강남-역삼',
      placement: 'bag',
      line: '2',
    });
  });

  it('ride 미입력 시 "(unlabeled)"로 대체', async () => {
    const { getByTestId } = renderWithTheme(<AccelSpikeLoggerSection />);
    await act(async () => {
      fireEvent.press(getByTestId('debug-spike-toggle'));
    });
    expect(mockStartSpikeLogging).toHaveBeenCalledWith(
      expect.objectContaining({ ride: '(unlabeled)' }),
    );
  });

  it('로깅 시작 후 counts 표시 + MARK 버튼 노출, 입력 UI는 숨김', async () => {
    const { getByTestId, queryByTestId } = renderWithTheme(<AccelSpikeLoggerSection />);
    mockIsSpikeLoggingActive.mockReturnValue(false);
    await act(async () => {
      fireEvent.press(getByTestId('debug-spike-toggle'));
    });

    expect(queryByTestId('debug-spike-ride-input')).toBeNull();
    expect(getByTestId('debug-spike-counts')).toBeTruthy();
    expect(getByTestId('debug-spike-mark-arrive')).toBeTruthy();
    expect(getByTestId('debug-spike-mark-depart')).toBeTruthy();
  });

  it('MARK 도착/출발 버튼이 markSpikeEvent를 호출', async () => {
    const { getByTestId } = renderWithTheme(<AccelSpikeLoggerSection />);
    await act(async () => {
      fireEvent.press(getByTestId('debug-spike-toggle'));
    });

    fireEvent.press(getByTestId('debug-spike-mark-arrive'));
    expect(mockMarkSpikeEvent).toHaveBeenCalledWith('arrive');

    fireEvent.press(getByTestId('debug-spike-mark-depart'));
    expect(mockMarkSpikeEvent).toHaveBeenCalledWith('depart');
  });

  it('로깅 중 1초 간격으로 counts를 갱신한다', async () => {
    const { getByTestId } = renderWithTheme(<AccelSpikeLoggerSection />);
    await act(async () => {
      fireEvent.press(getByTestId('debug-spike-toggle'));
    });

    mockGetSpikeLoggingCounts.mockReturnValue({ samples: 20, marks: 1 });
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    expect(getByTestId('debug-spike-counts').props.children).toBe('samples=20 marks=1');
  });

  it('로깅 종료 버튼 탭 시 stopSpikeLoggingAndExport 호출 + Share + Alert', async () => {
    mockStopSpikeLoggingAndExport.mockResolvedValue('mock-file://accel-spike-1.jsonl');
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

    const { getByTestId } = renderWithTheme(<AccelSpikeLoggerSection />);
    await act(async () => {
      fireEvent.press(getByTestId('debug-spike-toggle'));
    });

    mockIsSpikeLoggingActive.mockReturnValue(true);
    await act(async () => {
      fireEvent.press(getByTestId('debug-spike-toggle'));
    });

    expect(mockStopSpikeLoggingAndExport).toHaveBeenCalledTimes(1);
    expect(shareSpy).toHaveBeenCalledWith({
      url: 'mock-file://accel-spike-1.jsonl',
      message: 'mock-file://accel-spike-1.jsonl',
    });
    expect(alertSpy).toHaveBeenCalledWith('SPIKE 로그 저장됨', 'mock-file://accel-spike-1.jsonl');

    shareSpy.mockRestore();
    alertSpy.mockRestore();
  });

  it('로깅 종료 시 counts를 0으로 리셋하고 시작 UI로 되돌아간다', async () => {
    mockStopSpikeLoggingAndExport.mockResolvedValue('mock-file://x.jsonl');
    jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

    const { getByTestId, queryByTestId } = renderWithTheme(<AccelSpikeLoggerSection />);
    await act(async () => {
      fireEvent.press(getByTestId('debug-spike-toggle'));
    });
    mockIsSpikeLoggingActive.mockReturnValue(true);
    await act(async () => {
      fireEvent.press(getByTestId('debug-spike-toggle'));
    });

    expect(queryByTestId('debug-spike-counts')).toBeNull();
    expect(queryByTestId('debug-spike-mark-arrive')).toBeNull();
    expect(getByTestId('debug-spike-ride-input')).toBeTruthy();
  });

  it('Share.share 실패 시에도 graceful — Alert는 여전히 호출된다', async () => {
    mockStopSpikeLoggingAndExport.mockResolvedValue('mock-file://x.jsonl');
    const shareSpy = jest.spyOn(Share, 'share').mockRejectedValue(new Error('no share sheet'));
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

    const { getByTestId } = renderWithTheme(<AccelSpikeLoggerSection />);
    await act(async () => {
      fireEvent.press(getByTestId('debug-spike-toggle'));
    });
    mockIsSpikeLoggingActive.mockReturnValue(true);
    await act(async () => {
      fireEvent.press(getByTestId('debug-spike-toggle'));
    });

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('SPIKE 로그 저장됨', 'mock-file://x.jsonl'));

    shareSpy.mockRestore();
    alertSpy.mockRestore();
  });

  it('버튼 연타(busyRef) — 진행 중 재탭은 무시된다', async () => {
    let resolveStart: (() => void) | undefined;
    mockStartSpikeLogging.mockImplementation(() => {
      // startSpikeLogging은 동기 함수지만, busyRef 가드 자체를 검증하기 위해
      // handleToggle 내부의 await 지점(Share 등)이 없는 시작 경로에서는
      // 동기 완료 후 busyRef가 즉시 풀린다 — 대신 종료 경로(비동기)로 검증한다.
      return undefined;
    });
    void resolveStart;

    mockStopSpikeLoggingAndExport.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveStart = () => resolve('mock-file://slow.jsonl');
        }),
    );
    jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

    const { getByTestId } = renderWithTheme(<AccelSpikeLoggerSection />);
    await act(async () => {
      fireEvent.press(getByTestId('debug-spike-toggle'));
    });
    mockIsSpikeLoggingActive.mockReturnValue(true);

    // 종료 탭 (비동기 stop 진행 중)
    act(() => {
      fireEvent.press(getByTestId('debug-spike-toggle'));
    });
    // 진행 중 재탭 — busyRef가 true이므로 stopSpikeLoggingAndExport가 다시 호출되면 안 됨
    act(() => {
      fireEvent.press(getByTestId('debug-spike-toggle'));
    });
    expect(mockStopSpikeLoggingAndExport).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveStart?.();
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});
