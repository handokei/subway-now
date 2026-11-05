/**
 * `resolvePromptAnchor` 단위 테스트 (#3046, 10/18 편측 감사 G1+F1).
 *
 * 세 소비자(①`maybeFireOriginBoardingPromptGpsFree`/②`computeBoardingContext`/
 * ③`resolveActiveLegOrigin`)가 수렴해야 할 공유 primitive. 이 파일은 primitive 자체만
 * 검증한다 — 소비자별 wiring 검증은 각 소비자의 기존 테스트 파일(liveActivity.test.ts /
 * boardingAnchorResolver.test.ts / scheduled.test.ts)에 추가한다.
 */
import { describe, expect, it } from 'vitest';
import { resolvePromptAnchor } from '../promptAnchor';
import type { Trip } from '../types';

function makeTrip(overrides: Partial<Trip> = {}): Pick<Trip, 'promptDisplay' | 'originStationName' | 'waypoints'> {
  return {
    promptDisplay: undefined,
    originStationName: undefined,
    waypoints: [],
    ...overrides,
  };
}

describe('resolvePromptAnchor (#3046)', () => {
  it('[거부 ④ 동작 불변] promptDisplay 있으면 그대로 반환, derived=false', () => {
    const trip = makeTrip({ promptDisplay: { originStation: '군자', line: '7' } });
    const result = resolvePromptAnchor(trip);
    expect(result.anchor).toEqual({ originStation: '군자', line: '7' });
    expect(result.derived).toBe(false);
    expect(result.failureReason).toBeUndefined();
  });

  it('promptDisplay 없음 + originStationName + waypoints[0].line → 파생, derived=true', () => {
    const trip = makeTrip({
      originStationName: '군자',
      waypoints: [{ stationName: '중곡', line: '7', kind: 'intermediate' }],
    });
    const result = resolvePromptAnchor(trip);
    expect(result.anchor).toEqual({ originStation: '군자', line: '7' });
    expect(result.derived).toBe(true);
    expect(result.failureReason).toBeUndefined();
  });

  it('[거부 ③] promptDisplay·originStationName 둘 다 없음 → null + failureReason=no-origin-station-name', () => {
    const trip = makeTrip({ waypoints: [{ stationName: '중곡', line: '7', kind: 'intermediate' }] });
    const result = resolvePromptAnchor(trip);
    expect(result.anchor).toBeNull();
    expect(result.derived).toBe(false);
    expect(result.failureReason).toBe('no-origin-station-name');
  });

  it('[거부 ③-b] originStationName 있으나 waypoints 비어 line 파생 불가 → null + failureReason=no-waypoint-line', () => {
    const trip = makeTrip({ originStationName: '군자', waypoints: [] });
    const result = resolvePromptAnchor(trip);
    expect(result.anchor).toBeNull();
    expect(result.derived).toBe(false);
    expect(result.failureReason).toBe('no-waypoint-line');
  });

  it('[G3] originStationName과 stationName이 일치하는 waypoint가 있으면(순환선 재등장) 그 line을 우선 사용 — waypoints[0]의 line과 달라도', () => {
    const trip = makeTrip({
      originStationName: '성수',
      waypoints: [
        { stationName: '을지로3가', line: '2-외선', kind: 'intermediate' },
        { stationName: '성수', line: '2-내선', kind: 'intermediate' },
      ],
    });
    const result = resolvePromptAnchor(trip);
    // waypoints[0].line('2-외선')이 아니라 stationName이 일치하는 두 번째 waypoint의
    // line('2-내선')을 써야 한다 — G3이 금지하는 "waypoints[0] 고정"의 반증 케이스.
    expect(result.anchor).toEqual({ originStation: '성수', line: '2-내선' });
    expect(result.derived).toBe(true);
  });

  it('[G3 대조] 일치하는 waypoint가 없으면(통상 경로) waypoints[0]의 line으로 fallback(#3038 기존 동작 보존)', () => {
    const trip = makeTrip({
      originStationName: '군자',
      waypoints: [
        { stationName: '중곡', line: '7', kind: 'intermediate' },
        { stationName: '용마산', line: '7', kind: 'destination' },
      ],
    });
    const result = resolvePromptAnchor(trip);
    expect(result.anchor).toEqual({ originStation: '군자', line: '7' });
  });
});
