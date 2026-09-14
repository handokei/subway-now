/**
 * 재생 fixture 라이브러리 registry (Epic #2239 P2, #2585).
 *
 * P0 체인(#2579 캡처 → #2580 번들러 → #2581 하네스)이 만든 `ReplayFixture` +
 * `runCaptureReplay`를 상시 PR 게이트로 만드는 데이터 주도 SSoT. 신규 fixture 추가는
 * 이 배열에 entry 하나 추가하는 것으로 끝난다 — `replay_library.full.test.ts`는 이 배열을
 * 순회만 하고 개별 시나리오 분기(if-else)를 갖지 않는다.
 *
 * fixture 실물은 `fixtures/replayLibrary/<slug>.fixture.json`에 둔다. 이 파일이 `fixturePath`로
 * 참조하는 파일명과 디렉터리 실제 파일 목록의 1:1 대조는 `replay_library.full.test.ts` 책임이다.
 *
 * fixture는 entry가 실제로 필요할 때(테스트 실행 시점)만 로드·파싱한다(`loadFixture`,
 * 메모이즈) — 모듈 top-level에서 파싱하면 fixture 하나가 스키마 위반으로 malformed일 때
 * 이 파일을 import하는 모든 테스트 파일의 collection 자체가 죽는다. entry별 lazy 로더로
 * 내리면 malformed fixture는 그 entry의 테스트만 red가 되고 나머지 라이브러리는 영향받지
 * 않는다(#2585 리뷰).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseReplayFixture, type ReplayFixture } from '../replayFixture';
import type { Trip } from '../types';
import { makeDesk20260913LockTrip } from './helpers/desk20260913Trip';
import { makeLine7SynthLockTrip } from './helpers/line7SynthTrip';

export const REPLAY_LIBRARY_DIR = path.join(__dirname, 'fixtures', 'replayLibrary');

export interface ReplayLibraryEntry {
  /** fixture 파일명(확장자 제외)과 1:1 — 사람이 읽는 라이브러리 식별자. */
  slug: string;
  /** `fixtures/replayLibrary/` 기준 상대 파일명. */
  fixturePath: string;
  /** 어떤 회귀를 앵커하는지 (원 사건/이슈 번호). */
  description: string;
  /** 재생 시작 시점(cron tick 0) trip 상태. */
  seedTrips: () => Trip[];
  /**
   * cron tick 스케줄 선택 — 암묵 기본값 없음, 매 entry가 명시적으로 골라야 한다(#2585 리뷰):
   * - `'recorded'`: fixture가 기록한 실제 cron cycle 시각(`fixture.cycleStartsMs`)을 그대로
   *   tick으로 쓴다. 실 P0-a 캡처 fixture는 이 값을 쓴다.
   * - `number`: 그 값을 간격으로 균일 그리드 tick을 만든다(`runCaptureReplay`의
   *   `cronIntervalMs` 옵트인과 동일 의미) — 합성/고밀도 샘플링 fixture가 production cron
   *   cadence(예: 60s)로 재생되는지 게이트하고 싶을 때 쓴다. 이걸 optional로 두고 암묵
   *   fallback(`undefined` → `'recorded'`)을 허용하면, 15s 간격 dense 합성 fixture가 조용히
   *   그 15s tick 그대로 재생돼 실제 60s cron 위상 문제를 전혀 검증하지 못하는 false-green이
   *   생긴다 — 그래서 필수 필드다.
   */
  cronIntervalMs: number | 'recorded';
  /** 전 위상 스윕. 생략 시 `DEFAULT_PHASE_OFFSETS_MS`. */
  phaseOffsetsMs?: number[];
  /**
   * fixture가 `lossyCapture`(캡처 유실/실패 cycle)를 갖고 있음을 명시 승인하는 opt-in
   * 플래그. 미설정 상태에서 lossy fixture가 라이브러리에 들어오면 `replay_library.full.test.ts`가
   * 실패시켜, 불완전 캡처가 조용히 회귀 앵커로 굳는 것을 막는다. 반대로 lossy 신호가 없는데
   * true로 남아 있어도(stale) 실패시킨다.
   */
  allowLossy?: boolean;
  /**
   * fixture를 로드·파싱해 반환한다 — 최초 호출 시 파일을 읽고, 이후 호출은 메모이즈된 값을
   * 반환한다(entry당 재파싱 비용 없음). `seedTrips`/`replay_library.full.test.ts` 양쪽이
   * 같은 loader를 공유해 fixture 파일을 두 번 읽지 않는다.
   */
  loadFixture: () => ReplayFixture;
  expect: {
    /**
     * 위상 무관 발사돼야 하는 역들 — **alert `data.nextWaypoint` 채널 전용**
     * (arvlcd/vanish-fallback station-passed push, `buildStationPassedImminentPayload`).
     * 발사 순서와 무관하게 정확히 이 집합과 일치해야 한다(중복 발사도 실패 — 순서 무시
     * 비교를 위해 실제 발사 리스트는 중복 제거하지 않는다).
     *
     * transfer waypoint는 **이 채널과 별개로** `hopEndPromptStations`(아래)에서도 동시에
     * 발사될 수 있다 — 두 채널을 섞어서 세면(#2600 최초 구현의 결함) 정상적으로 둘 다
     * 발사되는 trip(예: EVT 299+300 동시 실측)에서 같은 역이 2회로 잡혀 false-red가 난다.
     * `replay_library.full.test.ts`는 두 채널을 별도 collector로 분리해 검증한다.
     */
    firedStations: string[];
    /**
     * transfer waypoint 전용 hop-end-prompt 채널(`sendBoardingPromptPush`, "하차했나요?")에서
     * 발사돼야 하는 역들(#2600 코드리뷰 항목1) — `push.body.body.originStation`
     * (+ `hopEndKind==='disembark'`)로 식별. `evaluateTransferDestinationGate`의 60s 신선도
     * 게이트와 무관하게(자체 dedup만 적용) 항상 발사되는 channel이라 `firedStations`(alert
     * nextWaypoint 채널)와는 발사 조건이 다르다 — 같은 transfer 역이 두 채널 모두에서 발사될
     * 수 있으므로 별도 필드로 분리한다. 미지정 시 이 채널은 검증하지 않는다(N/A, 예:
     * intermediate/destination만 있는 trip).
     */
    hopEndPromptStations?: string[];
    /** 오발사 금지 역. */
    forbiddenStations?: string[];
    /** 재생 전체(모든 tick 합산)에서 최소 발사돼야 하는 push 총 수. */
    minPushes?: number;
    /**
     * 목적지 도착(trip-ended) 완결 신호 — `nextWaypoint` 기반 `firedStations`가 표현하지
     * 못하는 별도 신호(destination 도착은 station-passed push가 아니라 trip-ended alert로
     * 발사된다, `replay_harness_line7.test.ts` 참고). 지정하면 전 위상에서
     * `data.kind==='trip-ended' && data.reason===reason`인 alert push가 있어야 한다.
     */
    tripEnded?: { reason: string };
  };
}

/** 위상 스윕 기본값 — cron 60s 주기 내 임의 위상에서 캡처가 시작됐다고 가정. */
export const DEFAULT_PHASE_OFFSETS_MS = [0, 15_000, 30_000, 45_000];

/** entry별 lazy fixture 로더 — 파일 I/O + 파싱을 최초 호출 시 1회만 수행하고 메모이즈한다. */
function makeFixtureLoader(fixturePath: string): () => ReplayFixture {
  let cached: ReplayFixture | undefined;
  return () => {
    if (!cached) {
      const fullPath = path.join(REPLAY_LIBRARY_DIR, fixturePath);
      cached = parseReplayFixture(JSON.parse(fs.readFileSync(fullPath, 'utf8')));
    }
    return cached;
  };
}

const LINE7_SYNTH_FIXTURE_PATH = 'capture_20260912_line7_synth.fixture.json';
const loadLine7SynthFixture = makeFixtureLoader(LINE7_SYNTH_FIXTURE_PATH);

const DESK_20260913_FIXTURE_PATH = 'capture_20260913T1249Z_b00dd879.fixture.json';
const loadDesk20260913Fixture = makeFixtureLoader(DESK_20260913_FIXTURE_PATH);

// #2602 — 오늘 아침(2026-09-14 06:xx KST) 실캡처(17 cycles). RCA 확정 코멘트가 지정한
// 회귀 앵커: 건대입구 transfer alert가 어린이대공원 advance 이후 128,365ms(>구 60,000ms
// 시간창, ≤신규 2 cycle) 지연 평가돼 구 코드에서는 ssot-stale로 차단됐다.
const RIDE_20260914_MORNING_FIXTURE_PATH = 'capture_20260913T2127Z_b00dd879.fixture.json';
const loadRide20260914MorningFixture = makeFixtureLoader(RIDE_20260914_MORNING_FIXTURE_PATH);
// 오늘 아침 라이드는 desk20260913Trip과 동일 경로(용마산 승차→건대입구 환승)이지만 실제 탑승
// 열차 lock은 7301이 아니라 7039(D1 실측) — helper의 기본 trainCode를 override.
const RIDE_20260914_MORNING_LOCK_TRAIN = '7039';

export const REPLAY_LIBRARY: ReplayLibraryEntry[] = [
  {
    slug: 'capture_20260912_line7_synth',
    fixturePath: LINE7_SYNTH_FIXTURE_PATH,
    description:
      '#2571/#2581 — 7호선 건대입구→중곡 lock trip, cron 위상 무관 매역 발사(intermediate + destination, #2602) + destination trip-ended 완결(합성 캡처)',
    seedTrips: () => [
      makeLine7SynthLockTrip('replay-library-line7-synth', loadLine7SynthFixture().window.fromMs),
    ],
    // 합성 fixture는 실제로는 15~16s 간격 샘플이지만, 이 entry가 게이트하려는 건 "production
    // cron cadence(60s)에서도 매역 발사가 위상 무관하게 유지되는가"이므로 'recorded'(15s
    // 그대로 재생)가 아니라 60_000을 명시한다 — 위 인터페이스 설명 참고.
    cronIntervalMs: 60_000,
    phaseOffsetsMs: DEFAULT_PHASE_OFFSETS_MS,
    loadFixture: loadLine7SynthFixture,
    expect: {
      // #2602 — freshness 게이트가 시간창(60s)에서 cron cycle 수(2) 이산화로 바뀌면서 군자(능동)
      // →중곡(destination) 구간의 recorded 간격(120,000ms=정확히 2 cycle)이 기존엔
      // ssot-stale로 차단됐으나(구 60s 시간창의 razor-edge — 오늘 아침 실캡처 128,365ms
      // 사례와 구조적으로 동일: 이미 직전 hop에 도달해 position 게이트는 통과, freshness만
      // 경계에서 갈림) 신선 판정으로 바뀌어 중곡도 nextWaypoint 채널로 발사된다. destination
      // 도착은 이 station-passed push(“도착”)와 아래 trip-ended(“trip 종료”)가 함께 발사되는
      // 것이 정상 — 서로 다른 채널(#2600 계약)이라 이중 집계가 아니다.
      firedStations: ['어린이대공원(세종대)', '군자(능동)', '중곡'],
      minPushes: 3,
      tripEnded: { reason: 'destination-arrived' },
    },
  },
  {
    slug: 'capture_20260913T1249Z_b00dd879',
    fixturePath: DESK_20260913_FIXTURE_PATH,
    description: '2026-09-13 데스크 trip — 실캡처 첫 라이브러리 엔트리 (#2239 P1 실측)',
    seedTrips: () => [
      makeDesk20260913LockTrip('replay-library-desk-20260913', loadDesk20260913Fixture().window.fromMs),
    ],
    // 실 P0-a 캡처 — 실제 cron cycle 시각(fixture.cycleStartsMs)을 그대로 재생한다. 합성 균일
    // 그리드로 가정하면 실 캡처의 cron 위상/드리프트와 어긋난다(위 인터페이스 설명 참고).
    cronIntervalMs: 'recorded',
    // 'recorded' cadence는 이미 실 cron cycle 시각 그대로라 phase sweep이 무의미하다(위 필드
    // 설명 — "phaseOffsetsMs는 'recorded' cadence라 [0]만" 스펙).
    phaseOffsetsMs: [0],
    loadFixture: loadDesk20260913Fixture,
    expect: {
      // station-passed alert(nextWaypoint 채널) — 중곡/군자(능동)/어린이대공원(세종대)/건대입구 4역.
      //
      // #2600 코드리뷰 항목2 조사 결과(PR 본문에 상세 기록)에서는 어린이대공원 advance(cycle4)
      // ~건대입구 평가(cycle5) 간 recorded cron 간격이 60001ms로 구 60,000ms 시간창 게이트를
      // ms 단위로 넘어(razor-edge) 이 채널만 3역으로 정직 유지했었다("건대입구는 hop-end-prompt
      // 채널로만 재현, nextWaypoint 채널은 재현 한계"). #2602 — freshness 판정을 시간창에서
      // cron cycle 수(≤2) 이산화로 바꿔 ms 지터 무관하게 만들면서 이 60,001ms(1 cycle) 간격도
      // 신선 판정 → 건대입구가 이 채널에서도 결정론적으로 발사된다(4역 복원, 이슈 acceptance
      // 1번 항목).
      firedStations: ['중곡', '군자(능동)', '어린이대공원(세종대)', '건대입구'],
      // 건대입구는 hop-end-prompt("하차했나요?") 채널로도 재생에서 항상 발사된다(#2600
      // 코드리뷰 항목1 — nextWaypoint 채널과 별개, freshness 게이트 무관하게
      // `maybeFireHopEndPrompt` 자체 dedup만 적용). 같은 역이 두 채널 모두에서 발사되는 것은
      // 정상(#2600 계약) — 위 firedStations와 합산 집계하지 않는다.
      hopEndPromptStations: ['건대입구'],
      minPushes: 4,
    },
  },
  {
    slug: 'capture_20260913T2127Z_b00dd879',
    fixturePath: RIDE_20260914_MORNING_FIXTURE_PATH,
    description:
      '#2602 — 2026-09-14 06:xx 아침 라이드(7039 lock) 실캡처. RCA 확정 회귀 앵커: 어린이대공원' +
      ' advance~건대입구 평가 간 128,365ms 지연(구 60,000ms 시간창 초과, 신규 2 cycle 이내)이' +
      ' production 06:41 skip(EVT 315, D1)과 동일 root — freshness cycle 이산화 fix로 4역 발사.',
    seedTrips: () => {
      const trip = makeDesk20260913LockTrip(
        'replay-library-ride-20260914-morning',
        loadRide20260914MorningFixture().window.fromMs,
      );
      // 오늘 아침 실 탑승 열차는 7039(D1 실측) — helper 기본값(7301, 어제 데스크 trip)을 override.
      if (trip.boardingLock) trip.boardingLock.trainCode = RIDE_20260914_MORNING_LOCK_TRAIN;
      return [trip];
    },
    // 실 P0-a 캡처 — 실제 cron cycle 시각(fixture.cycleStartsMs)을 그대로 재생한다.
    cronIntervalMs: 'recorded',
    phaseOffsetsMs: [0],
    loadFixture: loadRide20260914MorningFixture,
    expect: {
      // #2602 fix 전: 건대입구가 ssot-stale(128,365ms>60,000ms)로 nextWaypoint 채널에서
      // 차단돼 3역만 발사(red). fix 후: freshness가 cron cycle(≤2) 이산화로 바뀌어 128,365ms
      // (2 cycle 이내)도 신선 판정 → 4역 모두 발사(green) — 회귀 앵커.
      firedStations: ['중곡', '군자(능동)', '어린이대공원(세종대)', '건대입구'],
      hopEndPromptStations: ['건대입구'],
      minPushes: 4,
    },
  },
];
