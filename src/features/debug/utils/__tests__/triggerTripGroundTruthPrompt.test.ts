/**
 * Trip ground truth trigger (#1502 M2, #1597 fix).
 *
 * #1597 — 호출자가 corrId를 명시적으로 캡처해서 전달하도록 signature 변경. trip-start
 * 경로에서 false fire되는 회귀(setTripCorrId가 sync cache를 덮어쓴 뒤 cleanup chain이 돌아
 * 새 corrId로 enqueue됨)를 근본 차단.
 */
import { triggerTripGroundTruthPrompt } from '../triggerTripGroundTruthPrompt';
import { useTripGroundTruthStore } from '../../store/useTripGroundTruthStore';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn().mockResolvedValue(null),
  setItem: jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
}));

describe('triggerTripGroundTruthPrompt (#1502 M2 / #1597)', () => {
  beforeEach(() => {
    useTripGroundTruthStore.setState({
      hydrated: true,
      pendingPrompt: null,
      responses: [],
    });
  });

  it('corrId가 null이면 prompt enqueue X (graceful skip)', async () => {
    await triggerTripGroundTruthPrompt(null);
    expect(useTripGroundTruthStore.getState().pendingPrompt).toBeNull();
  });

  it('corrId가 있으면 enqueue', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(12345);
    await triggerTripGroundTruthPrompt('trip-abc');
    expect(useTripGroundTruthStore.getState().pendingPrompt).toEqual({
      corrId: 'trip-abc',
      endedAt: 12345,
    });
  });

  it('#1597 — 호출자가 캡처한 snapshot이 그대로 enqueue된다 (cache mutation과 무관)', async () => {
    // setDestination switch 경로에서 setTripCorrId(new)가 동기적으로 sync cache를 덮어써도
    // 호출자가 미리 snapshot을 캡처해서 넘기면 그 값이 보존된다 (read 시점 race 차단).
    jest.spyOn(Date, 'now').mockReturnValue(99999);
    const snapshot = 'prev-trip-corr-id';
    // snapshot 캡처 후 다른 corrId로 cache가 바뀐 상황을 시뮬레이션해도 (본 함수는 sync cache를
    // 더 이상 읽지 않으므로) snapshot 값이 그대로 사용된다.
    await triggerTripGroundTruthPrompt(snapshot);
    expect(useTripGroundTruthStore.getState().pendingPrompt?.corrId).toBe(snapshot);
  });
});
