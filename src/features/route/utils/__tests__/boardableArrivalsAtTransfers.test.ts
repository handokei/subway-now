import { buildBoardableArrivalsAtTransfers } from '../boardableArrivalsAtTransfers';

// #1480 PR-D — 환승 목록 arrivals(이미 toLine·진행 방향 필터됨)를 엔진 입력(환승 순서별 후보)으로 배치한다.
const train = (arrivalSeconds: number | null, receivedAtMs = 1_000) => ({ arrivalSeconds, receivedAtMs });

describe('buildBoardableArrivalsAtTransfers', () => {
  it('활성 환승 index 슬롯에만 후보를 채우고 앞 슬롯은 null (엔진은 index로 환승을 구분)', () => {
    const arrivals = [train(120), train(420)];
    expect(buildBoardableArrivalsAtTransfers(1, arrivals)).toEqual([null, arrivals]);
  });

  it('index 0이면 길이 1', () => {
    const arrivals = [train(60)];
    expect(buildBoardableArrivalsAtTransfers(0, arrivals)).toEqual([arrivals]);
  });

  it('도착 정보가 없으면(빈 목록) 슬롯도 null → 엔진이 시간표로 폴백', () => {
    expect(buildBoardableArrivalsAtTransfers(0, [])).toEqual([null]);
  });

  it('환승 컨텍스트가 없으면(index null) undefined → 입력 자체를 주지 않는다', () => {
    expect(buildBoardableArrivalsAtTransfers(null, [train(60)])).toBeUndefined();
  });
});
