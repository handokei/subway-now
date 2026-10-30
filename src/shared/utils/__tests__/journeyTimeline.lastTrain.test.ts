import { readFileSync } from 'fs';
import { join } from 'path';
import { computeJourneyEta } from '../journeyTimeline';
import { calculateStaticEtaDetail } from '../stationRoute';
import type { Route } from '../stationRoute';
import { findBoardableDeparture } from '../timetableShared';
import { makeTransferRoute } from '../../../testUtils/routeFixtures';

// #1480 — 막차 이후 시각에는 다음날 첫차까지의 수 시간 대기를 합산하지 않고 lastTrainEnded를 세운다.
// 시각은 KST 고정 주입. 2026-10-29는 목요일.

const kstMs = (y: number, mo: number, d: number, h: number, mi: number, s = 0): number =>
  Date.UTC(y, mo - 1, d, h, mi, s) - 9 * 3_600_000;

const contract = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '../../../../backend/alarm-worker/src/__tests__/fixtures/capture_20261028_trip179/device_waypoints.contract.json',
    ),
    'utf8',
  ),
) as { route: NonNullable<Route> };
const trip179Route = contract.route;
const THREE_HOURS_SECONDS = 3 * 3600;

describe('막차 이후 — 대기 합산 금지 + lastTrainEnded', () => {
  it('02:25 KST trip 179: 환승 대기가 다음날 첫차 대기(수 시간)로 합산되지 않고 lastTrainEnded=true', () => {
    const eta = calculateStaticEtaDetail(trip179Route, { nowMs: kstMs(2026, 10, 29, 2, 25) });
    expect(eta?.lastTrainEnded).toBe(true);
    expect(eta?.waits.some((w) => w.source === 'ended' && w.seconds === 0)).toBe(true);
    expect(eta?.totalSeconds).toBeLessThan(THREE_HOURS_SECONDS);
  });

  it('목요일 막차(00:58 꼬리) 직후 01:10: 같은 규칙 (금요일 첫차로 넘어가는 값을 대기로 쓰지 않는다)', () => {
    const eta = computeJourneyEta({ route: trip179Route, nowMs: kstMs(2026, 10, 30, 1, 10), excludeOriginWait: true });
    expect(eta.lastTrainEnded).toBe(true);
    expect(eta.totalSeconds).toBeLessThan(THREE_HOURS_SECONDS);
  });

  it('배차간격 폴백도 운행 시간 밖(closed 01:00~05:30)이면 ended — "N분+"(floor)가 아니다', () => {
    const route = makeTransferRoute({
      transferName: '홍대입구',
      fromLine: '2',
      toLine: 'gyeongui',
      stopsToTransfer: 2,
      stopsFromTransfer: 3,
    });
    const eta = computeJourneyEta({ route, nowMs: kstMs(2026, 10, 28, 3, 0), excludeOriginWait: true });
    expect(eta.waits[0]).toMatchObject({ source: 'ended', seconds: 0 });
    expect(eta.lastTrainEnded).toBe(true);
    expect(eta.waitUnknown).toBe(false);
  });

  it('출발 대기(originStop)도 새벽 첫차 전이면 ended', () => {
    const eta = computeJourneyEta({
      route: trip179Route,
      nowMs: kstMs(2026, 10, 29, 2, 25),
      originStop: { stationName: '용마산', line: '7', direction: 'down' },
    });
    expect(eta.waits[0]).toMatchObject({ kind: 'origin', source: 'ended', seconds: 0 });
  });
});

describe('거부 케이스 — 정상 운행은 대기로 계산된다', () => {
  it('00:20에 전날 24xx 꼬리는 정상 timetable 대기', () => {
    const result = findBoardableDeparture({
      stationName: '건대입구',
      line: '2',
      direction: 'down',
      from: new Date(kstMs(2026, 10, 29, 0, 20)),
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.departure.isNextDayFallback).toBe(false);
      expect(result.departure.waitSeconds).toBeLessThan(30 * 60);
    }
  });

  it('00:05 trip 환승은 ended가 아니라 timetable', () => {
    const eta = computeJourneyEta({ route: trip179Route, nowMs: kstMs(2026, 10, 29, 0, 5), excludeOriginWait: true });
    expect(eta.lastTrainEnded).toBe(false);
    expect(eta.waits[0]).toMatchObject({ source: 'timetable' });
  });

  it('운행 중(12:00)은 ended가 아니다', () => {
    const eta = computeJourneyEta({ route: trip179Route, nowMs: kstMs(2026, 10, 29, 12, 0), excludeOriginWait: true });
    expect(eta.lastTrainEnded).toBe(false);
  });
});
