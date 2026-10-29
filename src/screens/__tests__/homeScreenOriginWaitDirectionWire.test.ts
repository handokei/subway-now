/**
 * #1480 N8 — HomeScreen 배선 가드 (screens는 소스 단언으로 고정).
 * 출발 대기 두 호출부(pickNextTrainMinutes / pickArrivalAtOrigin)가 route 기준 방향을 넘긴다.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SOURCE = readFileSync(join(__dirname, '..', 'HomeScreen.tsx'), 'utf8');

describe('HomeScreen — 출발 대기 방향 배선 (#1480 N8)', () => {
  it('originWaitDirection을 resolveTripDirection(route, destination.name, effectiveOrigin.id)로 산출', () => {
    expect(SOURCE).toMatch(
      /const originWaitDirection\b[\s\S]{0,300}resolveTripDirection\(\s*route,\s*destination\.name,\s*effectiveOrigin\.id/,
    );
  });

  it('pickNextTrainMinutes가 방향을 받는다', () => {
    expect(SOURCE).toMatch(/pickNextTrainMinutes\(arrival,\s*originWaitDirection\)/);
  });

  it('pickArrivalAtOrigin이 방향을 받는다', () => {
    expect(SOURCE).toMatch(/pickArrivalAtOrigin\(rawArrival,\s*originWaitDirection\)/);
  });
});
