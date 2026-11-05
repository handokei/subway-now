import { computeJourneyEta } from '../journeyTimeline';
import { makeTransferRoute } from '../../../testUtils/routeFixtures';

// #1480 — 운행 시간 안인데 배차간격 데이터가 없으면(closed 아님) 하한 + waitUnknown ("N분+").
jest.mock('../lineHeadway', () => ({
  ...jest.requireActual('../lineHeadway'),
  lookupHeadwaySeconds: () => null,
}));

describe('배차간격 데이터 누락(운행 시간 안) → floor', () => {
  it('정오에 headway가 null이면 막차 종료가 아니라 하한 + waitUnknown', () => {
    const route = makeTransferRoute({
      transferName: '홍대입구',
      fromLine: '2',
      toLine: 'gyeongui',
      stopsToTransfer: 2,
      stopsFromTransfer: 3,
    });
    const nowMs = Date.UTC(2026, 9, 28, 3, 0, 0); // 수요일 12:00 KST
    const eta = computeJourneyEta({ route, nowMs, excludeOriginWait: true });
    expect(eta.waits[0]).toMatchObject({ source: 'floor', seconds: 60 });
    expect(eta.waitUnknown).toBe(true);
    expect(eta.lastTrainEnded).toBe(false);
  });
});
