/**
 * 2026-09-13 데스크 trip(capture_20260913T1249Z_b00dd879) 전용 seed Trip 빌더 (#2600, Epic
 * #2239 P1 실측 → 라이브러리 첫 실캡처 엔트리). 용마산(7-015)에서 7301 열차를 사용자 탭으로
 * lock한 뒤 중곡→군자(능동)→어린이대공원(세종대)→건대입구(환승)까지 leg-1(7호선)을 타고,
 * 건대입구에서 2호선으로 환승해 뚝섬(destination, 성수 방면)까지 향하는 경로(leg-2는
 * lockless — D1 실측상 trip은 13:02Z user-delete로 종료돼 leg-2 fire는 관측되지 않았다).
 *
 * `now`는 fixture의 `window.fromMs`를 그대로 받는다 — `replayLibrary.ts`가 로드한 fixture와
 * 같은 앵커를 공유해야 lock의 `selectedDepartureTime`/`expiresAt`이 재생 시간창과 정합한다.
 */
import type { Trip } from '../../types';

// #2600 코드리뷰 항목5 — line7SynthTrip.ts의 자매 helper와 달리 이 두 상수는 다른 테스트
// 파일에서 직접 참조하는 caller가 없다(replayLibrary.ts는 `makeDesk20260913LockTrip`만
// 소비). orphan export를 만들지 않도록 비export const로 유지 — 소비자가 생기면 그때
// export한다.
const DESK_20260913_LOCK_TRAIN = '7301';

/** leg-1(용마산 승차 → 건대입구 환승) 구간 정차역 시퀀스 — hop 거리 산출용(`segmentStations`). */
const DESK_20260913_SEGMENT = ['용마산', '중곡', '군자(능동)', '어린이대공원(세종대)', '건대입구'];

export function makeDesk20260913LockTrip(
  token: string,
  now: number,
  // #2602 코드리뷰 항목8 — 다른 실캡처(2026-09-14 아침 라이드, 7039 lock)가 이 helper의 경로
  // 형태(용마산 승차 → 건대입구 환승)를 재사용하되 실 탑승 열차 trainCode만 다르다. 호출부에서
  // `trip.boardingLock`이 undefined일 수 있다고 방어적으로 가정해 `if (trip.boardingLock)`로
  // 조용히 override를 건너뛰면(silent-skip), boardingLock 생성 로직이 바뀌어도 테스트가 그
  // 실패를 감추고 계속 green을 낼 위험이 있다 — `makeFixtureTrip`(evidence_20260703_junggok_seongsu.ts)
  // 관례대로 overrides 파라미터를 받아 이 함수가 항상 확정적으로 boardingLock을 만드는 지점에서
  // 직접 반영한다(사후 optional-mutation 없음).
  overrides?: { trainCode?: string },
): Trip {
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
    boardingLock: {
      trainCode: overrides?.trainCode ?? DESK_20260913_LOCK_TRAIN,
      line: '7',
      subwayId: '1007',
      selectedDepartureTime: now,
      segmentStations: DESK_20260913_SEGMENT,
      expiresAt: now + 60 * 60_000,
    },
    expiresAt: now + 60 * 60_000,
    createdAt: now,
    alarmAtEpochMs: now,
    // #2651 (PR #2772 리뷰) — 이 trip은 "사용자 탭으로 lock"(위 파일 doc comment)돼 생성됐다.
    // 실제 architecture상 BoardingTrainList 직접 탭은 항상 `infoModeEnabled=true`를 함께
    // stamp한다(`useBoardingLockController.ts`) — 이 필드가 캡처 시점(#2651 신설 전)엔
    // 존재하지 않았을 뿐, lock이 실재한다는 사실 자체가 이 값을 함의한다. leg-2/hop-end
    // boarding-prompt 게이트(OR: promptOptIn || infoModeEnabled)를 재생이 통과하려면 명시해야
    // 한다 — 측정된 push 횟수/타이밍을 조정하는 게 아니라 당시 실제 상태를 구조적으로 복원.
    infoModeEnabled: true,
  };
}
