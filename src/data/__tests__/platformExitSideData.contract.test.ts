/**
 * #3129 — 하차문 방향 데이터 계약.
 *   - platformExitSide.json: 'both' 금지, 항목마다 출처 등급, 성수 등 불일치 역은 키 없음.
 *   - platformExitSideByDirection.json: 인용 URL이 있는 비공식(wiki) 방향별 항목만.
 */
import platformExitSide from '../platformExitSide.json';
import byDirection from '../platformExitSideByDirection.json';
import stations from '../stations.json';

type Entry = { side: string; grade: string };
const SIDES = ['left', 'right'];
const stationIds = new Set(stations.map((s) => s.id));

describe('platformExitSide.json 계약', () => {
  const entries = Object.entries(platformExitSide as Record<string, Entry>);

  it('비어 있지 않고 모든 id는 stations.json에 존재한다', () => {
    expect(entries.length).toBeGreaterThan(100);
    for (const [id] of entries) expect(stationIds.has(id)).toBe(true);
  });

  it("side는 left/right뿐이며 'both'는 없다", () => {
    for (const [, { side }] of entries) expect(SIDES).toContain(side);
    expect(JSON.stringify(platformExitSide)).not.toContain('both');
  });

  it('모든 항목은 official-derived 또는 wiki-crosschecked 등급', () => {
    for (const [, { grade }] of entries) {
      expect(['official-derived', 'wiki-crosschecked']).toContain(grade);
    }
  });

  it('공식 두 CSV가 불일치하는 성수(2-011)·신도림(2-034)은 키가 없다', () => {
    const map = platformExitSide as Record<string, Entry>;
    expect(map['2-011']).toBeUndefined();
    expect(map['2-034']).toBeUndefined();
  });

  it('1호선(1-*)은 서울교통공사 구간 1-025~1-034 10역만 키를 가진다 (코레일 구간 없음)', () => {
    const ids = entries.filter(([id]) => id.startsWith('1-')).map(([id]) => id).sort();
    expect(ids).toEqual([
      '1-025', '1-026', '1-027', '1-028', '1-029', '1-030', '1-031', '1-032', '1-033', '1-034',
    ]);
  });
});

describe('platformExitSideByDirection.json 계약', () => {
  type Dir = {
    up: string;
    down: string;
    grade: string;
    sourceUrl: string;
    note: string;
    terminating?: { up?: string; down?: string };
  };
  const entries = Object.entries(byDirection as Record<string, Dir>);

  it('새절(6-007)과 수락산(7-003)이 시드로 들어 있다', () => {
    const ids = entries.map(([id]) => id);
    expect(ids).toEqual(expect.arrayContaining(['6-007', '7-003']));
  });

  it('성수(2-011) 본선은 나무위키 문장 근거로 up/down 모두 right', () => {
    const entry = (byDirection as Record<string, Dir>)['2-011'];
    expect(entry.up).toBe('right');
    expect(entry.down).toBe('right');
    expect(entry.sourceUrl).toMatch(/^https:\/\/namu\.wiki\//);
  });

  it('성수 외선(down) 당역 종착은 left, 내선(up)은 종착 값 없음', () => {
    const entry = (byDirection as Record<string, Dir>)['2-011'];
    expect(entry.terminating).toEqual({ down: 'left' });
  });

  it('terminating 값은 left/right뿐이다', () => {
    for (const [, entry] of entries) {
      for (const side of Object.values(entry.terminating ?? {})) expect(SIDES).toContain(side);
    }
  });

  it('문장 근거 없는 방화·강동·성수지선·1호선은 키가 없다(unknown)', () => {
    const map = byDirection as Record<string, Dir>;
    for (const id of ['5-001', '5-039']) expect(map[id]).toBeUndefined();
    expect(Object.keys(map).filter((id) => id.startsWith('1-'))).toEqual([]);
  });

  it("어떤 하차문 데이터에도 'both'는 없다", () => {
    expect(JSON.stringify(byDirection)).not.toContain('both');
  });

  it('항목마다 stations.json id, left/right, wiki 등급, 인용 URL, 메모를 가진다', () => {
    for (const [id, entry] of entries) {
      expect(stationIds.has(id)).toBe(true);
      expect(SIDES).toContain(entry.up);
      expect(SIDES).toContain(entry.down);
      expect(entry.grade).toBe('wiki');
      expect(entry.sourceUrl).toMatch(/^https:\/\/(ko\.wikipedia\.org|namu\.wiki)\/(wiki|w)\//);
      expect(entry.note.length).toBeGreaterThan(0);
    }
  });
});

describe('platformExitSide.json — 9호선 wiki-crosschecked (#3177 PR-1)', () => {
  const map = platformExitSide as Record<string, Entry>;

  it.each([
    ['9-001', 'left'], // 개화 섬식
    ['9-003', 'right'], // 공항시장 상대식
    ['9-013', 'left'], // 당산 섬식
    ['9-023', 'right'], // 고속터미널 상대식
    ['9-037', 'left'], // 둔촌오륜 섬식
  ])('%s → %s, grade wiki-crosschecked', (id, side) => {
    expect(map[id]).toEqual({ side, grade: 'wiki-crosschecked' });
  });

  it.each(['9-002', '9-005', '9-007', '9-012', '9-025', '9-034', '9-038'])(
    '%s(복합/급행 4선/3선)은 키가 없다',
    (id) => {
      expect(map[id]).toBeUndefined();
    },
  );

  it('wiki-crosschecked 항목은 9호선뿐이며 26건이다', () => {
    const wiki = Object.entries(map).filter(([, { grade }]) => grade === 'wiki-crosschecked');
    expect(wiki).toHaveLength(26);
    for (const [id] of wiki) expect(id.startsWith('9-')).toBe(true);
  });
});
