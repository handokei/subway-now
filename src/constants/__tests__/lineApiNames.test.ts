import { LINE_API_NAMES, getLineApiName, subwayIdToLine, lineToSubwayId } from '../lineApiNames';

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

  describe('subwayIdToLine', () => {
    it('1001~1009 → 1~9호선', () => {
      expect(subwayIdToLine('1001')).toBe('1');
      expect(subwayIdToLine('1002')).toBe('2');
      expect(subwayIdToLine('1003')).toBe('3');
      expect(subwayIdToLine('1004')).toBe('4');
      expect(subwayIdToLine('1005')).toBe('5');
      expect(subwayIdToLine('1006')).toBe('6');
      expect(subwayIdToLine('1007')).toBe('7');
      expect(subwayIdToLine('1008')).toBe('8');
      expect(subwayIdToLine('1009')).toBe('9');
    });

    it('특수 노선 코드 매핑 (경의중앙/공항/분당/신분당)', () => {
      expect(subwayIdToLine('1063')).toBe('gyeongui');
      expect(subwayIdToLine('1065')).toBe('airport');
      expect(subwayIdToLine('1075')).toBe('bundang');
      expect(subwayIdToLine('1077')).toBe('sinbundang');
    });

    it('number 입력은 string으로 변환되어 매핑된다', () => {
      expect(subwayIdToLine(1002)).toBe('2');
    });

    it('null·undefined·매핑 실패 코드는 null', () => {
      expect(subwayIdToLine(null)).toBeNull();
      expect(subwayIdToLine(undefined)).toBeNull();
      expect(subwayIdToLine('9999')).toBeNull();
      expect(subwayIdToLine('')).toBeNull();
    });

    it('object·array·boolean 등 비-string/number 입력은 null (의미 없는 stringification 방지)', () => {
      expect(subwayIdToLine({})).toBeNull();
      expect(subwayIdToLine([])).toBeNull();
      expect(subwayIdToLine(true)).toBeNull();
    });

    it('lineToSubwayId는 subwayIdToLine의 round-trip을 만족한다', () => {
      for (const id of ['1001', '1002', '1009', '1063', '1077']) {
        const line = subwayIdToLine(id);
        expect(line).not.toBeNull();
        expect(lineToSubwayId(line!)).toBe(id);
      }
    });

    it('lineToSubwayId: 매핑 없는 line은 null', () => {
      expect(lineToSubwayId('unknown' as never)).toBeNull();
    });

    it('SUBWAY_ID_TO_LINE 값 집합이 LINE_API_NAMES 키 집합(모든 LineNumber)을 완전 커버한다 — 신규 노선 추가 시 동기화 누락 방지', () => {
      const mappedLines = new Set<string>();
      for (const id of ['1001', '1002', '1003', '1004', '1005', '1006', '1007', '1008', '1009', '1063', '1065', '1075', '1077']) {
        const line = subwayIdToLine(id);
        if (line) mappedLines.add(line);
      }
      for (const key of Object.keys(LINE_API_NAMES)) {
        expect(mappedLines.has(key)).toBe(true);
      }
    });
  });
});
