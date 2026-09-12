import { lookupPlatformExitSide } from '../platformExitSideLookup';
import type { PlatformExitSideMap } from '../../types/platformExitSide';

// 데이터 자체는 build-platform-exit-side 스크립트가 결정하므로
// helper 단위 테스트는 mock 데이터로 lookup 동작만 검증한다.
jest.mock(
  '../../../data/platformExitSide.json',
  () =>
    ({
      '1-034': 'left', // 서울역 (섬식)
      '2-008': 'right', // 왕십리 (상대식)
      '2-009': 'right', // 한양대 (상대식)
      '2-011': 'both', // 성수 (복합식)
      '5-032': 'right', // 마장 (상대식)
      '1-001': 'both', // 소요산 (시종착 override)
    }) satisfies PlatformExitSideMap,
);

describe('lookupPlatformExitSide', () => {
  it.each([
    ['1-034', 'left'],
    ['2-008', 'right'],
    ['2-009', 'right'],
    ['2-011', 'both'],
    ['5-032', 'right'],
  ] as const)('등록된 id %s는 %s를 반환한다', (id, expected) => {
    expect(lookupPlatformExitSide(id)).toBe(expected);
  });

  it('시종착 override가 적용된 역은 both를 반환한다', () => {
    expect(lookupPlatformExitSide('1-001')).toBe('both');
  });

  it('등록되지 않은 id는 null을 반환한다', () => {
    expect(lookupPlatformExitSide('9-001')).toBeNull();
    expect(lookupPlatformExitSide('99-999')).toBeNull();
    expect(lookupPlatformExitSide('')).toBeNull();
  });
});
