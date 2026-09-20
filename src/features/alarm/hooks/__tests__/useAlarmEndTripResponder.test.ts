import { handleAlarmEndTripResponse } from '../useAlarmEndTripResponder';
import { ALARM_ACTION_ACKNOWLEDGE, ALARM_ACTION_END_TRIP } from '../../utils/notificationCategory';

const mockGetTripStartedAt = jest.fn<Promise<number | null>, []>();
jest.mock('../../utils/tripStartStorage', () => ({
  getTripStartedAt: () => mockGetTripStartedAt(),
}));

const mockCleanupUserInitiatedEndedTrip = jest.fn<Promise<void>, [number]>();
jest.mock('../../utils/tripEndedCleanupSequence', () => ({
  cleanupUserInitiatedEndedTrip: (...args: [number]) =>
    mockCleanupUserInitiatedEndedTrip(...args),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// #2722 — 이 파일은 더 이상 `useAlarmEndTripResponder` 훅(자체 listener 등록)을 export하지
// 않는다. 그 등록은 `useBoardingPromptResponder`의 단일 dispatcher로 흡수됐다 — listener wiring
// 검증은 `useBoardingPromptResponder.test.ts`의 "#2722 리스너 단일화" describe가 담당한다.
// 이 파일은 순수 함수 `handleAlarmEndTripResponse`의 분기 로직만 검증한다(로직 변경 없음).
describe('handleAlarmEndTripResponse', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('ALARM_ACTION_END_TRIP 이외의 액션은 무시 (cleanup 미호출)', async () => {
    await handleAlarmEndTripResponse(ALARM_ACTION_ACKNOWLEDGE);
    expect(mockGetTripStartedAt).not.toHaveBeenCalled();
    expect(mockCleanupUserInitiatedEndedTrip).not.toHaveBeenCalled();
  });

  it('$default(배너 탭) 등 임의 문자열도 무시', async () => {
    await handleAlarmEndTripResponse('$default');
    expect(mockCleanupUserInitiatedEndedTrip).not.toHaveBeenCalled();
  });

  it('ALARM_ACTION_END_TRIP + 활성 trip 없음 → no-op (cleanup 미호출)', async () => {
    mockGetTripStartedAt.mockResolvedValue(null);

    await handleAlarmEndTripResponse(ALARM_ACTION_END_TRIP);

    expect(mockGetTripStartedAt).toHaveBeenCalled();
    expect(mockCleanupUserInitiatedEndedTrip).not.toHaveBeenCalled();
  });

  it('ALARM_ACTION_END_TRIP + 활성 trip 있음 → cleanupUserInitiatedEndedTrip 호출', async () => {
    mockGetTripStartedAt.mockResolvedValue(1_700_000_000_000);
    const now = 1_700_000_500_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);

    await handleAlarmEndTripResponse(ALARM_ACTION_END_TRIP);

    expect(mockCleanupUserInitiatedEndedTrip).toHaveBeenCalledWith(now);

    (Date.now as jest.Mock).mockRestore();
  });
});
