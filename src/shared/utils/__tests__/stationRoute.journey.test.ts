import {
  calculateEtaDetail,
  calculateETA,
  calculateStaticEtaDetail,
  calculateStaticETA,
} from '../stationRoute';
import type { Route } from '../stationRoute';
import { etaDisplayKind } from '../journeyTimeline';
import { makeDirectRoute, makeTransferRoute } from '../../../testUtils/routeFixtures';

// #1480 PR-C — calculateStaticETA / calculateETA가 journeyTimeline 엔진에 위임한다.
// 고정 3분(DEFAULT_WAIT_MINUTES) 폐기: 모든 케이스는 nowMs를 KST로 고정 주입한다.

const noon = Date.UTC(2026, 9, 28, 3, 0, 0); // 수요일 12:00 KST
const direct = makeDirectRoute(5, '2'); // 주행 600초

describe('calculateStaticETA — 엔진 위임', () => {
  it('출발 실시간이 없으면 3분 고정이 아니라 노선 배차간격/2 (2호선 평일 offPeak 135s → 600+135=735s → 12분)', () => {
    expect(calculateStaticETA(direct, { nowMs: noon })).toBe(12);
  });

  it('출발 실시간이 fresh하면 그 값 (90초 → 690초 → 12분)', () => {
    expect(
      calculateStaticETA(direct, { nowMs: noon, arrivalAtOrigin: { arrivalSeconds: 90, receivedAtMs: noon - 5_000 } }),
    ).toBe(12);
    expect(
      calculateStaticETA(direct, { nowMs: noon, arrivalAtOrigin: { arrivalSeconds: 30, receivedAtMs: noon - 5_000 } }),
    ).toBe(11);
  });

  it('stale 출발 실시간(>60s)은 버리고 배차간격/2', () => {
    expect(
      calculateStaticETA(direct, { nowMs: noon, arrivalAtOrigin: { arrivalSeconds: 30, receivedAtMs: noon - 120_000 } }),
    ).toBe(12);
  });

  it('excludeOriginWait면 주행만', () => {
    expect(calculateStaticETA(direct, { nowMs: noon, excludeOriginWait: true })).toBe(10);
  });

  it('환승 대기는 환승역 실시간(arrivalsAtTransfers) fresh → 우선', () => {
    const route = makeTransferRoute({
      transferName: '홍대입구',
      fromLine: '2',
      toLine: 'gyeongui',
      stopsToTransfer: 2,
      stopsFromTransfer: 3,
    });
    // 주행 240+360=600s + 도보 407 + buffer 60(>300s) + 실시간 대기 120 = 1187s → 19.8분 → 20
    expect(
      calculateStaticETA(route, {
        nowMs: noon,
        excludeOriginWait: true,
        arrivalsAtTransfers: [{ arrivalSeconds: 120, receivedAtMs: noon - 1_000 }],
      }),
    ).toBe(20);
  });

  it('route=null → null', () => {
    expect(calculateStaticETA(null, { nowMs: noon })).toBeNull();
  });

  it('onBoardableLookup으로 시간표 조회 결과가 관측된다 (방향 미상 환승 = miss)', () => {
    const route = makeTransferRoute({
      transferName: '홍대입구',
      fromLine: '2',
      toLine: 'gyeongui',
      stopsToTransfer: 2,
      stopsFromTransfer: 3,
    });
    const seen: unknown[] = [];
    calculateStaticETA(route, { nowMs: noon, excludeOriginWait: true, onBoardableLookup: (l) => seen.push(l) });
    expect(seen).toEqual([{ status: 'miss', line: 'gyeongui', stationName: '홍대입구' }]);
  });
});

describe('calculateStaticEtaDetail — 표시 플래그', () => {
  it('route=null → null', () => {
    expect(calculateStaticEtaDetail(null, { nowMs: noon })).toBeNull();
    expect(calculateStaticEtaDetail(null)).toBeNull(); // options 기본값
  });

  it('운행 시간 밖(배차간격 closed)이면 waitUnknown이 아니라 lastTrainEnded (#1480)', () => {
    const route = makeTransferRoute({
      transferName: '홍대입구',
      fromLine: '2',
      toLine: 'gyeongui',
      stopsToTransfer: 2,
      stopsFromTransfer: 3,
    });
    const closed = Date.UTC(2026, 9, 27, 18, 0, 0); // 03:00 KST (배차간격 closed)
    expect(calculateStaticEtaDetail(route, { nowMs: closed, excludeOriginWait: true })).toMatchObject({
      waitUnknown: false,
      lastTrainEnded: true,
    });
  });
});

describe('calculateETA / calculateEtaDetail — 엔진 위임', () => {
  it('route 없으면 출발 대기만', () => {
    expect(calculateETA(4, null, { nowMs: noon })).toBe(4);
    expect(calculateEtaDetail(4, null, { nowMs: noon })).toBeNull();
  });

  it('직통: 출발 대기(호출자 실시간) + 주행', () => {
    expect(calculateETA(3, direct, { nowMs: noon })).toBe(13);
    expect(calculateETA(3, direct, { nowMs: noon, excludeOriginWait: true })).toBe(10);
  });

  it('환승 대기는 3분 고정이 아니라 엔진 값 (trip 179: 06:34:21 건대입구 도착 → 0641 91초)', () => {
    const route: NonNullable<Route> = {
      type: 'transfer',
      transferName: '건대입구',
      transferStationId: '7-019',
      destinationStationId: '2-010',
      fromLine: '7',
      toLine: '2',
      stopsToTransfer: 3,
      stopsFromTransfer: 2,
      secondsToTransfer: 330,
      secondsFromTransfer: 210,
    };
    const nowMs = Date.UTC(2026, 9, 28, 6, 34, 21) - 9 * 3_600_000 - 330_000;
    // 330(주행) + 278+30+91(도보·buffer·대기) + 210 = 939s = 15.65분 → 16. (고정 3분이면 330+278+180+210=998s → 17)
    expect(calculateETA(0, route, { nowMs, excludeOriginWait: true })).toBe(16);
    expect(calculateEtaDetail(0, route, { nowMs, excludeOriginWait: true })).toMatchObject({
      minutes: 16,
      waitUnknown: false,
      lastTrainEnded: false,
    });
  });
});

describe('etaDisplayKind', () => {
  it.each([
    [null, 'exact'],
    [{ waitUnknown: false, lastTrainEnded: false }, 'exact'],
    [{ waitUnknown: true, lastTrainEnded: false }, 'unknownWait'],
    [{ waitUnknown: false, lastTrainEnded: true }, 'lastTrainEnded'],
    [{ waitUnknown: true, lastTrainEnded: true }, 'lastTrainEnded'],
  ] as const)('%j → %s', (flags, kind) => {
    expect(etaDisplayKind(flags)).toBe(kind);
  });
});

describe('calculateEtaDetail — boardableArrivalsAtTransfers (#1480 PR-D)', () => {
  const route = makeTransferRoute({
    transferName: '홍대입구',
    fromLine: '2',
    toLine: 'gyeongui',
    stopsToTransfer: 2,
    stopsFromTransfer: 3,
  });
  const fresh = (arrivalSeconds: number | null, ageMs = 1_000) => ({ arrivalSeconds, receivedAtMs: noon - ageMs });
  // 환승역 도착까지 주행 240s + 도보 407 + buffer 60 = T_platform까지 707s.
  const platformSec = 240 + 407 + 60;
  const etaWith = (list: ReturnType<typeof fresh>[] | null) =>
    calculateEtaDetail(0, route, {
      nowMs: noon,
      excludeOriginWait: true,
      boardableArrivalsAtTransfers: [list],
    });

  it('fresh 후보 중 T_platform 이후 첫 열차를 대기로 쓴다 (receivedAt 기준 절대시각)', () => {
    // 후보 도착 절대시각 = noon - 1s + sec. platform = noon + 707s.
    const eta = etaWith([fresh(platformSec - 200), fresh(platformSec + 300)]); // 앞 후보는 platform 이전
    expect(eta?.waits[0]).toMatchObject({ source: 'realtime', seconds: 299 });
  });

  it('stale(>60s)·receivedAt<=0·arrivalSeconds null/음수 후보는 제외하고 폴백', () => {
    const eta = etaWith([
      fresh(platformSec + 300, 61_000),
      { arrivalSeconds: platformSec + 300, receivedAtMs: 0 },
      fresh(null),
      fresh(-5),
    ]);
    expect(eta?.waits[0].source).not.toBe('realtime');
  });

  it('후보 없음(null) → 입력 없음과 동일 결과', () => {
    const plain = calculateEtaDetail(0, route, { nowMs: noon, excludeOriginWait: true });
    expect(etaWith(null)).toEqual(plain);
  });

  it('calculateStaticEtaDetail도 같은 입력을 받는다', () => {
    const eta = calculateStaticEtaDetail(route, {
      nowMs: noon,
      excludeOriginWait: true,
      boardableArrivalsAtTransfers: [[fresh(platformSec + 300)]],
    });
    expect(eta?.waits[0]).toMatchObject({ source: 'realtime', seconds: 299 });
  });
});
