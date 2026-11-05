import { renderHook, act } from '@testing-library/react-native';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { useOnboardingPermissions } from '../useOnboardingPermissions';

jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: jest.fn(),
}));

jest.mock('expo-notifications', () => ({
  requestPermissionsAsync: jest.fn(),
}));

const mockRequestLocation = Location.requestForegroundPermissionsAsync as jest.Mock;
const mockRequestNotification = Notifications.requestPermissionsAsync as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequestLocation.mockResolvedValue({ status: 'granted' });
  mockRequestNotification.mockResolvedValue({ status: 'granted' });
});

describe('useOnboardingPermissions', () => {
  it('starts with step="idle"', () => {
    const { result } = renderHook(() => useOnboardingPermissions());
    expect(result.current.step).toBe('idle');
  });

  it('goes through all steps and ends at "done" when both permissions granted', async () => {
    const { result } = renderHook(() => useOnboardingPermissions());

    await act(async () => {
      await result.current.requestPermissionsSequentially();
    });

    expect(result.current.step).toBe('done');
    expect(mockRequestLocation).toHaveBeenCalledTimes(1);
    expect(mockRequestNotification).toHaveBeenCalledTimes(1);
  });

  it('continues to "done" when location permission is denied', async () => {
    mockRequestLocation.mockResolvedValue({ status: 'denied' });
    const { result } = renderHook(() => useOnboardingPermissions());

    await act(async () => {
      await result.current.requestPermissionsSequentially();
    });

    expect(result.current.step).toBe('done');
    expect(mockRequestNotification).toHaveBeenCalledTimes(1);
  });

  it('continues to "done" when notification permission is denied', async () => {
    mockRequestNotification.mockResolvedValue({ status: 'denied' });
    const { result } = renderHook(() => useOnboardingPermissions());

    await act(async () => {
      await result.current.requestPermissionsSequentially();
    });

    expect(result.current.step).toBe('done');
  });

  it('continues gracefully when location request throws', async () => {
    mockRequestLocation.mockRejectedValue(new Error('location error'));
    const { result } = renderHook(() => useOnboardingPermissions());

    await act(async () => {
      await result.current.requestPermissionsSequentially();
    });

    expect(result.current.step).toBe('done');
    expect(mockRequestNotification).toHaveBeenCalledTimes(1);
  });

  it('continues gracefully when notification request throws', async () => {
    mockRequestNotification.mockRejectedValue(new Error('notification error'));
    const { result } = renderHook(() => useOnboardingPermissions());

    await act(async () => {
      await result.current.requestPermissionsSequentially();
    });

    expect(result.current.step).toBe('done');
  });
});
