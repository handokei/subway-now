/**
 * #3223 — 2026-10-28 실측 라이드 seed Trip 빌더 (매역 알림 진입 시점 발사 replay).
 *  - 아침 trip 179: 7호선 열차 7035(중곡 -> 군자 -> 어린이대공원 -> 건대입구 환승, 이후 2호선 성수 -> 뚝섬).
 *    lock 부착: D1 06:27:55 `lock-attached path:confirm 7035`. 06:26:56 sync가 중곡을 소비해 head=군자.
 *  - 저녁 trip 180 leg-2: 7호선 열차 7252(건대입구 -> 어린이대공원 -> 군자 -> 중곡 -> 용마산).
 *    lock 부착: D1 17:24:55 `lock-attached path:confirm 7252`.
 * 입력 상태는 D1 `trip_events`(token_hash b00dd879) 원문에서 복원했다. 통과시키려 조정 금지.
 */
import type { Trip } from '../../types';

const HOUR_MS = 60 * 60_000;

const MORNING_TRAIN = '7035';
const MORNING_SEGMENT = ['용마산', '중곡', '군자(능동)', '어린이대공원(세종대)', '건대입구'];

const EVENING_TRAIN = '7252';
const EVENING_SEGMENT = ['건대입구', '어린이대공원(세종대)', '군자(능동)', '중곡', '용마산'];

export function makeRide20261028MorningTrip(token: string, now: number): Trip {
  return {
    token,
    route: {
      type: 'transfer',
      transferName: '건대입구',
      fromLine: '7',
      toLine: '2',
      stopsToTransfer: 4,
      stopsFromTransfer: 2,
    },
    destination: '뚝섬',
    waypoints: [
      { stationName: '군자(능동)', line: '7', kind: 'intermediate' },
      { stationName: '어린이대공원(세종대)', line: '7', kind: 'intermediate' },
      { stationName: '건대입구', line: '7', kind: 'transfer' },
      { stationName: '성수', line: '2', kind: 'intermediate' },
      { stationName: '뚝섬', line: '2', kind: 'destination' },
    ],
    boardingLock: {
      trainCode: MORNING_TRAIN,
      line: '7',
      subwayId: '1007',
      selectedDepartureTime: now,
      segmentStations: MORNING_SEGMENT,
      expiresAt: now + HOUR_MS,
    },
    expiresAt: now + HOUR_MS,
    createdAt: now,
    alarmAtEpochMs: now,
    infoModeEnabled: true,
  };
}

export function makeRide20261028EveningTrip(token: string, now: number): Trip {
  return {
    token,
    route: {
      type: 'transfer',
      transferName: '건대입구',
      fromLine: '2',
      toLine: '7',
      stopsToTransfer: 1,
      stopsFromTransfer: 4,
    },
    destination: '용마산',
    waypoints: [
      { stationName: '어린이대공원(세종대)', line: '7', kind: 'intermediate' },
      { stationName: '군자(능동)', line: '7', kind: 'intermediate' },
      { stationName: '중곡', line: '7', kind: 'intermediate' },
      { stationName: '용마산', line: '7', kind: 'destination' },
    ],
    boardingLock: {
      trainCode: EVENING_TRAIN,
      line: '7',
      subwayId: '1007',
      selectedDepartureTime: now,
      segmentStations: EVENING_SEGMENT,
      expiresAt: now + HOUR_MS,
    },
    expiresAt: now + HOUR_MS,
    createdAt: now,
    alarmAtEpochMs: now,
    infoModeEnabled: true,
  };
}
