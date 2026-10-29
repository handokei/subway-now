/**
 * #3223 — 2026-10-28 실측 라이드(trip 179 아침 7035 / trip 180 저녁 leg-2 7252) 역별 매역 알림 발사 tick.
 *
 * 입력은 불변 실측 — `fixtures/replayLibrary/capture_20261028_trip{179_morning_7035,180_evening_7252}.fixture.json`
 * (R2 `seoul-capture` 원문, etag 일치, `buildReplayFixture.mjs`). 통과시키려 조정 금지.
 *
 * acceptance(plan v2-1 [U5]): 진입(position sttus0)이 캡처 tick에 노출된 intermediate 역(군자AM, 어대PM, 중곡PM)은
 * 그 역의 sttus0 첫 노출 tick에 발사한다. 노출되지 않은 역(어대AM, 군자PM)과 transfer(건대입구)·destination(용마산)은
 * 현행 발사 tick(도착 첫 tick) 그대로다. 역당 발사 1회, 어떤 역도 sttus0 첫 노출 tick보다 먼저 발사하지 않는다.
 * 성수AM은 캡처에 3013 행이 없어 assert 대상에서 뺀다. replay의 mid pass는 캡처 시각 데이터만 보므로 D1 실발사
 * 시각(mid 06:31:15 등)이 메인 tick(06:31:46)에서 발사로 관측된다.
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

const AM_TRAIN = '7035';
const PM_TRAIN = '7252';

/** fixture 에서 `trainCode` 열차가 `station` 에서 trainSttus 0 으로 처음 보인 cycle tick(KST). 없으면 null. */
function firstEnteringTick(fixtureName: string, result: ReplayRunResult, trainCode: string, station: string): string | null {
  const fixture = loadFixture(fixtureName);
  const seen = fixture.entries
    .filter((e) => e.kind === 'position')
    .filter((e) => {
      const rows = (JSON.parse(e.body) as { realtimePositionList?: Array<Record<string, string>> }).realtimePositionList ?? [];
      return rows.some((r) => r.trainNo === trainCode && r.statnNm === station && r.trainSttus === '0');
    })
    .map((e) => e.tMs);
  if (seen.length === 0) return null;
  const first = Math.min(...seen);
  const tick = result.cycles.find((c) => c.simNowMs >= first);
  return tick ? kstOf(tick.simNowMs) : null;
}

function loadFixture(fixtureName: string) {
  return parseReplayFixture(
    JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'replayLibrary', fixtureName), 'utf8')),
  );
}

describe('#3223 — 매역 알림은 진입(position sttus0)이 노출된 intermediate 역에서 그 첫 tick에 발사된다 (실측 10/28 replay)', () => {
  it('trip 179 아침 7035: 군자 06:30:46(진입 첫 tick, 현행 06:31:46) / 어린이대공원 06:33:46(진입 미노출, 불변) / 건대입구 transfer 06:34:46(진입 첫 tick, 현행 06:35:46), 역당 1회', async () => {
    const result = await replay(AM_FIXTURE, makeRide20261028MorningTrip);
    const log = fireLog(result);
    expect(firstKst(log)).toEqual({
      '군자(능동)': '06:30:46',
      '어린이대공원(세종대)': '06:33:46',
      건대입구: '06:34:46',
    });
    for (const fires of log.values()) expect(fires).toHaveLength(1);
    expect(firstEnteringTick(AM_FIXTURE, result, AM_TRAIN, '군자(능동)')).toBe('06:30:46');
    expect(firstEnteringTick(AM_FIXTURE, result, AM_TRAIN, '어린이대공원(세종대)')).toBeNull();
    expect(firstEnteringTick(AM_FIXTURE, result, AM_TRAIN, '건대입구')).toBe('06:34:46');
  });

  it('trip 180 저녁 7252: 어린이대공원 17:26:46 / 중곡 17:30:46 (진입 첫 tick) · 군자 17:29:46(진입 미노출, 불변) · 용마산 dest 17:33:47(불변), 역당 1회', async () => {
    const result = await replay(PM_FIXTURE, makeRide20261028EveningTrip);
    const log = fireLog(result);
    expect(firstKst(log)).toEqual({
      '어린이대공원(세종대)': '17:26:46',
      '군자(능동)': '17:29:46',
      중곡: '17:30:46',
      용마산: '17:33:47',
    });
    for (const fires of log.values()) expect(fires).toHaveLength(1);
    expect(firstEnteringTick(PM_FIXTURE, result, PM_TRAIN, '어린이대공원(세종대)')).toBe('17:26:46');
    expect(firstEnteringTick(PM_FIXTURE, result, PM_TRAIN, '중곡')).toBe('17:30:46');
    expect(firstEnteringTick(PM_FIXTURE, result, PM_TRAIN, '군자(능동)')).toBeNull();
  });

  it('오발사 0: 어떤 역도 그 역 sttus0 첫 노출 tick 보다 먼저 발사되지 않는다', async () => {
    for (const [fixtureName, makeTrip, train] of [
      [AM_FIXTURE, makeRide20261028MorningTrip, AM_TRAIN],
      [PM_FIXTURE, makeRide20261028EveningTrip, PM_TRAIN],
    ] as const) {
      const result = await replay(fixtureName, makeTrip);
      for (const [station, fires] of fireLog(result)) {
        const entering = firstEnteringTick(fixtureName, result, train, station);
        if (entering !== null) expect(fires[0].kst >= entering).toBe(true);
      }
    }
  });
});
