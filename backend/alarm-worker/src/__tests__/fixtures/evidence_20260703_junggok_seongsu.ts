/**
 * 2026-07-03 08:24 KST 중곡→성수 trip evidence fixture (Issue #2024).
 *
 * 사용자 실기기 dump(`/Users/kimdohan/Downloads/텍스트-ABF10FD55360-1.txt`) 파싱 결과.
 * Wave 1 (A+B+C+E) 완결의 code-level 회귀 검증 기준.
 *
 * 자료 정합 근거:
 * - Raw Signal (173건): 08:23:42 ~ 08:37:34 (dump L398~514 발췌 — 아침 trip 47건)
 * - Alarm log (200건): 08:35:53 ~ 08:37:29 (dump L156~282 발췌)
 * - Backend calls: dump L330~336 (admin/arch-flag=404 → archFlag 미배포 확인)
 * - Boarding Prompt Acceptance 7일 = 0/0/0/0 (dump L343~357)
 * - BoardingLock active=no (dump L69~71), Notifications fired = 4건 (dump L75~80)
 *
 * 4 root cause (memory `project_2026_07_03_trip_regression_evidence.md`):
 *   RC1. Backend deploy gap — archFlag 미배포(코드 O / production KV 미배포)
 *   RC2. Position tier lock 8분+ 유지 (용마산 7-015)
 *   RC3. arc(time-integration) 폭주 3985 → 4710m
 *   RC4. Route line 갱신 실패 (7호선 → 2호선 mismatch)
 *
 * 이슈 매핑 (Wave 1 대상):
 *   A) #2019 — trip token rotation caller 미호출
 *   B) #2021 — archFlag=on 시 payload.boardingLine 3곳 봉인
 *   C) #2022 — arvlCd=1 관측 시 boardingPrompt 즉시 발사 caller
 *   E) #2018 — 목적지 도착 후 안내종료 미발동
 *   J) #2023 — arc(time-integration) 폭주로 조기 발사 방지 gate
 *   K) #2023 흡수 — ETA 조기 발사 (arc + destination-early)
 */

import type { ArrivalEntry } from '../../seoul';
import type {
  Trip,
  BoardingPromptState,
  MultiTransferRoute,
} from '../../types';

// dump 상단 timestamp `2026-07-03T06:26:37.764Z` = KST 15:26:37 (dump 시점)
// 실 aching trip은 KST 08:23:42 ~ 08:37:34.
// 아래 상수는 fixture 재현 시점(cron cycle 재현). KST 08:32:26 (승차 후 첫 backend cron 관측 시점)
// = UTC 2026-07-02T23:32:26Z = epoch ms.
export const FIXTURE_NOW = 1_751_495_546_000; // 2026-07-02T23:32:26.000Z = KST 2026-07-03 08:32:26

/**
 * Raw signal 시계열 (아침 trip 발췌). 각 항목은 device debug dump의 한 줄에 대응.
 *   ts       — dump timestamp (KST)
 *   epochMs  — UTC epoch ms (fixture 계산 편의)
 *   type     — 'cycle' | 'enter' | 'exit' (dump 원문 그대로)
 *   stationId — 파싱한 stationId (dump 원문의 `2-011`, `7-015` 등). 없으면 null.
 *   source   — dump 원문 3번째 컬럼 (예: 'position-train/position-train')
 *   arvlCd   — Seoul API arvlCd (dump 원문). 미관측 시 null.
 *   arc      — arc(time-integration) 값 (dump 원문 소수점). 미관측 시 null.
 *   gpsAccuracyM — dump 원문의 gps 사이 값 (예: `gps(47m/-)` → 47)
 *   speedMs  — dump 원문 gps 속도. `-`면 null.
 *   motion   — dump 원문 motion 컬럼 ('walking'|'automotive'|'unknown').
 *   subsurface — dump 원문 sub 컬럼 (true/false).
 *   cellVote — dump 원문 cell 컬럼 (예: 'NRNSA/surface-weak').
 */
export interface RawSignalSample {
  ts: string;
  epochMs: number;
  type: 'cycle' | 'enter' | 'exit';
  stationId: string | null;
  source: string;
  arvlCd: number | null;
  arc: number | null;
  gpsAccuracyM: number | null;
  speedMs: number | null;
  motion: 'walking' | 'automotive' | 'unknown';
  subsurface: boolean | null;
  cellVote: string;
}

// KST → UTC epoch ms (2026-07-03 08:XX:XX KST = 2026-07-02 23:XX:XX UTC).
// 아침 trip 시각들만 헬퍼로 생성 (재사용).
const kst = (hhmmss: string, hour = 8): number => {
  const [mm, ss] = hhmmss.split(':').map(Number);
  const date = new Date(Date.UTC(2026, 6, 2, hour - 9, mm, ss)); // month 6 = July (0-indexed)
  return date.getTime();
};

/** 08:23:42 ~ 08:37:34 사이 47건 발췌 (dump L505~514 + L429~514 아침 부분). */
export const AM_RAW_SIGNAL_SAMPLES: readonly RawSignalSample[] = [
  // === Pre-boarding: 승차 전 용마산 lock stuck 시작 ===
  { ts: '08:23:42', epochMs: kst('23:42'), type: 'cycle', stationId: '7-015', source: 'position/arrival-confirmed', arvlCd: 1, arc: null, gpsAccuracyM: 34, speedMs: null, motion: 'unknown', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:23:52', epochMs: kst('23:52'), type: 'cycle', stationId: '7-015', source: 'arrival/arrival-confirmed', arvlCd: 1, arc: 0, gpsAccuracyM: 34, speedMs: null, motion: 'automotive', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  // === 승차 (사용자 실 승차역 중곡 7-016, but device는 여전히 용마산 lock) ===
  { ts: '08:24:05', epochMs: kst('24:05'), type: 'cycle', stationId: '7-015', source: 'position-train/position-train', arvlCd: 1, arc: 0, gpsAccuracyM: 47, speedMs: null, motion: 'automotive', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:24:15', epochMs: kst('24:15'), type: 'cycle', stationId: '7-015', source: 'position-train/position-train', arvlCd: 1, arc: 0, gpsAccuracyM: 47, speedMs: null, motion: 'automotive', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:24:18', epochMs: kst('24:18'), type: 'cycle', stationId: '7-015', source: 'position-train/position-train', arvlCd: 1, arc: 0, gpsAccuracyM: 47, speedMs: null, motion: 'automotive', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:24:33', epochMs: kst('24:33'), type: 'cycle', stationId: '7-015', source: 'position-train/position-train', arvlCd: 1, arc: 0, gpsAccuracyM: 47, speedMs: null, motion: 'automotive', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  // === Trip 이동 중 (여전히 용마산 lock, arc=0 stuck) ===
  { ts: '08:26:55', epochMs: kst('26:55'), type: 'cycle', stationId: '7-015', source: 'position-train/position-train', arvlCd: 1, arc: 0, gpsAccuracyM: 47, speedMs: null, motion: 'walking', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:27:09', epochMs: kst('27:09'), type: 'cycle', stationId: '7-015', source: 'position-train/position-train', arvlCd: 1, arc: 0, gpsAccuracyM: 47, speedMs: null, motion: 'walking', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:27:28', epochMs: kst('27:28'), type: 'cycle', stationId: '7-015', source: 'position-train/position-train', arvlCd: 1, arc: 0, gpsAccuracyM: 47, speedMs: null, motion: 'walking', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  // === Backend SSoT 중곡(7-016) 밀림 → device 즉시 되돌림 ===
  { ts: '08:27:32', epochMs: kst('27:32'), type: 'enter', stationId: '7-016', source: 'backend-ssot/backend-ssot', arvlCd: 2, arc: 0, gpsAccuracyM: 47, speedMs: null, motion: 'walking', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:27:32', epochMs: kst('27:32'), type: 'exit', stationId: '7-015', source: '-/-', arvlCd: 2, arc: 0, gpsAccuracyM: 47, speedMs: null, motion: 'walking', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:27:37', epochMs: kst('27:37'), type: 'enter', stationId: '7-015', source: 'position-train/position-train', arvlCd: 1, arc: 0, gpsAccuracyM: 47, speedMs: null, motion: 'walking', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  // === Backend SSoT 군자(7-017) 밀림 → device 다시 되돌림 ===
  { ts: '08:29:32', epochMs: kst('29:32'), type: 'enter', stationId: '7-017', source: 'backend-ssot/backend-ssot', arvlCd: null, arc: 0, gpsAccuracyM: 77, speedMs: null, motion: 'walking', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:29:32', epochMs: kst('29:32'), type: 'exit', stationId: '7-015', source: '-/-', arvlCd: null, arc: 0, gpsAccuracyM: 77, speedMs: null, motion: 'walking', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:30:32', epochMs: kst('30:32'), type: 'enter', stationId: '7-015', source: 'position-train/position-train', arvlCd: 99, arc: 0, gpsAccuracyM: 77, speedMs: null, motion: 'walking', subsurface: true, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:30:32', epochMs: kst('30:32'), type: 'exit', stationId: '7-017', source: '-/-', arvlCd: 99, arc: 0, gpsAccuracyM: 77, speedMs: null, motion: 'walking', subsurface: true, cellVote: 'NRNSA/surface-weak' },
  // === 08:32:09 ~ 08:32:17 건대입구(7-019) 감지 → 즉시 되돌림 ===
  { ts: '08:32:09', epochMs: kst('32:09'), type: 'cycle', stationId: '7-015', source: 'position-train/position-train', arvlCd: 99, arc: 0, gpsAccuracyM: 77, speedMs: null, motion: 'walking', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:32:17', epochMs: kst('32:17'), type: 'enter', stationId: '7-019', source: 'position/arrival-confirmed', arvlCd: 99, arc: 0, gpsAccuracyM: 87, speedMs: null, motion: 'walking', subsurface: true, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:32:17', epochMs: kst('32:17'), type: 'exit', stationId: '7-015', source: '-/-', arvlCd: 99, arc: 0, gpsAccuracyM: 87, speedMs: null, motion: 'walking', subsurface: true, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:32:17', epochMs: kst('32:17'), type: 'enter', stationId: '7-015', source: 'route-progress/route-progress', arvlCd: null, arc: 0, gpsAccuracyM: 87, speedMs: null, motion: 'walking', subsurface: true, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:32:17', epochMs: kst('32:17'), type: 'exit', stationId: '7-019', source: '-/-', arvlCd: null, arc: 0, gpsAccuracyM: 87, speedMs: null, motion: 'walking', subsurface: true, cellVote: 'NRNSA/surface-weak' },
  // === 08:32:45 device 2호선 건대입구 인식 시작 (route line 7→2 mismatch 시작) ===
  { ts: '08:32:45', epochMs: kst('32:45'), type: 'enter', stationId: '2-012', source: 'route-progress/route-progress', arvlCd: null, arc: 3998.03, gpsAccuracyM: 69, speedMs: null, motion: 'walking', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:32:45', epochMs: kst('32:45'), type: 'exit', stationId: '7-015', source: '-/-', arvlCd: null, arc: 3998.03, gpsAccuracyM: 69, speedMs: null, motion: 'walking', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:32:45', epochMs: kst('32:45'), type: 'cycle', stationId: '2-012', source: 'route-progress/route-progress', arvlCd: null, arc: 3998.03, gpsAccuracyM: 69, speedMs: null, motion: 'walking', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  // === 08:33 ~ 08:34 arc 4000m 대 유지 (accuracy=15~19m, 정지 상태) ===
  { ts: '08:33:16', epochMs: kst('33:16'), type: 'cycle', stationId: '2-012', source: 'gps/gps-only', arvlCd: 1, arc: 3995.41, gpsAccuracyM: 42, speedMs: null, motion: 'automotive', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:33:23', epochMs: kst('33:23'), type: 'cycle', stationId: '2-012', source: 'position/arrival-confirmed', arvlCd: 5, arc: 3991.09, gpsAccuracyM: 38, speedMs: null, motion: 'automotive', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:34:08', epochMs: kst('34:08'), type: 'cycle', stationId: '2-012', source: 'arrival/arrival-arriving', arvlCd: 5, arc: 3995.66, gpsAccuracyM: 90, speedMs: 0.8, motion: 'automotive', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  // === 08:35 ~ 08:36:47 arc 3985~3986 (정지 상태 시간 적분 pattern) ===
  { ts: '08:35:03', epochMs: kst('35:03'), type: 'cycle', stationId: '2-012', source: 'position-train/position-train', arvlCd: null, arc: 4000.68, gpsAccuracyM: 19, speedMs: 0.6, motion: 'automotive', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:35:54', epochMs: kst('35:54'), type: 'cycle', stationId: '2-012', source: 'route-progress/route-progress', arvlCd: null, arc: 3986.07, gpsAccuracyM: 15, speedMs: 0, motion: 'automotive', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:36:24', epochMs: kst('36:24'), type: 'cycle', stationId: '2-012', source: 'route-progress/route-progress', arvlCd: null, arc: 3982.64, gpsAccuracyM: 43, speedMs: 0.4, motion: 'automotive', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:36:47', epochMs: kst('36:47'), type: 'cycle', stationId: '2-012', source: 'route-progress/route-progress', arvlCd: 2, arc: 3985.60, gpsAccuracyM: 194, speedMs: null, motion: 'automotive', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  // === 08:37 성수 도착 가속 ===
  { ts: '08:37:08', epochMs: kst('37:08'), type: 'cycle', stationId: '2-012', source: 'gps/gps-only', arvlCd: -1, arc: 4618.35, gpsAccuracyM: 50, speedMs: 16.9, motion: 'walking', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:37:12', epochMs: kst('37:12'), type: 'cycle', stationId: '2-012', source: 'gps/gps-only', arvlCd: -1, arc: 4666.98, gpsAccuracyM: 64, speedMs: 16.6, motion: 'walking', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:37:19', epochMs: kst('37:19'), type: 'cycle', stationId: '2-012', source: 'gps/gps-only', arvlCd: -1, arc: 4683.41, gpsAccuracyM: 73, speedMs: 16.6, motion: 'walking', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  // === 08:37:25 성수(2-011) 도착 + BG station-passed fired (dump L79/L164) ===
  { ts: '08:37:25', epochMs: kst('37:25'), type: 'enter', stationId: '2-011', source: 'gps/gps-only', arvlCd: -1, arc: 4710.04, gpsAccuracyM: 128, speedMs: null, motion: 'walking', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:37:25', epochMs: kst('37:25'), type: 'exit', stationId: '2-012', source: '-/-', arvlCd: -1, arc: 4710.04, gpsAccuracyM: 128, speedMs: null, motion: 'walking', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:37:28', epochMs: kst('37:28'), type: 'cycle', stationId: '2-011', source: 'gps/gps-only', arvlCd: -1, arc: 4737.88, gpsAccuracyM: 132, speedMs: null, motion: 'walking', subsurface: false, cellVote: 'NRNSA/surface-weak' },
  { ts: '08:37:34', epochMs: kst('37:34'), type: 'cycle', stationId: '2-011', source: 'gps/gps-only', arvlCd: -1, arc: null, gpsAccuracyM: 132, speedMs: null, motion: 'walking', subsurface: false, cellVote: 'NRNSA/surface-weak' },
];

/**
 * Fixture Trip — 아침 사용자 trip (중곡 → 성수).
 *
 * 정합 근거:
 * - dump L69~71 `BoardingLock active=no` → `boardingLock: undefined`
 * - dump L339~341 `boardingPrompt(all)=0` → `boardingPromptState: undefined` (미발사)
 * - dump L343~357 7일 acceptance 0/0/0/0 → 사용자 명시 응답 0
 * - Trip 실 route: 중곡(7-016) → 성수(2-011) 5정거장 환승 (7호선 → 2호선 건대입구 환승)
 */
export function makeFixtureTrip(overrides: Partial<Trip> = {}): Trip {
  // multi-transfer route: 중곡(7) → 건대입구 환승 → 성수(2)
  const route: MultiTransferRoute = {
    type: 'multi-transfer',
    transfers: [
      {
        transferName: '건대입구',
        fromLine: '7',
        toLine: '2',
        stopsToTransfer: 3, // 중곡 → 군자 → 어린이대공원 → 건대입구
      },
    ],
    stopsAfterLastTransfer: 1, // 건대입구 → 성수
  };
  return {
    token: 'apns-junggok-seongsu',
    route,
    destination: '2-011', // 성수 stationId
    waypoints: [
      // hop 0: 중곡 → 군자 (intermediate)
      { stationName: '군자', line: '7', kind: 'intermediate', hopIndex: 0 },
      // hop 1: 군자 → 어린이대공원 (intermediate)
      { stationName: '어린이대공원', line: '7', kind: 'intermediate', hopIndex: 1 },
      // hop 2: 어린이대공원 → 건대입구 (transfer)
      { stationName: '건대입구', line: '7', kind: 'transfer', hopIndex: 2 },
      // hop 3: 건대입구(2호선) → 성수 (destination)
      { stationName: '성수', line: '2', kind: 'destination', hopIndex: 3 },
    ],
    apnsEnv: 'production',
    // dump 시각 기준. trip 등록 시각(createdAt)은 승차 15초 전 가정 (사용자 잠금 화면 조작).
    createdAt: kst('23:27', 8),
    // FIXTURE_NOW + 1h.
    expiresAt: FIXTURE_NOW + 60 * 60_000,
    // dump 시점 실 정보 없음 — 승차 후 5분 뒤 알람 발사 예상값(디폴트).
    alarmAtEpochMs: kst('30:00', 8),
    // dump L27 `lockless=false` — trip은 등록됨. lock은 없음 (dump L69~71).
    // → boardingLock: undefined (기본).
    // dump L343~357 acceptance 0 — boardingPrompt 미발사 상태.
    // → boardingPromptState: undefined (기본).
    // dump L61 `no recent SSoT push` — 즉 archFlag=on 미배포이므로 SSoT forward 없음.
    // 사용자 명시 응답 = 0. lock=null, boardingPromptState=null 유지.
    ...overrides,
  };
}

/** boardingPromptState — 이미 발사한 trip을 시뮬레이션할 때(silence 게이트 검증). */
export function makeBoardingPromptFiredState(): BoardingPromptState {
  return {
    fired: true,
    lastFiredAt: FIXTURE_NOW - 60_000,
  };
}

/**
 * Seoul API arrivals — 08:32 cron cycle 시점 중곡역 관측 결과.
 * dump 원문에는 없지만 (실기기 debug dump는 device 관측만 기록) domain SSOT 기반 복원.
 *
 * arvlCd = 1 (도착) → boardingPrompt 즉시 발사 조건 (Issue C acceptance).
 * 만약 archFlag=on caller 미구현(Issue C 미fix)이면 발사 X → replay fail 조건 첫 번째.
 */
export const AM_JUNGGOK_ARRIVALS_ARVLCD_1: readonly ArrivalEntry[] = [
  {
    destination: '온수',
    arrivalSeconds: 0,
    trainCode: '7124',
    isUp: false,
    subwayNm: '지하철7호선',
    arvlCd: 1, // 도착
  },
  {
    destination: '온수',
    arrivalSeconds: 240,
    trainCode: '7126',
    isUp: false,
    subwayNm: '지하철7호선',
    arvlCd: 99, // 운행중
  },
];

/**
 * Seoul API arrivals — 08:36 성수 도착 임박 시점.
 * dump 시각 08:36:47 arvlCd=2(출발) 관측 (raw L443).
 */
export const AM_SEONGSU_ARRIVALS_ARVLCD_2: readonly ArrivalEntry[] = [
  {
    destination: '내선순환',
    arrivalSeconds: 30,
    trainCode: '2242',
    isUp: true,
    subwayNm: '지하철2호선',
    arvlCd: 2, // 출발 (성수 도착 직전 상태)
  },
];

/** Seoul API arrivals — 08:37 성수 도착. arvlCd=1(도착) — device BG station-passed fired. */
export const AM_SEONGSU_ARRIVALS_ARVLCD_1: readonly ArrivalEntry[] = [
  {
    destination: '내선순환',
    arrivalSeconds: 0,
    trainCode: '2242',
    isUp: true,
    subwayNm: '지하철2호선',
    arvlCd: 1, // 도착 (성수 도착 순간)
  },
];

/**
 * Alarm log 시계열 (아침 trip만). dump L156~282 발췌.
 *   ts       — KST timestamp (dump 원문)
 *   epochMs  — UTC epoch ms
 *   source   — 채널 ('bg' | 'fg' | 'fg-evaluated' | 'silent-push-received' | 등)
 *   result   — 'fired' | 'suppressed' | 'received'
 *   reason   — suppress 사유 (있으면). 예: 'lockless-no-user-intent'
 *   kind     — waypoint kind (있으면). 예: 'station-passed' | 'destination'
 *   phaseId  — 발사 phase (있으면). 예: 'early' | 'imminent'
 *   stationName — 대상 역명
 */
export interface AlarmLogEntry {
  ts: string;
  epochMs: number;
  source: 'bg' | 'fg' | 'fg-evaluated' | 'silent-push-received' | 'silent-push-skipped' | 'lockless-trip-end' | 'cross-trip-mirror-launch' | 'cross-trip-mirror-register' | 'fusion-candidate-reject' | 'fg-hydrate' | 'accel-pattern-observed';
  result: 'fired' | 'suppressed' | 'received';
  reason?: string;
  kind?: string;
  phaseId?: string;
  stationName?: string;
}

export const AM_ALARM_LOG_ENTRIES: readonly AlarmLogEntry[] = [
  // === 승차 전 (~08:32) : 관측 없음 (dump 원문 최소 이벤트) ===
  // === 08:35~08:36:47 fg destination early 성수 스팸 반복 (arc 폭주 영향) ===
  { ts: '08:35:53', epochMs: kst('35:53'), source: 'fg', result: 'suppressed', reason: 'dismiss-silence', kind: 'destination', phaseId: 'early', stationName: '성수' },
  { ts: '08:35:57', epochMs: kst('35:57'), source: 'fg', result: 'suppressed', reason: 'dismiss-silence', kind: 'destination', phaseId: 'early', stationName: '성수' },
  { ts: '08:36:00', epochMs: kst('36:00'), source: 'fg', result: 'suppressed', reason: 'movement-static-speed', kind: 'station-passed', stationName: '건대입구' },
  { ts: '08:36:00', epochMs: kst('36:00'), source: 'fg', result: 'suppressed', reason: 'dismiss-silence', kind: 'destination', phaseId: 'early', stationName: '성수' },
  { ts: '08:36:11', epochMs: kst('36:11'), source: 'fg', result: 'suppressed', reason: 'movement-static-speed', kind: 'station-passed', stationName: '건대입구' },
  { ts: '08:36:47', epochMs: kst('36:47'), source: 'fusion-candidate-reject', result: 'suppressed', reason: 'candidate-distance-reject', stationName: '용마산' },
  { ts: '08:36:47', epochMs: kst('36:47'), source: 'fusion-candidate-reject', result: 'suppressed', reason: 'candidate-distance-reject', stationName: '중곡' },
  // === 08:36:50~08:37:00 lockless-no-user-intent 스팸 (paradigm shift #1810 게이트) ===
  { ts: '08:36:50', epochMs: kst('36:50'), source: 'fg', result: 'suppressed', reason: 'dedup-alarm', kind: 'destination', phaseId: 'early', stationName: '성수' },
  { ts: '08:36:55', epochMs: kst('36:55'), source: 'fg', result: 'suppressed', reason: 'gate-passed-event-on-lock-origin', kind: 'station-passed', stationName: '건대입구' },
  { ts: '08:37:00', epochMs: kst('37:00'), source: 'fg', result: 'suppressed', reason: 'lockless-no-user-intent', kind: 'station-passed', stationName: '건대입구' },
  { ts: '08:37:00', epochMs: kst('37:00'), source: 'fg-evaluated', result: 'suppressed', reason: 'lockless-no-user-intent', kind: 'destination', phaseId: 'early', stationName: '성수' },
  { ts: '08:37:06', epochMs: kst('37:06'), source: 'bg', result: 'suppressed', reason: 'dedup-channel-agnostic', kind: 'station-passed', stationName: '건대입구' },
  { ts: '08:37:06', epochMs: kst('37:06'), source: 'bg', result: 'suppressed', reason: 'dedup-alarm', kind: 'destination', phaseId: 'early', stationName: '성수' },
  // === 08:37:25 결정적 이벤트: bg station-passed 성수 fired (dump L164) ===
  { ts: '08:37:25', epochMs: kst('37:25'), source: 'bg', result: 'fired', kind: 'station-passed', stationName: '성수' },
  { ts: '08:37:25', epochMs: kst('37:25'), source: 'fg', result: 'suppressed', reason: 'movement-low-accuracy', kind: 'station-passed', stationName: '성수' },
  { ts: '08:37:25', epochMs: kst('37:25'), source: 'fg-evaluated', result: 'suppressed', reason: 'lockless-no-user-intent', kind: 'destination', phaseId: 'early', stationName: '성수' },
  { ts: '08:37:27', epochMs: kst('37:27'), source: 'bg', result: 'suppressed', reason: 'dedup-station', kind: 'station-passed', stationName: '성수' },
  { ts: '08:37:29', epochMs: kst('37:29'), source: 'lockless-trip-end', result: 'fired', reason: '1:intent' },
];

/**
 * archFlag 시나리오. 오늘 evidence 재현: `archFlag='off'`가 실 배포 상태.
 * dump L333 `/admin/arch-flag → 404` → production KV 미배포 확인 (RC1).
 *
 * Wave 1 fix 후 예상 상태: `archFlag='on'`. 각 replay test는 이 두 시나리오를 매트릭스 검증.
 */
export type ArchFlagScenario = 'production-off' | 'target-on';

/** RC1 root cause 재현. dump 시점 실 상태. */
export const AM_ARCH_FLAG_PRODUCTION: ArchFlagScenario = 'production-off';

/** Wave 1 완결 후 목표 상태. Issue B/C fix가 이 flag=on 을 전제로 봉인/발사 활성. */
export const AM_ARCH_FLAG_TARGET: ArchFlagScenario = 'target-on';

/**
 * 재발 판정 표.
 * 각 Assertion helper가 참조하는 acceptance 매트릭스. 이슈 fix 진행 상황에 맞춰
 * `expected` 열이 Green으로 뒤집혀야 함.
 */
export interface RegressionAssertion {
  /** 이슈 매핑 (A/B/C/E/J/K). */
  issue: 'A' | 'B' | 'C' | 'E' | 'J' | 'K';
  /** 사람이 읽는 한 줄. */
  description: string;
  /** 현재 상태 (오늘 evidence). 회귀 재현 확인용. */
  observedToday: string;
  /** Wave 1 완결 후 통과해야 하는 목표 상태. */
  expected: string;
}

export const REGRESSION_TABLE: readonly RegressionAssertion[] = [
  {
    issue: 'A',
    description: 'trip token rotation caller — 새 route 등록 시 old destination push 정리',
    observedToday: 'rotation helper 존재 O / production caller 부재 → old destination 재발사',
    expected: 'rotation helper 새 route 등록 시 호출 O (archFlag=on 조건부)',
  },
  {
    issue: 'B',
    description: 'archFlag=on 시 payload.boardingLine 봉인 (3곳)',
    observedToday: 'lock=null + archFlag=on 상태에서 backend가 boardingLine 실은 push 발사 → device authoritative pass → fire',
    expected: 'archFlag=on + lock=null 시 backend payload.boardingLine = undefined → device lockless-opt-out skip',
  },
  {
    issue: 'C',
    description: 'arvlCd=1 관측 시 boardingPrompt 즉시 발사 caller',
    observedToday: 'gate skip은 되지만 caller 자체 미구현 → boardingPrompt push 미발사 (7일 0/0/0/0)',
    expected: 'archFlag=on + arvlCd=1 감지 시 즉시 boarding-prompt push fired ≥ 1',
  },
  {
    issue: 'E',
    description: '목적지 도착 후 안내종료 미발동 (성수→성수 0정거장 UI 잔존)',
    observedToday: 'destination arvlCd=1 관측 후에도 trip cleanup + endTrip 미호출 → UI 지속',
    expected: 'destination match 시 trip 종료 chain 발동 → routeStops UI 즉시 종료',
  },
  {
    issue: 'J',
    description: 'arc(time-integration) 폭주 조기 발사 방지 gate',
    observedToday: 'arc=3985 → 4710m (정지 상태 시간 적분) → 성수 destination-early 조기 발사',
    expected: 'archFlag=on + arc > hopDistance × N배 감지 시 hop 진행 pause → 조기 fire skip',
  },
  {
    issue: 'K',
    description: 'ETA 조기 발사 (arc + destination-early)',
    observedToday: '성수 destination-early 발사 08:29부터 (실 도착 08:37) — 8분 조기',
    expected: 'archFlag=on + arc guard 통과 시에만 destination-early 발사 (실 도착 - ETA 기준 발사)',
  },
];
