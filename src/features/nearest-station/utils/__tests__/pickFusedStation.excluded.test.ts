/**
 * #3191 PR-1(A) - pickFusedStation `excluded`('off-arc') 규칙.
 *
 * 규칙(스펙): candidate.excluded가 있으면 arrival/position 두 신호 모두 점수 0(fail-closed).
 * 제외 전 점수>0이었던 신호는 onExcludedDrop으로 후보·종류당 1회 보고한다.
 * 모든 후보가 0이면 기존 규칙대로 candidates[0] gps-only.
 */
import { pickFusedStation, type ExcludedCandidateDrop } from '../pickFusedStation';
import { findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import { makeTrain } from '../../../../testUtils/positionApiFixtures';
import { TRAIN_STATUS } from '../../../../shared/constants/trainStatus';
import type { ArrivalInfo, StationArrival } from '../../../../shared/types/arrival';

const yongmasan = findStationByNameAndLine('용마산', '7')!;
const sagajeong = findStationByNameAndLine('사가정', '7')!;
const NOW = 1_700_000_000_000;

function info(arrivalCode: number): ArrivalInfo {
  return {
    destination: '',
    arrivalSeconds: 60,
    stopsAway: null,
    statusMessage: '',
    trainCode: 'A',
    line: '7',
    receivedAtMs: NOW,
    arrivalCode,
    isLastTrain: false,
    trainType: 'normal',
  } as ArrivalInfo;
}

const cand = (station: typeof yongmasan, distanceKm = 0) => ({ station, distanceKm });
const ARRIVED_DOWN: StationArrival = { up: [], down: [info(1)] };

describe('pickFusedStation excluded (#3191 PR-1 A)', () => {
  it('excluded 후보의 arrival 100점은 점수에서 빠져 GPS 최근접이 결과가 된다 + 사유 보고', () => {
    const drops: ExcludedCandidateDrop[] = [];
    const r = pickFusedStation(
      [
        { candidate: cand(yongmasan) },
        { candidate: cand(sagajeong, 0.79), arrival: ARRIVED_DOWN, excluded: 'off-arc' },
      ],
      undefined,
      undefined,
      (d) => drops.push(d),
    );
    expect(r?.result.station.id).toBe(yongmasan.id);
    expect(r?.source).toBe('gps');
    expect(drops).toEqual([{ reason: 'off-arc', kind: 'arrival', stationName: '사가정', line: '7' }]);
  });

  it('excluded 후보의 position 점수도 빠지고 position 종류로 보고된다', () => {
    const drops: ExcludedCandidateDrop[] = [];
    const r = pickFusedStation(
      [
        { candidate: cand(yongmasan) },
        {
          candidate: cand(sagajeong, 0.79),
          positionMatches: [makeTrain('사가정', TRAIN_STATUS.ARRIVED, { updnLine: 1 })],
          excluded: 'off-arc',
        },
      ],
      undefined,
      undefined,
      (d) => drops.push(d),
    );
    expect(r?.result.station.id).toBe(yongmasan.id);
    expect(drops.map((d) => d.kind)).toEqual(['position']);
  });

  it('거부 케이스: excluded가 없으면 같은 신호가 이긴다(현행)', () => {
    const r = pickFusedStation([
      { candidate: cand(yongmasan) },
      { candidate: cand(sagajeong, 0.79), arrival: ARRIVED_DOWN },
    ]);
    expect(r?.result.station.id).toBe(sagajeong.id);
  });

  it('excluded 후보에 점수>0 신호가 없으면 보고하지 않는다', () => {
    const drops: ExcludedCandidateDrop[] = [];
    pickFusedStation(
      [{ candidate: cand(yongmasan) }, { candidate: cand(sagajeong, 0.79), excluded: 'off-arc' }],
      undefined,
      undefined,
      (d) => drops.push(d),
    );
    expect(drops).toEqual([]);
  });

  it('콜백 미전달이어도 제외는 적용된다', () => {
    const r = pickFusedStation([
      { candidate: cand(yongmasan) },
      { candidate: cand(sagajeong, 0.79), arrival: ARRIVED_DOWN, excluded: 'off-arc' },
    ]);
    expect(r?.result.station.id).toBe(yongmasan.id);
  });

  it('on-arc 후보 신호는 같은 호출에서 그대로 이긴다(제외는 해당 후보만)', () => {
    const junggok = findStationByNameAndLine('중곡', '7')!;
    const r = pickFusedStation([
      { candidate: cand(yongmasan) },
      { candidate: cand(sagajeong, 0.79), arrival: ARRIVED_DOWN, excluded: 'off-arc' },
      { candidate: cand(junggok, 0.9), arrival: ARRIVED_DOWN },
    ]);
    expect(r?.result.station.id).toBe(junggok.id);
    expect(r?.source).toBe('arrival');
  });
});
