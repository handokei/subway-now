/**
 * #2615 (서비스체인① 1단계, cycle 내 +30초 재폴링 pass, 재설계 — allowlist in-memory 연속)
 * — 재생 3 fixture 전량(capture_20260912_line7_synth / capture_20260913T1249Z_b00dd879 /
 * capture_20260913T2127Z_b00dd879, 이슈 본문 지정) 검증:
 *
 *   1. 2-pass(`runCaptureReplay({ twoPass: true })`) 재생에서도 역당 발사가 정확히 1회
 *      (double-fire 0) — `runMidCycleFireOnly`의 dedup(in-memory + 발사 직전 1건 KV GET)이
 *      1차 pass의 기존 dedup과 충돌 없이 동작하는지 확인.
 *   2. 1-pass vs 2-pass 발사 지연(첫 발사 tick) 비교표 — p50 개선 수치 산출(acceptance).
 *      "지연"은 각 fixture의 1-pass 재생 스케줄(twoPass:false, 기존 REPLAY_LIBRARY 게이트와
 *      동일 tick)과 2-pass 재생 스케줄(twoPass:true, t+30 mid pass 추가)에서 같은 역이 처음
 *      발사되는 tick의 차이로 정의한다 — 2-pass 스케줄은 1-pass 스케줄의 상위집합(같은 tick
 *      + 중간 tick)이므로 항상 t2 <= t1 (음의 개선 불가능).
 */
import { describe, expect, it } from 'vitest';
import { REPLAY_LIBRARY, type ReplayLibraryEntry } from './replayLibrary';
import { runCaptureReplay, type ReplayRunResult } from './helpers/replayHarness';
import { firedStationOccurrences } from './helpers/pushAssertions';

function resolveCronIntervalMs(cronIntervalMs: ReplayLibraryEntry['cronIntervalMs']): number | undefined {
  return cronIntervalMs === 'recorded' ? undefined : cronIntervalMs;
}

/**
 * 재생 결과에서 특정 역이 nextWaypoint 채널로 처음 발사된 tick(simNowMs) — 1차(cycles)와
 * mid(midCycles) 양쪽을 시간순으로 합쳐서 찾는다.
 */
function firstFireTick(result: ReplayRunResult, station: string): number | undefined {
  const entries = [
    ...result.cycles.map((c) => ({ simNowMs: c.simNowMs, pushes: c.pushes })),
    ...result.midCycles.map((c) => ({ simNowMs: c.simNowMs, pushes: c.pushes })),
  ].sort((a, b) => a.simNowMs - b.simNowMs);
  for (const entry of entries) {
    if (firedStationOccurrences(entry.pushes).includes(station)) return entry.simNowMs;
  }
  return undefined;
}

describe('#2615 — 재생 3 fixture: 2-pass 역당 발사 정확히 1회 (double-fire 0)', () => {
  for (const entry of REPLAY_LIBRARY) {
    it(`${entry.slug} — twoPass:true 재생에서도 기대 발사 역 집합이 정확히 1회씩만 발사된다`, async () => {
      const fixture = entry.loadFixture();
      const result = await runCaptureReplay({
        fixture,
        seedTrips: entry.seedTrips(),
        cronIntervalMs: resolveCronIntervalMs(entry.cronIntervalMs),
        phaseOffsetMs: 0,
        apns: 'capture',
        twoPass: true,
      });

      const fired = firedStationOccurrences(result.pushes);
      // 중복 없음 — 배열 길이와 Set 크기가 같아야 한다(같은 역 2회 발사 시 length > size).
      expect(fired.length).toBe(new Set(fired).size);
      // 기대 발사 집합 자체도 t+30 pass 추가로 달라지지 않는다(순서 무시 exact-match).
      expect([...fired].sort()).toEqual([...entry.expect.firedStations].sort());
    });
  }
});

describe('#2615 — 재생 측정표: 1-pass vs 2-pass 발사 지연(p50 개선)', () => {
  it('3 fixture 전량 — 2-pass가 1-pass보다 늦게 발사되는 역은 없고, p50 개선폭을 표로 산출한다', async () => {
    type Row = { slug: string; station: string; onePassTick: number; twoPassTick: number; improvementMs: number };
    const rows: Row[] = [];

    for (const entry of REPLAY_LIBRARY) {
      const fixture = entry.loadFixture();
      const cronIntervalMs = resolveCronIntervalMs(entry.cronIntervalMs);

      const onePass = await runCaptureReplay({
        fixture,
        seedTrips: entry.seedTrips(),
        cronIntervalMs,
        phaseOffsetMs: 0,
        apns: 'capture',
        twoPass: false,
      });
      const twoPass = await runCaptureReplay({
        fixture,
        seedTrips: entry.seedTrips(),
        cronIntervalMs,
        phaseOffsetMs: 0,
        apns: 'capture',
        twoPass: true,
      });

      for (const station of entry.expect.firedStations) {
        const t1 = firstFireTick(onePass, station);
        const t2 = firstFireTick(twoPass, station);
        if (t1 === undefined || t2 === undefined) continue;
        rows.push({ slug: entry.slug, station, onePassTick: t1, twoPassTick: t2, improvementMs: t1 - t2 });
      }
    }

    expect(rows.length).toBeGreaterThan(0);

    // 2-pass 스케줄은 1-pass 스케줄의 상위집합(같은 tick + 중간 t+30 tick)이므로, 같은 역의
    // 첫 발사 tick은 절대 2-pass 쪽이 더 늦을 수 없다 — regression 있으면 여기서 즉시 실패.
    for (const row of rows) {
      expect(row.improvementMs).toBeGreaterThanOrEqual(0);
    }

    const improvements = rows.map((r) => r.improvementMs).sort((a, b) => a - b);
    const mid = Math.floor(improvements.length / 2);
    const p50 =
      improvements.length % 2 === 0
        ? (improvements[mid - 1] + improvements[mid]) / 2
        : improvements[mid];

    // PR 본문/측정 plan 인용용 재생 측정표.
    console.log('#2615 재생 측정표 (1-pass vs 2-pass 발사 지연, ms):');
    console.table(rows);
    console.log(`p50 개선: ${p50}ms (n=${improvements.length}, max=${improvements[improvements.length - 1]}ms)`);

    // 발사 양자화를 60s→30s로 절반화하는 설계 목표 — 적어도 일부 역은 t+30 pass에서 먼저
    // 잡혀야 한다(개선폭 0인 fixture만 있으면 이 기능이 실효 없다는 신호).
    expect(improvements.some((d) => d > 0)).toBe(true);
  });
});
