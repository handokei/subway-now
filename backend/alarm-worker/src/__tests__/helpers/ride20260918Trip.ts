/**
 * 2026-09-18 저녁 라이드(건대입구→용마산, 사용자가 목적지를 지나침) 전용 seed Trip 빌더
 * (#2718, ADR-039 close 조건 재생). `capture_20260918_line7_yongmasan_overshoot.fixture.json`과
 * 짝을 이룬다 — R2 실측(`GET /admin/seoul-capture/keys` → `wrangler r2 object get --remote`)으로
 * 확인된 실 궤적: 건대입구(17:40:29 승차) → 어린이대공원(세종대) → 군자(능동) → 중곡 →
 * 용마산(destination, 17:49:29 실 도착) → 사가정 → 면목.
 *
 * `now`는 fixture의 `window.fromMs`를 그대로 받는다 — `line7SynthTrip.ts`/`desk20260913Trip.ts`
 * 자매 helper와 동일 관례.
 */
import type { Trip } from '../../types';

export const RIDE_20260918_LOCK_TRAIN = '7256';
export const RIDE_20260918_SEGMENT = ['건대입구', '어린이대공원(세종대)', '군자(능동)', '중곡', '용마산'];

export function makeRide20260918LockTrip(token: string, now: number): Trip {
  return {
    token,
    route: { type: 'direct', line: '7', stops: 4 },
    destination: '용마산',
    waypoints: [
      { stationName: '어린이대공원(세종대)', line: '7', kind: 'intermediate' },
      { stationName: '군자(능동)', line: '7', kind: 'intermediate' },
      { stationName: '중곡', line: '7', kind: 'intermediate' },
      { stationName: '용마산', line: '7', kind: 'destination' },
    ],
    boardingLock: {
      trainCode: RIDE_20260918_LOCK_TRAIN,
      line: '7',
      subwayId: '1007',
      selectedDepartureTime: now,
      segmentStations: RIDE_20260918_SEGMENT,
      expiresAt: now + 60 * 60_000,
    },
    expiresAt: now + 60 * 60_000,
    createdAt: now,
    alarmAtEpochMs: now,
  };
}
