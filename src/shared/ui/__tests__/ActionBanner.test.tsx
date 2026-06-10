import { Text } from 'react-native';
import { fireEvent } from '@testing-library/react-native';
import { ActionBanner } from '../ActionBanner';
import { renderWithTheme } from '../../../testUtils/renderWithTheme';

describe('ActionBanner', () => {
  it('actionLabel 텍스트와 testID 부착', () => {
    const { getByTestId, getByText } = renderWithTheme(
      <ActionBanner
        accent="#000"
        testID="banner"
        actionLabel="실행"
        actionTestID="banner-action"
        onActionPress={() => {}}
      >
        <Text>info</Text>
      </ActionBanner>,
    );
    expect(getByTestId('banner')).toBeTruthy();
    expect(getByTestId('banner-action')).toBeTruthy();
    expect(getByText('실행')).toBeTruthy();
    expect(getByText('info')).toBeTruthy();
  });

  it('액션 버튼 탭 → onActionPress 호출', () => {
    const onActionPress = jest.fn();
    const { getByTestId } = renderWithTheme(
      <ActionBanner
        accent="#000"
        testID="banner"
        actionLabel="실행"
        actionTestID="banner-action"
        onActionPress={onActionPress}
      >
        <Text>info</Text>
      </ActionBanner>,
    );
    fireEvent.press(getByTestId('banner-action'));
    expect(onActionPress).toHaveBeenCalledTimes(1);
  });

  it.each<[number | undefined, number]>([
    [undefined, 0],
    [12, 12],
  ])('marginBottom prop=%s → 컨테이너 marginBottom=%s', (prop, expected) => {
    const { getByTestId } = renderWithTheme(
      <ActionBanner
        accent="#000"
        testID="banner"
        actionLabel="실행"
        actionTestID="banner-action"
        onActionPress={() => {}}
        marginBottom={prop}
      >
        <Text>info</Text>
      </ActionBanner>,
    );
    const view = getByTestId('banner');
    const flat = Array.isArray(view.props.style) ? view.props.style.flat() : [view.props.style];
    const marginBottom = flat
      .filter((s: unknown): s is { marginBottom?: number } => typeof s === 'object' && s !== null)
      .map((s: { marginBottom?: number }) => s.marginBottom)
      .find((m: number | undefined) => m !== undefined);
    expect(marginBottom).toBe(expected);
  });

  it('컨테이너에 alert role + liveRegion + 전달된 accessibilityLabel 부착', () => {
    const { getByTestId } = renderWithTheme(
      <ActionBanner
        accent="#000"
        testID="banner"
        actionLabel="실행"
        actionTestID="banner-action"
        onActionPress={() => {}}
        accessibilityLabel="긴급 안내"
      >
        <Text>info</Text>
      </ActionBanner>,
    );
    const view = getByTestId('banner');
    expect(view.props.accessibilityRole).toBe('alert');
    expect(view.props.accessibilityLiveRegion).toBe('polite');
    expect(view.props.accessibilityLabel).toBe('긴급 안내');
  });

  it('accessibilityLabel 미전달 시 컨테이너 라벨 undefined', () => {
    const { getByTestId } = renderWithTheme(
      <ActionBanner
        accent="#000"
        testID="banner"
        actionLabel="실행"
        actionTestID="banner-action"
        onActionPress={() => {}}
      >
        <Text>info</Text>
      </ActionBanner>,
    );
    expect(getByTestId('banner').props.accessibilityLabel).toBeUndefined();
  });

  it('액션 버튼: actionAccessibilityLabel 우선, 미전달 시 actionLabel fallback + hint 전달', () => {
    const { getByTestId, rerender } = renderWithTheme(
      <ActionBanner
        accent="#000"
        testID="banner"
        actionLabel="실행"
        actionTestID="banner-action"
        onActionPress={() => {}}
        actionAccessibilityLabel="자세한 실행"
        actionAccessibilityHint="동작 시작"
      >
        <Text>info</Text>
      </ActionBanner>,
    );
    const action = getByTestId('banner-action');
    expect(action.props.accessibilityRole).toBe('button');
    expect(action.props.accessibilityLabel).toBe('자세한 실행');
    expect(action.props.accessibilityHint).toBe('동작 시작');

    rerender(
      <ActionBanner
        accent="#000"
        testID="banner"
        actionLabel="실행"
        actionTestID="banner-action"
        onActionPress={() => {}}
      >
        <Text>info</Text>
      </ActionBanner>,
    );
    const action2 = getByTestId('banner-action');
    expect(action2.props.accessibilityLabel).toBe('실행');
    expect(action2.props.accessibilityHint).toBeUndefined();
  });
});
