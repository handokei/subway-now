import { fireEvent } from '@testing-library/react-native';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { OnboardingSplash1 } from '../OnboardingSplash1';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('OnboardingSplash1', () => {
  it('renders with testID', () => {
    const { getByTestId } = renderWithTheme(
      <OnboardingSplash1 onNext={jest.fn()} onSkip={jest.fn()} />,
    );
    expect(getByTestId('onboarding-splash1')).toBeTruthy();
  });

  it('calls onNext when next button is pressed', () => {
    const onNext = jest.fn();
    const { getByTestId } = renderWithTheme(
      <OnboardingSplash1 onNext={onNext} onSkip={jest.fn()} />,
    );
    fireEvent.press(getByTestId('onboarding-splash1-next'));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('calls onSkip when skip is pressed', () => {
    const onSkip = jest.fn();
    const { getByTestId } = renderWithTheme(
      <OnboardingSplash1 onNext={jest.fn()} onSkip={onSkip} />,
    );
    fireEvent.press(getByTestId('onboarding-splash1-skip'));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});
