import { fireEvent } from '@testing-library/react-native';
import { LocklessBadge } from '../LocklessBadge';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';

describe('LocklessBadge (#1755)', () => {
  it('badge와 "탑승 확인하기" 텍스트를 렌더한다', () => {
    const { getByTestId, getByText } = renderWithTheme(
      <LocklessBadge onPress={() => {}} />,
    );
    expect(getByTestId('lockless-badge')).toBeTruthy();
    expect(getByText('🔍 탐색 중')).toBeTruthy();
    expect(getByText('탑승 확인하기')).toBeTruthy();
  });

  it('탭 시 onPress 콜백이 1회 호출된다', () => {
    const onPress = jest.fn();
    const { getByTestId } = renderWithTheme(
      <LocklessBadge onPress={onPress} />,
    );
    fireEvent.press(getByTestId('lockless-badge'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('accessibilityRole이 button이다', () => {
    const { getByTestId } = renderWithTheme(
      <LocklessBadge onPress={() => {}} />,
    );
    expect(getByTestId('lockless-badge').props.accessibilityRole).toBe('button');
  });

  it('accessibilityLabel이 탑승 확인하기 i18n 키와 일치한다', () => {
    const { getByTestId } = renderWithTheme(
      <LocklessBadge onPress={() => {}} />,
    );
    expect(getByTestId('lockless-badge').props.accessibilityLabel).toBe('탑승 확인하기');
  });

  it('onPress를 다르게 전달해도 각각 독립 호출된다', () => {
    const onPressA = jest.fn();
    const onPressB = jest.fn();
    const { getByTestId, rerender } = renderWithTheme(
      <LocklessBadge onPress={onPressA} />,
    );
    fireEvent.press(getByTestId('lockless-badge'));
    expect(onPressA).toHaveBeenCalledTimes(1);
    expect(onPressB).not.toHaveBeenCalled();

    rerender(<LocklessBadge onPress={onPressB} />);
    fireEvent.press(getByTestId('lockless-badge'));
    expect(onPressB).toHaveBeenCalledTimes(1);
    expect(onPressA).toHaveBeenCalledTimes(1);
  });
});
