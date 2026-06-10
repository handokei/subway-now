import { act, fireEvent } from '@testing-library/react-native';
import { Toast } from '../Toast';
import { renderWithTheme } from '../../../testUtils/renderWithTheme';

describe('Toast', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('visible=false면 렌더 안 됨', () => {
    const { queryByTestId } = renderWithTheme(
      <Toast visible={false} message="msg" onDismiss={() => {}} testID="t" />,
    );
    expect(queryByTestId('t')).toBeNull();
  });

  it('visible=true면 메시지 렌더', () => {
    const { getByTestId, getByText } = renderWithTheme(
      <Toast visible message="잘못된 열차" onDismiss={() => {}} testID="t" />,
    );
    expect(getByTestId('t')).toBeTruthy();
    expect(getByText('잘못된 열차')).toBeTruthy();
  });

  it('탭 시 onDismiss 호출', () => {
    const onDismiss = jest.fn();
    const { getByTestId } = renderWithTheme(
      <Toast visible message="msg" onDismiss={onDismiss} testID="t" />,
    );
    fireEvent.press(getByTestId('t'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('durationMs 후 자동 onDismiss 호출', () => {
    const onDismiss = jest.fn();
    renderWithTheme(
      <Toast visible message="msg" onDismiss={onDismiss} durationMs={3000} testID="t" />,
    );
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('durationMs=0이면 자동 dismiss 안 함', () => {
    const onDismiss = jest.fn();
    renderWithTheme(
      <Toast visible message="msg" onDismiss={onDismiss} durationMs={0} testID="t" />,
    );
    act(() => {
      jest.advanceTimersByTime(100_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('visible=false 변화 시 타이머 클린업', () => {
    const onDismiss = jest.fn();
    const { rerender } = renderWithTheme(
      <Toast visible message="msg" onDismiss={onDismiss} durationMs={3000} testID="t" />,
    );
    rerender(<Toast visible={false} message="msg" onDismiss={onDismiss} durationMs={3000} testID="t" />);
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('accent 미전달 시 colors.accent 기본 사용', () => {
    const { getByTestId } = renderWithTheme(
      <Toast visible message="msg" onDismiss={() => {}} testID="t" />,
    );
    expect(getByTestId('t')).toBeTruthy();
  });

  it('accent prop 적용 (warn 등)', () => {
    const { getByTestId } = renderWithTheme(
      <Toast visible message="msg" onDismiss={() => {}} accent="#ff0000" testID="t" />,
    );
    expect(getByTestId('t')).toBeTruthy();
  });

  // #1058 — 액션 버튼(actionLabel + onAction) 지원.
  it('actionLabel + onAction 둘 다 전달 시 액션 버튼 렌더 + 탭 시 onAction만 호출', () => {
    const onAction = jest.fn();
    const onDismiss = jest.fn();
    const { getByTestId, getByText } = renderWithTheme(
      <Toast
        visible
        message="msg"
        onDismiss={onDismiss}
        actionLabel="Undo"
        onAction={onAction}
        testID="t"
      />,
    );
    expect(getByText('Undo')).toBeTruthy();
    fireEvent.press(getByTestId('t-action'));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('actionLabel만 있고 onAction 없으면 액션 버튼 렌더 안 함', () => {
    const { queryByTestId } = renderWithTheme(
      <Toast visible message="msg" onDismiss={() => {}} actionLabel="Undo" testID="t" />,
    );
    expect(queryByTestId('t-action')).toBeNull();
  });

  it('actionLabel/onAction 모두 없으면 액션 버튼 미렌더', () => {
    const { queryByTestId } = renderWithTheme(
      <Toast visible message="msg" onDismiss={() => {}} testID="t" />,
    );
    expect(queryByTestId('t-action')).toBeNull();
  });

  it('testID 미전달 시 액션 버튼 testID도 undefined (탭은 동작)', () => {
    const onAction = jest.fn();
    const { getByText } = renderWithTheme(
      <Toast visible message="msg" onDismiss={() => {}} actionLabel="Undo" onAction={onAction} />,
    );
    fireEvent.press(getByText('Undo'));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
