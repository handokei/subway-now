import { planTransferReselect } from '../journeyTimeline';
import type { Route } from '../stationRoute';
import { findBoardableDeparture } from '../timetableShared';

jest.mock('../timetableShared', () => ({
  ...jest.requireActual('../timetableShared'),
  findBoardableDeparture: jest.fn(),
}));

const lookup = findBoardableDeparture as jest.MockedFunction<typeof findBoardableDeparture>;

// #1480 PR-E — 시간표 조회가 중간에 끊기는 경계(역 miss / 막차 이후 익일 첫차 fallback)에서 재료를 어떻게 자르는가.
const route: NonNullable<Route> = {
  type: 'transfer',
  transferName: '건대입구',
  transferStationId: '7-019',
  destinationStationId: '2-010',
  fromLine: '7',
  toLine: '2',
  stopsToTransfer: 0,
  stopsFromTransfer: 2,
  secondsToTransfer: 0,
  secondsFromTransfer: 210,
};
const AT = Date.UTC(2026, 9, 28, 6, 34, 21) - 9 * 3_600_000;
const departure = (waitSeconds: number, isNextDayFallback = false) =>
  ({ status: 'ok', departure: { departureMinutes: 0, departureLabel: '', waitSeconds, missedCount: 0, isNextDayFallback } }) as const;

describe('planTransferReselect — 시간표 조회 경계', () => {
  beforeEach(() => lookup.mockReset());

  it('거부: 환승역이 시간표에 없으면(station-missing) 재료 없음 -> null', () => {
    lookup.mockReturnValue({ status: 'station-missing' });
    expect(planTransferReselect(route, AT)).toBeNull();
  });

  it('막차 이후 익일 첫차 fallback이 나오면 거기서 수집을 멈춘다 (익일 열차를 이번 여정 후보로 넣지 않는다)', () => {
    lookup.mockReturnValueOnce(departure(60)).mockReturnValueOnce(departure(600, true));
    const plan = planTransferReselect(route, AT)!;
    expect(plan.departuresEpochMs).toEqual([AT + (308 + 60) * 1000]);
  });

  it('첫 조회부터 fallback이면 null (대기를 합산하지 않는 "막차 종료" 상태와 정합)', () => {
    lookup.mockReturnValue(departure(600, true));
    expect(planTransferReselect(route, AT)).toBeNull();
  });
});
