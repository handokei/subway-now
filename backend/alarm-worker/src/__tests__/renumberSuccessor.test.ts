/**
 * #3158 — 2호선 성수 renumber 시간표 후속 재부착: 순수 판정 단위 테스트.
 * 스펙(이슈/리서치)에서 도출한 기대값만 쓴다. 시간표 오라클은 리서치 §1.2 표(관측 9건 + 모호 해소 2건):
 *   평일 외선 2009 -> 2045(3009->3045), 내선 2012 -> 2048(3012->3048), 외선 2007 -> 2041, 내선 2014 -> 2052.
 */
import { describe, expect, it } from 'vitest';
import {
  RENUMBER_ARM_TTL_MS,
  checkRenumberLeg,
  legDirectionOf,
  RENUMBER_SWAP_DEFER_TICKS,
  shouldDeferVanishSwap,
  RENUMBER_OBSERVATION_MAX_AGE_MS,
  RENUMBER_TIMETABLE_BASE_DATE,
  decideTimetableReattach,
  kstDayType,
  lookupRenumberSuccessor,
  nextRenumberArm,
  resolveRenumberOrigin,
} from '../renumberSuccessor';
import type { PositionEntry } from '../seoul';
import successorData from '../data/line2RenumberSuccessors.json';
import type { Trip } from '../types';

/** KST 벽시계 -> epoch ms. 2026-10-21=수, 2026-10-24=토, 2026-10-25=일. */
function kst(month: number, day: number, hour: number, min: number, sec = 0): number {
  return Date.UTC(2026, month - 1, day, hour - 9, min, sec);
}

const WEDNESDAY_0633 = kst(10, 21, 6, 33, 30);
const SATURDAY_0633 = kst(10, 24, 6, 33, 30);

function pos(trainCode: string, over: Partial<PositionEntry> & { at?: number } = {}): PositionEntry {
  const { at, ...rest } = over;
  return {
    trainCode,
    stationName: '성수',
    trainSttus: 2,
    isUp: false,
    recptnMs: at ?? WEDNESDAY_0633 - 5_000,
    terminus: '성수',
    ...rest,
  };
}

describe('kstDayType', () => {
  it('KST 요일로 평일/주말을 가른다 (UTC 자정 경계가 아니라 KST 기준)', () => {
    expect(kstDayType(WEDNESDAY_0633)).toBe('weekday');
    expect(kstDayType(SATURDAY_0633)).toBe('weekend');
    expect(kstDayType(kst(10, 25, 12, 0))).toBe('weekend');
    // 금요일 23:30 KST = 금요일 14:30 UTC. 토요일 00:10 KST = 금요일 15:10 UTC -> 주말.
    expect(kstDayType(kst(10, 23, 23, 30))).toBe('weekday');
    expect(kstDayType(kst(10, 24, 0, 10))).toBe('weekend');
  });
});

describe('lookupRenumberSuccessor — 시간표 오라클(리서치 §1.2)', () => {
  it.each([
    ['3009', '3045', false, kst(10, 21, 6, 33, 30)],
    ['3012', '3048', true, kst(10, 21, 6, 30, 0)],
    ['2005', '2039', false, kst(10, 21, 6, 21, 0)],
    ['2010', '2044', true, kst(10, 21, 6, 23, 30)],
    ['2007', '2041', false, kst(10, 21, 6, 33, 0)], // 모호 해소(3047 아님)
    ['2014', '2052', true, kst(10, 21, 6, 37, 0)], // 모호 해소(3054 아님)
  ])('평일 %s -> %s (isUp=%s)', (from, expected, isUp, now) => {
    expect(lookupRenumberSuccessor('2', from, now)).toMatchObject({ fromCode: from, successorCode: expected, isUp, dayType: 'weekday' });
  });

  it('prefix(2|3)는 소멸 열차 것을 보존한다 — 3009->3045, 2009->2045', () => {
    expect(lookupRenumberSuccessor('2', '2009', WEDNESDAY_0633)?.successorCode).toBe('2045');
    expect(lookupRenumberSuccessor('2', '3009', WEDNESDAY_0633)?.successorCode).toBe('3045');
  });

  it('주말 시간표는 평일과 번호 체계가 다르다 — 같은 3009가 3039로 이어진다', () => {
    expect(lookupRenumberSuccessor('2', '3009', SATURDAY_0633)).toMatchObject({ successorCode: '3039', dayType: 'weekend' });
  });

  it('거부: 2호선이 아니면 조회하지 않는다', () => {
    expect(lookupRenumberSuccessor('7', '3009', WEDNESDAY_0633)).toBeNull();
    expect(lookupRenumberSuccessor('1', '2009', WEDNESDAY_0633)).toBeNull();
  });

  it('거부: 시간표 항목이 없는 번호(차고지 입출고/지선/형식 불일치)는 null', () => {
    expect(lookupRenumberSuccessor('2', '2999', WEDNESDAY_0633)).toBeNull();
    expect(lookupRenumberSuccessor('2', '1509', WEDNESDAY_0633)).toBeNull(); // 지선 prefix
    expect(lookupRenumberSuccessor('2', '009', WEDNESDAY_0633)).toBeNull();
    expect(lookupRenumberSuccessor('2', '', WEDNESDAY_0633)).toBeNull();
  });

  it('시각과 무관하다 — 저녁 +14분 어긋남(10/28 17:13, 3286 -> 3324)에도 후속을 돌려준다', () => {
    expect(lookupRenumberSuccessor('2', '3286', kst(10, 28, 17, 13, 45))).toMatchObject({ successorCode: '3324', isUp: true });
    // 같은 번호는 시간대와 무관하게 같은 후속 (키당 시간표 항목 1개, 시간창은 판별에 기여하지 않는다).
    expect(lookupRenumberSuccessor('2', '3009', kst(10, 21, 12, 0))?.successorCode).toBe('3045');
    expect(lookupRenumberSuccessor('2', '3009', kst(10, 21, 6, 0))?.successorCode).toBe('3045');
  });

  it.each(['weekday', 'weekend'] as const)('데이터 불변식: %s 표는 키당 항목이 정확히 1개다 (시간창을 지운 근거)', (dayType) => {
    const tables = (successorData as { tables: Record<string, Record<string, unknown[]>> }).tables[dayType];
    expect(Object.keys(tables).length).toBeGreaterThan(0);
    for (const [key, entries] of Object.entries(tables)) {
      expect({ key, count: entries.length }).toEqual({ key, count: 1 });
    }
  });

  it('시간표 기준일 메타가 JSON에 담겨 있다', () => {
    expect(RENUMBER_TIMETABLE_BASE_DATE).toMatch(/^\d{8}$/);
  });
});

describe('decideTimetableReattach — 라이브 피드 관측 AND 조건', () => {
  const base = { lockLine: '2', lockTrainCode: '3009', arm: undefined, nowMs: WEDNESDAY_0633, legDirection: 'down' } as const;
  const successorRow = pos('3045', { terminus: '성수종착' });

  it('lock 열차 소멸 + 후속이 같은 방향·신선하게 관측 -> 허용', () => {
    expect(decideTimetableReattach({ ...base, positions: [successorRow] })).toEqual({
      ok: true,
      fromCode: '3009',
      successorCode: '3045',
      dayType: 'weekday',
    });
  });

  it('lock 열차가 아직 성수 종착으로 표시된 채 남아 있어도(후속 관측 시) 허용', () => {
    const lockRow = pos('3009', { stationName: '건대입구', terminus: '성수' });
    expect(decideTimetableReattach({ ...base, positions: [lockRow, successorRow] })).toMatchObject({ ok: true, successorCode: '3045' });
  });

  it('거부(사유): 후속이 피드에 없으면 table 재부착 없음 -> 기존 vanish-swap에 맡긴다', () => {
    expect(decideTimetableReattach({ ...base, positions: [pos('3047')] })).toEqual({ ok: false, reason: 'successor-not-observed' });
  });

  it('거부(사유): 후속이 반대 방향(isUp)으로만 관측되면 불허', () => {
    expect(decideTimetableReattach({ ...base, positions: [pos('3045', { isUp: true })] })).toEqual({ ok: false, reason: 'successor-not-observed' });
  });

  it('거부(사유): 후속 행 수신이 오래되면(stale) 불허', () => {
    const stale = pos('3045', { at: WEDNESDAY_0633 - RENUMBER_OBSERVATION_MAX_AGE_MS - 1_000 });
    expect(decideTimetableReattach({ ...base, positions: [stale] })).toEqual({ ok: false, reason: 'successor-not-observed' });
  });

  it('거부(사유): lock 열차가 성수 종착이 아닌 채 운행 중이면 불허 (아직 번호가 안 바뀜)', () => {
    const lockRow = pos('3009', { stationName: '건대입구', terminus: '신도림' });
    expect(decideTimetableReattach({ ...base, positions: [lockRow, successorRow] })).toEqual({ ok: false, reason: 'lock-train-still-running' });
  });

  it('거부(사유): 신선한 피드가 없으면 불허', () => {
    expect(decideTimetableReattach({ ...base, positions: null })).toEqual({ ok: false, reason: 'no-fresh-feed' });
  });

  it('거부(사유): 2호선이 아니면 조회 없이 불허 (7호선에 3045가 있어도)', () => {
    expect(decideTimetableReattach({ ...base, lockLine: '7', positions: [successorRow] })).toEqual({ ok: false, reason: 'not-renumber-line' });
  });

  it('거부(사유): 시간표 항목 없는 번호는 불허 -> 기존 동작', () => {
    expect(decideTimetableReattach({ ...base, lockTrainCode: '2999', positions: [successorRow] })).toEqual({ ok: false, reason: 'no-table-entry' });
  });

  it('거부(사유): 주말 시간표 불일치 — 토요일 같은 시각에 3045가 보여도 주말 후속(3039)이 아니므로 불허', () => {
    const satRow = pos('3045', { at: SATURDAY_0633 - 5_000 });
    expect(decideTimetableReattach({ ...base, nowMs: SATURDAY_0633, positions: [satRow] })).toEqual({ ok: false, reason: 'successor-not-observed' });
    const satSuccessor = pos('3039', { at: SATURDAY_0633 - 5_000 });
    expect(decideTimetableReattach({ ...base, nowMs: SATURDAY_0633, positions: [satSuccessor] })).toMatchObject({ ok: true, successorCode: '3039', dayType: 'weekend' });
  });
});

describe('vanish-swap 정정 표식 (RenumberArm)', () => {
  it('vanish-swap이 옮긴 lock이면 원 열차(from)로 시간표를 조회한다', () => {
    const arm = { from: '3009', swappedTo: '1509', armedAt: WEDNESDAY_0633 - 30_000 };
    expect(resolveRenumberOrigin('1509', arm, WEDNESDAY_0633)).toBe('3009');
    const positions = [pos('3045', { terminus: '성수종착' })];
    expect(decideTimetableReattach({ lockLine: '2', lockTrainCode: '1509', arm, positions, nowMs: WEDNESDAY_0633, legDirection: 'down' })).toMatchObject({ ok: true, fromCode: '3009', successorCode: '3045' });
  });

  it('거부: lock이 swappedTo와 다르면(그 사이 사용자 탭 등) 표식은 무시 — 불간섭', () => {
    const arm = { from: '3009', swappedTo: '1509', armedAt: WEDNESDAY_0633 - 30_000 };
    expect(resolveRenumberOrigin('3011', arm, WEDNESDAY_0633)).toBe('3011');
  });

  it('거부: 표식 TTL이 지나면 무시', () => {
    const arm = { from: '3009', swappedTo: '1509', armedAt: WEDNESDAY_0633 - RENUMBER_ARM_TTL_MS - 1 };
    expect(resolveRenumberOrigin('1509', arm, WEDNESDAY_0633)).toBe('1509');
  });

  it('nextRenumberArm: 번호 변경 열차가 vanish-swap되면 표식을 남긴다', () => {
    expect(nextRenumberArm('2', undefined, '3009', '1509', WEDNESDAY_0633)).toEqual({ from: '3009', swappedTo: '1509', armedAt: WEDNESDAY_0633 });
  });

  it('nextRenumberArm: 연쇄 swap은 from/armedAt을 유지하고 swappedTo만 갱신', () => {
    const prev = { from: '3009', swappedTo: '1509', armedAt: WEDNESDAY_0633 - 10_000 };
    expect(nextRenumberArm('2', prev, '1509', '3011', WEDNESDAY_0633)).toEqual({ from: '3009', swappedTo: '3011', armedAt: prev.armedAt });
  });

  it('nextRenumberArm: 항목 없는 열차/타 노선은 표식 없음(기존 필드 불변)', () => {
    expect(nextRenumberArm('2', undefined, '2999', '3001', WEDNESDAY_0633)).toBeUndefined();
    expect(nextRenumberArm('7', undefined, '3009', '3011', WEDNESDAY_0633)).toBeUndefined();
  });
});

describe('shouldDeferVanishSwap — 시간표 후속 대기 유예', () => {
  const base = { lockLine: '2', lockTrainCode: '3009', arm: undefined, swapThreshold: 2, nowMs: WEDNESDAY_0633 } as const;

  it('항목 있는 열차: 임계~임계+유예 직전 miss까지 유예', () => {
    expect(shouldDeferVanishSwap({ ...base, missCount: 2 })).toBe(true);
    expect(shouldDeferVanishSwap({ ...base, missCount: 3 })).toBe(true);
  });

  it('거부: 유예가 끝나면(후속 미출현) 기존 vanish-swap으로 폴백', () => {
    expect(shouldDeferVanishSwap({ ...base, missCount: 2 + RENUMBER_SWAP_DEFER_TICKS })).toBe(false);
    expect(shouldDeferVanishSwap({ ...base, missCount: 9 })).toBe(false);
  });

  it('거부: 시간표 항목이 없으면(번호/노선/시간창) 즉시 기존 동작', () => {
    expect(shouldDeferVanishSwap({ ...base, lockTrainCode: '2999', missCount: 2 })).toBe(false);
    expect(shouldDeferVanishSwap({ ...base, lockLine: '7', missCount: 2 })).toBe(false);
  });

  it('시각과 무관하게 유예한다 — 저녁 어긋남(17:15)에도 항목이 있으면 유예 (시간창 삭제)', () => {
    expect(shouldDeferVanishSwap({ ...base, lockTrainCode: '3286', nowMs: kst(10, 28, 17, 15, 45), missCount: 2 })).toBe(true);
  });

  it('vanish-swap이 옮긴 뒤에도(표식) 원 열차 항목으로 판정', () => {
    const arm = { from: '3009', swappedTo: '1509', armedAt: WEDNESDAY_0633 };
    expect(shouldDeferVanishSwap({ ...base, lockTrainCode: '1509', arm, missCount: 2 })).toBe(true);
  });
});

// ── #3158 B: 시간표 후속 재부착 게이트 (G1 성수 leg / G2 방향 / G3 인접성 / G4 leg당 1회) ──

const SEONGSU_LEG = ['성수', '건대입구']; // 성수 -> 건대입구 = 내선(up)
const SEONGSU_OUTER_LEG = ['성수', '뚝섬', '한양대']; // 성수 -> 한양대 = 외선(down)

function lockOn(trainCode: string, segmentStations: readonly string[], line = '2') {
  return { line, trainCode, segmentStations };
}
function tripOf(over: Partial<Trip> = {}): Trip {
  return { token: 'tok', waypoints: [], ...over } as unknown as Trip;
}
const EVENING_1713 = kst(10, 28, 17, 13, 45);

describe('legDirectionOf — lock이 달린 leg의 진행 방향', () => {
  it('segmentStations 양 끝으로 추론 (성수->건대입구 = up, 성수->한양대 = down)', () => {
    expect(legDirectionOf(tripOf(), lockOn('3286', SEONGSU_LEG))).toBe('up');
    expect(legDirectionOf(tripOf(), lockOn('3009', SEONGSU_OUTER_LEG))).toBe('down');
  });

  it('segmentStations가 1개뿐이면 leg 앵커(originStationName) -> 그 역으로 추론', () => {
    expect(legDirectionOf(tripOf({ originStationName: '성수' }), lockOn('3286', ['건대입구']))).toBe('up');
  });

  it('거부: 1개뿐인데 앵커도 없으면 null (fail-closed)', () => {
    expect(legDirectionOf(tripOf(), lockOn('3286', ['건대입구']))).toBeNull();
  });
});

describe('checkRenumberLeg — leg 게이트 (사유 assert)', () => {
  it('통과: 성수 포함 leg + 시간표 방향 == leg 방향 + 이력 없음 (10/28 3286, 성수->건대입구)', () => {
    expect(checkRenumberLeg(tripOf(), lockOn('3286', SEONGSU_LEG), EVENING_1713)).toEqual({ ok: true });
  });

  it('G1-OR 통과: seg=[건대입구]만이어도 leg 앵커가 성수면 성수 leg', () => {
    expect(checkRenumberLeg(tripOf({ originStationName: '성수' }), lockOn('3286', ['건대입구']), EVENING_1713)).toEqual({ ok: true });
  });

  it('G1 거부: leg에 성수가 없으면 no-renumber-station-on-leg (같은 번호 우연 일치 방어)', () => {
    expect(checkRenumberLeg(tripOf({ originStationName: '강남' }), lockOn('3286', ['강남', '건대입구']), EVENING_1713)).toEqual({
      ok: false,
      reason: 'no-renumber-station-on-leg',
    });
  });

  it('G2 거부: lock 열차 시간표 방향(내선)과 leg 방향(외선)이 다르면 direction-mismatch (10/3 3174->3212)', () => {
    expect(checkRenumberLeg(tripOf(), lockOn('3286', SEONGSU_OUTER_LEG), EVENING_1713)).toEqual({ ok: false, reason: 'direction-mismatch' });
  });

  it('G2 거부: leg 방향을 못 구하면 direction-mismatch (fail-closed)', () => {
    expect(checkRenumberLeg(tripOf({ originStationName: '성수' }), lockOn('3286', ['성수']), EVENING_1713)).toEqual({
      ok: false,
      reason: 'direction-mismatch',
    });
  });

  it('G2: vanish-swap 표식이 있으면 원 열차(from) 시간표 방향으로 비교한다', () => {
    const arm = { from: '3286', swappedTo: '2288', armedAt: EVENING_1713 - 30_000 };
    expect(checkRenumberLeg(tripOf({ renumberSuccessor: arm }), lockOn('2288', SEONGSU_LEG), EVENING_1713)).toEqual({ ok: true });
    expect(checkRenumberLeg(tripOf({ renumberSuccessor: arm }), lockOn('2288', SEONGSU_OUTER_LEG), EVENING_1713)).toEqual({
      ok: false,
      reason: 'direction-mismatch',
    });
  });

  it('G4 거부: 이력 열차의 시간표 후속이 현재 lock이면(이미 번호를 바꾼 같은 열차) already-reattached-this-leg', () => {
    expect(checkRenumberLeg(tripOf({ lockCodeHistory: ['3286'] }), lockOn('3324', SEONGSU_LEG), EVENING_1713)).toEqual({
      ok: false,
      reason: 'already-reattached-this-leg',
    });
  });

  it('G4: 이력에 무관한 열차만 있으면 통과 (vanish-swap으로 옮겨진 lock의 정정은 허용)', () => {
    expect(checkRenumberLeg(tripOf({ lockCodeHistory: ['3286'] }), lockOn('2288', SEONGSU_LEG), EVENING_1713)).toEqual({ ok: true });
  });

  it('시간표 항목이 없는 lock(지선 1509 등)은 비교 대상이 없어 게이트를 막지 않는다 (후속 조회가 따로 null)', () => {
    expect(checkRenumberLeg(tripOf(), lockOn('1509', SEONGSU_LEG), EVENING_1713)).toEqual({ ok: true });
  });
});

describe('decideTimetableReattach — G2 방향 / G3 인접성', () => {
  const base = { lockLine: '2', lockTrainCode: '3286', arm: undefined, nowMs: EVENING_1713 } as const;
  const successor = (over: Partial<PositionEntry> = {}) =>
    pos('3324', { isUp: true, terminus: '성수종착', at: EVENING_1713 - 5_000, ...over });

  it('통과: 후속 3324가 성수(내선)에 관측 + leg 방향 up (10/28)', () => {
    expect(decideTimetableReattach({ ...base, legDirection: 'up', positions: [successor()] })).toMatchObject({ ok: true, successorCode: '3324' });
  });

  it('통과: 후속이 leg 방향 다음 역(건대입구)까지 나아간 상태여도 인접으로 본다', () => {
    expect(decideTimetableReattach({ ...base, legDirection: 'up', positions: [successor({ stationName: '건대입구' })] })).toMatchObject({ ok: true });
  });

  it('G2 거부(사유): leg 방향이 시간표 방향과 다르면 direction-mismatch', () => {
    expect(decideTimetableReattach({ ...base, legDirection: 'down', positions: [successor()] })).toEqual({ ok: false, reason: 'direction-mismatch' });
  });

  it('G2 거부(사유): leg 방향 미상이면 direction-mismatch (fail-closed)', () => {
    expect(decideTimetableReattach({ ...base, legDirection: null, positions: [successor()] })).toEqual({ ok: false, reason: 'direction-mismatch' });
  });

  it('G3 거부(사유): 후속이 성수·다음 역이 아닌 먼 역에 있으면 successor-not-adjacent (번호 재사용 열차)', () => {
    expect(decideTimetableReattach({ ...base, legDirection: 'up', positions: [successor({ stationName: '잠실' })] })).toEqual({
      ok: false,
      reason: 'successor-not-adjacent',
    });
  });

  it('G3: 후속이 아예 없으면 기존 사유 successor-not-observed', () => {
    expect(decideTimetableReattach({ ...base, legDirection: 'up', positions: [pos('3290', { isUp: true })] })).toEqual({
      ok: false,
      reason: 'successor-not-observed',
    });
  });
});
