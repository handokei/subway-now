import { getExpressStopsOnLine, isExpressStop } from '../expressLookup';
import stations from '../../../../data/stations.json';
import type { Station } from '../../../../shared/types/station';

describe('getExpressStopsOnLine', () => {
  it('1호선 급행 정차역 셋 반환', () => {
    const stops = getExpressStopsOnLine('1', 'express');
    expect(stops.has('용산')).toBe(true);
    expect(stops.has('신도림')).toBe(true);
    expect(stops.has('영등포')).toBe(true);
  });

  it('9호선 급행 정차역 셋 반환', () => {
    const stops = getExpressStopsOnLine('9', 'express');
    expect(stops.has('여의도')).toBe(true);
    expect(stops.has('고속터미널')).toBe(true);
  });

  it('공항철도 직통은 rapid 카테고리', () => {
    const rapid = getExpressStopsOnLine('airport', 'rapid');
    expect(rapid.has('서울역')).toBe(true);
    expect(rapid.has('인천공항1터미널')).toBe(true);
    expect(getExpressStopsOnLine('airport', 'express').size).toBe(0);
  });

  it('normal은 항상 빈 셋', () => {
    expect(getExpressStopsOnLine('1', 'normal').size).toBe(0);
    expect(getExpressStopsOnLine('9', 'normal').size).toBe(0);
  });

  it('미존재 노선/타입은 빈 셋', () => {
    expect(getExpressStopsOnLine('8', 'express').size).toBe(0);
    expect(getExpressStopsOnLine('1', 'itx').size).toBe(0);
  });
});

describe('isExpressStop', () => {
  it('급행 정차역은 true', () => {
    expect(isExpressStop('용산', '1', 'express')).toBe(true);
    expect(isExpressStop('여의도', '9', 'express')).toBe(true);
  });

  it('급행 통과역은 false', () => {
    expect(isExpressStop('대방', '1', 'express')).toBe(false);
    expect(isExpressStop('등촌', '9', 'express')).toBe(false);
  });

  it('normal은 모든 역에서 true', () => {
    expect(isExpressStop('대방', '1', 'normal')).toBe(true);
    expect(isExpressStop('미존재역', '5', 'normal')).toBe(true);
  });

  it('데이터 없는 노선은 보수적으로 true (잘못된 경고 방지)', () => {
    expect(isExpressStop('아무역', '8', 'express')).toBe(true);
    expect(isExpressStop('아무역', '1', 'itx')).toBe(true);
  });
});

describe('expressStops dataset integrity vs stations.json', () => {
  it('expressStops에 등록된 모든 역이 stations.json의 해당 노선에 실제 존재', () => {
    const typed = stations as Station[];
    const namesByLine = new Map<string, Set<string>>();
    for (const s of typed) {
      const bag = namesByLine.get(s.line) ?? new Set<string>();
      bag.add(s.name);
      namesByLine.set(s.line, bag);
    }

    const lines = ['1', '9', 'bundang', 'gyeongui', 'airport'] as const;
    const trainTypes = ['express', 'itx', 'rapid'] as const;

    for (const line of lines) {
      for (const t of trainTypes) {
        const stops = getExpressStopsOnLine(line, t);
        for (const name of stops) {
          expect({ line, type: t, name, exists: namesByLine.get(line)?.has(name) ?? false })
            .toEqual({ line, type: t, name, exists: true });
        }
      }
    }
  });

  it('노선별 급행 정차역 수 고정 (실수로 추가/삭제 시 회귀 알림)', () => {
    expect(getExpressStopsOnLine('1', 'express').size).toBe(16);
    expect(getExpressStopsOnLine('9', 'express').size).toBe(20);
    expect(getExpressStopsOnLine('bundang', 'express').size).toBe(15);
    expect(getExpressStopsOnLine('gyeongui', 'express').size).toBe(24);
    expect(getExpressStopsOnLine('airport', 'rapid').size).toBe(3);
  });

  it('1호선 신도림 역이 stations.json에 존재하고 급행 정차역으로 인식', () => {
    const sindorim = (stations as Station[]).find(
      (s) => s.line === '1' && s.name === '신도림',
    );
    expect(sindorim).toBeDefined();
    expect(isExpressStop(sindorim!.name, sindorim!.line, 'express')).toBe(true);
  });
});
