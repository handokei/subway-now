import { lookupPlatformExitSide } from '../platformExitSideLookup';

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
