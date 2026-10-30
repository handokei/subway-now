/**
 * #3221 — 기기 여정 LA 필드(남은 시간·진행 막대·다음 역). 입력은 10/28 실측 trip 179/180과 같은 route.
 * backend `computeLegProgressContext`/`computeNextStopContext`와의 parity는 backend
 * `journeyLaFields.deviceParity.test.ts`가 강제한다.
 */
import { LINE_COLORS, LINE_NAMES } from '../../../../shared/constants/lineColors';
import type { LineNumber } from '../../../../shared/types/station';
import { findRoutes, findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';
import { computeJourneyLaFields } from '../journeyLaFields';

function station(name: string, line: LineNumber) {
  const found = findStationByNameAndLine(name, line);
  if (!found) throw new Error(`fixture station missing: ${name}`);
  return found;
}

function routeOf(type: string, from: [string, LineNumber], to: [string, LineNumber]) {
  const candidate = findRoutes(station(...from).id, station(...to).id).find((c) => c.route.type === type);
  if (!candidate) throw new Error(`fixture route missing: ${type}`);
  return candidate.route;
}

describe('computeJourneyLaFields (#3221)', () => {
  const route179 = routeOf('transfer', ['용마산', '7'], ['뚝섬', '2']);
  const destination179 = station('뚝섬', '2');

  it('trip 179 출발 전 용마산: 목적지까지 시간 + leg1 진행 막대 + 다음 역/환승 후 노선·방면', () => {
    const fields = computeJourneyLaFields(route179, station('용마산', '7'), destination179);
    expect(fields).toEqual({
      etaMinutes: expect.any(Number),
      nextStationName: '중곡',
      legStopsTotal: 4,
      nextLegStopsTotal: 2,
      nextLineColorHex: LINE_COLORS['2'],
      nextLineName: LINE_NAMES['2'],
      nextLineDirection: '성수',
    });
    expect(fields.etaMinutes).toBeGreaterThan(0);
  });

  it('trip 179 진행 중(원본 route로 호출해도 leg 전체 정거장 수는 유지, 다음 역은 현재역 기준)', () => {
    const fields = computeJourneyLaFields(route179, station('군자(능동)', '7'), destination179);
    expect(fields.legStopsTotal).toBe(4);
    expect(fields.nextStationName).toBe('어린이대공원(세종대)');
    expect(fields.nextLineDirection).toBe('성수');
  });

  it('trip 179 환승 후 성수(2호선): 현재 leg=2호선 2역, 다음 leg·환승 필드 생략', () => {
    const fields = computeJourneyLaFields(route179, station('성수', '2'), destination179);
    expect(fields).toEqual({
      etaMinutes: expect.any(Number),
      nextStationName: '뚝섬',
      legStopsTotal: 2,
    });
  });

  it('direct route: legStopsTotal=stops, 환승·다음 leg 필드 없음', () => {
    const fields = computeJourneyLaFields(makeDirectRoute(7, '2'), station('교대', '2'), station('강남', '2'));
    expect(fields.legStopsTotal).toBe(7);
    expect(fields.nextLegStopsTotal).toBeUndefined();
    expect(fields.nextLineName).toBeUndefined();
    expect(fields.nextLineDirection).toBeUndefined();
    expect(fields.nextLineColorHex).toBeUndefined();
    expect(fields.nextStationName).toBe('강남');
  });

  it('multi-transfer: leg 0/1에서 각각 현재 leg 정거장 수·다음 leg 수·다음 노선색', () => {
    const route = routeOf('multi-transfer', ['인천', '1'], ['수서', '3']);
    if (route?.type !== 'multi-transfer') throw new Error('unreachable');
    const [first, second] = route.transfers;
    const dest = station('수서', '3');

    const atOrigin = computeJourneyLaFields(route, station('인천', '1'), dest);
    expect(atOrigin.legStopsTotal).toBe(first.stopsToTransfer);
    expect(atOrigin.nextLegStopsTotal).toBe(second.stopsToTransfer);
    expect(atOrigin.nextLineColorHex).toBe(LINE_COLORS[first.toLine]);
    expect(atOrigin.nextLineName).toBe(LINE_NAMES[first.toLine]);

    const afterFirst = computeJourneyLaFields(route, station(first.transferName, first.toLine), dest);
    expect(afterFirst.legStopsTotal).toBe(second.stopsToTransfer);
    expect(afterFirst.nextLegStopsTotal).toBe(route.stopsAfterLastTransfer);
    expect(afterFirst.nextLineColorHex).toBe(LINE_COLORS[second.toLine]);
  });

  it('route 없음: 아무 필드도 산출하지 않는다(위젯 폴백 유지)', () => {
    expect(computeJourneyLaFields(null, station('용마산', '7'), destination179)).toEqual({});
  });
});
