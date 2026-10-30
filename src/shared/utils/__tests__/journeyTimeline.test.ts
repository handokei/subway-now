import { readFileSync } from 'fs';
import { join } from 'path';
import { computeJourneyEta } from '../journeyTimeline';
import { findStationByNameAndLine } from '../stationRoute';
import type { Route } from '../stationRoute';
import { makeDirectRoute, makeTransferRoute } from '../../../testUtils/routeFixtures';

// #1480 PR-C — 여정 타임라인 엔진. 모든 시각은 KST 고정 주입(nowMs). 기대값 근거는 각 케이스 주석.

function kstMs(y: number, mo: number, d: number, h: number, mi: number, s = 0): number {
  return Date.UTC(y, mo - 1, d, h, mi, s) - 9 * 3_600_000;
}

// 10/28 trip 179 실측 계약(중곡(7) → 건대입구 환승 → 뚝섬(2)). backend replay와 같은 파일.
const contract = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '../../../../backend/alarm-worker/src/__tests__/fixtures/capture_20261028_trip179/device_waypoints.contract.json',
    ),
    'utf8',
  ),
) as { route: NonNullable<Route> };
const trip179Route = contract.route as Extract<NonNullable<Route>, { type: 'transfer' }>;

/** 건대입구(7) 도착 시각이 arrivalMs가 되도록 now를 역산 (excludeOriginWait 상태). */
const nowForTransferArrival = (arrivalMs: number): number => arrivalMs - trip179Route.secondsToTransfer * 1000;

describe('computeJourneyEta — 환승 대기 = 실시간 → 시간표 → 배차간격/2 → 하한', () => {
  it('trip 179: 건대입구 06:34:21 도착 + 도보 278 + buffer 30 → 2호선 down 0641 (91초 대기)', () => {
    const nowMs = nowForTransferArrival(kstMs(2026, 10, 28, 6, 34, 21));
    const eta = computeJourneyEta({ route: trip179Route, nowMs, excludeOriginWait: true });
    expect(eta.waits).toEqual([
      { kind: 'transfer', line: '2', stationName: '건대입구', source: 'timetable', seconds: 91 },
    ]);
    expect(eta.waitUnknown).toBe(false);
    expect(eta.lastTrainEnded).toBe(false);
    // 06:39:29 + 91s = 06:41:00 승차 → +210s 주행 = 06:44:30. now(06:28:51) 기준 15.65분 → 16.
    expect(eta.minutes).toBe(16);
    expect(eta.lookups).toEqual([{ status: 'ok', line: '2', stationName: '건대입구' }]);
  });

  it('buffer가 대기 합산에 포함된다 (도보만으로는 0635 승차, buffer까지 더하면 0641)', () => {
    // 도착 06:30:52 + 도보 278 = 06:35:30 → 분 395 == 0635 (같은 분 허용)이라 도보만 합산하면 0635를 탄다.
    // buffer 30을 더하면 06:36:00 → 0635는 놓치고 0641.
    const nowMs = nowForTransferArrival(kstMs(2026, 10, 28, 6, 30, 52));
    const eta = computeJourneyEta({ route: trip179Route, nowMs, excludeOriginWait: true });
    // T_platform = 06:30:52+278+30 = 06:36:00 → 0641까지 300초
    expect(eta.waits[0]).toMatchObject({ source: 'timetable', seconds: 300 });
  });

  it('실시간 대기 슬롯이 있으면 시간표보다 우선한다', () => {
    const nowMs = nowForTransferArrival(kstMs(2026, 10, 28, 6, 34, 21));
    const eta = computeJourneyEta({
      route: trip179Route,
      nowMs,
      excludeOriginWait: true,
      transferRealtimeWaitSeconds: [120],
    });
    expect(eta.waits).toEqual([
      { kind: 'transfer', line: '2', stationName: '건대입구', source: 'realtime', seconds: 120 },
    ]);
    expect(eta.lookups).toEqual([]);
  });

  it('완료된 환승(도보·대기 모두 끝)은 합산하지 않는다', () => {
    const anchored: NonNullable<Route> = {
      ...trip179Route,
      secondsToTransfer: 0,
      stopsToTransfer: 0,
      completedTransfers: 1,
    };
    const eta = computeJourneyEta({ route: anchored, nowMs: kstMs(2026, 10, 28, 6, 42), excludeOriginWait: true });
    expect(eta.waits).toEqual([]);
    expect(eta.minutes).toBe(4); // 210초 = 3.5분 → 4
  });

  it('환승역 toLine 위(transferWaitPending)면 도보·buffer 없이 대기만 남는다', () => {
    const anchored: NonNullable<Route> = {
      ...trip179Route,
      secondsToTransfer: 0,
      stopsToTransfer: 0,
      completedTransfers: 1,
      transferWaitPending: true,
    };
    // now 06:39:29 (이미 승강장) → 0641까지 91초, 이후 주행 210초.
    const eta = computeJourneyEta({ route: anchored, nowMs: kstMs(2026, 10, 28, 6, 39, 29), excludeOriginWait: true });
    expect(eta.waits).toEqual([
      { kind: 'transfer', line: '2', stationName: '건대입구', source: 'timetable', seconds: 91 },
    ]);
    expect(eta.minutes).toBe(5); // 301초 = 5.02분
  });

  it('방향을 모르면(목적지 id 없음) 시간표 대신 배차간격/2 (2호선 평일 offPeak 270s → 135s)', () => {
    const { destinationStationId: _d, transferStationId: _t, ...noIds } = trip179Route;
    const eta = computeJourneyEta({
      route: noIds as NonNullable<Route>,
      nowMs: kstMs(2026, 10, 28, 12, 0),
      excludeOriginWait: true,
    });
    expect(eta.waits[0]).toMatchObject({ source: 'headway', seconds: 135 });
    expect(eta.waitUnknown).toBe(false);
    expect(eta.lookups).toEqual([{ status: 'miss', line: '2', stationName: '건대입구' }]);
  });

  it('시간표 없는 노선(경의중앙)은 배차간격/2 (평일 offPeak 900s → 450s)', () => {
    const route = makeTransferRoute({
      transferName: '홍대입구',
      fromLine: '2',
      toLine: 'gyeongui',
      stopsToTransfer: 2,
      stopsFromTransfer: 3,
    });
    const eta = computeJourneyEta({ route, nowMs: kstMs(2026, 10, 28, 12, 0), excludeOriginWait: true });
    expect(eta.waits[0]).toMatchObject({ line: 'gyeongui', source: 'headway', seconds: 450 });
    expect(eta.lookups).toEqual([{ status: 'miss', line: 'gyeongui', stationName: '홍대입구' }]);
  });

  it('배차간격도 없는 시간대(심야 closed)는 하한 + waitUnknown ("N분+")', () => {
    const route = makeTransferRoute({
      transferName: '홍대입구',
      fromLine: '2',
      toLine: 'gyeongui',
      stopsToTransfer: 2,
      stopsFromTransfer: 3,
    });
    const eta = computeJourneyEta({ route, nowMs: kstMs(2026, 10, 28, 3, 0), excludeOriginWait: true });
    expect(eta.waits[0]).toMatchObject({ source: 'floor', seconds: 60 });
    expect(eta.waitUnknown).toBe(true);
    expect(eta.lastTrainEnded).toBe(false);
  });

  it('9호선은 시간표 방향 극성이 directionOnLine과 달라 시간표를 쓰지 않고 배차간격/2 (평일 offPeak 480s → 240s)', () => {
    const dangsan = findStationByNameAndLine('당산', '9');
    const yeouido = findStationByNameAndLine('여의도', '9');
    if (!dangsan || !yeouido) throw new Error('fixture station missing');
    const route: NonNullable<Route> = {
      ...makeTransferRoute({ transferName: '당산', fromLine: '2', toLine: '9', stopsToTransfer: 2, stopsFromTransfer: 3 }),
      destinationStationId: yeouido.id,
    };
    const eta = computeJourneyEta({ route, nowMs: kstMs(2026, 10, 28, 12, 0), excludeOriginWait: true });
    expect(eta.waits[0]).toMatchObject({ line: '9', source: 'headway', seconds: 240 });
  });

  it('막차 이후: 대기를 합산하지 않고 lastTrainEnded (목요일 23:50, 1호선 소요산 down 막차 2347)', () => {
    const soyosan = findStationByNameAndLine('소요산', '1');
    const dongducheon = findStationByNameAndLine('동두천', '1');
    if (!soyosan || !dongducheon) throw new Error('fixture station missing');
    const route: NonNullable<Route> = {
      type: 'transfer',
      transferName: '소요산',
      fromLine: '3', // 도보 fallback 180s + buffer 20s 경로를 쓰기 위한 임의 fromLine
      toLine: '1',
      stopsToTransfer: 0,
      stopsFromTransfer: 2,
      secondsToTransfer: 0,
      secondsFromTransfer: 240,
      destinationStationId: dongducheon.id,
    };
    const eta = computeJourneyEta({ route, nowMs: kstMs(2026, 10, 29, 23, 50), excludeOriginWait: true });
    expect(eta.lastTrainEnded).toBe(true);
    expect(eta.waits[0]).toMatchObject({ source: 'ended', seconds: 0 });
    expect(eta.minutes).toBe(7); // 도보 180 + buffer 20 + 주행 240 = 440초, 대기 0
  });
});

describe('computeJourneyEta — 출발 대기 / 도보 / 직통', () => {
  const direct = makeDirectRoute(5, '2'); // 600초
  const noon = kstMs(2026, 10, 28, 12, 0);

  it('excludeOriginWait면 출발 대기 없음 (주행만)', () => {
    const eta = computeJourneyEta({ route: direct, nowMs: noon, excludeOriginWait: true });
    expect(eta.waits).toEqual([]);
    expect(eta.minutes).toBe(10);
  });

  it('출발 실시간 슬롯이 있으면 그 값 (DEFAULT 3분 아님)', () => {
    const eta = computeJourneyEta({ route: direct, nowMs: noon, originRealtimeWaitSeconds: 90 });
    expect(eta.waits).toEqual([{ kind: 'origin', line: '2', stationName: null, source: 'realtime', seconds: 90 }]);
    expect(eta.minutes).toBe(12); // 600+90 = 690초 = 11.5분 → 12
  });

  it('출발 실시간이 없으면 출발 노선 배차간격/2 (2호선 평일 offPeak 135s)', () => {
    const eta = computeJourneyEta({ route: direct, nowMs: noon });
    expect(eta.waits).toEqual([{ kind: 'origin', line: '2', stationName: null, source: 'headway', seconds: 135 }]);
    expect(eta.minutes).toBe(12); // 735초 = 12.25분
  });

  it('출발역 시간표 슬롯(originStop)이 있으면 시간표 (PR-B 방향 입력용)', () => {
    const eta = computeJourneyEta({
      route: direct,
      nowMs: kstMs(2026, 10, 28, 6, 39, 29),
      originStop: { stationName: '건대입구', line: '2', direction: 'down' },
    });
    expect(eta.waits).toEqual([
      { kind: 'origin', line: '2', stationName: '건대입구', source: 'timetable', seconds: 91 },
    ]);
  });

  it('출발·하차 도보 초가 합산된다', () => {
    const eta = computeJourneyEta({
      route: direct,
      nowMs: noon,
      excludeOriginWait: true,
      originWalkSeconds: 120,
      destinationWalkSeconds: 60,
    });
    expect(eta.minutes).toBe(13); // 600+120+60 = 780초
  });

  it('상수 3분은 사라졌다: 어떤 입력에서도 대기 합산이 180초 고정이 아니다', () => {
    const eta = computeJourneyEta({ route: direct, nowMs: noon });
    expect(eta.waits[0].seconds).not.toBe(180);
  });
});

describe('computeJourneyEta — 환승 실시간 boardable 후보 (#1480 PR-D)', () => {
  const arriveKun = kstMs(2026, 10, 28, 6, 34, 21);
  const nowMs = nowForTransferArrival(arriveKun);
  const platformMs = arriveKun + (278 + 30) * 1000; // 도보 278 + buffer 30
  const base = { route: trip179Route, nowMs, excludeOriginWait: true } as const;

  it('T_platform 이전 도착은 건너뛰고 첫 boardable 열차를 고른다', () => {
    const eta = computeJourneyEta({
      ...base,
      transferBoardableArrivalsMs: [[platformMs - 60_000, platformMs + 240_000, platformMs + 600_000]],
    });
    expect(eta.waits).toEqual([
      { kind: 'transfer', line: '2', stationName: '건대입구', source: 'realtime', seconds: 240 },
    ]);
    expect(eta.lookups).toEqual([]);
  });

  it('T_platform과 정확히 같은 도착은 탈 수 있다(경계 포함)', () => {
    const eta = computeJourneyEta({ ...base, transferBoardableArrivalsMs: [[platformMs]] });
    expect(eta.waits[0]).toMatchObject({ source: 'realtime', seconds: 0 });
  });

  it('후보 순서와 무관하게 가장 이른 boardable을 고른다', () => {
    const eta = computeJourneyEta({
      ...base,
      transferBoardableArrivalsMs: [[platformMs + 600_000, platformMs + 120_000]],
    });
    expect(eta.waits[0]).toMatchObject({ source: 'realtime', seconds: 120 });
  });

  it('boardable 후보가 하나도 없으면(전부 platform 이전) 시간표로 폴백', () => {
    const eta = computeJourneyEta({ ...base, transferBoardableArrivalsMs: [[platformMs - 1_000]] });
    expect(eta.waits[0]).toMatchObject({ source: 'timetable', seconds: 91 });
  });

  it('슬롯이 null/빈 배열이면 입력 없음과 동치(시간표)', () => {
    const plain = computeJourneyEta(base);
    expect(computeJourneyEta({ ...base, transferBoardableArrivalsMs: [null] })).toEqual(plain);
    expect(computeJourneyEta({ ...base, transferBoardableArrivalsMs: [[]] })).toEqual(plain);
    expect(plain.waits[0].source).toBe('timetable');
  });
});
