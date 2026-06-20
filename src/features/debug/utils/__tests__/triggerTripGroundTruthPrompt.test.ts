/**
 * Trip ground truth trigger (#1502 M2) — TRIP_BOUND_CLEANUPS 호출 시점에 corrId 캡처 검증.
 */
import { triggerTripGroundTruthPrompt } from '../triggerTripGroundTruthPrompt';
import { useTripGroundTruthStore } from '../../store/useTripGroundTruthStore';
import * as tripCorrId from '../../../observability/utils/tripCorrId';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn().mockResolvedValue(null),
  setItem: jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
}));

describe('triggerTripGroundTruthPrompt (#1502 M2)', () => {
  beforeEach(() => {
    useTripGroundTruthStore.setState({
      hydrated: true,
      pendingPrompt: null,
      responses: [],
    });
  });

  it('corrId가 null이면 prompt enqueue X (graceful skip)', async () => {
    jest.spyOn(tripCorrId, 'getCurrentTripCorrIdSync').mockReturnValue(null);
    await triggerTripGroundTruthPrompt();
    expect(useTripGroundTruthStore.getState().pendingPrompt).toBeNull();
  });

  it('corrId가 있으면 동기 캡처 후 enqueue', async () => {
    jest.spyOn(tripCorrId, 'getCurrentTripCorrIdSync').mockReturnValue('trip-abc');
    jest.spyOn(Date, 'now').mockReturnValue(12345);
    await triggerTripGroundTruthPrompt();
    expect(useTripGroundTruthStore.getState().pendingPrompt).toEqual({
      corrId: 'trip-abc',
      endedAt: 12345,
    });
  });

  it('clearTripCorrId가 같은 batch에서 cache를 비워도 트리거가 먼저 호출되면 corrId 캡처 보존', async () => {
    // 시뮬레이션: triggerTripGroundTruthPrompt 첫 줄이 sync read하므로
    // 이후 clearTripCorrId가 실행돼도 캡처값은 유지된다.
    jest.spyOn(tripCorrId, 'getCurrentTripCorrIdSync').mockReturnValue('trip-xyz');
    const triggerPromise = triggerTripGroundTruthPrompt();
    // trigger 호출 시점 직후 cache를 비워본다.
    jest.spyOn(tripCorrId, 'getCurrentTripCorrIdSync').mockReturnValue(null);
    await triggerPromise;
    expect(useTripGroundTruthStore.getState().pendingPrompt?.corrId).toBe('trip-xyz');
  });
});
