import { lookupDirectionalExitSide, lookupPlatformExitSide } from '../platformExitSideLookup';

// 데이터 자체는 build-platform-exit-side 스크립트가 결정하므로
// helper 단위 테스트는 mock 데이터로 lookup 동작만 검증한다 (#3129: 항목은 { side, grade }).
jest.mock('../../../data/platformExitSide.json', () => ({
  '2-008': { side: 'right', grade: 'official-derived' },
  '5-035': { side: 'left', grade: 'official-derived' },
}));

describe('lookupPlatformExitSide', () => {
  it.each([
    ['2-008', 'right'],
    ['5-035', 'left'],
  ] as const)('등록된 id %s는 %s를 반환한다', (id, expected) => {
    expect(lookupPlatformExitSide(id)).toBe(expected);
  });

  it('등록되지 않은 id(불일치·복합·종착 포함 null 역)는 null을 반환한다', () => {
    expect(lookupPlatformExitSide('2-011')).toBeNull();
    expect(lookupPlatformExitSide('9-001')).toBeNull();
    expect(lookupPlatformExitSide('')).toBeNull();
  });
});

// 방향별(wiki) 항목 — 실데이터 그대로 조회한다(mock 없음: 데이터 계약을 소비자 경로에서 고정).
// 반환: null = 항목 없음(구조 fallback으로), { side: null } = 항목은 있으나 이 열차는 단정 불가(문 라인 생략).
describe('lookupDirectionalExitSide', () => {
  it.each([
    ['2-011', 'up', 'unknown', 'right'],
    ['2-011', 'down', 'elsewhere', 'right'],
    ['2-011', 'up', 'elsewhere', 'right'],
    ['2-011', 'down', 'here', 'left'],
    ['6-007', 'up', 'unknown', 'right'],
    ['6-007', 'down', 'unknown', 'left'],
    ['7-003', 'up', 'elsewhere', 'right'],
    ['7-003', 'down', 'elsewhere', 'left'],
  ] as const)('%s %s (종착 %s)는 %s', (id, direction, terminus, expected) => {
    expect(lookupDirectionalExitSide(id, direction, terminus)).toEqual({ side: expected });
  });

  it('종착 override가 있는 방향은 종착 여부를 모르면 단정하지 않는다(side null)', () => {
    expect(lookupDirectionalExitSide('2-011', 'down', 'unknown')).toEqual({ side: null });
  });

  it('당역 종착인데 종착 값이 없는 방향은 단정하지 않는다(side null)', () => {
    expect(lookupDirectionalExitSide('2-011', 'up', 'here')).toEqual({ side: null });
    expect(lookupDirectionalExitSide('6-007', 'up', 'here')).toEqual({ side: null });
  });

  it.each(['5-001', '5-039', '7-042', '9-001', ''])('문장 근거가 없는 id %s는 null', (id) => {
    expect(lookupDirectionalExitSide(id, 'up', 'unknown')).toBeNull();
    expect(lookupDirectionalExitSide(id, 'down', 'here')).toBeNull();
  });
});
