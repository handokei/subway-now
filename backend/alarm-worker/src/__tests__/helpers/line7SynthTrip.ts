/**
 * 7호선 합성 fixture(capture_20260912_line7_synth) 전용 seed Trip 빌더 — #2585 리뷰,
 * `replayLibrary.ts`(라이브러리 registry entry)와 `replay_harness_line7.test.ts`(하네스
 * 단위 검증) 양쪽이 동일한 lock trip 형태(건대입구→중곡, 7204 lock)를 필요로 해 이 helper
 * 하나로 통일한다. `now`는 두 소비자 모두 자신이 로드한 fixture의 `window.fromMs`를 그대로
 * 넘긴다 — 같은 fixture 파일을 각자 로드하므로 값은 항상 동일하다.
 */
import type { Trip } from '../../types';

export const LINE7_SYNTH_LOCK_TRAIN = '7204';
export const LINE7_SYNTH_SEGMENT = ['건대입구', '어린이대공원(세종대)', '군자(능동)', '중곡'];

export function makeLine7SynthLockTrip(token: string, now: number): Trip {
  return {
    token,
    route: { type: 'direct', line: '7', stops: 3 },
    destination: '중곡',
    waypoints: [
      { stationName: '어린이대공원(세종대)', line: '7', kind: 'intermediate' },
      { stationName: '군자(능동)', line: '7', kind: 'intermediate' },
      { stationName: '중곡', line: '7', kind: 'destination' },
    ],
    boardingLock: {
      trainCode: LINE7_SYNTH_LOCK_TRAIN,
      line: '7',
      subwayId: '1007',
      selectedDepartureTime: now,
      segmentStations: LINE7_SYNTH_SEGMENT,
      expiresAt: now + 60 * 60_000,
    },
    expiresAt: now + 60 * 60_000,
    createdAt: now,
    alarmAtEpochMs: now,
  };
}
