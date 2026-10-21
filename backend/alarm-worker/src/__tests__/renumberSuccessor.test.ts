/**
 * #3158 — 2호선 성수 renumber 시간표 후속 재부착: 순수 판정 단위 테스트.
 * 스펙(이슈/리서치)에서 도출한 기대값만 쓴다. 시간표 오라클은 리서치 §1.2 표(관측 9건 + 모호 해소 2건):
 *   평일 외선 2009 -> 2045(3009->3045), 내선 2012 -> 2048(3012->3048), 외선 2007 -> 2041, 내선 2014 -> 2052.
 */
import { describe, expect, it } from 'vitest';
import {
  RENUMBER_ARM_TTL_MS,
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

  it('거부: 시간표 종착~시발 시각에서 시간창 밖이면 null (같은 번호의 다른 시간대 오발 방지)', () => {
    expect(lookupRenumberSuccessor('2', '3009', kst(10, 21, 12, 0))).toBeNull();
    expect(lookupRenumberSuccessor('2', '3009', kst(10, 21, 6, 0))).toBeNull();
  });

  it('시간표 기준일 메타가 JSON에 담겨 있다', () => {
    expect(RENUMBER_TIMETABLE_BASE_DATE).toMatch(/^\d{8}$/);
  });
});

describe('decideTimetableReattach — 라이브 피드 관측 AND 조건', () => {
  const base = { lockLine: '2', lockTrainCode: '3009', arm: undefined, nowMs: WEDNESDAY_0633 } as const;
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
    expect(decideTimetableReattach({ lockLine: '2', lockTrainCode: '1509', arm, positions, nowMs: WEDNESDAY_0633 })).toMatchObject({ ok: true, fromCode: '3009', successorCode: '3045' });
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
    expect(shouldDeferVanishSwap({ ...base, nowMs: kst(10, 21, 12, 0), missCount: 2 })).toBe(false);
  });

  it('vanish-swap이 옮긴 뒤에도(표식) 원 열차 항목으로 판정', () => {
    const arm = { from: '3009', swappedTo: '1509', armedAt: WEDNESDAY_0633 };
    expect(shouldDeferVanishSwap({ ...base, lockTrainCode: '1509', arm, missCount: 2 })).toBe(true);
  });
});
