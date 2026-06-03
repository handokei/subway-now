import { resolveProgressingTerminal, resolveTravelDirection } from '../travelDirection';

jest.mock('../stationRoute', () => ({
  // 가짜 3호선 — 단조 노선이라는 가정. (MONOTONIC_LINES 화이트리스트에 포함됨.)
  getStationsOnLine: (line: string) => {
    if (line === '3') {
      return [
        { id: '3-0', name: '대화', line: '3' },
        { id: '3-1', name: '주엽', line: '3' },
        { id: '3-2', name: '연신내', line: '3' },
        { id: '3-3', name: '종로3가', line: '3' },
        { id: '3-4', name: '오금', line: '3' },
      ];
    }
    if (line === '8') return []; // 단조이지만 노선 목록 비어있는 경계 케이스
    return [];
  },
  normalizeStationName: (name: string) => {
    if (name.endsWith(')')) {
      const open = name.lastIndexOf('(');
      if (open > 0) return name.slice(0, open).trim();
    }
    return name;
  },
}));

describe('resolveTravelDirection', () => {
  it('단조 노선에서 도착역 인덱스가 출발역보다 작으면 up + station 객체 반환', () => {
    const r = resolveTravelDirection('3', '오금', '종로3가');
    expect(r?.direction).toBe('up');
    expect(r?.fromStation.name).toBe('오금');
    expect(r?.toStation.name).toBe('종로3가');
  });

  it('단조 노선에서 도착역 인덱스가 출발역보다 크면 down', () => {
    expect(resolveTravelDirection('3', '주엽', '종로3가')?.direction).toBe('down');
  });

  it('같은 역이면 null', () => {
    expect(resolveTravelDirection('3', '종로3가', '종로3가')).toBeNull();
  });

  it('출발역이 노선에 없으면 null', () => {
    expect(resolveTravelDirection('3', '없는역', '종로3가')).toBeNull();
  });

  it('도착역이 노선에 없으면 null', () => {
    expect(resolveTravelDirection('3', '종로3가', '없는역')).toBeNull();
  });

  it('노선에 등록된 역이 없으면 null', () => {
    expect(resolveTravelDirection('8', '암사', '모란')).toBeNull();
  });

  it('괄호 부제가 붙은 이름은 정규화로 매칭한다', () => {
    expect(resolveTravelDirection('3', '종로3가(서울)', '오금')?.direction).toBe('down');
  });

  it('순환선(2호선)은 단조 가정이 깨지므로 항상 null', () => {
    expect(resolveTravelDirection('2', '시청', '잠실')).toBeNull();
  });

  it('분기 노선(5/6호선, 1호선, 경의중앙선)도 null', () => {
    expect(resolveTravelDirection('5', '방화', '마천')).toBeNull();
    expect(resolveTravelDirection('6', '응암', '신내')).toBeNull();
    expect(resolveTravelDirection('1', '소요산', '인천')).toBeNull();
    expect(resolveTravelDirection('gyeongui', '운천', '지평')).toBeNull();
  });
});

describe('resolveProgressingTerminal (#788)', () => {
  // travelDirection.test.ts 상단 jest.mock에서 line 3의 stations 시퀀스는
  // [대화, 주엽, 연신내, 종로3가, 오금]. lineTopology.json 실데이터(endpoints["3"] = {low:대화, high:오금})와 정렬.

  it('단조 노선에서 toIdx > fromIdx면 high endpoint 반환', () => {
    // 주엽(idx 1) → 종로3가(idx 3): id 증가 → high → "오금"
    expect(resolveProgressingTerminal('3', '주엽', '종로3가')).toBe('오금');
  });

  it('단조 노선에서 toIdx < fromIdx면 low endpoint 반환', () => {
    // 오금(idx 4) → 종로3가(idx 3): id 감소 → low → "대화"
    expect(resolveProgressingTerminal('3', '오금', '종로3가')).toBe('대화');
  });

  it('비단조 노선은 null (resolveTravelDirection이 null이기 때문)', () => {
    expect(resolveProgressingTerminal('2', '시청', '잠실')).toBeNull();
    expect(resolveProgressingTerminal('5', '방화', '마천')).toBeNull();
  });

  it('같은 역이면 null', () => {
    expect(resolveProgressingTerminal('3', '종로3가', '종로3가')).toBeNull();
  });

  it('출발역이 노선에 없으면 null', () => {
    expect(resolveProgressingTerminal('3', '없는역', '오금')).toBeNull();
  });

  it('단조 노선 화이트리스트지만 mock stations 빈 배열이면 null', () => {
    // line 8은 단조 화이트리스트에 있지만 본 mock에서 stations 빈 배열로 반환 →
    // resolveTravelDirection 단계에서 이미 null이라 진입 자체가 안 됨.
    expect(resolveProgressingTerminal('8', '암사', '모란')).toBeNull();
  });
});
