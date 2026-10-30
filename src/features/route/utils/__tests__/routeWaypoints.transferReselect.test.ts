import { routeToWaypoints } from '../routeWaypoints';
import { findRoutes, findStationByNameAndLine } from '../../../../shared/utils/stationRoute';

// #1480 PR-E (B2) — 환승 waypoint에 backend가 push마다 대기를 재선택할 재료를 stamp한다.
// 값은 10/28 trip 179 실측 등록 시각 기준(중곡 출발 06:28:51 KST, 수요일 평일). backend replay가 같은 의미를 소비한다.
describe('routeToWaypoints — 환승 대기 재선택 재료 (#1480 PR-E)', () => {
  const origin = findStationByNameAndLine('중곡', '7');
  const dest = findStationByNameAndLine('뚝섬', '2');
  const REGISTERED_AT_MS = Date.UTC(2026, 9, 28, 6, 28, 51) - 9 * 3_600_000;
  const wps = () => {
    const route = findRoutes(origin!.id, dest!.id)[0].route!;
    return routeToWaypoints(route, '뚝섬', origin!, REGISTERED_AT_MS);
  };

  it('trip 179 건대입구: 해당 방향 시간표 다음 출발 K=6개(epoch 초, 오름차순) + 도보+buffer(278+30) + 대기 제외 주행(210)', () => {
    const transfer = wps().find((w) => w.kind === 'transfer')!;
    expect(transfer.nextLegDeparturesEpochSec).toEqual([
      1793137260, 1793137620, 1793138160, 1793138400, 1793138760, 1793139060,
    ]);
    expect(transfer.transferWalkSec).toBe(308);
    expect(transfer.rideSecToDest).toBe(210);
  });

  it('구 필드 remainingSecToDest는 그대로 유지된다 (하위호환)', () => {
    const transfer = wps().find((w) => w.kind === 'transfer')!;
    expect(transfer.remainingSecToDest).toBe(600);
  });

  it('환승이 아닌 waypoint(intermediate/destination)에는 새 필드가 없다', () => {
    for (const w of wps().filter((x) => x.kind !== 'transfer')) {
      expect(w).not.toHaveProperty('nextLegDeparturesEpochSec');
      expect(w).not.toHaveProperty('transferWalkSec');
      expect(w).not.toHaveProperty('rideSecToDest');
    }
  });

  // 교대(3) → 신논현(9): 고속터미널에서 9호선으로 갈아타는 환승.
  const line9TransferWaypoint = (
    toWaypoints: typeof routeToWaypoints,
    find: typeof findRoutes,
    lookup: typeof findStationByNameAndLine,
  ) => {
    const from = lookup('교대', '3')!;
    const to = lookup('신논현', '9')!;
    const route = find(from.id, to.id)
      .map((r) => r.route!)
      .find((r) => r.type === 'transfer')!;
    return toWaypoints(route, '신논현', from, REGISTERED_AT_MS).find((w) => w.kind === 'transfer')!;
  };

  it('9호선 환승도 시간표 극성 원천 수정(#3247) 후에는 재선택 재료를 낸다', () => {
    const transfer = line9TransferWaypoint(routeToWaypoints, findRoutes, findStationByNameAndLine);
    expect(transfer.nextLegDeparturesEpochSec).toHaveLength(6);
    expect(transfer.rideSecToDest).toEqual(expect.any(Number));
  });

  it('거부: 시간표 극성 불일치 노선으로 갈아타는 환승은 새 필드를 내지 않는다 (backend는 remainingSecToDest 폴백)', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../../shared/constants/timetableDirection', () => ({
        ...jest.requireActual('../../../../shared/constants/timetableDirection'),
        TIMETABLE_DIRECTION_MISMATCH_LINES: ['9'],
      }));
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { routeToWaypoints: isolatedToWaypoints } = require('../routeWaypoints');
      const isolatedRoute = require('../../../../shared/utils/stationRoute');
      /* eslint-enable @typescript-eslint/no-require-imports */
      const transfer = line9TransferWaypoint(
        isolatedToWaypoints,
        isolatedRoute.findRoutes,
        isolatedRoute.findStationByNameAndLine,
      );
      expect(transfer).not.toHaveProperty('nextLegDeparturesEpochSec');
      expect(transfer).not.toHaveProperty('rideSecToDest');
    });
  });
});
