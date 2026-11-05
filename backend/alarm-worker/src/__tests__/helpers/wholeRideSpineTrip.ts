/**
 * #3027 — Task 0 합성 whole-ride 등뼈 전용 seed Trip 빌더.
 *
 * 경로는 `desk20260913Trip.ts`(#2600)와 동일하다 — 용마산(7) 승차 → 중곡 → 군자(능동) →
 * 어린이대공원(세종대) → 건대입구(환승) → 성수(2) → 뚝섬(destination). 차이는 시작 상태다:
 * desk trip은 "이미 탑승해 lock이 있는" 상태로 시작하지만, 이 helper는 "목적지만 설정, 아직
 * 응답 없음"(S-B/S-A 공통 등록 상태, plan v2 §S-B 1단계)으로 **lockless**로 시작한다.
 *
 * 게이트 ②⑤⑥(plan v2)을 전부 통과시키는 시드:
 *   - `trackingOptIn=true` + `promptOptIn=false` + `infoModeEnabled=false` — 명시 의향
 *     (promptOptIn/infoModeEnabled) 둘 다 없는 "목적지만 설정" trip의 OR 3항(#2997 S3 v2).
 *   - `promptDisplay`(게이트 ②, 없으면 `maybeFireOriginBoardingPromptGpsFree`가 즉시 return).
 *   - `promptGeoContext.originDistanceM`/`originAccuracyM` 둘 다(게이트 ⑤ —
 *     `hasProximityReading` 계산 자체가 이 둘의 존재를 전제, `scheduled.ts:8148`). 거리차
 *     80-20=60 ≤ 150m(PROMPT_PROXIMITY_MARGIN_M) — `isNearOrigin` 통과.
 */
import type { Trip } from '../../types';

export function makeWholeRideSpineTrip(token: string, now: number): Trip {
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
      { stationName: '중곡', line: '7', kind: 'intermediate' },
      { stationName: '군자(능동)', line: '7', kind: 'intermediate' },
      { stationName: '어린이대공원(세종대)', line: '7', kind: 'intermediate' },
      { stationName: '건대입구', line: '7', kind: 'transfer' },
      { stationName: '성수', line: '2', kind: 'intermediate' },
      { stationName: '뚝섬', line: '2', kind: 'destination' },
    ],
    expiresAt: now + 60 * 60_000,
    createdAt: now,
    alarmAtEpochMs: now,
    promptDisplay: { originStation: '용마산', line: '7' },
    promptGeoContext: {
      origin: { lat: 37.5664, lng: 127.0837 },
      nextStation: { lat: 37.5571, lng: 127.0796 },
      direction: 'down',
      originDistanceM: 80,
      originAccuracyM: 20,
    },
    trackingOptIn: true,
    promptOptIn: false,
    infoModeEnabled: false,
  };
}
