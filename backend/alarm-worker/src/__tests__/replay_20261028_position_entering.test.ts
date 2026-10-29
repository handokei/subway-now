/**
 * #3223 PR-0 — 2026-10-28 실측 라이드(trip 179 아침 7035 / trip 180 저녁 leg-2 7252) 역별 매역 알림 발사 tick.
 *
 * 입력은 불변 실측 — `fixtures/replayLibrary/capture_20261028_trip{179_morning_7035,180_evening_7252}.fixture.json`
 * (R2 `seoul-capture` 원문, etag 일치, `buildReplayFixture.mjs`). 통과시키려 조정 금지.
 *
 * 이 커밋은 **현행(도착 시점 발사) baseline**을 단언한다. replay의 mid pass는 캡처 시각 데이터만 보므로
 * D1 실발사 시각(mid 06:31:15 등)이 메인 tick(06:31:46)에서 발사로 관측된다.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseReplayFixture } from '../replayFixture';
import { runCaptureReplay, type ReplayRunResult } from './helpers/replayHarness';
import { makeRide20261028EveningTrip, makeRide20261028MorningTrip } from './helpers/ride20261028Trips';
import type { Trip } from '../types';

const KST_OFFSET_MS = 9 * 3600_000;
const AM_FIXTURE = 'capture_20261028_trip179_morning_7035.fixture.json';
const PM_FIXTURE = 'capture_20261028_trip180_evening_7252.fixture.json';

interface Fire {
  kst: string;
  pass: 'main' | 'mid';
}

function kstOf(ms: number): string {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(11, 19);
}

async function replay(fixtureName: string, makeTrip: (token: string, now: number) => Trip): Promise<ReplayRunResult> {
  const fixture = parseReplayFixture(
    JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'replayLibrary', fixtureName), 'utf8')),
  );
  return runCaptureReplay({
    fixture,
    seedTrips: [makeTrip('replay-20261028-entering', fixture.window.fromMs)],
    apns: 'capture',
    twoPass: true,
  });
}

/** station-passed alert(`data.nextWaypoint`, collapseId `station-*`)의 모든 발사 — 역별 시간순 목록(중복 제거 없음). */
function fireLog(result: ReplayRunResult): Map<string, Fire[]> {
  const log = new Map<string, Fire[]>();
  const add = (pass: Fire['pass'], pushes: ReplayRunResult['pushes']) => {
    for (const push of pushes) {
      if (push.headers.pushType !== 'alert') continue;
      const { nextWaypoint } = (push.body.data ?? {}) as Record<string, unknown>;
      if (typeof nextWaypoint !== 'string' || !(push.headers.collapseId ?? '').startsWith('station-')) continue;
      log.set(nextWaypoint, [...(log.get(nextWaypoint) ?? []), { kst: kstOf(push.simNowMs), pass }]);
    }
  };
  for (const cycle of result.cycles) add('main', cycle.pushes);
  for (const mid of result.midCycles) add('mid', mid.pushes);
  return log;
}

function firstKst(log: Map<string, Fire[]>): Record<string, string> {
  return Object.fromEntries([...log].map(([station, fires]) => [station, fires[0].kst]));
}

describe('#3223 baseline — 현행 매역 알림은 도착 시점에 발사된다 (실측 10/28 replay)', () => {
  it('trip 179 아침 7035: 군자 06:31:46 / 어린이대공원 06:33:46 / 건대입구(transfer) 06:35:46, 역당 1회', async () => {
    const log = fireLog(await replay(AM_FIXTURE, makeRide20261028MorningTrip));
    expect(firstKst(log)).toEqual({
      '군자(능동)': '06:31:46',
      '어린이대공원(세종대)': '06:33:46',
      건대입구: '06:35:46',
    });
    for (const fires of log.values()) expect(fires).toHaveLength(1);
  });

  it('trip 180 저녁 7252: 어린이대공원 17:27:46 / 군자 17:29:46 / 중곡 17:31:46 / 용마산(dest) 17:33:47, 역당 1회', async () => {
    const log = fireLog(await replay(PM_FIXTURE, makeRide20261028EveningTrip));
    expect(firstKst(log)).toEqual({
      '어린이대공원(세종대)': '17:27:46',
      '군자(능동)': '17:29:46',
      중곡: '17:31:46',
      용마산: '17:33:47',
    });
    for (const fires of log.values()) expect(fires).toHaveLength(1);
  });
});
