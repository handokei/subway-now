import { fireEvent } from '@testing-library/react-native';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { OnboardingSplash2 } from '../OnboardingSplash2';
import type { PermissionStep } from '../../hooks/useOnboardingPermissions';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('OnboardingSplash2', () => {
  const defaultProps = {
    step: 'idle' as PermissionStep,
    onGrantPermissions: jest.fn(),
    onSkip: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders with testID', () => {
    const { getByTestId } = renderWithTheme(<OnboardingSplash2 {...defaultProps} />);
    expect(getByTestId('onboarding-splash2')).toBeTruthy();
  });

  it('calls onGrantPermissions when grant button is pressed (idle step)', () => {
    const onGrantPermissions = jest.fn();
    const { getByTestId } = renderWithTheme(
      <OnboardingSplash2 {...defaultProps} onGrantPermissions={onGrantPermissions} />,
    );
    fireEvent.press(getByTestId('onboarding-splash2-grant'));
    expect(onGrantPermissions).toHaveBeenCalledTimes(1);
  });

  it('disables grant button while requesting-location', () => {
    const onGrantPermissions = jest.fn();
    const { getByTestId } = renderWithTheme(
      <OnboardingSplash2
        {...defaultProps}
        step="requesting-location"
        onGrantPermissions={onGrantPermissions}
      />,
    );
    fireEvent.press(getByTestId('onboarding-splash2-grant'));
    expect(onGrantPermissions).not.toHaveBeenCalled();
  });

  it('disables grant button while requesting-notification', () => {
    const onGrantPermissions = jest.fn();
    const { getByTestId } = renderWithTheme(
      <OnboardingSplash2
        {...defaultProps}
        step="requesting-notification"
        onGrantPermissions={onGrantPermissions}
      />,
    );
    fireEvent.press(getByTestId('onboarding-splash2-grant'));
    expect(onGrantPermissions).not.toHaveBeenCalled();
  });

  it('calls onSkip when skip is pressed', () => {
    const onSkip = jest.fn();
    const { getByTestId } = renderWithTheme(
      <OnboardingSplash2 {...defaultProps} onSkip={onSkip} />,
    );
    fireEvent.press(getByTestId('onboarding-splash2-skip'));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('is enabled when step is "done"', () => {
    const onGrantPermissions = jest.fn();
    const { getByTestId } = renderWithTheme(
      <OnboardingSplash2
        {...defaultProps}
        step="done"
        onGrantPermissions={onGrantPermissions}
      />,
    );
    fireEvent.press(getByTestId('onboarding-splash2-grant'));
    expect(onGrantPermissions).toHaveBeenCalledTimes(1);
  });
});
