import AsyncStorage from '@react-native-async-storage/async-storage';
import { ACTIVE_TRIP_KEY } from '../../../../shared/constants/storageKeys';
import { cleanupBackendConfirmedEndedTrip } from '../tripEndedCleanupSequence';
import { useDestinationStore } from '../../../route/store/useDestinationStore';
import { MOCK_STATIONS } from '../../../../testUtils/fixtures';

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
    useDestinationStore.setState({
      destination: MOCK_STATIONS.gangnam,
      customOrigin: MOCK_STATIONS.chungmuro,
      tripOrigin: MOCK_STATIONS.hyochang,
    });
  });

  // #2419 — runTripBoundCleanups는 storage(DESTINATION_KEY)만 정리하고 in-memory
  // useDestinationStore.destination은 stale로 남는다. cleanupBackendConfirmedEndedTrip은
  // backend가 명시적으로 trip 종료를 확정한 경우에만 호출되므로(caller 계약, 헤더 주석)
  // 뒤이어 새 destination이 set될 일이 없다 — 여기서 memory를 직접 reset해야 stale
  // destination이 lockless trip을 유령 재시작시키는 회귀(#2419)를 막는다.
  it('in-memory destination/customOrigin/tripOrigin을 null로 reset', async () => {
    await cleanupBackendConfirmedEndedTrip(1_700_000_000_000);

    const state = useDestinationStore.getState();
    expect(state.destination).toBeNull();
    expect(state.customOrigin).toBeNull();
    expect(state.tripOrigin).toBeNull();
  });

  it('destination reset은 prompt 이후, sentinel 이전에 발생 (cleanup 순서 유지)', async () => {
    mockTriggerTripGroundTruthPrompt.mockImplementation(async () => {
      // prompt가 아직 실행 중인 시점에는 destination이 아직 살아있어야 한다.
      expect(useDestinationStore.getState().destination).not.toBeNull();
    });
    mockSetTripEndedSentinel.mockImplementation(async () => {
      // sentinel 기록 시점에는 이미 destination이 reset되어 있어야 한다.
      expect(useDestinationStore.getState().destination).toBeNull();
    });

    await cleanupBackendConfirmedEndedTrip(1_700_000_000_000);

    expect(mockTriggerTripGroundTruthPrompt).toHaveBeenCalled();
    expect(mockSetTripEndedSentinel).toHaveBeenCalled();
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
