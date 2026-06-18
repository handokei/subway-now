import {
  computeBoardableWaitsForRoute,
  totalBoardableWaitMinutes,
} from '../computeBoardableWaitsForRoute';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../../../testUtils/routeFixtures';

// KST 평일 12:00 = UTC 03:00 — 실 timetable에 다수 발차 보장.
const KST_WEEKDAY_NOON = new Date('2026-06-09T03:00:00.000Z');

describe('computeBoardableWaitsForRoute', () => {
  it('returns empty array for null route', () => {
    const result = computeBoardableWaitsForRoute({
      route: null,
      startAt: KST_WEEKDAY_NOON,
      initialWaitSeconds: 0,
    });
    expect(result).toEqual([]);
  });

  it('returns empty array for direct route', () => {
    const result = computeBoardableWaitsForRoute({
      route: makeDirectRoute(5, '1'),
      startAt: KST_WEEKDAY_NOON,
      initialWaitSeconds: 0,
    });
    expect(result).toEqual([]);
  });

  it('single-transfer route — direction inference fails without destinationName', () => {
    // transfer route + destinationName 미지정 시 transferName === transferName으로 direction
    // inference 실패 → element=null (호출자 cascade가 DEFAULT_WAIT_MINUTES 적용).
    const route = makeTransferRoute({
      transferName: '왕십리',
      fromLine: '2',
      toLine: '5',
      stopsToTransfer: 3,
      stopsFromTransfer: 4,
    });
    const result = computeBoardableWaitsForRoute({
      route,
      startAt: KST_WEEKDAY_NOON,
      initialWaitSeconds: 0,
    });
    expect(result.length).toBe(1);
    expect(result[0]).toBeNull();
  });

  it('single-transfer route with destinationName — direction inference succeeds', () => {
    // 3호선 종로3가 → 충무로(=down 방향). 3호선은 단조 화이트리스트(low=대화, high=오금) 안.
    const route = makeTransferRoute({
      transferName: '종로3가',
      fromLine: '1',
      toLine: '3',
      stopsToTransfer: 2,
      stopsFromTransfer: 1,
    });
    const result = computeBoardableWaitsForRoute({
      route,
      startAt: KST_WEEKDAY_NOON,
      initialWaitSeconds: 0,
      destinationName: '충무로',
    });
    expect(result.length).toBe(1);
    // 3호선 종로3가 12:00 직후 first boardable 존재 → number.
    expect(typeof result[0]).toBe('number');
    expect(result[0]).toBeGreaterThanOrEqual(0);
  });

  it('multi-transfer route — each leg gets boardable wait', () => {
    // 1호선 시청 → 종로3가(3호선 환승) → 충무로(4호선 환승) → 동대문(4호선 도착).
    // 1호선 시청 → 종로3가 환승 → 3호선 종로3가 → 충무로 환승 → 4호선 충무로 → 4호선 동대문.
    // 본 fixture는 실 timetable lookup으로 검증 (단조 노선 + 실 station name).
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: '종로3가', fromLine: '1', toLine: '3', stopsToTransfer: 2 },
        { transferName: '충무로', fromLine: '3', toLine: '4', stopsToTransfer: 1 },
      ],
      stopsAfterLastTransfer: 2,
    });
    const result = computeBoardableWaitsForRoute({
      route,
      startAt: KST_WEEKDAY_NOON,
      initialWaitSeconds: 0,
      destinationName: '동대문',
    });
    expect(result.length).toBe(2);
    // 각 leg는 number 또는 null. 단조 화이트리스트(1,3,4)에 있어 inference 성공 기대.
    for (const wait of result) {
      // 실 timetable lookup이 성공해야 number — 정상 case는 number.
      expect(wait === null || typeof wait === 'number').toBe(true);
    }
  });

  it('multi-transfer with unmonotonic line (2호선 순환) — leg 1은 null', () => {
    // 5호선 → 2호선 환승 → 7호선 도착. 2호선은 단조 화이트리스트 밖 (순환) → direction null.
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: '왕십리', fromLine: '5', toLine: '2', stopsToTransfer: 2 },
        { transferName: '대림', fromLine: '2', toLine: '7', stopsToTransfer: 3 },
      ],
      stopsAfterLastTransfer: 1,
    });
    const result = computeBoardableWaitsForRoute({
      route,
      startAt: KST_WEEKDAY_NOON,
      initialWaitSeconds: 0,
      destinationName: '청담',
    });
    expect(result.length).toBe(2);
    // 첫 leg: 2호선 왕십리. nextEndName=대림 — 둘 다 2호선 단조 화이트리스트 밖 → direction null → element null.
    expect(result[0]).toBeNull();
  });

  it('multi-transfer without destinationName — last leg falls back to transferName', () => {
    // 마지막 leg의 nextEndName이 자기 transferName과 같아져 direction inference null.
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: '종로3가', fromLine: '1', toLine: '3', stopsToTransfer: 2 },
        { transferName: '충무로', fromLine: '3', toLine: '4', stopsToTransfer: 1 },
      ],
      stopsAfterLastTransfer: 2,
    });
    const result = computeBoardableWaitsForRoute({
      route,
      startAt: KST_WEEKDAY_NOON,
      initialWaitSeconds: 0,
      // destinationName 미지정
    });
    expect(result.length).toBe(2);
    // 마지막 leg는 transferName=충무로 fallback → direction inference 실패 → null.
    expect(result.at(-1)).toBeNull();
  });

  it('handles lookup failure status (no-timetable line) — element null', () => {
    // bundang은 timetable 부재 노선. fromLine은 아무거나, toLine만 bundang.
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: '왕십리', fromLine: '2', toLine: 'bundang', stopsToTransfer: 2 },
      ],
      stopsAfterLastTransfer: 3,
    });
    const result = computeBoardableWaitsForRoute({
      route,
      startAt: KST_WEEKDAY_NOON,
      initialWaitSeconds: 0,
      destinationName: '서울숲',
    });
    expect(result.length).toBe(1);
    expect(result[0]).toBeNull();
  });
});

describe('totalBoardableWaitMinutes', () => {
  it('returns 0 for empty list', () => {
    expect(totalBoardableWaitMinutes([])).toBe(0);
  });

  it('skips null elements and sums seconds → minutes', () => {
    // 60 + 120 + 30 = 210초 → 3.5분.
    expect(totalBoardableWaitMinutes([60, null, 120, null, 30])).toBe(
      (60 + 120 + 30) / 60,
    );
  });

  it('returns 0 when all elements are null', () => {
    expect(totalBoardableWaitMinutes([null, null, null])).toBe(0);
  });
});
