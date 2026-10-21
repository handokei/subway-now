/**
 * #3129 — 하차문 방향 데이터 계약.
 *   - platformExitSide.json: 'both' 금지, 항목마다 출처 등급, 성수 등 불일치 역은 키 없음.
 *   - platformExitSideByDirection.json: 인용 URL이 있는 비공식(wiki) 방향별 항목만.
 */
import platformExitSide from '../platformExitSide.json';
import byDirection from '../platformExitSideByDirection.json';
import exitSideByName from '../exitSide.json';
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

  it('모든 항목은 official-derived 등급', () => {
    for (const [, { grade }] of entries) expect(grade).toBe('official-derived');
  });

  it('공식 두 CSV가 불일치하는 성수(2-011)·신도림(2-034)은 키가 없다', () => {
    const map = platformExitSide as Record<string, Entry>;
    expect(map['2-011']).toBeUndefined();
    expect(map['2-034']).toBeUndefined();
  });

  it('주행방향 미검증 1호선(1-*)은 키가 없다', () => {
    expect(entries.filter(([id]) => id.startsWith('1-'))).toEqual([]);
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

  it('문장 근거 없는 방화·강동·온수·성수지선·1호선은 키가 없다(unknown)', () => {
    const map = byDirection as Record<string, Dir>;
    for (const id of ['5-001', '5-039', '7-042']) expect(map[id]).toBeUndefined();
    expect(Object.keys(map).filter((id) => id.startsWith('1-'))).toEqual([]);
  });

  it("어떤 하차문 데이터에도 'both'는 없다", () => {
    expect(JSON.stringify(byDirection)).not.toContain('both');
    expect(JSON.stringify(exitSideByName)).not.toContain('both');
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
