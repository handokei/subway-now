import { lookupExitSide } from '../exitSide';
import type { ExitSideMap } from '../../../../shared/types/exitSide';

jest.mock('../../../../data/exitSide.json', () => ({
  강남: { up: 'left', down: 'right' },
  '상봉': { up: 'right' },
  잠실: { up: 'both', down: 'both' },
}) satisfies ExitSideMap);

describe('lookupExitSide', () => {
  it('등록된 역+방향이면 해당 좌/우를 반환한다', () => {
    expect(lookupExitSide('강남', 'up')).toBe('left');
    expect(lookupExitSide('강남', 'down')).toBe('right');
  });

  it('등록되지 않은 역은 null을 반환한다', () => {
    expect(lookupExitSide('없는역', 'up')).toBeNull();
  });

  it('등록된 역이지만 해당 방향만 누락이면 null을 반환한다', () => {
    expect(lookupExitSide('상봉', 'up')).toBe('right');
    expect(lookupExitSide('상봉', 'down')).toBeNull();
  });

  it('섬식 승강장은 양쪽(both)을 반환한다', () => {
    expect(lookupExitSide('잠실', 'up')).toBe('both');
  });

  it('괄호 부제가 붙은 이름은 정규화해서 매칭한다', () => {
    expect(lookupExitSide('상봉(시외버스터미널)', 'up')).toBe('right');
  });
});
