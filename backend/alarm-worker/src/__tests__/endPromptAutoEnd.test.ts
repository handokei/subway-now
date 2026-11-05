/**
 * #3007 PR-1 — 질문("안내를 종료할까요?") 후 약 5분 무응답 + 계속 정지 -> 자동 종료 판정(순수 함수).
 *
 * fixture는 **합성**이다: 현재 덤프(`~/.claude/uploads/*.txt`)에는 end-prompt 실측이 없다.
 * 사용자 결정 2026-11-03: 질문 유지, 질문 후 ~5분 무응답·무이동이면 자동 종료, 움직이거나 [계속]이면 취소,
 * 앱이 꺼진 상태(기기 sync stale)여도 질문 이후 50m+ 이동 증거가 없으면 종료 대상.
 */
import { describe, expect, it } from 'vitest';
import {
  END_PROMPT_AUTO_END_GRACE_MS,
  MOTION_MOVING_DISPLACEMENT_M,
  evaluateEndPromptAutoEnd,
} from '../motionState';
import {
  DEVICE_SYNC_STALE_THRESHOLD_MS,
  type MotionEvidence,
  type TripPositionSSoT,
} from '../tripPositionSsot';
import type { Trip } from '../types';

const NOW = 1_800_000_000_000;
const SHOWN_AT = NOW - END_PROMPT_AUTO_END_GRACE_MS;
const M_PER_DEG_LAT = 111_320;

function ev(ts: number, northM = 0): MotionEvidence {
  return {
    source: 'device-position',
    ts,
    signal: { lat: 37.5 + northM / M_PER_DEG_LAT, lng: 127.0, motion: 'unknown' },
  };
}

/** [from, to] 구간에 25s 간격으로 같은 좌표 샘플. */
function still(from: number, to: number): MotionEvidence[] {
  const out: MotionEvidence[] = [];
  for (let ts = from; ts <= to; ts += 25_000) out.push(ev(ts));
  return out;
}

function makeSsot(evidence: MotionEvidence[], lastDeviceSyncAt = NOW): TripPositionSSoT {
  return { motionEvidence: evidence, lastDeviceSyncAt } as unknown as TripPositionSSoT;
}

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 't',
    endPromptShownAt: SHOWN_AT,
    laClient: { split: true, boardingStart: 'push-to-start', endPromptAutoEnd: true },
    ...overrides,
  } as unknown as Trip;
}

describe('evaluateEndPromptAutoEnd', () => {
  it('none: 질문 기록이 없다', () => {
    const trip = makeTrip({ endPromptShownAt: undefined });
    expect(evaluateEndPromptAutoEnd(trip, makeSsot(still(SHOWN_AT, NOW)), NOW)).toBe('none');
  });

  it('none: endPromptAutoEnd capability가 없다 (구버전 앱 보호 — [계속] 채널이 없는 앱)', () => {
    const still5 = makeSsot(still(SHOWN_AT - 60_000, NOW));
    expect(evaluateEndPromptAutoEnd(makeTrip({ laClient: undefined }), still5, NOW)).toBe('none');
    expect(
      evaluateEndPromptAutoEnd(
        makeTrip({ laClient: { split: true, boardingStart: 'push-to-start' } }),
        still5,
        NOW,
      ),
    ).toBe('none');
    // 이동했어도(cancel 후보) capability 없으면 none — 구버전 trip의 endPromptShownAt은 손대지 않는다
    const moved = makeSsot([...still(SHOWN_AT, NOW), ev(NOW - 10_000, 80)]);
    expect(evaluateEndPromptAutoEnd(makeTrip({ laClient: undefined }), moved, NOW)).toBe('none');
  });

  it('none: [계속] 응답이 질문 이후다', () => {
    const trip = makeTrip({ endPromptContinuedAt: SHOWN_AT + 1_000 });
    expect(evaluateEndPromptAutoEnd(trip, makeSsot(still(SHOWN_AT, NOW)), NOW)).toBe('none');
  });

  it('[계속] 응답이 이전 질문 것이면(continuedAt < shownAt) 무시한다', () => {
    const trip = makeTrip({ endPromptContinuedAt: SHOWN_AT - 1 });
    expect(evaluateEndPromptAutoEnd(trip, makeSsot(still(SHOWN_AT - 60_000, NOW)), NOW)).toBe('end');
  });

  it('none: 활성 lock이 있다', () => {
    const trip = makeTrip({ boardingLock: { expiresAt: NOW + 1 } } as Partial<Trip>);
    expect(evaluateEndPromptAutoEnd(trip, makeSsot(still(SHOWN_AT, NOW)), NOW)).toBe('none');
  });

  it('만료된 lock은 lockless 취급 -> end', () => {
    const trip = makeTrip({ boardingLock: { expiresAt: NOW } } as Partial<Trip>);
    expect(evaluateEndPromptAutoEnd(trip, makeSsot(still(SHOWN_AT - 60_000, NOW)), NOW)).toBe('end');
  });

  it('end: 경과 == GRACE 이고 질문 이후 계속 정지', () => {
    expect(evaluateEndPromptAutoEnd(makeTrip(), makeSsot(still(SHOWN_AT - 60_000, NOW)), NOW)).toBe('end');
  });

  it('wait: 경과 GRACE-1ms (경계)', () => {
    expect(
      evaluateEndPromptAutoEnd(makeTrip(), makeSsot(still(SHOWN_AT - 60_000, NOW - 1)), NOW - 1),
    ).toBe('wait');
  });

  it('cancel: 질문 이후 변위 >= 50m (경계 포함)', () => {
    const moved = [...still(SHOWN_AT - 60_000, NOW), ev(NOW - 10_000, MOTION_MOVING_DISPLACEMENT_M + 1)];
    expect(evaluateEndPromptAutoEnd(makeTrip(), makeSsot(moved), NOW)).toBe('cancel');
  });

  it('cancel은 GRACE 이전에도 즉시 판정된다 (움직이면 바로 취소)', () => {
    const now = SHOWN_AT + 60_000;
    const moved = [ev(SHOWN_AT + 1_000), ev(now - 1_000, 80)];
    expect(evaluateEndPromptAutoEnd(makeTrip(), makeSsot(moved), now)).toBe('cancel');
  });

  it('질문 이전의 이동은 cancel 근거가 아니다', () => {
    const before = [ev(SHOWN_AT - 120_000, 500), ...still(SHOWN_AT - 60_000, NOW)];
    expect(evaluateEndPromptAutoEnd(makeTrip(), makeSsot(before), NOW)).toBe('end');
  });

  it('wait: 변위 10~50m 애매 구간', () => {
    const ambiguous = [...still(SHOWN_AT - 60_000, NOW), ev(NOW - 10_000, 30)];
    expect(evaluateEndPromptAutoEnd(makeTrip(), makeSsot(ambiguous), NOW)).toBe('wait');
  });

  it('wait: 샘플 부족 (판정 근거 없음 — 침묵이 낫다)', () => {
    const few = [ev(SHOWN_AT - 30_000), ev(NOW - 1_000)];
    expect(evaluateEndPromptAutoEnd(makeTrip(), makeSsot(few), NOW)).toBe('wait');
  });

  it('end: 기기 sync stale + 질문 이후 이동 증거 없음 (앱 꺼짐)', () => {
    const lastSync = NOW - DEVICE_SYNC_STALE_THRESHOLD_MS - 1;
    const sparse = [ev(SHOWN_AT - 30_000)]; // 샘플 부족이어도 stale이면 end
    expect(evaluateEndPromptAutoEnd(makeTrip(), makeSsot(sparse, lastSync), NOW)).toBe('end');
  });

  it('stale이어도 sync 끊기기 전 50m+ 이동 증거가 있으면 cancel', () => {
    const lastSync = NOW - DEVICE_SYNC_STALE_THRESHOLD_MS - 1;
    const moved = [ev(SHOWN_AT + 1_000), ev(SHOWN_AT + 20_000, 200)];
    expect(evaluateEndPromptAutoEnd(makeTrip(), makeSsot(moved, lastSync), NOW)).toBe('cancel');
  });

  it('stale이어도 경과 < GRACE면 wait', () => {
    const now = SHOWN_AT + 60_000;
    const lastSync = now - DEVICE_SYNC_STALE_THRESHOLD_MS - 1;
    expect(evaluateEndPromptAutoEnd(makeTrip(), makeSsot([], lastSync), now)).toBe('wait');
  });
});
