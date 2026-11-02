/**
 * #3036 — 2026-11-02 아침 라이드(token_hash b00dd879, 용마산 -> 건대입구 환승 -> 뚝섬) seed Trip 빌더.
 *
 * 실측(불변): 경로/waypoints/출발역은 D1 `route-signature-mismatch` existingSig와 sync(용마산) 그대로,
 * Seoul position은 fixture(`fixtures/originPrompt/capture_20261102_morning_yongmasan_b00dd879.fixture.json`).
 *
 * 실측 불가(합성 변형 — fixture 데이터에 섞지 않고 여기서만 라벨해 만든다):
 *  - trackingOptIn / promptOptIn: 등록 payload가 보존되지 않았다. 'tracking' = 목적지만 설정(안내 시작 안 함),
 *    'promptOptIn' = 대조군(안내 시작).
 *  - V-a(근접 정보 없음) / V-b(등록 스냅샷 원거리): `promptGeoContext`.
 *  - alarmAtEpochMs: V-alarm0/1/7 (createdAt 대비 +0/+60s/+7분).
 */
import { findStationCoordsByNameAndLine } from '../../stationsLookup';
import type { PromptGeoContext, Trip } from '../../types';

const HOUR_MS = 60 * 60_000;

export const RIDE_20261102_FIXTURE = 'capture_20261102_morning_yongmasan_b00dd879.fixture.json';
/** D1 trip-register(id 1941) 시각 = fixture.window.fromMs + 2분(fixtureFromTrip 선행 창 2분). */
export const RIDE_20261102_REGISTERED_AT_OFFSET_MS = 120_000;

export type Ride20261102Intent = 'tracking' | 'promptOptIn';
export type Ride20261102AlarmVariant = 'alarm0' | 'alarm1' | 'alarm7';
export const RIDE_20261102_ALARM_OFFSET_MS: Record<Ride20261102AlarmVariant, number> = {
  alarm0: 0,
  alarm1: 60_000,
  alarm7: 7 * 60_000,
};

/** 출발역(용마산 7) / 다음역(중곡 7) 좌표 + 선택적 등록 스냅샷. */
export function makeRide20261102GeoContext(snapshot?: {
  originDistanceM: number;
  originAccuracyM: number;
  originFixAgeMs?: number;
  originFixSource?: 'gps-live' | 'gps-last-known';
}): PromptGeoContext {
  const origin = findStationCoordsByNameAndLine('용마산', '7');
  const next = findStationCoordsByNameAndLine('중곡', '7');
  if (origin === null || next === null) throw new Error('fixture 전제 실패 — 용마산/중곡 7호선 좌표 lookup 불가');
  return { origin, nextStation: next, direction: 'down', ...(snapshot ?? {}) };
}

export function makeRide20261102MorningTrip(
  token: string,
  createdAt: number,
  opts: {
    intent: Ride20261102Intent;
    alarm?: Ride20261102AlarmVariant;
    geo?: PromptGeoContext;
    /** #3036 O3 — 등록 시점에 계산돼 trip에 저장되는 창 시작 시각(`originPromptWindow.startAt`). */
    windowStartAt?: number;
  },
): Trip {
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
    expiresAt: createdAt + HOUR_MS,
    createdAt,
    alarmAtEpochMs: createdAt + RIDE_20261102_ALARM_OFFSET_MS[opts.alarm ?? 'alarm0'],
    originStationName: '용마산',
    promptDisplay: { originStation: '용마산', line: '7' },
    apnsEnv: 'production',
    activityPushToken: undefined,
    ...(opts.intent === 'promptOptIn' ? { promptOptIn: true } : { trackingOptIn: true }),
    ...(opts.geo !== undefined ? { promptGeoContext: opts.geo } : {}),
    ...(opts.windowStartAt !== undefined ? { originPromptWindow: { startAt: opts.windowStartAt } } : {}),
  } as Trip;
}
