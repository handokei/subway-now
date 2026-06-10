import React from 'react';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { FeedbackModal, FEEDBACK_MAX_LENGTH } from '../FeedbackModal';
import { submitFeedback } from '../../../../shared/api/feedback';

jest.mock('../../../../shared/api/feedback', () => ({
  submitFeedback: jest.fn(),
}));

const mockedSubmit = submitFeedback as jest.MockedFunction<typeof submitFeedback>;

describe('FeedbackModal', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockedSubmit.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders title and submit disabled until non-empty input', () => {
    const onClose = jest.fn();
    const { getByTestId, getByText } = renderWithTheme(
      <FeedbackModal visible onClose={onClose} />,
    );
    expect(getByText('버그 신고')).toBeTruthy();
    const submit = getByTestId('feedback-submit');
    expect(submit.props.accessibilityState).toEqual({ disabled: true });

    fireEvent.changeText(getByTestId('feedback-input'), 'something broke');
    expect(getByTestId('feedback-submit').props.accessibilityState).toEqual({
      disabled: false,
    });
  });

  it('disables submit when only whitespace is entered', () => {
    const { getByTestId } = renderWithTheme(
      <FeedbackModal visible onClose={jest.fn()} />,
    );
    fireEvent.changeText(getByTestId('feedback-input'), '   ');
    expect(getByTestId('feedback-submit').props.accessibilityState).toEqual({
      disabled: true,
    });
  });

  it('submits trimmed message and shows success toast, then auto-closes', async () => {
    mockedSubmit.mockResolvedValue({ ok: true, status: 201 });
    const onClose = jest.fn();
    const { getByTestId } = renderWithTheme(
      <FeedbackModal visible onClose={onClose} />,
    );
    fireEvent.changeText(getByTestId('feedback-input'), '  hello  ');
    await act(async () => {
      fireEvent.press(getByTestId('feedback-submit'));
    });
    expect(mockedSubmit).toHaveBeenCalledWith('hello');
    await waitFor(() => {
      expect(getByTestId('feedback-status')).toBeTruthy();
    });
    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps input and shows error toast on submit failure', async () => {
    mockedSubmit.mockResolvedValue({ ok: false, status: 500 });
    const onClose = jest.fn();
    const { getByTestId } = renderWithTheme(
      <FeedbackModal visible onClose={onClose} />,
    );
    fireEvent.changeText(getByTestId('feedback-input'), 'broken');
    await act(async () => {
      fireEvent.press(getByTestId('feedback-submit'));
    });
    await waitFor(() => {
      expect(getByTestId('feedback-status')).toBeTruthy();
    });
    expect(onClose).not.toHaveBeenCalled();
    // 입력 보존 — 사용자가 재시도할 수 있다.
    expect(getByTestId('feedback-input').props.value).toBe('broken');
  });

  it('no-op when submit pressed while disabled', async () => {
    mockedSubmit.mockResolvedValue({ ok: true, status: 201 });
    const { getByTestId } = renderWithTheme(
      <FeedbackModal visible onClose={jest.fn()} />,
    );
    await act(async () => {
      fireEvent.press(getByTestId('feedback-submit'));
    });
    expect(mockedSubmit).not.toHaveBeenCalled();
  });

  it('shows submitting label while request is in flight', async () => {
    let resolveFn: (v: { ok: boolean }) => void = () => {};
    mockedSubmit.mockImplementation(
      () => new Promise((resolve) => {
        resolveFn = resolve;
      }),
    );
    const { getByTestId, queryByText } = renderWithTheme(
      <FeedbackModal visible onClose={jest.fn()} />,
    );
    fireEvent.changeText(getByTestId('feedback-input'), 'pending');
    await act(async () => {
      fireEvent.press(getByTestId('feedback-submit'));
    });
    expect(queryByText('보내는 중…')).toBeTruthy();
    await act(async () => {
      resolveFn({ ok: true });
    });
  });

  it('close button resets state and calls onClose', () => {
    const onClose = jest.fn();
    const { getByTestId } = renderWithTheme(
      <FeedbackModal visible onClose={onClose} />,
    );
    fireEvent.changeText(getByTestId('feedback-input'), 'draft');
    fireEvent.press(getByTestId('feedback-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('FEEDBACK_MAX_LENGTH is 2000 (matches backend)', () => {
    expect(FEEDBACK_MAX_LENGTH).toBe(2000);
  });
});
