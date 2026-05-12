import { LINE_API_NAMES, getLineApiName } from '../lineApiNames';

describe('lineApiNames', () => {
  it('1~9호선 매핑 + 특수 노선', () => {
    expect(getLineApiName('1')).toBe('1호선');
    expect(getLineApiName('9')).toBe('9호선');
    expect(getLineApiName('airport')).toBe('공항철도');
    expect(getLineApiName('gyeongui')).toBe('경의중앙선');
    expect(getLineApiName('bundang')).toBe('수인분당선');
    expect(getLineApiName('sinbundang')).toBe('신분당선');
  });

  it('LINE_API_NAMES가 모든 LineNumber를 cover (객체 키 9+4=13)', () => {
    expect(Object.keys(LINE_API_NAMES).length).toBe(13);
  });
});
