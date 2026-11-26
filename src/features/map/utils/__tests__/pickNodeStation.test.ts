import { pickNodeStation } from '../pickNodeStation';
import stationsData from '../../../../data/stations.json';
import type { Station } from '../../../../shared/types/station';

const stations = stationsData as Station[];

describe('pickNodeStation', () => {
  it('단일 id → 그 역', () => {
    expect(pickNodeStation(['2-022'], stations)?.id).toBe('2-022');
  });

  it('환승 node → 노선 순서 첫 역(입력 id 순서와 무관)', () => {
    const members = stations.filter((s) => s.name === '건대입구' && ['2', '7'].includes(s.line));
    const ids = members.map((s) => s.id).reverse();
    expect(pickNodeStation(ids, stations)?.line).toBe('2');
  });

  it('stations에 없는 id는 무시하고, 전부 없으면 null', () => {
    expect(pickNodeStation(['nope', '2-022'], stations)?.id).toBe('2-022');
    expect(pickNodeStation(['nope'], stations)).toBeNull();
    expect(pickNodeStation([], stations)).toBeNull();
  });
});
