import {
  calculateEtaDetail,
  calculateStaticEtaDetail,
  findRoutes,
} from '../../../../shared/utils/stationRoute';
import { formatFirstTrainTime } from '../../../../shared/utils/journeyTimeline';
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';
import { buildRouteChipLabel, computeChipEta } from '../routeChipEta';

// #1480 후속 — 경로 목록 칩의 "N분"은 홈 상단 ETA와 같은 엔진(journeyTimeline, 지금 출발)으로 산출한다.
// 정렬·선택(travelMinutes = 주행+도보)은 불변, 표시 숫자만 대기를 포함한다.

const WED_0625_KST = Date.UTC(2026, 9, 27, 21, 25, 0); // 2026-10-28 06:25 KST
const WED_0525_KST = Date.UTC(2026, 9, 27, 20, 25, 0); // 2026-10-28 05:25 KST (운행 종료 구간, #3262)
const WED_0225_KST = Date.UTC(2026, 9, 27, 17, 25, 0); // 2026-10-28 02:25 KST
const WED_1225_KST = Date.UTC(2026, 9, 28, 3, 25, 0);

// 10/28 trip 179: 용마산(7-015) → 건대입구(7|2) 환승 → 뚝섬(2-010)
const [trip179] = findRoutes('7-015', '2-010');

describe('computeChipEta', () => {
  it('trip 179 06:25 KST: 칩 분 = 엔진 총 분(출발·환승 대기 포함), 기존 대기 0 값(15)보다 크다', () => {
    expect(trip179.travelMinutes).toBe(15);
    expect(computeChipEta(trip179.route, WED_0625_KST)).toEqual({ minutes: 20, kind: 'exact' });
  });

  it('홈 상단 ETA와 같은 입력(출발 전·실시간 없음·GPS 없음)이면 같은 숫자', () => {
    const top = calculateStaticEtaDetail(trip179.route, { nowMs: WED_0625_KST });
    expect(computeChipEta(trip179.route, WED_0625_KST).minutes).toBe(top?.minutes);
  });

  it('상단 실시간 경로(calculateEtaDetail)에 출발 대기 180s를 넣은 값과도 일치한다', () => {
    const real = calculateEtaDetail(3, trip179.route, { nowMs: WED_0625_KST });
    expect(computeChipEta(trip179.route, WED_0625_KST).minutes).toBe(real?.minutes);
  });

  it('직통: 주행 + 출발 대기', () => {
    const [direct] = findRoutes('2-011', '2-010');
    const eta = computeChipEta(direct.route, WED_0625_KST);
    expect(eta.minutes).toBeGreaterThan(direct.travelMinutes);
    expect(eta.kind).toBe('exact');
  });

  it.each([
    ['02:25', WED_0225_KST],
    ['05:25', WED_0525_KST],
  ])('운행 종료 %s KST(#3262): 막차 종료 + 시간표 첫차 시각(firstTrainAtMs)', (_label, nowMs) => {
    const eta = computeChipEta(trip179.route, nowMs);
    expect(eta.kind).toBe('lastTrainEnded');
    expect(eta.firstTrainAtMs).toBeGreaterThan(nowMs);
    expect(formatFirstTrainTime(eta.firstTrainAtMs!)).toMatch(/^05:\d\d$/);
  });

  it('시간표 미커버 노선의 운행 종료는 firstTrainAtMs 없이 막차 종료 유지', () => {
    const eta = computeChipEta(makeDirectRoute(5, 'gyeongui'), Date.UTC(2026, 9, 27, 18, 0, 0)); // 03:00 KST
    expect(eta.kind).toBe('lastTrainEnded');
    expect(eta.firstTrainAtMs).toBeUndefined();
  });

  it('시각이 바뀌면 숫자가 바뀐다 (정렬용 travelMinutes는 불변)', () => {
    const a = computeChipEta(trip179.route, WED_0625_KST).minutes;
    const b = computeChipEta(trip179.route, WED_1225_KST).minutes;
    expect(a).not.toBe(b);
  });
});

describe('buildRouteChipLabel', () => {
  const t = (key: string, o?: Record<string, unknown>) => `${key}|${JSON.stringify(o)}`;

  it.each([
    [0, { minutes: 15, kind: 'exact' as const }, 'route.directOnly|{"min":15}'],
    [1, { minutes: 20, kind: 'exact' as const }, 'route.minutesAndTransfers|{"min":20,"count":1}'],
    [0, { minutes: 15, kind: 'unknownWait' as const }, 'route.directOnlyPlus|{"min":15}'],
    [2, { minutes: 23, kind: 'unknownWait' as const }, 'route.minutesAndTransfersPlus|{"min":23,"count":2}'],
    [1, { minutes: 20, kind: 'lastTrainEnded' as const }, 'home.lastTrainEnded|undefined'],
    [1, { minutes: 20, kind: 'lastTrainEnded' as const, firstTrainAtMs: Date.UTC(2026, 9, 27, 20, 34, 0) }, 'home.firstTrainAt|{"time":"05:34"}'],
  ])('transferCount=%i %j', (transferCount, eta, expected) => {
    expect(buildRouteChipLabel(t, transferCount, eta)).toBe(expected);
  });
});
