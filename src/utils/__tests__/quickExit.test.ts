import { resolveQuickExit } from '../quickExit';

jest.mock('../../data/quickExit.json', () => ({
  'gangnam-2': {
    stairs: [{ doorNumber: '2', carNumber: '3' }],
    elevator: [{ doorNumber: '1', carNumber: '4' }],
    transfer: [
      { doorNumber: '4', carNumber: '5', targetLine: '신분당' },
      { doorNumber: '3', carNumber: '2', targetLine: '9' },
    ],
  },
  'no-stairs-only-transfer': {
    transfer: [{ doorNumber: '6', carNumber: '1' }],
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
      entry: { doorNumber: '2', carNumber: '3' },
    });
  });

  it('accessibilityMode=true 면 elevator를 우선 반환한다', () => {
    expect(resolveQuickExit('gangnam-2', { accessibilityMode: true })).toEqual({
      category: 'elevator',
      entry: { doorNumber: '1', carNumber: '4' },
    });
  });

  it('우선 카테고리에 데이터가 없으면 다음 카테고리로 폴백한다', () => {
    expect(resolveQuickExit('no-stairs-only-transfer')).toEqual({
      category: 'transfer',
      entry: { doorNumber: '6', carNumber: '1' },
    });
  });

  it('등록되지 않은 역은 null', () => {
    expect(resolveQuickExit('unknown')).toBeNull();
  });

  it('모든 카테고리가 비어 있으면 null', () => {
    expect(resolveQuickExit('empty-buckets')).toBeNull();
  });

  it('targetLine은 stairs/elevator에는 영향을 주지 않고 우선순위대로 stairs를 반환한다', () => {
    expect(
      resolveQuickExit('gangnam-2', { accessibilityMode: false, targetLine: '9' }),
    ).toEqual({
      category: 'stairs',
      entry: { doorNumber: '2', carNumber: '3' },
    });
  });

  it('우선 카테고리가 비어 폴백된 transfer에서 targetLine 미스매치면 null', () => {
    expect(
      resolveQuickExit('no-stairs-only-transfer', { targetLine: '미등록' }),
    ).toBeNull();
  });

  it('우선 카테고리 폴백 후 transfer에서 targetLine 매칭이면 해당 엔트리 반환', () => {
    expect(
      resolveQuickExit('no-stairs-only-transfer', { targetLine: undefined }),
    ).toEqual({
      category: 'transfer',
      entry: { doorNumber: '6', carNumber: '1' },
    });
  });

  it('accessibilityMode + targetLine 조합 — elevator가 먼저 잡혀 targetLine은 무시된다', () => {
    expect(
      resolveQuickExit('gangnam-2', { accessibilityMode: true, targetLine: '신분당' }),
    ).toEqual({
      category: 'elevator',
      entry: { doorNumber: '1', carNumber: '4' },
    });
  });
});
