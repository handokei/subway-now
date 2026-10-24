/**
 * #1421 — PR-AutoLock-1 측정 인프라.
 *
 * verifyTrainDirection 단위 테스트. SSOT가 잡은 trainCode의 다음역(arrival 응답에서 추출)이
 * route의 destination 쪽 방향과 일치하는지 검증한다 — false-positive auto-lock 방지의 2차 게이트.
 *
 * "방향 일치" 정의: arrival의 trainTerminalStationName(다음 종착)이 routeStations 위에서 currentIdx
 * 기준 destinationIdx 쪽(forward)에 위치하면 matched=true. 반대 방향이면 matched=false.
 * terminal이 routeStations 밖이면 unknown (matched=false, reason='terminal-out-of-route').
 */

import { canonicalStationName } from '../../../../testUtils/canonicalStationName';
import { verifyTrainDirection } from '../verifyTrainDirection';
import type { Station } from '../../../../shared/types/station';

function makeStation(name: string, line: Station['line']): Station {
  return { id: `${line}-${name}`, name, line, lineColor: '#000', lat: 0, lng: 0 };
}

const sampleRoute: Station[] = [
  makeStation('교대-base-1', '2'),
  makeStation('역삼-base-2', '2'),
  makeStation('선릉-base-3', '2'),
  makeStation('삼성-base-4', '2'),
];

describe('verifyTrainDirection', () => {
  it('terminal이 destination 쪽(forward)이면 matched=true', () => {
    const result = verifyTrainDirection({
      routeStations: sampleRoute,
      currentIdx: 1,
      destinationIdx: 3,
      trainTerminalStationName: '삼성-base-4',
    });
    expect(result.matched).toBe(true);
    expect(result.reason).toBe('forward');
  });

  it('terminal이 currentIdx 그대로면 matched=true (정착 중)', () => {
    const result = verifyTrainDirection({
      routeStations: sampleRoute,
      currentIdx: 1,
      destinationIdx: 3,
      trainTerminalStationName: '역삼-base-2',
    });
    expect(result.matched).toBe(true);
    expect(result.reason).toBe('forward');
  });

  it('terminal이 destination 반대쪽이면 matched=false', () => {
    const result = verifyTrainDirection({
      routeStations: sampleRoute,
      currentIdx: 2,
      destinationIdx: 3,
      trainTerminalStationName: '교대-base-1',
    });
    expect(result.matched).toBe(false);
    expect(result.reason).toBe('reverse');
  });

  it('reverse 방향 route(destinationIdx < currentIdx) — terminal이 destination 쪽이면 matched=true', () => {
    const result = verifyTrainDirection({
      routeStations: sampleRoute,
      currentIdx: 3,
      destinationIdx: 0,
      trainTerminalStationName: '교대-base-1',
    });
    expect(result.matched).toBe(true);
    expect(result.reason).toBe('forward');
  });

  it('routeStations 밖의 terminal — matched=false, reason=terminal-out-of-route', () => {
    const result = verifyTrainDirection({
      routeStations: sampleRoute,
      currentIdx: 1,
      destinationIdx: 3,
      trainTerminalStationName: '강남-not-in-route',
    });
    expect(result.matched).toBe(false);
    expect(result.reason).toBe('terminal-out-of-route');
  });

  it('빈 routeStations — matched=false, reason=no-route', () => {
    const result = verifyTrainDirection({
      routeStations: [],
      currentIdx: 0,
      destinationIdx: 0,
      trainTerminalStationName: '강남',
    });
    expect(result.matched).toBe(false);
    expect(result.reason).toBe('no-route');
  });

  it('trainTerminalStationName이 null이면 matched=false, reason=no-terminal', () => {
    const result = verifyTrainDirection({
      routeStations: sampleRoute,
      currentIdx: 1,
      destinationIdx: 3,
      trainTerminalStationName: null,
    });
    expect(result.matched).toBe(false);
    expect(result.reason).toBe('no-terminal');
  });

  it('currentIdx == destinationIdx (도착) — matched=true (terminal 어디든 진행 방향 의미 X)', () => {
    const result = verifyTrainDirection({
      routeStations: sampleRoute,
      currentIdx: 3,
      destinationIdx: 3,
      trainTerminalStationName: '교대-base-1',
    });
    expect(result.matched).toBe(true);
    expect(result.reason).toBe('at-destination');
  });

  it('canonical name이 있는 케이스 — alias 흡수 (drift 회귀 방지)', () => {
    // base name이 stations.json 정식 표기와 다를 수 있으므로 alias helper로 정규화.
    const realRoute: Station[] = [makeStation(canonicalStationName('교대', '2'), '2')];
    const result = verifyTrainDirection({
      routeStations: realRoute,
      currentIdx: 0,
      destinationIdx: 0,
      trainTerminalStationName: canonicalStationName('교대', '2'),
    });
    expect(result.matched).toBe(true);
  });
});
