/**
 * 2026-09-18 저녁 라이드(뚝섬→건대입구 환승→용마산, 사용자가 목적지를 지나침) 전용 seed
 * Trip 빌더 (#2718, ADR-039 close 조건 재생).
 * `capture_20260918_line7_yongmasan_overshoot.fixture.json`과 짝을 이룬다.
 *
 * ## fidelity 수정 (main coordinator 지적, 최초 구현 오류)
 * 최초 구현은 이 trip에 `boardingLock: { trainCode: '7256' }`를 심었다 — **실측과 다르다.**
 * 실 라이딩 중 KV를 3회 직접 읽은 결과 `boardingLock`은 세 시점 모두 `None`이었다:
 * ```
 * 17:42:xx  boardingLock: None
 * 17:48:58  boardingLock: None
 * 17:49:57  boardingLock: None
 * ```
 * device에는 17:40:32 생성된 lock(7256)이 있었으나 `/boarding-lock/sync`가 13분간 0회였고
 * `POST /trips`도 `isLockConsistentWithRoute` 불일치로 lock을 싣지 못했다(#2709) — **backend는
 * 이 trip을 끝까지 lockless로 취급했다.** lock을 심은 최초 fixture는 backend에게 실제로
 * 없던 것을 쥐여준 셈이라 "pre-#2713 재생에서도 GREEN"이 "backend는 멀쩡했다"의 증거가 될 수
 * 없었다(lock이 있는 backend가 잘 동작하는 것은 애초에 의심 대상이 아니었음).
 *
 * `makeRide20260918LocklessTrip`(기본, 실측 재현)는 boardingLock 없이 seed한다.
 * `makeRide20260918LockSeededTrip`(대조군, **실측 아님** — 명시)은 종전 lock-seeded 버전을
 * 보존해 "lock이 있었다면 어땠을까"를 대조 비교할 수 있게 남긴다.
 *
 * ## 실측 경로 재구성 (KV 17:48:58 스냅샷 + R2 realtimePosition 교차 확인)
 * `originStationName: '뚝섬'`(device SSOT 출발역, 등록 후 불변)과 `waypoints`가 어린이대공원
 * 부터 시작(건대입구 부재)이라는 사실을 R2 실측 위치(열차 7256이 캡처 개시 시점(17:37:03)에
 * 이미 7호선 뚝섬유원지 인근을 상행 중, 17:39~17:40에 건대입구 통과)와 교차하면 이 trip은
 * **뚝섬(2호선) 승차 → 건대입구 환승(2→7) → 어린이대공원→군자→중곡→용마산(destination)**
 * 경로였음을 알 수 있다. 재생 시작 시각(fixture `window.fromMs`≈17:38:31)에는 아직 건대입구
 * 환승 waypoint가 소비되지 않은 상태였다(열차가 건대입구에 아직 도달 전) — 그래서 seed는
 * 등록 시점(createdAt=17:26:01) 기준 waypoints를 그대로 담고, transfer waypoint 소비/
 * `currentLegAnchor` stamp는 cron 재생이 실제로 만들어내는지를 관찰 대상으로 남긴다.
 *
 * ## 재현 못 한 것 (정직 명시, #2718 지적사항 4)
 * KV 17:42→17:48:58 사이 `currentLegAnchor`({건대입구,7}→소실)/`legBoardingEligibleAt`
 * (17:43:07→소실)/`passedStations`(["건대입구"]→소실) 전이, `boardingPromptState`가
 * 17:48:29에 **trainCode 7260**(!) 으로 발사된 것, `promptDisplay`가 {건대입구,7}로 찍힌
 * 것(원 등록 origin `뚝섬`과 불일치 — 재등록 흔적으로 추정)은 seed 시점(등록 직후) 상태로는
 * 원리적으로 표현 불가능한 **mid-trip 전이**다. registration-time 필드만 seed하고 이후는
 * cron 재생이 실제로 어떻게 진화시키는지 관찰하는 방식을 택했다 — PR 본문에 재생 결과와
 * 실측 전이의 일치/불일치를 그대로 기록한다. `promptGeoContext`(boarding-prompt 게이트
 * 필수 입력) 실측 좌표를 확보하지 못해 seed에서 생략했다 — 이 replay에서 boarding-prompt
 * 발사 자체는 검증 대상이 아니다(조건 1/4은 boarding-prompt와 무관한 채널).
 *
 * `now`는 fixture의 `window.fromMs`를 그대로 받는다 — `line7SynthTrip.ts`/`desk20260913Trip.ts`
 * 자매 helper와 동일 관례. `createdAt`만은 실측(17:26:01 KST)을 그대로 고정한다 — window보다
 * 12분 이른 실 등록 시각이라 `now` 인자와 분리한다.
 */
import type { Trip, Waypoint } from '../../types';

export const RIDE_20260918_TRAIN = '7256';
export const RIDE_20260918_ORIGIN_STATION = '뚝섬';
/** 실측: 2026-09-18 17:26:01 KST(POST /trips 등록 시각) epoch ms. */
export const RIDE_20260918_CREATED_AT_MS = 1_789_719_961_000;

const RIDE_20260918_WAYPOINTS: Waypoint[] = [
  { stationName: '건대입구', line: '2', kind: 'transfer' },
  { stationName: '어린이대공원(세종대)', line: '7', kind: 'intermediate' },
  { stationName: '군자(능동)', line: '7', kind: 'intermediate' },
  { stationName: '중곡', line: '7', kind: 'intermediate' },
  { stationName: '용마산', line: '7', kind: 'destination' },
];

/**
 * 실측 재현(기본) — boardingLock 없음. backend가 이 trip을 처음부터 끝까지 lockless로
 * 취급한 실제 상태를 그대로 seed한다.
 */
export function makeRide20260918LocklessTrip(token: string): Trip {
  return {
    token,
    route: {
      type: 'transfer',
      transferName: '건대입구',
      fromLine: '2',
      toLine: '7',
      // 뚝섬→건대입구 line 2 정차 수(성수 경유, 2 stops) — 표시/reschedule payload용 근사치.
      // scheduled.ts의 push 발사/게이트 판정에는 이 값이 소비되지 않는다(waypoints가 SSoT).
      stopsToTransfer: 2,
      stopsFromTransfer: 4,
    },
    destination: '용마산',
    waypoints: RIDE_20260918_WAYPOINTS,
    expiresAt: RIDE_20260918_CREATED_AT_MS + 60 * 60_000,
    createdAt: RIDE_20260918_CREATED_AT_MS,
    alarmAtEpochMs: RIDE_20260918_CREATED_AT_MS,
    originStationName: RIDE_20260918_ORIGIN_STATION,
    // 실측: KV 17:48:58 스냅샷 `infoModeEnabled: true`.
    infoModeEnabled: true,
  };
}

/**
 * 대조군(**실측 아님**) — device가 실제로 생성했던 lock(17:40:32, "lock-create:user-tap
 * 7256(7) station=7-019"=건대입구의 7호선 station id)이 `/boarding-lock/sync`로 정상
 * 전달돼 backend에 부착**됐다면** 어떻게 동작했을지를 대조하기 위한 참고용이다. 실 lock은
 * 건대입구에서 7호선 승차를 확정한 뒤 생성됐으므로, waypoints도 그 시점 기준(환승 완료 후,
 * 어린이대공원부터 시작)으로 구성한다 — lockless 실측(`makeRide20260918LocklessTrip`, 환승
 * 전 5-waypoint)과 의도적으로 다른 시작점이다. `REPLAY_LIBRARY`에는 등록하지 않는다(실측
 * 아님) — `replay_20260918_lock_seeded_contrast.test.ts`가 직접 `runCaptureReplay`로 재생.
 */
export function makeRide20260918LockSeededTrip(token: string): Trip {
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
      trainCode: RIDE_20260918_TRAIN,
      line: '7',
      subwayId: '1007',
      selectedDepartureTime: RIDE_20260918_CREATED_AT_MS,
      segmentStations: ['건대입구', '어린이대공원(세종대)', '군자(능동)', '중곡', '용마산'],
      expiresAt: RIDE_20260918_CREATED_AT_MS + 60 * 60_000,
    },
    expiresAt: RIDE_20260918_CREATED_AT_MS + 60 * 60_000,
    createdAt: RIDE_20260918_CREATED_AT_MS,
    alarmAtEpochMs: RIDE_20260918_CREATED_AT_MS,
    originStationName: RIDE_20260918_ORIGIN_STATION,
    infoModeEnabled: true,
  };
}
