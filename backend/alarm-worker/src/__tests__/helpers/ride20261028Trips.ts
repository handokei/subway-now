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

/**
 * #3221 PR-3 — 아침 trip 179의 **탑승 전(pre-boarding) seed**. lock seed(`makeRide20261028MorningTrip`)는 질문 사슬
 * (탑승 질문 -> 응답 -> 환승 하차 질문 -> leg-2 질문 -> 재질문)을 못 탄다. 창 시작(06:26:46) 시점 실측 상태:
 * 용마산 출발 대기, 7호선 안내 시작(promptOptIn), 여정 LA live, lock 없음. 응답은 replay 테스트의 `beforeTick`이 주입한다.
 * `split`이면 LA 2개 분리를 지원하고 push-to-start token을 등록한 클라이언트(`laClient` + token).
 */
export const RIDE_20261028_BOARDING_START_TOKEN = 'ptstoken0179';

export function makeRide20261028MorningPreBoardingTrip(token: string, now: number, opts: { split: boolean }): Trip {
  return {
    token,
    route: { type: 'transfer', transferName: '건대입구', fromLine: '7', toLine: '2', stopsToTransfer: 5, stopsFromTransfer: 2 },
    destination: '뚝섬',
    waypoints: [
      { stationName: '중곡', line: '7', kind: 'intermediate' },
      { stationName: '군자(능동)', line: '7', kind: 'intermediate' },
      { stationName: '어린이대공원(세종대)', line: '7', kind: 'intermediate' },
      { stationName: '건대입구', line: '7', kind: 'transfer' },
      { stationName: '성수', line: '2', kind: 'intermediate' },
      { stationName: '뚝섬', line: '2', kind: 'destination' },
    ],
    expiresAt: now + HOUR_MS,
    createdAt: now,
    alarmAtEpochMs: now,
    promptOptIn: true,
    originStationName: '용마산',
    promptDisplay: { originStation: '용마산', line: '7' },
    activityPushToken: 'la-token',
    activityState: 'live',
    apnsEnv: 'production',
    ...(opts.split
      ? {
          laClient: { split: true, boardingStart: 'push-to-start' as const },
          boardingPushToStartToken: RIDE_20261028_BOARDING_START_TOKEN,
        }
      : {}),
  };
}
