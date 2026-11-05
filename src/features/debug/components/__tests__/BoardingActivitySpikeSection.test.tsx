/**
 * #3221 PR-1 — 탑승 LA 실기기 스파이크(§10-1) 섹션. live-activity 모듈은 jest.mock으로 격리하고
 * UI wiring(버튼 → 모듈 함수, push-to-start token 표시, 종료 이벤트 반영)만 검증한다.
 */
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { BoardingActivitySpikeSection } from '../BoardingActivitySpikeSection';
import {
  addBoardingActivityEndedListener,
  addBoardingPushToStartTokenListener,
  endBoardingActivities,
  requestBoardingPushToStartToken,
  startBoardingActivity,
} from 'live-activity';

jest.mock('live-activity', () => ({
  addBoardingActivityEndedListener: jest.fn(),
  addBoardingPushToStartTokenListener: jest.fn(),
  endBoardingActivities: jest.fn(),
  requestBoardingPushToStartToken: jest.fn(),
  startBoardingActivity: jest.fn(),
}));

const mockAddEnded = addBoardingActivityEndedListener as jest.Mock;
const mockAddToken = addBoardingPushToStartTokenListener as jest.Mock;
const mockEnd = endBoardingActivities as jest.Mock;
const mockRequestToken = requestBoardingPushToStartToken as jest.Mock;
const mockStart = startBoardingActivity as jest.Mock;

describe('BoardingActivitySpikeSection (#3221 PR-1)', () => {
  let tokenListener: (e: { token: string }) => void;
  let endedListener: (e: { promptId: string; state: string }) => void;
  const removeToken = jest.fn();
  const removeEnded = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockRequestToken.mockResolvedValue(null);
    mockStart.mockResolvedValue(undefined);
    mockEnd.mockResolvedValue(undefined);
    mockAddToken.mockImplementation((cb) => {
      tokenListener = cb;
      return { remove: removeToken };
    });
    mockAddEnded.mockImplementation((cb) => {
      endedListener = cb;
      return { remove: removeEnded };
    });
  });

  it('마운트 시 push-to-start token을 조회해 표시하고, 없으면 미발급으로 표시한다', async () => {
    const { getByTestId } = renderWithTheme(<BoardingActivitySpikeSection />);
    await waitFor(() => expect(mockRequestToken).toHaveBeenCalledTimes(1));
    expect(getByTestId('debug-boarding-la-token').props.children).toContain('미발급');
  });

  it('조회된 token과 이후 token 이벤트를 표시한다', async () => {
    mockRequestToken.mockResolvedValue('abc123');
    const { getByTestId } = renderWithTheme(<BoardingActivitySpikeSection />);
    await waitFor(() =>
      expect(getByTestId('debug-boarding-la-token').props.children).toContain('abc123'),
    );
    act(() => tokenListener({ token: 'def456' }));
    expect(getByTestId('debug-boarding-la-token').props.children).toContain('def456');
  });

  it('시작 버튼은 서로 다른 promptId로 탑승 LA를 시작하고 결과를 표시한다', async () => {
    const { getByTestId } = renderWithTheme(<BoardingActivitySpikeSection />);
    await act(async () => {
      fireEvent.press(getByTestId('debug-boarding-la-start'));
    });
    expect(mockStart).toHaveBeenCalledTimes(1);
    const [arg] = mockStart.mock.calls[0];
    expect(arg).toMatchObject({ phase: 'pre-boarding', tripToken: expect.any(String) });
    expect(typeof arg.promptId).toBe('string');
    expect(getByTestId('debug-boarding-la-status').props.children).toContain('시작');
  });

  it('시작 실패 시 에러 메시지를 표시한다', async () => {
    mockStart.mockRejectedValue(new Error('boom'));
    const { getByTestId } = renderWithTheme(<BoardingActivitySpikeSection />);
    await act(async () => {
      fireEvent.press(getByTestId('debug-boarding-la-start'));
    });
    expect(getByTestId('debug-boarding-la-status').props.children).toContain('boom');
  });

  it('Error가 아닌 값으로 거부돼도 문자열로 표시한다', async () => {
    mockStart.mockRejectedValue('native-down');
    const { getByTestId } = renderWithTheme(<BoardingActivitySpikeSection />);
    await act(async () => {
      fireEvent.press(getByTestId('debug-boarding-la-start'));
    });
    expect(getByTestId('debug-boarding-la-status').props.children).toContain('native-down');
  });

  it('종료 버튼은 endBoardingActivities를 호출하고, 종료 이벤트를 상태에 반영한다', async () => {
    const { getByTestId } = renderWithTheme(<BoardingActivitySpikeSection />);
    await act(async () => {
      fireEvent.press(getByTestId('debug-boarding-la-end'));
    });
    expect(mockEnd).toHaveBeenCalledTimes(1);
    act(() => endedListener({ promptId: 'p1', state: 'dismissed' }));
    expect(getByTestId('debug-boarding-la-status').props.children).toContain('dismissed');
  });

  it('언마운트 시 두 listener를 해제한다', () => {
    const { unmount } = renderWithTheme(<BoardingActivitySpikeSection />);
    unmount();
    expect(removeToken).toHaveBeenCalledTimes(1);
    expect(removeEnded).toHaveBeenCalledTimes(1);
  });
});
