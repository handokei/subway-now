/**
 * #3158 PR-2 — vanish 경로 picker의 99-only 모호성 차단 (실측 R2 캡처 기준).
 *
 * 입력은 불변 실측(R2 원문과 byte 동일) — 통과시키려 조정 금지:
 *  - `fixtures/replay_20261028_trip180/caps` 17:15:45: 건대입구 arrival 내선 후보 = 2288 arvlCd99, 3290 arvlCd99 (둘 다 뒤 열차).
 *  - `fixtures/replay_20261022_wangsimni/caps` 18:46:45: 왕십리 arrival 외선 6405 arvlCd5 단독 tier(맞는 교체).
 */
import { describe, expect, it } from 'vitest';
import { attachTrainCodeForLeg } from '../lockSwap';
import { SeoulArrivalClient } from '../seoul';
import type { Trip } from '../types';
import { loadCaptures } from './helpers/renumberProbe';

type Capture = ReturnType<typeof loadCaptures>[number];
const KST_OFFSET_MS = 9 * 3600_000;

function captureAt(fixtureDir: string, kst: string): Capture {
  const found = loadCaptures(fixtureDir).find(
    (c) => new Date(c.cycleStartMs + KST_OFFSET_MS).toISOString().slice(11, 19) === kst,
  );
  if (!found) throw new Error(`capture ${kst} not found in ${fixtureDir}`);
  return found;
}

function seoulFrom(cap: Capture): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => cap.cycleStartMs,
    fetchImpl: (async (url: string) => {
      const target = decodeURIComponent(url.split('/').pop() ?? '');
      const hit = cap.entries.find((e) => e.kind === 'arrival' && e.target === target);
      return new Response(hit?.body ?? '{"realtimeArrivalList":[]}', { status: 200 });
    }) as unknown as typeof fetch,
  });
}

function tripOf(cap: Capture, overrides: Partial<Trip>): Trip {
  return {
    token: 'tok',
    expiresAt: cap.cycleStartMs + 3600_000,
    alarmAtEpochMs: cap.cycleStartMs + 60_000,
    createdAt: cap.cycleStartMs - 60_000,
    originStationName: '성수',
    ...overrides,
  } as unknown as Trip;
}

describe('#3158 vanish picker — 99-only 모호성', () => {
  it('trip 180 17:15:45: 건대입구 arrival 내선 후보가 2288·3290 둘 다 arvlCd99면 교체 대상 없음(null)', async () => {
    const cap = captureAt('replay_20261028_trip180', '17:15:45');
    const trip = tripOf(cap, {
      route: { type: 'transfer', line: '2', stops: 5 },
      destination: '용마산',
      waypoints: [
        { stationName: '건대입구', line: '2', kind: 'transfer' },
        { stationName: '어린이대공원(세종대)', line: '7', kind: 'intermediate' },
        { stationName: '용마산', line: '7', kind: 'destination' },
      ],
    });
    const lock = await attachTrainCodeForLeg({
      targetWaypoint: trip.waypoints[0],
      seoul: seoulFrom(cap),
      now: cap.cycleStartMs,
      trip,
    } as Parameters<typeof attachTrainCodeForLeg>[0]);
    expect(lock).toBeNull();
  });

  it('10/22 18:46:45: 왕십리 arrival 외선 6405 arvlCd5 단독 tier는 그대로 6405로 교체', async () => {
    const cap = captureAt('replay_20261022_wangsimni', '18:46:45');
    const trip = tripOf(cap, {
      route: { type: 'transfer', line: '2', stops: 7 },
      destination: '한강진',
      waypoints: [
        { stationName: '왕십리(성동구청)', line: '2', kind: 'intermediate' },
        { stationName: '상왕십리', line: '2', kind: 'intermediate' },
        { stationName: '신당', line: '2', kind: 'transfer' },
        { stationName: '한강진', line: '6', kind: 'destination' },
      ],
    });
    const lock = await attachTrainCodeForLeg({
      targetWaypoint: trip.waypoints[0],
      seoul: seoulFrom(cap),
      now: cap.cycleStartMs,
      trip,
    } as Parameters<typeof attachTrainCodeForLeg>[0]);
    expect(lock?.trainCode).toBe('6405');
  });
});
