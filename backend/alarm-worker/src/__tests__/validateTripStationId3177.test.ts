import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as sentryModule from '../sentry';
import { validateTrip } from '../index';

/**
 * #3177 PR-9a — waypoint.stationId(실제 하차 승강장의 stations.json id) 수용 규칙.
 *
 * 서버는 배포 시점의 stations.json을, 앱은 빌드 시점의 파일을 쓴다(배포 주기가 달라 버전이 어긋날 수 있다).
 * 그래서 stationId는 **트립 거부 사유가 아니다** — 문자열이 아님 / 서버 stations.json에 없음 / 노선이 wp.line과 다름
 * 세 경우에는 그 waypoint의 stationId 필드만 지우고 관측(console.warn + Sentry breadcrumb)한다.
 */
const FUTURE = Date.now() + 60 * 60 * 1000;

function trip(waypoints: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    token: 'tok-3177',
    route: { type: 'transfer', fromLine: '2', toLine: '4' },
    destination: '4-025',
    waypoints,
    expiresAt: FUTURE,
    alarmAtEpochMs: FUTURE - 30 * 60 * 1000,
  };
}

describe('#3177 validateTrip — waypoint.stationId', () => {
  let breadcrumbSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    breadcrumbSpy = vi.spyOn(sentryModule, 'addValidateRejectBreadcrumb').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('유효한 id(강남→사당 환승 waypoint 2-026, 노선 일치)는 보존한다 — 환승역 id는 fromLine 쪽', () => {
    const result = validateTrip(
      trip([
        { stationName: '사당', line: '2', kind: 'transfer', stationId: '2-026' },
        { stationName: '사당', line: '4', kind: 'destination', stationId: '4-025' },
      ]),
    );
    expect(result).not.toBeNull();
    expect(result?.waypoints.map(({ stationId }) => stationId)).toEqual(['2-026', '4-025']);
    expect(breadcrumbSpy).not.toHaveBeenCalled();
  });

  it('stationId가 없는 구버전 등록은 그대로 받는다(필드 부재 유지, 관측 없음)', () => {
    const result = validateTrip(trip([{ stationName: '사당', line: '4', kind: 'destination' }]));
    expect(result).not.toBeNull();
    expect(result?.waypoints[0]).not.toHaveProperty('stationId');
    expect(breadcrumbSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['문자열이 아님', 2026, 'not-string'],
    ['서버 stations.json에 없음', 'zz-999', 'unknown-id'],
    ['노선이 wp.line과 다름(사당 4호선 waypoint에 2호선 id)', '2-026', 'line-mismatch'],
  ])('%s → 트립은 받고 그 waypoint의 stationId만 지운다 + 사유 관측', (_label, stationId, cause) => {
    const result = validateTrip(
      trip([
        { stationName: '사당', line: '4', kind: 'destination', stationId },
        { stationName: '교대', line: '3', kind: 'intermediate', stationId: '3-032' },
      ]),
    );
    expect(result).not.toBeNull();
    const [bad, good] = result?.waypoints ?? [];
    expect(bad).not.toHaveProperty('stationId');
    expect(good.stationId).toBe('3-032');
    expect(breadcrumbSpy).toHaveBeenCalledTimes(1);
    expect(breadcrumbSpy).toHaveBeenCalledWith(
      'waypoint-station-id-dropped',
      expect.objectContaining({ cause, stationName: '사당', line: '4' }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('waypoint-station-id-dropped'),
      expect.stringContaining(cause),
    );
  });
});
