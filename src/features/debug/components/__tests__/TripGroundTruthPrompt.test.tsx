import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { TripGroundTruthPrompt } from '../TripGroundTruthPrompt';
import { useTripGroundTruthStore } from '../../store/useTripGroundTruthStore';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn().mockResolvedValue(null),
  setItem: jest.fn().mockResolvedValue(undefined),
}));

describe('TripGroundTruthPrompt (#1502 M2)', () => {
  beforeEach(() => {
    useTripGroundTruthStore.setState({
      hydrated: true,
      pendingPrompt: null,
      responses: [],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('pendingPrompt 없으면 modal 숨김', () => {
    const { queryByTestId } = renderWithTheme(<TripGroundTruthPrompt />);
    expect(queryByTestId('trip-ground-truth-card')).toBeNull();
  });

  it('pendingPrompt가 set되면 modal 자동 노출 (3 액션 + dismiss)', async () => {
    const { getByTestId } = renderWithTheme(<TripGroundTruthPrompt />);
    await act(async () => {
      await useTripGroundTruthStore
        .getState()
        .enqueuePrompt({ corrId: 'c1', endedAt: 100 });
    });
    expect(getByTestId('trip-ground-truth-card')).toBeTruthy();
    expect(getByTestId('trip-ground-truth-accurate')).toBeTruthy();
    expect(getByTestId('trip-ground-truth-inaccurate')).toBeTruthy();
    expect(getByTestId('trip-ground-truth-dismiss')).toBeTruthy();
  });

  it('accurate 탭 → respond("accurate") 호출 + thanks 1.5s 노출 후 자동 close', async () => {
    jest.useFakeTimers();
    const { getByTestId, queryByTestId } = renderWithTheme(<TripGroundTruthPrompt />);
    await act(async () => {
      await useTripGroundTruthStore
        .getState()
        .enqueuePrompt({ corrId: 'c1', endedAt: 100 });
    });

    await act(async () => {
      fireEvent.press(getByTestId('trip-ground-truth-accurate'));
    });

    // pending 해제됨, thanks 노출
    expect(useTripGroundTruthStore.getState().pendingPrompt).toBeNull();
    expect(useTripGroundTruthStore.getState().responses[0].outcome).toBe('accurate');
    expect(getByTestId('trip-ground-truth-thanks')).toBeTruthy();

    // 1500ms 후 thanks 사라짐
    act(() => {
      jest.advanceTimersByTime(1500);
    });
    await waitFor(() => {
      expect(queryByTestId('trip-ground-truth-thanks')).toBeNull();
    });
  });

  it('inaccurate 탭 → respond("inaccurate")', async () => {
    const { getByTestId } = renderWithTheme(<TripGroundTruthPrompt />);
    await act(async () => {
      await useTripGroundTruthStore
        .getState()
        .enqueuePrompt({ corrId: 'c2', endedAt: 200 });
    });
    await act(async () => {
      fireEvent.press(getByTestId('trip-ground-truth-inaccurate'));
    });
    expect(useTripGroundTruthStore.getState().responses[0].outcome).toBe('inaccurate');
  });

  it('dismiss 탭 → respond("unanswered")', async () => {
    const { getByTestId } = renderWithTheme(<TripGroundTruthPrompt />);
    await act(async () => {
      await useTripGroundTruthStore
        .getState()
        .enqueuePrompt({ corrId: 'c3', endedAt: 300 });
    });
    await act(async () => {
      fireEvent.press(getByTestId('trip-ground-truth-dismiss'));
    });
    expect(useTripGroundTruthStore.getState().responses[0].outcome).toBe('unanswered');
  });

  it('hydrated=false면 hydrate를 자동 호출', async () => {
    const hydrate = jest.fn().mockResolvedValue(undefined);
    useTripGroundTruthStore.setState({
      hydrated: false,
      pendingPrompt: null,
      responses: [],
      hydrate,
    });
    renderWithTheme(<TripGroundTruthPrompt />);
    await waitFor(() => {
      expect(hydrate).toHaveBeenCalled();
    });
  });

  it('hydrated=true면 hydrate 호출 X', async () => {
    const hydrate = jest.fn().mockResolvedValue(undefined);
    useTripGroundTruthStore.setState({
      hydrated: true,
      pendingPrompt: null,
      responses: [],
      hydrate,
    });
    renderWithTheme(<TripGroundTruthPrompt />);
    // microtask flush
    await act(async () => {
      await Promise.resolve();
    });
    expect(hydrate).not.toHaveBeenCalled();
  });

  it('연속 응답 시 이전 thanks timer를 clear하고 새 timer 재시작', async () => {
    jest.useFakeTimers();
    const { getByTestId } = renderWithTheme(<TripGroundTruthPrompt />);
    // 첫 번째 trip 응답
    await act(async () => {
      await useTripGroundTruthStore
        .getState()
        .enqueuePrompt({ corrId: 'c1', endedAt: 100 });
    });
    await act(async () => {
      fireEvent.press(getByTestId('trip-ground-truth-accurate'));
    });
    // thanks가 노출된 사이에 다음 trip 응답 — 이전 timer가 clear되어야 한다.
    await act(async () => {
      await useTripGroundTruthStore
        .getState()
        .enqueuePrompt({ corrId: 'c2', endedAt: 200 });
    });
    await act(async () => {
      fireEvent.press(getByTestId('trip-ground-truth-accurate'));
    });
    // 새 thanks가 노출 중
    expect(getByTestId('trip-ground-truth-thanks')).toBeTruthy();
  });

  it('unmount 시 thanks timer cleanup (메모리 누수 방지)', async () => {
    jest.useFakeTimers();
    const { getByTestId, unmount } = renderWithTheme(<TripGroundTruthPrompt />);
    await act(async () => {
      await useTripGroundTruthStore
        .getState()
        .enqueuePrompt({ corrId: 'c1', endedAt: 100 });
    });
    await act(async () => {
      fireEvent.press(getByTestId('trip-ground-truth-accurate'));
    });
    // unmount 직후 timer가 더 이상 실행되지 않아야 한다.
    unmount();
    act(() => {
      jest.advanceTimersByTime(1500);
    });
    // throw 없이 통과하면 OK.
  });

  it('Modal onRequestClose (안드로이드 back) → unanswered 응답', async () => {
    const { UNSAFE_getByType } = renderWithTheme(<TripGroundTruthPrompt />);
    await act(async () => {
      await useTripGroundTruthStore
        .getState()
        .enqueuePrompt({ corrId: 'c4', endedAt: 400 });
    });
    // Modal의 onRequestClose prop을 직접 호출.
    const { Modal } = jest.requireActual('react-native');
    const modal = UNSAFE_getByType(Modal);
    await act(async () => {
      modal.props.onRequestClose();
    });
    expect(useTripGroundTruthStore.getState().responses[0].outcome).toBe('unanswered');
  });
});
