import { planTransferReselect } from '../journeyTimeline';
import type { Route } from '../stationRoute';
import { makeDirectRoute } from '../../../testUtils/routeFixtures';

// #1480 PR-E — backend 환승 대기 재선택 재료. 실측 기준: trip 179 건대입구(7→2) 06:34:21 도착(수요일 평일).
const kstMs = (h: number, mi: number, s = 0): number => Date.UTC(2026, 9, 28, h, mi, s) - 9 * 3_600_000;

// 건대입구(7) 앵커 경로: 이미 건대입구에 있으므로 환승 주행 0, 남은 2호선 210초.
const atTransfer: NonNullable<Route> = {
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

describe('planTransferReselect', () => {
  it('도보+buffer(278+30) 이후 시간표 다음 출발 K=6개를 오름차순으로 낸다 (06:39:29 이후: 0641 0647 0656 0700 0706 0711)', () => {
    const plan = planTransferReselect(atTransfer, kstMs(6, 34, 21))!;
    expect(plan.walkSeconds).toBe(308);
    expect(plan.departuresEpochMs.map((ms) => ms / 1000)).toEqual([
      1793137260, 1793137620, 1793138160, 1793138400, 1793138760, 1793139060,
    ]);
    expect(plan.rideSeconds).toBe(210);
  });

  it('같은 분 열차는 한 번만 센다 (분 해상도 시간표)', () => {
    const { departuresEpochMs } = planTransferReselect(atTransfer, kstMs(6, 34, 21))!;
    expect(new Set(departuresEpochMs).size).toBe(departuresEpochMs.length);
  });

  it('환승 도보를 이미 마친(대기만 남은) 환승은 walkSeconds 0 — 도착 시각부터 출발을 고른다', () => {
    const waiting: NonNullable<Route> = { ...atTransfer, completedTransfers: 1, transferWaitPending: true };
    const plan = planTransferReselect(waiting, kstMs(6, 34, 21))!;
    expect(plan.walkSeconds).toBe(0);
    // 06:34:21 이후 첫 2호선 down 출발은 도보 가산이 없으니 0641보다 이르거나 같다.
    expect(plan.departuresEpochMs[0]).toBeLessThanOrEqual(1793137260 * 1000);
    expect(plan.rideSeconds).toBe(210);
  });

  it('거부: 환승이 없는 direct 경로는 null', () => {
    expect(planTransferReselect(makeDirectRoute(5, '2'), kstMs(6, 34, 21))).toBeNull();
  });

  it('거부: 환승이 모두 완료돼 남은 대기가 없으면 null', () => {
    const done: NonNullable<Route> = { ...atTransfer, completedTransfers: 1 };
    expect(planTransferReselect(done, kstMs(6, 34, 21))).toBeNull();
  });
});
