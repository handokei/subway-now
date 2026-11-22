/**
 * #3177 — 복합식/섬식(복합) 승강장 방향별 하차문.
 * 근거 문장이 명시된 역만 항목을 둔다(온수 7-042: 나무위키 '내리는 문의 위치').
 * 근거 없는 역(신도림·수서·방화·강동·상월곡·봉화산·신내·청담·광명사거리·까치산)은 값을 지어내지 않고 문 라인을 생략한다.
 */
import { resolveExitSideForStation } from '../resolveExitSideForStation';

const ONSU = '7-042';

describe('온수(7-042) — 석남 착발(통과) 왼쪽, 당역 착발(종착) 오른쪽', () => {
  it.each([
    ['up', 'elsewhere', 'left'],
    ['down', 'elsewhere', 'left'],
    ['up', 'unknown', 'left'],
    ['down', 'here', 'right'],
  ] as const)('direction=%s terminus=%s → %s (directional)', (direction, terminus, side) => {
    expect(resolveExitSideForStation({ stationId: ONSU, direction, terminus })).toEqual({
      side,
      reason: 'directional',
    });
  });

  it('하행 종착 여부를 모르면 통과(left)/종착(right)가 갈리므로 단정하지 않는다', () => {
    expect(resolveExitSideForStation({ stationId: ONSU, direction: 'down', terminus: 'unknown' })).toEqual({
      side: null,
      reason: 'directional-undetermined',
    });
  });

  it('상행 당역 종착은 근거 문장이 없어 단정하지 않는다', () => {
    expect(resolveExitSideForStation({ stationId: ONSU, direction: 'up', terminus: 'here' })).toEqual({
      side: null,
      reason: 'directional-undetermined',
    });
  });

  it('방향을 모르고 구조값도 없으면 no-data(문 라인 생략)', () => {
    expect(resolveExitSideForStation({ stationId: ONSU, terminus: 'elsewhere' })).toEqual({
      side: null,
      reason: 'no-data',
    });
  });
});

describe('근거 문장이 없는 복합 승강장 역은 어떤 방향·종착에도 null', () => {
  it.each([
    ['2-034', '신도림'],
    ['3-041', '수서'],
    ['5-001', '방화'],
    ['5-039', '강동'],
    ['6-033', '상월곡'],
    ['6-038', '봉화산'],
    ['6-039', '신내'],
    ['7-021', '청담'],
    ['7-040', '광명사거리'],
    ['2-105', '까치산'],
  ])('%s %s', (stationId) => {
    for (const direction of ['up', 'down', undefined] as const) {
      for (const terminus of ['here', 'elsewhere', 'unknown'] as const) {
        const { side } = resolveExitSideForStation({ stationId, direction, terminus });
        expect(side).toBeNull();
      }
    }
  });
});
