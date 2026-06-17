import { canonicalStationName } from '../canonicalStationName';

describe('canonicalStationName', () => {
  it('정확 매칭이 있으면 그대로 반환한다 (괄호 없는 역)', () => {
    expect(canonicalStationName('잠실나루', '2')).toBe('잠실나루');
  });

  it('base name으로 정식 표기(괄호 부제 포함)를 룩업한다', () => {
    expect(canonicalStationName('교대', '2')).toBe('교대(법원.검찰청)');
    expect(canonicalStationName('잠실', '2')).toBe('잠실(송파구청)');
    expect(canonicalStationName('광화문', '5')).toBe('광화문(세종문화회관)');
  });

  it('같은 base가 여러 line에 있을 때 line별로 다른 정식명을 반환한다', () => {
    // 교대는 2호선/3호선 환승역 — 두 line 모두 동일 정식 표기.
    expect(canonicalStationName('교대', '2')).toBe('교대(법원.검찰청)');
    expect(canonicalStationName('교대', '3')).toBe('교대(법원.검찰청)');
  });

  it('RENAME_MAP 박제된 케이스(7호선 자양)를 base로도 룩업할 수 있다', () => {
    expect(canonicalStationName('자양', '7')).toBe('자양(뚝섬한강공원)');
  });

  it('stations.json에 없는 base는 base 그대로 fallback 한다', () => {
    expect(canonicalStationName('존재하지않는역', '1')).toBe('존재하지않는역');
  });

  it('base 매칭은 line 일치 시에만 동작한다 (cross-line leak 방지)', () => {
    // 교대는 2/3호선에만 존재. 1호선으로 찾으면 fallback.
    expect(canonicalStationName('교대', '1')).toBe('교대');
  });
});
