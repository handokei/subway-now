import AsyncStorage from '@react-native-async-storage/async-storage';
import { ACTIVE_TRIP_KEY } from '../../../../shared/constants/storageKeys';
import { cleanupBackendConfirmedEndedTrip } from '../tripEndedCleanupSequence';

const mockTriggerTripEndRecall = jest.fn();
jest.mock('../triggerTripEndRecall', () => ({
  triggerTripEndRecall: (...args: unknown[]) => mockTriggerTripEndRecall(...args),
}));

const mockRunTripBoundCleanups = jest.fn();
jest.mock('../../store/tripBoundCleanups', () => ({
  runTripBoundCleanups: (...args: unknown[]) => mockRunTripBoundCleanups(...args),
}));

const mockSetTripEndedSentinel = jest.fn();
jest.mock('../tripEndedSentinel', () => ({
  setTripEndedSentinel: (...args: unknown[]) => mockSetTripEndedSentinel(...args),
}));

const mockGetCurrentTripCorrIdSync = jest.fn<string | null, []>(() => null);
jest.mock('../../../observability/utils/tripCorrId', () => ({
  getCurrentTripCorrIdSync: () => mockGetCurrentTripCorrIdSync(),
}));

const mockTriggerTripGroundTruthPrompt = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../debug/utils/triggerTripGroundTruthPrompt', () => ({
  triggerTripGroundTruthPrompt: (...args: unknown[]) => mockTriggerTripGroundTruthPrompt(...args),
}));

describe('cleanupBackendConfirmedEndedTrip', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockGetCurrentTripCorrIdSync.mockReturnValue(null);
    await AsyncStorage.clear();
  });

  it('5단 시퀀스를 순서대로 호출: recall → cleanup → prompt → sentinel → active trip clear', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockGetCurrentTripCorrIdSync.mockReturnValue('corr-1');

    await cleanupBackendConfirmedEndedTrip(1_700_000_000_000);

    const recallOrder = mockTriggerTripEndRecall.mock.invocationCallOrder[0];
    const cleanupOrder = mockRunTripBoundCleanups.mock.invocationCallOrder[0];
    const promptOrder = mockTriggerTripGroundTruthPrompt.mock.invocationCallOrder[0];
    const sentinelOrder = mockSetTripEndedSentinel.mock.invocationCallOrder[0];

    expect(recallOrder).toBeLessThan(cleanupOrder);
    expect(cleanupOrder).toBeLessThan(promptOrder);
    expect(promptOrder).toBeLessThan(sentinelOrder);
    expect(mockTriggerTripGroundTruthPrompt).toHaveBeenCalledWith('corr-1');
    expect(mockSetTripEndedSentinel).toHaveBeenCalledWith(1_700_000_000_000, 'corr-1');
    expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBeNull();
  });

  it('corrId null(미수화) → prompt/sentinel에 null 그대로 전달', async () => {
    mockGetCurrentTripCorrIdSync.mockReturnValue(null);

    await cleanupBackendConfirmedEndedTrip(42);

    expect(mockTriggerTripGroundTruthPrompt).toHaveBeenCalledWith(null);
    expect(mockSetTripEndedSentinel).toHaveBeenCalledWith(42, null);
  });
});
