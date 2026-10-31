/* eslint-disable import/no-restricted-paths --
 * Cross-feature test: route(journeyAdapter) → arrival(EditorialTimeline) 사슬 whole 검증.
 */
import React from 'react';
import { screen } from '@testing-library/react-native';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';
import { EditorialTimeline } from '../EditorialTimeline';
import { journeyDisplayToStops } from '../../../route/utils/journeyAdapter';
import { buildJourneyDisplay, findRoute } from '../../../../shared/utils/stationRoute';
import type { Route } from '../../../../shared/utils/stationRoute';
import type { LineNumber, Station } from '../../../../shared/types/station';
import type { Stop } from '../../../../shared/types/journey';
import stationsData from '../../../../data/stations.json';

// #3258 — 10/28 trip 179(용마산(7)→건대입구→뚝섬(2)) 전체 역 보기 표시 표.
// 실데이터(transferExit/quickExit) 사용 — 건대입구 7→2 석남행 1-1, 뚝섬 하차 빠른 칸 2-4.
const all = stationsData as Station[];
const pick = (name: string, line: LineNumber) =>
  all.find((s) => s.name === canonicalStationName(name, line) && s.line === line)!;
const N = canonicalStationName;

const YONGMASAN = pick('용마산', '7');
const TTUKSEOM = pick('뚝섬', '2');
const KONDAE_2 = pick('건대입구', '2');
const CHILDRENS_PARK = pick('어린이대공원', '7');

interface Row {
  station: string;
  note: string | null;
  door: string | null;
  doorNote: string | null;
  chip: string | null;
}

function text(testID: string | RegExp): string | null {
  const el = screen.queryByTestId(testID);
  if (!el) return null;
  const { children } = el.props;
  return Array.isArray(children) ? children.join('') : String(children);
}

function table(stops: Stop[]): Row[] {
  renderWithTheme(<EditorialTimeline stops={stops} />);
  return stops.map((s, i) => ({
    station: s.station,
    note: text(`timeline-note-${i}`),
    door: text(new RegExp(`^boarding-door-${i}-`)),
    doorNote: text(`boarding-door-note-${i}`),
    chip: text(`timeline-segment-${i}`),
  }));
}

function trip179Route(): Route {
  return findRoute(YONGMASAN.id, TTUKSEOM.id);
}

describe('#3258 전체 역 보기 — 환승 노드 정거장·탑승 칸 표시 표 (trip 179)', () => {
  const expectedBefore: Row[] = [
    { station: N('용마산', '7'), note: null, door: '탑승 1-1번 문', doorNote: `${N('건대입구', '7')} 환승 빠른 칸`, chip: '7호선 4정거장' },
    { station: N('건대입구', '7'), note: '7호선 → 2호선 환승', door: '탑승 2-4번 문', doorNote: `${N('뚝섬', '2')}에서 나가기 빠른 칸`, chip: '2호선 2정거장' },
    { station: N('뚝섬', '2'), note: '도착', door: null, doorNote: null, chip: null },
  ];

  it('환승 전: 출발=환승 빠른 칸 / 환승 노드=환승 문구+다음 하차 칸 / 도착=칸 없음 / 구간 칩', () => {
    const route = trip179Route();
    const journey = buildJourneyDisplay(route, YONGMASAN, TTUKSEOM)!;
    const stops = journeyDisplayToStops(journey);
    // 환승 노드에 이전 구간 정거장 수가 붙지 않는다.
    expect(stops.every((s) => !('stopsFromPrev' in s))).toBe(true);
    expect(table(stops)).toEqual(expectedBefore);
    expect(screen.queryByTestId(/^quick-exit-door-/)).toBeNull();
  });

  it('환승 후(접힘): 출발=2호선 탑승 칸, 도착 칸 없음, 중복 0', () => {
    const route = trip179Route();
    if (route?.type !== 'transfer') throw new Error('fixture: transfer route expected');
    const progressed: Route = { ...route, stopsToTransfer: 0 };
    const journey = buildJourneyDisplay(progressed, KONDAE_2, TTUKSEOM)!;
    const rows = table(journeyDisplayToStops(journey));
    expect(rows).toEqual([
      { station: N('건대입구', '2'), note: null, door: '탑승 2-4번 문', doorNote: `${N('뚝섬', '2')}에서 나가기 빠른 칸`, chip: '2호선 2정거장' },
      { station: N('뚝섬', '2'), note: '도착', door: null, doorNote: null, chip: null },
    ]);
    expect(screen.getAllByText(/2-4번 문/)).toHaveLength(1);
  });

  it('어린이대공원 재마운트(route는 현재역 기준 재계산, 출발역 이름은 tripOrigin 고정): 여전히 7호선 4정거장', () => {
    const remounted = findRoute(CHILDRENS_PARK.id, TTUKSEOM.id);
    expect(remounted?.type).toBe('transfer');
    const journey = buildJourneyDisplay(remounted, YONGMASAN, TTUKSEOM)!;
    expect(table(journeyDisplayToStops(journey))).toEqual(expectedBefore);
  });

  it('어린이대공원 재마운트 + 펼침: 중간역 3개 유지(7호선 구간)', () => {
    const remounted = findRoute(CHILDRENS_PARK.id, TTUKSEOM.id);
    const journey = buildJourneyDisplay(remounted, YONGMASAN, TTUKSEOM)!;
    const stops = journeyDisplayToStops(journey, { expanded: true });
    const firstTransferIdx = stops.findIndex((s) => s.mark === 'transfer');
    expect(stops.slice(0, firstTransferIdx).filter((s) => s.mark === 'intermediate')).toHaveLength(3);
  });
});

describe('#3258 다중 환승 / 직통 회귀', () => {
  it('다중 환승: 환승 노드마다 "from → to 환승" + 구간 칩, 마지막 노드 칩 없음', () => {
    const stops = journeyDisplayToStops({
      segments: [
        { line: '6', lineColor: '#CD7C2F', fromName: '효창공원앞', toName: '공덕', stops: 1 },
        { line: '5', lineColor: '#996CAC', fromName: '공덕', toName: '군자', stops: 12 },
        { line: '7', lineColor: '#747F00', fromName: '군자', toName: '건대입구', stops: 3 },
      ],
      totalStops: 16,
    });
    const rows = table(stops);
    expect(rows.map((r) => r.chip)).toEqual(['6호선 1정거장', '5호선 12정거장', '7호선 3정거장', null]);
    expect(rows.map((r) => r.note)).toEqual([null, '6호선 → 5호선 환승', '5호선 → 7호선 환승', '도착']);
  });

  it('직통(환승 없음): 출발 칩 "2호선 1정거장", 도착 노드에 칸·정거장 문구 없음', () => {
    const stops = journeyDisplayToStops({
      segments: [{ line: '2', lineColor: '#00A84D', fromName: '강남', toName: '역삼', stops: 1 }],
      totalStops: 1,
    });
    const rows = table(stops);
    expect(rows[0].chip).toBe('2호선 1정거장');
    expect(rows[1]).toEqual({ station: '역삼', note: '도착', door: null, doorNote: null, chip: null });
    expect(screen.queryByText('1정거장')).toBeNull();
  });
});
