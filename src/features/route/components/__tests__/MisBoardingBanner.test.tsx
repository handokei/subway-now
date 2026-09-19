import { fireEvent } from '@testing-library/react-native';
import { MisBoardingBanner } from '../MisBoardingBanner';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';

describe('MisBoardingBanner', () => {
  it('경고 라벨과 재선택 버튼을 렌더', () => {
    const { getByTestId, getByText } = renderWithTheme(
      <MisBoardingBanner onReselect={() => {}} />,
    );
    expect(getByTestId('mis-boarding-banner')).toBeTruthy();
    expect(getByText('탑승 열차 미확인')).toBeTruthy();
    expect(getByText('재선택')).toBeTruthy();
  });

  it('재선택 버튼 탭 시 onReselect 호출', () => {
    const onReselect = jest.fn();
    const { getByTestId } = renderWithTheme(
      <MisBoardingBanner onReselect={onReselect} />,
    );
    fireEvent.press(getByTestId('mis-boarding-reselect'));
    expect(onReselect).toHaveBeenCalledTimes(1);
  });

  it('a11y: 배너에 alert role + liveRegion, 재선택 버튼에 라벨/힌트 부착(#1077 후속)', () => {
    const { getByTestId } = renderWithTheme(<MisBoardingBanner onReselect={() => {}} />);
    const banner = getByTestId('mis-boarding-banner');
    expect(banner.props.accessibilityRole).toBe('alert');
    expect(banner.props.accessibilityLiveRegion).toBe('polite');
    expect(banner.props.accessibilityLabel).toBe(
      '탑승 열차를 확인할 수 없습니다. 다시 선택하세요.',
    );

    const action = getByTestId('mis-boarding-reselect');
    expect(action.props.accessibilityRole).toBe('button');
    expect(action.props.accessibilityLabel).toBe('탑승 열차 재선택');
    expect(action.props.accessibilityHint).toBe('탑승 열차 선택 화면을 다시 엽니다');
  });

  // 반대 방향 탑승 감지 (#2455, Phase B) — 기존 absent copy와 구분되는 별도 라벨/본문.
  it('reason="wrong-direction" → 반대 방향 경고 copy 렌더', () => {
    const { getByTestId, getByText } = renderWithTheme(
      <MisBoardingBanner onReselect={() => {}} reason="wrong-direction" />,
    );
    expect(getByTestId('mis-boarding-banner')).toBeTruthy();
    expect(getByText('반대 방향으로 가고 있어요')).toBeTruthy();
    expect(
      getByText('반대 방향으로 가고 계신 것 같아요. 다음 역에서 내려 반대편에서 타세요.'),
    ).toBeTruthy();
  });

  it('reason="wrong-direction" → a11y 라벨도 반대 방향 전용 copy', () => {
    const { getByTestId } = renderWithTheme(
      <MisBoardingBanner onReselect={() => {}} reason="wrong-direction" />,
    );
    const banner = getByTestId('mis-boarding-banner');
    expect(banner.props.accessibilityLabel).toBe(
      '반대 방향으로 가고 계신 것 같아요. 다시 선택하세요.',
    );
  });
});
