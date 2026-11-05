import { lookupAdjacentHopSeconds } from '../adjacentHopSeconds';

describe('lookupAdjacentHopSeconds', () => {
  it('인접 hop은 운행시간(초)을 돌려준다 (2호선 뚝섬 2-010 -> 성수 2-011 = 60s)', () => {
    expect(lookupAdjacentHopSeconds('2', '2-010', '2-011')).toBe(60);
  });

  it('양방향 키가 모두 등록돼 있다 (성수 -> 뚝섬)', () => {
    expect(lookupAdjacentHopSeconds('2', '2-011', '2-010')).toBe(60);
  });

  it('7호선 건대입구 7-019 -> 어린이대공원 7-018 = 80s', () => {
    expect(lookupAdjacentHopSeconds('7', '7-019', '7-018')).toBe(80);
  });

  it('인접이 아니면 null (뚝섬 2-010 -> 건대입구 2호선 이상 두 칸 이상)', () => {
    expect(lookupAdjacentHopSeconds('2', '2-010', '2-013')).toBeNull();
  });

  it('다른 노선 키는 null (같은 id라도 line이 다르면 hop 아님)', () => {
    expect(lookupAdjacentHopSeconds('7', '2-010', '2-011')).toBeNull();
  });
});
