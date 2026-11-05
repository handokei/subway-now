import { MockExitInfoProvider } from '../MockExitInfoProvider';

describe('MockExitInfoProvider', () => {
  it('샘플 fixture에서 강남 2호선 출구를 반환한다', async () => {
    const provider = new MockExitInfoProvider();
    const exits = await provider.getExits('강남', '2');
    expect(exits.length).toBeGreaterThan(0);
    expect(exits.every((e) => e.stationName === '강남' && e.line === '2')).toBe(true);
  });

  it('없는 역은 빈 배열', async () => {
    const provider = new MockExitInfoProvider();
    const exits = await provider.getExits('없는역', '2');
    expect(exits).toEqual([]);
  });

  it('다른 노선은 분리된다', async () => {
    const provider = new MockExitInfoProvider();
    const line2 = await provider.getExits('강남', '2');
    const line1 = await provider.getExits('강남', '1');
    expect(line2.length).toBeGreaterThan(0);
    expect(line1).toEqual([]);
  });

  it('주입된 데이터를 사용한다', async () => {
    const provider = new MockExitInfoProvider({
      exits: [
        { stationName: '테스트', line: '3', exitNumber: '2', facilities: ['카페'], nearby: '메모' },
      ],
    });
    const exits = await provider.getExits('테스트', '3');
    expect(exits).toEqual([
      { stationName: '테스트', line: '3', exitNumber: '2', facilities: ['카페'], nearby: '메모' },
    ]);
  });

  it('nearby가 없는 엔트리도 그대로 보존된다 (undefined)', async () => {
    const provider = new MockExitInfoProvider({
      exits: [
        { stationName: '테스트', line: '3', exitNumber: '1', facilities: ['역사'] },
      ],
    });
    const exits = await provider.getExits('테스트', '3');
    expect(exits[0]?.nearby).toBeUndefined();
  });
});
