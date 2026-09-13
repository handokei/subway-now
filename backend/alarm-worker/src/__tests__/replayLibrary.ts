/**
 * 재생 fixture 라이브러리 registry (Epic #2239 P2, #2585).
 *
 * P0 체인(#2579 캡처 → #2580 번들러 → #2581 하네스)이 만든 `ReplayFixture` +
 * `runCaptureReplay`를 상시 PR 게이트로 만드는 데이터 주도 SSoT. 신규 fixture 추가는
 * 이 배열에 entry 하나 추가하는 것으로 끝난다 — `replay_library.full.test.ts`는 이 배열을
 * 순회만 하고 개별 시나리오 분기(if-else)를 갖지 않는다.
 *
 * fixture 실물은 `fixtures/replayLibrary/<slug>.fixture.json`에 둔다. 이 파일이 `fixturePath`로
 * 참조하는 파일명과 디렉터리 실제 파일 목록의 1:1 대조는 `replay_library.full.test.ts` 책임이다
 * (이 파일은 registry 데이터 정의만 — fs I/O 없음).
 */
import { parseReplayFixture } from '../replayFixture';
import type { Trip } from '../types';
import fixtureJson from './fixtures/replayLibrary/capture_20260912_line7_synth.fixture.json';

export interface ReplayLibraryEntry {
  /** fixture 파일명(확장자 제외)과 1:1 — 사람이 읽는 라이브러리 식별자. */
  slug: string;
  /** `fixtures/replayLibrary/` 기준 상대 파일명. */
  fixturePath: string;
  /** 어떤 회귀를 앵커하는지 (원 사건/이슈 번호). */
  description: string;
  /** 재생 시작 시점(cron tick 0) trip 상태. */
  seedTrips: () => Trip[];
  cronIntervalMs?: number;
  /** 전 위상 스윕 (기본 [0, 15000, 30000, 45000]). */
  phaseOffsetsMs: number[];
  /**
   * fixture가 `lossyCapture`(캡처 유실/실패 cycle)를 갖고 있음을 명시 승인하는 opt-in
   * 플래그. 미설정 상태에서 lossy fixture가 라이브러리에 들어오면 `replay_library.full.test.ts`가
   * 실패시켜, 불완전 캡처가 조용히 회귀 앵커로 굳는 것을 막는다.
   */
  allowLossy?: boolean;
  expect: {
    /** 위상 무관 매역 발사돼야 하는 역들 — 최초 발사 순서 포함. */
    firedStations: string[];
    /** 오발사 금지 역. */
    forbiddenStations?: string[];
    /** 재생 전체(모든 tick 합산)에서 최소 발사돼야 하는 push 총 수. */
    minPushes?: number;
  };
}

/** 위상 스윕 기본값 — cron 60s 주기 내 임의 위상에서 캡처가 시작됐다고 가정. */
export const DEFAULT_PHASE_OFFSETS_MS = [0, 15_000, 30_000, 45_000];

/** 합성 fixture는 15~16s 간격 샘플 — 60s cron이 이를 읽는 시나리오를 재현하려면 명시 옵트인. */
const LINE7_SYNTH_CRON_INTERVAL_MS = 60_000;

const line7SynthFixture = parseReplayFixture(fixtureJson);
const LINE7_SYNTH_NOW = line7SynthFixture.window.fromMs;
const LINE7_LOCK_TRAIN = '7204';
const LINE7_SEGMENT = ['건대입구', '어린이대공원(세종대)', '군자(능동)', '중곡'];

function makeLine7LockTrip(token: string): Trip {
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
      trainCode: LINE7_LOCK_TRAIN,
      line: '7',
      subwayId: '1007',
      selectedDepartureTime: LINE7_SYNTH_NOW,
      segmentStations: LINE7_SEGMENT,
      expiresAt: LINE7_SYNTH_NOW + 60 * 60_000,
    },
    expiresAt: LINE7_SYNTH_NOW + 60 * 60_000,
    createdAt: LINE7_SYNTH_NOW,
    alarmAtEpochMs: LINE7_SYNTH_NOW,
  };
}

export const REPLAY_LIBRARY: ReplayLibraryEntry[] = [
  {
    slug: 'capture_20260912_line7_synth',
    fixturePath: 'capture_20260912_line7_synth.fixture.json',
    description:
      '#2571/#2581 — 7호선 건대입구→중곡 lock trip, 60s cron 위상 무관 intermediate 매역 발사(합성 캡처)',
    seedTrips: () => [makeLine7LockTrip('replay-library-line7-synth')],
    cronIntervalMs: LINE7_SYNTH_CRON_INTERVAL_MS,
    phaseOffsetsMs: DEFAULT_PHASE_OFFSETS_MS,
    expect: {
      firedStations: ['어린이대공원(세종대)', '군자(능동)'],
      minPushes: 2,
    },
  },
];
