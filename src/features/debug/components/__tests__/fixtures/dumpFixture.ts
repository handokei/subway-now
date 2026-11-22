/**
 * #3366 — buildDumpText characterization / redact 테스트 공용 고정 입력.
 * nowMs·launchAtMs·ts 전부 고정(모듈 상태·Date.now 비의존) — 시각 표기는 호출부가 TZ를 고정한다.
 * 좌표·token 값은 실기기 덤프 형식(`pos=37.54321,127.05432`, `/trips/<64hex>/status` 등)을 따른다.
 */
import type { __test__ } from '../../DebugModal';
import type { RawSignalEntry } from '../../../../observability/utils/rawSignalBuffer';
import type { BackendCallEntry } from '../../../../../shared/utils/backendCallBuffer';

export type DumpArgs = Parameters<typeof __test__.buildDumpText>[0];

/** 2026-11-22T00:00:00Z — UTC 00:00:00 / KST 09:00:00. */
export const FIXTURE_NOW_MS = Date.UTC(2026, 10, 22, 0, 0, 0);
export const FIXTURE_LAUNCH_AT_MS = FIXTURE_NOW_MS - 600_000;

export const FIXTURE_APNS_TOKEN = '3f9a1c7be24d5086a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';
export const FIXTURE_ACTIVE_TRIP_TOKEN =
  '9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d';
/** device-local trip id(`local-<tripStart>`) — Scheduled queue identifier에 쓰이는 token 계열. */
export const FIXTURE_LOCAL_TRIP_ID = `local-${FIXTURE_NOW_MS - 300_000}`;

const baseFusion = {
  confidence: 'gps-only' as const,
  source: 'gps' as const,
  fusedLabel: '성수(2) · 120m',
  gpsLabel: '성수(2) · 120m',
  differs: false,
  candidateTrains: null as string[] | null,
};

const rawSignal = (overrides: Partial<RawSignalEntry>): RawSignalEntry => ({
  ts: FIXTURE_NOW_MS - 30_000,
  corrId: null,
  kind: 'cycle',
  gps: { lat: 37.54321, lng: 127.05432, accM: 12, speedMps: 8.5, fixAtMs: FIXTURE_NOW_MS - 31_000 },
  motion: null,
  accelPattern: null,
  cellular: null,
  subsurface: null,
  barometerHpa: null,
  arvlCd: 1,
  line: '2',
  dir: null,
  arcIdx: null,
  arcProgress: 0.5,
  stationId: '2-211',
  source: 'gps',
  confidence: 'gps-only',
  pushReceipt: null,
  ...overrides,
});

export const FIXTURE_RAW_SIGNALS: RawSignalEntry[] = [
  rawSignal({}),
  rawSignal({ ts: FIXTURE_NOW_MS - 20_000, arcProgress: 33.53, gps: null }),
  rawSignal({ ts: FIXTURE_NOW_MS - 10_000, arcProgress: 4636.57, gps: null }),
];

const call = (overrides: Partial<BackendCallEntry>): BackendCallEntry => ({
  kind: 'call',
  ts: FIXTURE_NOW_MS - 5_000,
  callId: 'c1',
  corrId: null,
  url: `https://backend.example/trips/${FIXTURE_ACTIVE_TRIP_TOKEN}/status`,
  method: 'GET',
  ...overrides,
});

export const FIXTURE_BACKEND_CALLS: BackendCallEntry[] = [
  call({}),
  call({ kind: 'response', callId: 'c1', status: 200, latencyMs: 120 }),
  call({
    callId: 'c2',
    method: 'PUT',
    url: `https://backend.example/live-activity/${FIXTURE_APNS_TOKEN}`,
  }),
];

export function makeFixtureDumpArgs(overrides: Partial<DumpArgs> = {}): DumpArgs {
  return {
    userLocation: { lat: 37.5612345, lng: 127.0543216 },
    speedMps: 8.5,
    accuracyMeters: 12,
    gpsActive: 'fg',
    lastFixAtMs: FIXTURE_NOW_MS - 31_000,
    fusedSpeed: null,
    nearestName: '성수',
    nearestDistanceM: 120,
    variants: ['성수(2)'],
    fusion: baseFusion,
    arrivalSummary: 'up: 신도림 · 2분\ndown: 잠실 · 4분',
    isMock: false,
    silentPush: {
      apnsToken: FIXTURE_APNS_TOKEN,
      activeTripToken: FIXTURE_ACTIVE_TRIP_TOKEN,
      apnsEnv: 'production',
      apnsEnvStamped: 'production',
      permissionStatus: null,
      taskRegistrationState: 'unknown',
      taskRegistrationError: null,
      lastReceivedAt: null,
      lastFiredAt: null,
      lastSkippedAt: null,
      hasRoute: true,
      destinationId: '2-222',
      lastNotifiedStationId: null,
    },
    logs: [],
    scheduledDump: [
      {
        identifier: `alarm-${FIXTURE_ACTIVE_TRIP_TOKEN}-station-passed-2-212`,
        fireAtMs: FIXTURE_NOW_MS + 120_000,
        title: '다음 역 성수',
        body: '',
      },
      {
        identifier: `alarm-${FIXTURE_LOCAL_TRIP_ID}-destination`,
        fireAtMs: FIXTURE_NOW_MS + 240_000,
        title: '곧 도착',
        body: '',
      },
    ],
    trip: {
      lockless: true,
      tripStartedAt: FIXTURE_NOW_MS - 300_000,
      currentHopIndex: 2,
      routeHopCount: 8,
      displayOnlyEstimateStrategy: null,
      lifecyclePhase: 'normal',
    },
    sleep: { sleepMode: false, firstHopApproaching: false },
    backendCalls: FIXTURE_BACKEND_CALLS,
    rawSignalLog: FIXTURE_RAW_SIGNALS,
    nowMs: FIXTURE_NOW_MS,
    launchAtMs: FIXTURE_LAUNCH_AT_MS,
    ...overrides,
  };
}
