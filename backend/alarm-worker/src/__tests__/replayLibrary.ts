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
    /** 위상 무관 발사돼야 하는 역들 — 발사 순서와 무관하게 정확히 이 집합과 일치해야 한다
     * (중복 발사도 실패 — 순서 무시 비교를 위해 실제 발사 리스트는 중복 제거하지 않는다). */
    firedStations: string[];
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

export const REPLAY_LIBRARY: ReplayLibraryEntry[] = [
  {
    slug: 'capture_20260912_line7_synth',
    fixturePath: LINE7_SYNTH_FIXTURE_PATH,
    description:
      '#2571/#2581 — 7호선 건대입구→중곡 lock trip, cron 위상 무관 intermediate 매역 발사 + destination trip-ended 완결(합성 캡처)',
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
      firedStations: ['어린이대공원(세종대)', '군자(능동)'],
      minPushes: 2,
      tripEnded: { reason: 'destination-arrived' },
    },
  },
];
