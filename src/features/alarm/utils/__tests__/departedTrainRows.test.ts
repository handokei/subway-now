import { buildDepartedTrainRows } from '../departedTrainRows';
import type { AnchorDeparturesView } from '../../api/anchorDepartures';

// trip 171 실측: 2011이 건대입구(2호선)를 06:36:28에 출발. 이후 탭 시점 목록에 이 열차가 있어야 했다.
const DEPARTED_AT = new Date(2026, 9, 20, 6, 36, 28).getTime();
const NOW = DEPARTED_AT + 90_000;
const SLOT = { stationName: '건대입구', line: '2' as const };

function view(overrides: Partial<AnchorDeparturesView> = {}): AnchorDeparturesView {
  return {
    station: '건대입구',
    line: '2',
    departed: [{ trainCode: '2011', departedAt: DEPARTED_AT, currentStation: '성수' }],
    ...overrides,
  };
}

describe('buildDepartedTrainRows (#3155)', () => {
  it('171 실측 형태: 2011 → 탭 가능한 ArrivalInfo(line/trainCode) + 출발 시각 + 지금 역', () => {
    const rows = buildDepartedTrainRows(view(), SLOT, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ departedAtMs: DEPARTED_AT, currentStation: '성수' });
    expect(rows[0].train).toMatchObject({ trainCode: '2011', line: '2', arrivalSeconds: null, arrivalCode: 2 });
  });

  it('최근 출발 순으로 정렬한다', () => {
    const rows = buildDepartedTrainRows(
      view({
        departed: [
          { trainCode: '2005', departedAt: DEPARTED_AT - 240_000, currentStation: null },
          { trainCode: '2011', departedAt: DEPARTED_AT, currentStation: null },
          { trainCode: '2007', departedAt: DEPARTED_AT - 120_000, currentStation: null },
        ],
      }),
      SLOT,
      NOW,
    );
    expect(rows.map((r) => r.train.trainCode)).toEqual(['2011', '2007', '2005']);
  });

  it('10분을 넘긴 출발은 (오래된 캐시여도) 표시하지 않는다', () => {
    const rows = buildDepartedTrainRows(view(), SLOT, DEPARTED_AT + 10 * 60_000 + 1);
    expect(rows).toEqual([]);
  });

  it('이 목록의 역/노선과 backend 앵커가 다르면 표시하지 않는다 (환승 슬롯 vs 출발 슬롯 혼동 방지)', () => {
    expect(buildDepartedTrainRows(view(), { stationName: '용마산', line: '7' }, NOW)).toEqual([]);
    expect(buildDepartedTrainRows(view(), { stationName: '건대입구', line: '7' }, NOW)).toEqual([]);
  });

  it('필드 부재(null view)는 빈 배열 — 섹션 없음', () => {
    expect(buildDepartedTrainRows(null, SLOT, NOW)).toEqual([]);
  });
});
