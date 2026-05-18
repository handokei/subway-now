import { resolveQuickExit } from '../quickExit';

jest.mock('../../data/quickExit.json', () => ({
  'gangnam-2': {
    stairs: [
      { doorNumber: '2-3', direction: 'up', towardLabel: '교대' },
      { doorNumber: '4-1', direction: 'down', towardLabel: '역삼' },
    ],
    elevator: [{ doorNumber: '1-1', direction: 'up', towardLabel: '교대' }],
  },
  'only-elevator': {
    elevator: [{ doorNumber: '5-2', direction: 'up' }],
  },
  'empty-buckets': {
    stairs: [],
    elevator: [],
  },
}));

describe('resolveQuickExit', () => {
  it('기본 모드는 stairs를 우선 반환한다', () => {
    expect(resolveQuickExit('gangnam-2')).toEqual({
      category: 'stairs',
      entry: { doorNumber: '2-3', direction: 'up', towardLabel: '교대' },
    });
  });

  it('accessibilityMode=true 면 elevator를 우선 반환한다', () => {
    expect(resolveQuickExit('gangnam-2', { accessibilityMode: true })).toEqual({
      category: 'elevator',
      entry: { doorNumber: '1-1', direction: 'up', towardLabel: '교대' },
    });
  });

  it('우선 카테고리에 데이터가 없으면 다음 카테고리로 폴백한다', () => {
    expect(resolveQuickExit('only-elevator')).toEqual({
      category: 'elevator',
      entry: { doorNumber: '5-2', direction: 'up' },
    });
  });

  it('direction 필터로 같은 방향 엔트리만 후보로 본다', () => {
    expect(resolveQuickExit('gangnam-2', { direction: 'down' })).toEqual({
      category: 'stairs',
      entry: { doorNumber: '4-1', direction: 'down', towardLabel: '역삼' },
    });
  });

  it('direction이 카테고리 안에 없으면 다음 카테고리로 폴백한다', () => {
    expect(resolveQuickExit('only-elevator', { direction: 'down' })).toBeNull();
  });

  it('등록되지 않은 역은 null', () => {
    expect(resolveQuickExit('unknown')).toBeNull();
  });

  it('모든 카테고리가 비어 있으면 null', () => {
    expect(resolveQuickExit('empty-buckets')).toBeNull();
  });

  it('accessibilityMode + direction 조합도 동작한다', () => {
    expect(
      resolveQuickExit('gangnam-2', { accessibilityMode: true, direction: 'up' }),
    ).toEqual({
      category: 'elevator',
      entry: { doorNumber: '1-1', direction: 'up', towardLabel: '교대' },
    });
  });
});
