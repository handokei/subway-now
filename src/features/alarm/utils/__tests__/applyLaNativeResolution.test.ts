/**
 * #3055 PR-1 — `applyLaNativeResolution` (plan v6 §3.3, R10).
 *
 * native LA 버튼 POST가 이미 받은 backend 해소(resolvedTrainCode)를 기기 lock에 반영하는 4행 표:
 *   lock 없음 → 실 lock 생성(선언된 변경) / PENDING → 교체 안 함 + 관측 로그 /
 *   실 lock 동일 → no-op / 실 lock 상이 → 교체 안 함 + 관측 로그.
 * 스펙(plan 표)만 보고 작성 — 구현 내부를 모사하지 않는다.
 */
import { applyLaNativeResolution } from '../applyLaNativeResolution';
import { useBoardingLockStore } from '../../store/useBoardingLockStore';
import { PENDING_TRAIN_CODE } from '../../../../shared/constants/boardingLock';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

const mockLogInfo = jest.fn();
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: (...a: unknown[]) => mockLogInfo(...a),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));
jest.mock('../../../../shared/utils/stationLookup', () => ({ findStationByNameAndLine: jest.fn() }));
jest.mock('../widgetRefreshContext', () => ({ readWidgetRefreshContext: jest.fn() }));
jest.mock('../alarmLog', () => ({ logBoardingPromptResponded: jest.fn() }));
const mockSetInfoMode = jest.fn(() => Promise.resolve());
jest.mock('../../store/useUserIntentStore', () => ({
  useUserIntentStore: { getState: () => ({ setInfoModeEnabled: mockSetInfoMode }) },
}));
const mockResumeNavigation = jest.fn();
jest.mock('../../store/tripBoundCleanups', () => ({ resumeNavigation: () => mockResumeNavigation() }));

const { findStationByNameAndLine } = jest.requireMock('../../../../shared/utils/stationLookup');
const { readWidgetRefreshContext } = jest.requireMock('../widgetRefreshContext');
const { logBoardingPromptResponded } = jest.requireMock('../alarmLog');

const INTENT = { originStation: '건대입구', line: '7' };
const STATION = { id: 'S-kondae', line: '7', name: '건대입구' };

function makeDeps(over: Partial<{ destinationId: string | null }> = {}) {
  return {
    createLock: jest.fn(async () => undefined),
    destinationId: 'dst' as string | null,
    expectedDurationMs: 30 * 60_000,
    ...over,
  };
}

const BASE_LOCK: BoardingLock = {
  destinationId: 'dst',
  trainCode: '7320',
  boardingStationId: STATION.id,
  boardingLine: '7',
  boardedAt: 1_000,
  expectedDurationMs: 600_000,
  boardingEvidence: true,
};

describe('applyLaNativeResolution (#3055 R10)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useBoardingLockStore.setState({ lock: null });
    findStationByNameAndLine.mockReturnValue(STATION);
    readWidgetRefreshContext.mockResolvedValue({ destination: null, route: null, bgContext: null });
  });

  it('행1: lock 부재 → 실 lock 생성(evidence=true, lifecycle source la-native-response) + 명시 의향 stamp', async () => {
    const deps = makeDeps();
    const result = await applyLaNativeResolution(INTENT, '7320', deps);
    expect(result).toBe('created');
    expect(deps.createLock).toHaveBeenCalledTimes(1);
    expect(deps.createLock).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationId: 'dst',
        trainCode: '7320',
        boardingStationId: STATION.id,
        boardingLine: '7',
        expectedDurationMs: 30 * 60_000,
      }),
      true,
      'la-native-response',
    );
    // 알림 [탑승] 경로(handleResponse)와 같은 명시 의향 stamp — 이 경로는 handleResponse를 타지 않는다.
    expect(mockSetInfoMode).toHaveBeenCalledWith(true);
    expect(mockResumeNavigation).toHaveBeenCalledTimes(1);
    expect(logBoardingPromptResponded).toHaveBeenCalledWith({ outcome: 'boarded' });
  });

  it('행1: deps.destinationId가 null이면 저장된 목적지(widget context)로 생성', async () => {
    readWidgetRefreshContext.mockResolvedValue({ destination: { id: 'dst-stored' }, route: null, bgContext: null });
    const deps = makeDeps({ destinationId: null });
    expect(await applyLaNativeResolution(INTENT, '7320', deps)).toBe('created');
    expect(deps.createLock).toHaveBeenCalledWith(
      expect.objectContaining({ destinationId: 'dst-stored' }),
      true,
      'la-native-response',
    );
  });

  it('[거부] 행1: 목적지가 어디에도 없으면 생성하지 않는다(autolock-no-trip과 동일)', async () => {
    const deps = makeDeps({ destinationId: null });
    expect(await applyLaNativeResolution(INTENT, '7320', deps)).toBe('skipped-no-trip');
    expect(deps.createLock).not.toHaveBeenCalled();
    expect(mockSetInfoMode).not.toHaveBeenCalled();
  });

  it.each([
    ['유효하지 않은 노선', { originStation: '건대입구', line: 'not-a-line' }, STATION],
    ['역 매칭 실패', INTENT, null],
  ])('[거부] 행1: %s → 생성하지 않는다', async (_label, intent, station) => {
    findStationByNameAndLine.mockReturnValue(station);
    const deps = makeDeps();
    expect(await applyLaNativeResolution(intent, '7320', deps)).toBe('skipped-station');
    expect(deps.createLock).not.toHaveBeenCalled();
  });

  it('행1: createLock 예외는 흡수한다(throw 금지)', async () => {
    const deps = makeDeps();
    deps.createLock.mockRejectedValue(new Error('storage'));
    await expect(applyLaNativeResolution(INTENT, '7320', deps)).resolves.toBe('failed');
  });

  it('행2: store lock이 PENDING → 교체하지 않고 foreign pending 관측 로그', async () => {
    useBoardingLockStore.setState({ lock: { ...BASE_LOCK, trainCode: PENDING_TRAIN_CODE } });
    const deps = makeDeps();
    expect(await applyLaNativeResolution(INTENT, '7320', deps)).toBe('ignored-pending');
    expect(deps.createLock).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(expect.stringContaining('la-native-response ignored: foreign pending'));
  });

  it('행3: 실 lock이 열차·역·노선 동일 → no-op(로그 없음)', async () => {
    useBoardingLockStore.setState({ lock: BASE_LOCK });
    const deps = makeDeps();
    expect(await applyLaNativeResolution(INTENT, '7320', deps)).toBe('noop-same');
    expect(deps.createLock).not.toHaveBeenCalled();
    expect(mockLogInfo).not.toHaveBeenCalled();
  });

  it.each([
    ['열차', { trainCode: 'T9' }],
    ['역', { boardingStationId: 'S-other' }],
    ['노선', { boardingLine: '2' as const }],
  ])('행4: 실 lock이 %s만 달라도 교체하지 않고 관측 로그', async (_label, diff) => {
    useBoardingLockStore.setState({ lock: { ...BASE_LOCK, ...diff } });
    const deps = makeDeps();
    expect(await applyLaNativeResolution(INTENT, '7320', deps)).toBe('ignored-other');
    expect(deps.createLock).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(expect.stringContaining('la-native-response ignored: real lock differs'));
  });
});
