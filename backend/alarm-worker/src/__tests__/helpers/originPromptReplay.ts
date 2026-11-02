/**
 * #3036 — 11/02 아침 출발역 탑승 질문 replay 공용 헬퍼 (PR-2 baseline / PR-3b O3 창 테스트 공유).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseReplayFixture, type ReplayFixture } from '../../replayFixture';
import type { Trip } from '../../types';
import { runCaptureReplay, type ReplayRunResult } from './replayHarness';
import { RIDE_20261102_FIXTURE, RIDE_20261102_REGISTERED_AT_OFFSET_MS } from './ride20261102MorningTrips';

const KST_OFFSET_MS = 9 * 3600_000;

export function kstOf(ms: number): string {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(11, 19);
}

export function loadRide20261102Fixture(): ReplayFixture {
  return parseReplayFixture(
    JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'originPrompt', RIDE_20261102_FIXTURE), 'utf8')),
  );
}

/** D1 trip-register(06:27:45.090) 시각 — fixture 창 시작 + 2분. */
export function ride20261102RegisteredAt(fixture: ReplayFixture): number {
  return fixture.window.fromMs + RIDE_20261102_REGISTERED_AT_OFFSET_MS;
}

export async function replayRide20261102(build: (registeredAt: number) => Trip): Promise<ReplayRunResult> {
  const fixture = loadRide20261102Fixture();
  return runCaptureReplay({ fixture, seedTrips: [build(ride20261102RegisteredAt(fixture))], apns: 'capture' });
}

/** 실제 APNs 요청 중 boarding-prompt alert -> `[KST tick, trainCode]`. */
export function boardingPromptsOf(result: ReplayRunResult, originStation?: string): Array<[string, string]> {
  return result.pushes
    .filter((p) => p.headers.pushType === 'alert' && p.body.body !== undefined)
    .filter((p) => (p.body.body as Record<string, unknown>).kind === 'boarding-prompt')
    .filter((p) => originStation === undefined || (p.body.body as Record<string, unknown>).originStation === originStation)
    .map((p) => [kstOf(p.simNowMs), String((p.body.body as Record<string, unknown>).trainCode)]);
}
