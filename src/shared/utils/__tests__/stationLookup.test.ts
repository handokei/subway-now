import {
  findLineByStationName,
  findStationByName,
  findStationByNameAndLine,
} from '../stationLookup';

jest.mock('../../../data/stations.json', () => [
  { id: '1-001', name: '서울역', line: '1', lineColor: '#0052A4', lat: 37.5547, lng: 126.9706 },
  { id: '4-001', name: '서울역', line: '4', lineColor: '#00A5DE', lat: 37.5547, lng: 126.9706 },
  { id: '2-001', name: '강남', line: '2', lineColor: '#00A84D', lat: 37.4979, lng: 127.0276 },
  // #1397: 정식 표기(괄호 부제 포함)역 — canonical fallback 검증용
  { id: '7-020', name: '자양(뚝섬한강공원)', line: '7', lineColor: '#747F00', lat: 37.531, lng: 127.066 },
]);

describe('findLineByStationName', () => {
  it('returns the line of the first matching station', () => {
    expect(findLineByStationName('강남')).toBe('2');
  });

  it('returns the first registered line for transfer stations', () => {
    expect(findLineByStationName('서울역')).toBe('1');
  });

  it('returns null for unknown station names', () => {
    expect(findLineByStationName('없는역')).toBeNull();
  });

  it('#1397: 정식명에 괄호 부제가 있어도 base 이름으로 lookup 성공', () => {
    expect(findLineByStationName('자양')).toBe('7');
  });

  it('#1397: 옛 이름(뚝섬유원지)도 alias로 정식명에 fallback', () => {
    expect(findLineByStationName('뚝섬유원지')).toBe('7');
  });
});

describe('findStationByName', () => {
  it('역명으로 첫 매칭 Station(좌표 포함) 반환', () => {
    const result = findStationByName('강남');
    expect(result).toMatchObject({ id: '2-001', name: '강남', lat: 37.4979, lng: 127.0276 });
  });

  it('환승역은 등록 순서상 첫 호선 반환', () => {
    const result = findStationByName('서울역');
    expect(result?.line).toBe('1');
  });

  it('없는 역명은 null', () => {
    expect(findStationByName('없는역')).toBeNull();
  });

  it('#1397: base 이름(자양)으로 정식명(자양(뚝섬한강공원)) 매칭', () => {
    const result = findStationByName('자양');
    expect(result?.id).toBe('7-020');
    expect(result?.name).toBe('자양(뚝섬한강공원)');
  });

  it('#1397: 옛 이름(뚝섬유원지) → alias → canonical → 정식명 매칭', () => {
    const result = findStationByName('뚝섬유원지');
    expect(result?.id).toBe('7-020');
  });
});

describe('findStationByNameAndLine (#707)', () => {
  it('환승역에서 line 일치하는 Station 반환', () => {
    expect(findStationByNameAndLine('서울역', '1')).toMatchObject({ id: '1-001', line: '1' });
    expect(findStationByNameAndLine('서울역', '4')).toMatchObject({ id: '4-001', line: '4' });
  });

  it('역명은 있지만 해당 line에는 정차하지 않으면 null', () => {
    // 강남은 line 2에만 등록 — line 1로 조회하면 null.
    expect(findStationByNameAndLine('강남', '1')).toBeNull();
  });

  it('없는 역명은 null', () => {
    expect(findStationByNameAndLine('없는역', '2')).toBeNull();
  });

  it('#1405: base 이름(자양) + line=7 → 정식명(자양(뚝섬한강공원)) canonical fallback 매칭', () => {
    const result = findStationByNameAndLine('자양', '7');
    expect(result?.id).toBe('7-020');
    expect(result?.name).toBe('자양(뚝섬한강공원)');
  });

  it('#1405: 옛 boardingLock(뚝섬유원지) + line=7 → alias → canonical → 정식명 매칭', () => {
    const result = findStationByNameAndLine('뚝섬유원지', '7');
    expect(result?.id).toBe('7-020');
  });

  it('#1405: canonical 매칭되어도 line 불일치면 null (호선 정확성 유지)', () => {
    // 뚝섬유원지는 alias로 자양에 매칭되지만, 자양은 7호선만이라 line=2 조회는 null.
    expect(findStationByNameAndLine('뚝섬유원지', '2')).toBeNull();
  });
});
