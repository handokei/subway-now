/**
 * Trip ground truth trigger (#1502 M2, #1597 fix).
 *
 * #1597 — 호출자가 corrId를 명시적으로 캡처해서 전달하도록 signature 변경. trip-start
 * 경로에서 false fire되는 회귀(setTripCorrId가 sync cache를 덮어쓴 뒤 cleanup chain이 돌아
 * 새 corrId로 enqueue됨)를 근본 차단.
 */
import { triggerTripGroundTruthPrompt } from '../triggerTripGroundTruthPrompt';
import { useTripGroundTruthStore } from '../../store/useTripGroundTruthStore';
import {
  logFiredAlarm,
  _resetAccurateDestinationFireForTests,
} from '../../../alarm/utils/alarmLog';

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
    _resetAccurateDestinationFireForTests();
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

  // #2309 — 07:46:09 destination imminent 발사(정확) → 3초 뒤 사용자 안내 종료 시 정답지
  // 확정 창이 완료되지 못해 miss로 self-report되던 회귀. imminent fire는 fusion arrival-confirmed
  // 신호이므로 trip 종료 즉시 수동 응답 없이 accurate로 확정돼야 한다.
  it('#2309 — destination imminent 발사 직후(3초 내) user-delete 시 accurate로 즉시 확정, modal(prompt) 미노출', async () => {
    jest.spyOn(Date, 'now').mockReturnValueOnce(1000); // fire 시각
    logFiredAlarm('fg', { phaseId: 'imminent', type: 'destination', stationName: '뚝섬' }, 'api');

    jest.spyOn(Date, 'now').mockReturnValue(3000); // 3초 뒤 user-delete → trip end
    await triggerTripGroundTruthPrompt('trip-2309');

    const state = useTripGroundTruthStore.getState();
    // 수동 응답 대기 modal이 뜨지 않아야 한다 — pendingPrompt는 null 그대로.
    expect(state.pendingPrompt).toBeNull();
    // 정답지는 이미 accurate 1건으로 확정 — alarmAccuracy(local) 1/1.
    expect(state.responses).toEqual([
      { corrId: 'trip-2309', endedAt: 3000, respondedAt: 3000, outcome: 'accurate' },
    ]);
  });

  it('#2309 — 정확한 발사가 없었던 trip 종료는 기존과 동일하게 수동 prompt enqueue', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(4000);
    await triggerTripGroundTruthPrompt('trip-no-fire');
    const state = useTripGroundTruthStore.getState();
    expect(state.pendingPrompt).toEqual({ corrId: 'trip-no-fire', endedAt: 4000 });
    expect(state.responses).toEqual([]);
  });

  it('#2309 — destination 이외 kind(transfer) imminent 발사는 auto-confirm 대상 아님', async () => {
    jest.spyOn(Date, 'now').mockReturnValueOnce(1000);
    logFiredAlarm('fg', { phaseId: 'imminent', type: 'transfer', stationName: '건대입구' }, 'api');
    jest.spyOn(Date, 'now').mockReturnValue(2000);
    await triggerTripGroundTruthPrompt('trip-transfer-only');
    expect(useTripGroundTruthStore.getState().pendingPrompt).toEqual({
      corrId: 'trip-transfer-only',
      endedAt: 2000,
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
