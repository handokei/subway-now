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
describe('lookupDirectionalExitSide', () => {
  it.each([
    ['2-011', 'up', 'right'],
    ['2-011', 'down', 'right'],
    ['6-007', 'up', 'right'],
    ['6-007', 'down', 'left'],
    ['7-003', 'up', 'right'],
    ['7-003', 'down', 'left'],
  ] as const)('%s %s는 %s', (id, direction, expected) => {
    expect(lookupDirectionalExitSide(id, direction)).toBe(expected);
  });

  it.each(['5-001', '5-039', '7-042', '9-001', ''])('문장 근거가 없는 id %s는 null', (id) => {
    expect(lookupDirectionalExitSide(id, 'up')).toBeNull();
    expect(lookupDirectionalExitSide(id, 'down')).toBeNull();
  });
});
