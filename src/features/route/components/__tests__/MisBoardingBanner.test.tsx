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
});
