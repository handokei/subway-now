/**
 * #3191 PR-2D — pickFusedStation 방향 필터.
 *
 * 규칙(스펙): candidate.direction이 'up'|'down'이면 arrival은 해당 방향 리스트만, position은
 * updnLine === (up?0:1)만 점수에 넣는다(-1 제외). direction===null(route 있는데 방향 미해결)이면 점수 0
 * (fail-closed). direction===undefined(route 없음)이면 현행 그대로.
 */
import { pickFusedStation } from '../pickFusedStation';
import { findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import { makeTrain } from '../../../../testUtils/positionApiFixtures';
import { TRAIN_STATUS } from '../../../../shared/constants/trainStatus';
import type { ArrivalInfo, StationArrival } from '../../../../shared/types/arrival';

const yongmasan = findStationByNameAndLine('용마산', '7')!;
const junggok = findStationByNameAndLine('중곡', '7')!;
const NOW = 1_700_000_000_000;

function info(arrivalCode: number, overrides?: Partial<ArrivalInfo>): ArrivalInfo {
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
    ...overrides,
  } as ArrivalInfo;
}

const cand = (station: typeof yongmasan, distanceKm = 0) => ({ station, distanceKm });

describe('pickFusedStation direction (#3191 PR-2D)', () => {
  const OPPOSITE_UP_100 = [makeTrain('중곡', TRAIN_STATUS.ARRIVED, { trainNo: '7012', updnLine: 0 })];
  const SAME_DOWN_80 = [makeTrain('용마산', TRAIN_STATUS.ENTERING, { trainNo: '7035', updnLine: 1 })];

  it('position: 반대 방향(updn 0) 100점은 direction=down 후보 점수에서 빠져 같은 방향 80점 후보가 이긴다', () => {
    const r = pickFusedStation([
      { candidate: cand(yongmasan), positionMatches: SAME_DOWN_80, direction: 'down' },
      { candidate: cand(junggok, 0.9), positionMatches: OPPOSITE_UP_100, direction: 'down' },
    ]);
    expect(r?.result.station.id).toBe(yongmasan.id);
    expect(r?.source).toBe('position');
  });

  it('direction 미지정(route 없음)이면 현행 — 반대 방향 100점이 이긴다', () => {
    const r = pickFusedStation([
      { candidate: cand(yongmasan), positionMatches: SAME_DOWN_80 },
      { candidate: cand(junggok, 0.9), positionMatches: OPPOSITE_UP_100 },
    ]);
    expect(r?.result.station.id).toBe(junggok.id);
  });

  it('arrival: direction=down이면 up 리스트의 100점은 무시된다', () => {
    const arrival: StationArrival = { up: [info(1)], down: [] };
    const r = pickFusedStation([{ candidate: cand(yongmasan), arrival, direction: 'down' }]);
    expect(r?.source).toBe('gps');
  });

  it('arrival: direction=up이면 up 리스트 점수를 쓴다', () => {
    const arrival: StationArrival = { up: [info(1)], down: [] };
    const r = pickFusedStation([{ candidate: cand(yongmasan), arrival, direction: 'up' }]);
    expect(r?.source).toBe('arrival');
  });

  it('fail-closed: direction=null이면 모든 신호 점수가 0 → GPS 최근접', () => {
    const r = pickFusedStation([
      { candidate: cand(yongmasan) },
      {
        candidate: cand(junggok, 0.9),
        positionMatches: OPPOSITE_UP_100,
        arrival: { up: [info(1)], down: [info(1)] },
        direction: null,
      },
    ]);
    expect(r?.result.station.id).toBe(yongmasan.id);
    expect(r?.source).toBe('gps');
  });

  it('updnLine -1(파싱 실패) position은 방향 지정 시 제외된다', () => {
    const r = pickFusedStation([
      {
        candidate: cand(junggok),
        positionMatches: [makeTrain('중곡', TRAIN_STATUS.ARRIVED, { updnLine: -1 })],
        direction: 'down',
      },
    ]);
    expect(r?.source).toBe('gps');
  });

  it('관측: 점수>0 반대 방향 항목이 빠질 때만 후보·종류당 1건 콜백, 0점 항목은 무콜백', () => {
    const drops: unknown[] = [];
    pickFusedStation(
      [
        {
          candidate: cand(junggok, 0.9),
          positionMatches: [
            ...OPPOSITE_UP_100,
            makeTrain('중곡', TRAIN_STATUS.ARRIVED, { trainNo: '7013', updnLine: 0 }),
          ],
          arrival: { up: [info(1), info(0)], down: [] },
          direction: 'down',
        },
        {
          candidate: cand(yongmasan),
          positionMatches: [makeTrain('용마산', TRAIN_STATUS.ARRIVED, { updnLine: 0, receivedAtMs: 0 })],
          arrival: { up: [info(99)], down: [] },
          direction: 'down',
        },
      ],
      undefined,
      (d) => drops.push(d),
    );
    expect(drops).toEqual([
      { kind: 'position', stationName: '중곡', line: '7' },
      { kind: 'arrival', stationName: '중곡', line: '7' },
    ]);
  });

  it('방향 지정이어도 신호 자체가 null이면(미호출/실패) 현행처럼 GPS 최근접', () => {
    const r = pickFusedStation([
      { candidate: cand(yongmasan), arrival: null, positionMatches: null, direction: 'up' },
    ]);
    expect(r?.source).toBe('gps');
  });

  it('콜백 미지정이어도 반대 방향 신호를 안전하게 제외한다', () => {
    const r = pickFusedStation([
      { candidate: cand(junggok), positionMatches: OPPOSITE_UP_100, arrival: { up: [info(1)], down: [] }, direction: 'down' },
    ]);
    expect(r?.source).toBe('gps');
  });
});
