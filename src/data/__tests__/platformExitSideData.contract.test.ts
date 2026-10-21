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
  };
  const entries = Object.entries(byDirection as Record<string, Dir>);

  it('새절(6-007)과 수락산(7-003)이 시드로 들어 있다', () => {
    const ids = entries.map(([id]) => id);
    expect(ids).toEqual(expect.arrayContaining(['6-007', '7-003']));
  });

  it('성수(2-011)는 방향별 근거 문서가 없어 시드에 없다', () => {
    expect((byDirection as Record<string, Dir>)['2-011']).toBeUndefined();
  });

  it('항목마다 stations.json id, left/right, wiki 등급, 인용 URL, 메모를 가진다', () => {
    for (const [id, entry] of entries) {
      expect(stationIds.has(id)).toBe(true);
      expect(SIDES).toContain(entry.up);
      expect(SIDES).toContain(entry.down);
      expect(entry.grade).toBe('wiki');
      expect(entry.sourceUrl).toMatch(/^https:\/\/ko\.wikipedia\.org\/wiki\//);
      expect(entry.note.length).toBeGreaterThan(0);
    }
  });
});
