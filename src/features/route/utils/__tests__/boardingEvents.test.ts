import { computeBoardingEvents } from '../boardingEvents';
import { getStationsOnLine } from '../../../../shared/utils/stationRoute';
import type { LineNumber, Station } from '../../../../shared/types/station';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../../../testUtils/routeFixtures';

function stationById(line: LineNumber, id: string): Station {
  const found = getStationsOnLine(line).find((s) => s.id === id);
  if (!found) throw new Error(`fixture station missing: ${id}`);
  return found;
}

describe('computeBoardingEvents', () => {
  it('direct route → initial 이벤트 1개', () => {
    const origin = stationById('1', '1-001'); // 소요산
    const route = makeDirectRoute(4, '1');

    const events = computeBoardingEvents(route, origin, '지행');

    expect(events).toEqual([
      {
        index: 0,
        kind: 'initial',
        boardingStationId: '1-001',
        boardingStationName: '소요산',
        line: '1',
        directionStationId: '1-002',
        directionStationName: '동두천',
      },
    ]);
  });

  it('direct route: 출발역이 목적지 바로 다음 정거장(1정거장)이어도 방향 산출', () => {
    const origin = stationById('1', '1-001'); // 소요산
    const route = makeDirectRoute(1, '1');

    const events = computeBoardingEvents(route, origin, '동두천');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'initial',
      boardingStationId: '1-001',
      directionStationId: '1-002',
      directionStationName: '동두천',
    });
  });

  it('transfer route(환승 1회) → initial(fromLine) + transfer(toLine) 2개', () => {
    const origin = stationById('1', '1-038'); // 대방
    const route = makeTransferRoute({
      transferName: '신도림',
      fromLine: '1',
      toLine: '2',
      stopsToTransfer: 3,
      stopsFromTransfer: 1,
    });

    const events = computeBoardingEvents(route, origin, '문래');

    expect(events).toEqual([
      {
        index: 0,
        kind: 'initial',
        boardingStationId: '1-038',
        boardingStationName: '대방',
        line: '1',
        directionStationId: '1-039',
        directionStationName: '신길',
      },
      {
        index: 1,
        kind: 'transfer',
        boardingStationId: '2-034',
        boardingStationName: '신도림',
        line: '2',
        directionStationId: '2-035',
        directionStationName: '문래',
      },
    ]);
  });

  it('transfer route: 환승역=목적지(0정거장 leg)여도 transfer 이벤트는 unconditional 생성 — direction은 목적지 자신', () => {
    const origin = stationById('1', '1-038'); // 대방
    const route = makeTransferRoute({
      transferName: '신도림',
      fromLine: '1',
      toLine: '2',
      stopsToTransfer: 3,
      stopsFromTransfer: 0,
    });

    const events = computeBoardingEvents(route, origin, '신도림');

    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      index: 1,
      kind: 'transfer',
      boardingStationId: '2-034',
      boardingStationName: '신도림',
      line: '2',
      directionStationId: '2-034',
      directionStationName: '신도림',
    });
  });

  it('multi-transfer route(환승 2회) → initial + transfer 2개 = 총 3개, transfers 배열 순회로 생성', () => {
    const origin = stationById('1', '1-039'); // 신길
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: '신도림', fromLine: '1', toLine: '2', stopsToTransfer: 2 },
        { transferName: '교대', fromLine: '2', toLine: '3', stopsToTransfer: 11 },
      ],
      stopsAfterLastTransfer: 1,
    });

    const events = computeBoardingEvents(route, origin, '남부터미널(예술의전당)');

    expect(events).toEqual([
      {
        index: 0,
        kind: 'initial',
        boardingStationId: '1-039',
        boardingStationName: '신길',
        line: '1',
        directionStationId: '1-040',
        directionStationName: '영등포',
      },
      {
        index: 1,
        kind: 'transfer',
        boardingStationId: '2-034',
        boardingStationName: '신도림',
        line: '2',
        directionStationId: '2-033',
        directionStationName: '대림(구로구청)',
      },
      {
        index: 2,
        kind: 'transfer',
        boardingStationId: '3-032',
        boardingStationName: '교대',
        line: '3',
        directionStationId: '3-033',
        directionStationName: '남부터미널(예술의전당)',
      },
    ]);
  });

  it('multi-transfer route: transfers 길이가 늘어나도 하드코딩 분기 없이 이벤트 수가 그만큼 늘어난다 (환승 3회)', () => {
    const origin = stationById('1', '1-001'); // 소요산
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: '신도림', fromLine: '1', toLine: '2', stopsToTransfer: 40 },
        { transferName: '교대', fromLine: '2', toLine: '3', stopsToTransfer: 11 },
        { transferName: '양재(서초구청)', fromLine: '3', toLine: '3', stopsToTransfer: 2 },
      ],
      stopsAfterLastTransfer: 1,
    });

    const events = computeBoardingEvents(route, origin, '매봉');

    expect(events).toHaveLength(4);
    expect(events.map((e) => e.kind)).toEqual(['initial', 'transfer', 'transfer', 'transfer']);
    expect(events.map((e) => e.index)).toEqual([0, 1, 2, 3]);
  });

  it('목적지명이 해당 노선에 존재하지 않으면(malformed 입력) directionStation은 boardingStationId로 fallback', () => {
    const origin = stationById('1', '1-001'); // 소요산
    const route = makeDirectRoute(4, '1');

    const events = computeBoardingEvents(route, origin, '존재하지않는역');

    expect(events[0]).toMatchObject({
      boardingStationId: '1-001',
      directionStationId: '1-001',
      directionStationName: '존재하지않는역',
    });
  });

  it('환승역명이 toLine에 존재하지 않으면(malformed route) boardingStationId는 빈 문자열로 fallback', () => {
    const origin = stationById('1', '1-038'); // 대방
    const route = makeTransferRoute({
      transferName: '소요산', // 1호선 역명 — 2호선(toLine)에는 존재하지 않는다.
      fromLine: '1',
      toLine: '2',
      stopsToTransfer: 3,
      stopsFromTransfer: 1,
    });

    const events = computeBoardingEvents(route, origin, '문래');

    expect(events[1]).toMatchObject({
      kind: 'transfer',
      boardingStationId: '',
      boardingStationName: '소요산',
      line: '2',
    });
  });

  it('환승역 표기가 노선별로 다른 경우에도 findStationByNameAndLine 정규화로 boardingStationId를 해석한다', () => {
    const origin = stationById('7', '7-012'); // 상봉(시외버스터미널)
    const route = makeTransferRoute({
      transferName: '상봉',
      fromLine: '7',
      toLine: 'gyeongui',
      stopsToTransfer: 3,
      stopsFromTransfer: 2,
    });

    const events = computeBoardingEvents(route, origin, '망우');

    expect(events[1].boardingStationName).toBe('상봉');
    expect(events[1].line).toBe('gyeongui');
    expect(events[1].boardingStationId).not.toBe('');
  });
});
