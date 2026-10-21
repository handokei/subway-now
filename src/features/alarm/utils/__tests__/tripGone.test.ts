/**
 * PR-2 (plan 2026-10-21 §2.3) — `decideTripGone`: backend가 트립 없음(404/410)을 낸 것이 "device가 스스로
 * 종료해도 되는 증거"인지 판정하는 순수 함수. 4 guard 전부 AND, 불충족 사유는 `young|lock|alarm`.
 */
import { DEFAULT_TRIP_TTL_MS } from '../../api/alarmBackend';
import { TRIP_GONE_GRACE_MS } from '../../../../shared/constants/realtime';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import { decideTripGone, hasFutureTripArrivalAlarm } from '../tripGone';

const mockGetAllScheduled = jest.fn();
jest.mock('expo-notifications', () => ({
  getAllScheduledNotificationsAsync: (...a: unknown[]) => mockGetAllScheduled(...a),
}));

const START = 1_700_000_000_000;
/** 하한(시작 + 2h + GRACE)을 막 넘긴 시각. */
const PAST_BOUND = START + DEFAULT_TRIP_TTL_MS + TRIP_GONE_GRACE_MS + 1;
const GONE_404 = { status: 'gone', code: 404 } as const;
const GONE_410 = { status: 'gone', code: 410 } as const;

const LOCK: BoardingLock = {
  trainCode: '2701',
  boardingLine: '2',
  boardedAt: PAST_BOUND - 10 * 60_000,
  expectedDurationMs: 60 * 60_000,
} as BoardingLock;
const EXPIRED_LOCK: BoardingLock = {
  ...LOCK,
  boardedAt: PAST_BOUND - 3 * 60 * 60_000,
  expectedDurationMs: 60 * 60_000,
};

const base = {
  now: PAST_BOUND,
  tripStartedAt: START,
  lock: null as BoardingLock | null,
  hasFutureArrivalAlarm: false,
};

describe('decideTripGone — 4 guard 전부 AND', () => {
  it.each([
    ['404', GONE_404],
    ['410', GONE_410],
  ])('%s + 모든 guard 통과 -> end', (_n, result) => {
    expect(decideTripGone({ ...base, result })).toEqual({ verdict: 'end' });
  });

  it('guard 2 — gone이 아닌 응답은 판정 대상이 아니다(not-gone)', () => {
    expect(
      decideTripGone({ ...base, result: { status: 'active', endedAt: null, endReason: null } }),
    ).toEqual({ verdict: 'not-gone' });
    expect(
      decideTripGone({ ...base, result: { status: 'ended', endedAt: 1, endReason: 'unknown' } }),
    ).toEqual({ verdict: 'not-gone' });
  });

  describe('guard 1 — 하한(시작 + 2h + GRACE)', () => {
    it.each([
      ['하한 직전(경계 포함 안 됨)', START + DEFAULT_TRIP_TTL_MS + TRIP_GONE_GRACE_MS],
      ['시작 직후', START + 1_000],
      ['시작 + 2h 정각(GRACE 미경과)', START + DEFAULT_TRIP_TTL_MS],
    ])('%s -> young', (_n, now) => {
      expect(decideTripGone({ ...base, now, result: GONE_404 })).toEqual({
        verdict: 'defer',
        reason: 'young',
      });
    });

    it('tripStartedAt 부재 -> young(하한을 계산할 수 없으면 종료 불가)', () => {
      expect(decideTripGone({ ...base, tripStartedAt: null, result: GONE_404 })).toEqual({
        verdict: 'defer',
        reason: 'young',
      });
    });

    it('410도 같은 하한을 따른다', () => {
      expect(decideTripGone({ ...base, now: START + 1_000, result: GONE_410 })).toEqual({
        verdict: 'defer',
        reason: 'young',
      });
    });
  });

  describe('guard 3 — 미만료 BoardingLock', () => {
    it('미만료 lock -> lock(9h force-end에 위임)', () => {
      expect(decideTripGone({ ...base, lock: LOCK, result: GONE_404 })).toEqual({
        verdict: 'defer',
        reason: 'lock',
      });
    });

    it('만료 lock은 차단하지 못한다(영구 차단 방지) -> end', () => {
      expect(decideTripGone({ ...base, lock: EXPIRED_LOCK, result: GONE_404 })).toEqual({
        verdict: 'end',
      });
    });
  });

  it('guard 4 — 미래 OS 도착 알람이 남아있으면 alarm', () => {
    expect(decideTripGone({ ...base, hasFutureArrivalAlarm: true, result: GONE_404 })).toEqual({
      verdict: 'defer',
      reason: 'alarm',
    });
  });

  it('여러 guard가 동시에 불충족이면 young이 우선(가장 약한 증거부터 설명)', () => {
    expect(
      decideTripGone({
        now: START + 1_000,
        tripStartedAt: START,
        lock: LOCK,
        hasFutureArrivalAlarm: true,
        result: GONE_404,
      }),
    ).toEqual({ verdict: 'defer', reason: 'young' });
  });
});

describe('hasFutureTripArrivalAlarm — 이 트립의 대기 중 도착 알람', () => {
  const TOKEN = 'abcdef0123456789abcdef';
  const req = (identifier: string, data: Record<string, unknown>) => ({
    identifier,
    content: { data },
  });

  beforeEach(() => mockGetAllScheduled.mockReset());

  it('safety-net destination 알람(alarm-<token>-…) -> true', async () => {
    mockGetAllScheduled.mockResolvedValue([
      req(`alarm-${TOKEN}-역삼-destination#0`, {
        channel: 'safety-net',
        tripToken: TOKEN,
        station: '역삼',
        kind: 'destination',
      }),
    ]);
    await expect(hasFutureTripArrivalAlarm(TOKEN)).resolves.toBe(true);
  });

  it('presched destination 알람(presched-<token16>-…) -> true', async () => {
    mockGetAllScheduled.mockResolvedValue([
      req(`presched-${TOKEN.slice(0, 16)}-역삼-destination#0`, {
        channel: 'presched-station',
        tripToken: TOKEN,
        station: '역삼',
        kind: 'destination',
      }),
    ]);
    await expect(hasFutureTripArrivalAlarm(TOKEN)).resolves.toBe(true);
  });

  it.each([
    ['다른 트립의 알람', `alarm-other-역삼-destination#0`, { kind: 'destination', channel: 'safety-net' }],
    ['이 트립의 중간역(transfer) 알람', `alarm-${TOKEN}-강남-transfer#0`, { kind: 'transfer', channel: 'safety-net' }],
    ['관련 없는 알림', 'trip-end-offer', { kind: 'trip-end-offer' }],
  ])('거부 — %s -> false', async (_n, identifier, data) => {
    mockGetAllScheduled.mockResolvedValue([req(identifier, data)]);
    await expect(hasFutureTripArrivalAlarm(TOKEN)).resolves.toBe(false);
  });

  it('예약 0건 -> false', async () => {
    mockGetAllScheduled.mockResolvedValue([]);
    await expect(hasFutureTripArrivalAlarm(TOKEN)).resolves.toBe(false);
  });

  it('조회 실패는 fail-closed(true) — 확인 못 하면 종료하지 않는다', async () => {
    mockGetAllScheduled.mockRejectedValue(new Error('os down'));
    await expect(hasFutureTripArrivalAlarm(TOKEN)).resolves.toBe(true);
  });
});
