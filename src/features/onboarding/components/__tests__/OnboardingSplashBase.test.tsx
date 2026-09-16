import { fireEvent } from '@testing-library/react-native';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { OnboardingSplashBase } from '../OnboardingSplashBase';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const baseProps = {
  testID: 'test-splash',
  emoji: '🚇',
  title: 'Splash Title',
  primaryButtonTestID: 'test-splash-primary',
  primaryButtonLabel: 'Action',
  onPrimaryAction: jest.fn(),
  onSkip: jest.fn(),
};

describe('OnboardingSplashBase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders with given testID', () => {
    const { getByTestId } = renderWithTheme(<OnboardingSplashBase {...baseProps} />);
    expect(getByTestId('test-splash')).toBeTruthy();
  });

  it('calls onPrimaryAction when primary button is pressed', () => {
    const onPrimaryAction = jest.fn();
    const { getByTestId } = renderWithTheme(
      <OnboardingSplashBase {...baseProps} onPrimaryAction={onPrimaryAction} />,
    );
    fireEvent.press(getByTestId('test-splash-primary'));
    expect(onPrimaryAction).toHaveBeenCalledTimes(1);
  });

  it('does not call onPrimaryAction when disabled', () => {
    const onPrimaryAction = jest.fn();
    const { getByTestId } = renderWithTheme(
      <OnboardingSplashBase
        {...baseProps}
        primaryButtonDisabled={true}
        onPrimaryAction={onPrimaryAction}
      />,
    );
    fireEvent.press(getByTestId('test-splash-primary'));
    expect(onPrimaryAction).not.toHaveBeenCalled();
  });

  it('calls onSkip when skip is pressed', () => {
    const onSkip = jest.fn();
    const { getByTestId } = renderWithTheme(
      <OnboardingSplashBase {...baseProps} onSkip={onSkip} />,
    );
    fireEvent.press(getByTestId('test-splash-skip'));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('renders children inside content area', () => {
    const { getByText } = renderWithTheme(
      <OnboardingSplashBase {...baseProps}>
        <></>
      </OnboardingSplashBase>,
    );
    expect(getByText('Splash Title')).toBeTruthy();
  });
});
