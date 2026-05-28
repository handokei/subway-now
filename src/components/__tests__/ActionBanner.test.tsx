import { Text } from 'react-native';
import { fireEvent } from '@testing-library/react-native';
import { ActionBanner } from '../ActionBanner';
import { renderWithTheme } from '../../testUtils/renderWithTheme';

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
});
