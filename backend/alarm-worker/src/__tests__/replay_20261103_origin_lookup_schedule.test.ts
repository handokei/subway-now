/**
 * #3036 PR-3c (Part of #3036) — 출발역 arrival 조회 스케줄 ("다음 같은 방향 열차 ETA - 120s부터 다시 조회").
 *
 * 사용자 아이디어(원문): "34분 37분이면, 34분 이후에 35분~까지는 하지 않는거 아니면 그전 다음 열차가 몇 분 후에 오는거 이미
 * 알고 있으니까 그 1분 전부터 다시 받아오는거". 적용 결정: 재개 = 다음 열차 ETA - 120s(실측 198건 중 197건 커버), 모든 origin 트립.
 *
 * 불변 조건: 질문을 실제로 트리거하는 position 확정 읽기는 매 cycle 유지(Seoul 추가 호출 0) -> 발사 (tick, 열차) 집합 불변.
 * 줄어드는 것은 출발역 `realtimeStationArrival` 호출뿐. 입력은 불변 실측 fixture:
 *  - 10/28 아침 용마산(REPLAY_LIBRARY `capture_20261028_trip179_morning_7035`) — 발사 직후 다음 열차 7039 ETA가 피드에 있다.
 *  - 11/02 저녁 뚝섬(`replay_20261102_lockless_jump_leg2` caps) — 다음 열차 3370이 ETA 120s 이내라 스케줄이 걸리지 않아야 한다.
 *  - 10/31 09:40 7077 용마산은 R2 캡처가 레포에 fixture로 존재하지 않아(09:55~09:59 5 cycle만 있음) 대조에서 제외 — PR 본문에 명시.
 * 합성 변형(라벨 명시): ETA 모름 / 조기 도착(ETA보다 2분 빨리) / position 스냅샷 부재 — 실측 fixture 본문을 복제해 해당 행만 바꾼다.
 */
import { describe, expect, it } from 'vitest';
import type { ReplayFixture } from '../replayFixture';
import type { Trip } from '../types';
import { boardingPromptsOf, kstOf } from './helpers/originPromptReplay';
import { loadCapsFixture } from './helpers/replay20261019';
import { runCaptureReplay, type ReplayRunResult } from './helpers/replayHarness';
import { makeRide20261102MorningTrip } from './helpers/ride20261102MorningTrips';
import { REPLAY_LIBRARY } from './replayLibrary';

const LEAD_MS = 120_000;
const KST_RECPTN = (text: string): number => Date.parse(`${text.replace(' ', 'T')}+09:00`);

function morning1028Fixture(): ReplayFixture {
  const entry = REPLAY_LIBRARY.find((e) => e.slug === 'capture_20261028_trip179_morning_7035');
  if (entry === undefined) throw new Error('전제 실패 — REPLAY_LIBRARY에 10/28 아침 fixture 없음');
  return entry.loadFixture();
}

function cloneFixture(fixture: ReplayFixture): ReplayFixture {
  return structuredClone(fixture);
}

type RawArrivalRow = Record<string, string>;

/** 복제 fixture의 `station` arrival 본문 행을 변형한다(합성 변형 전용 — 원본 fixture는 불변). */
function mapArrivalRows(fixture: ReplayFixture, station: string, mutate: (rows: RawArrivalRow[]) => RawArrivalRow[]): void {
  for (const entry of fixture.entries) {
    if (entry.kind !== 'arrival' || entry.target !== station) continue;
    const body = JSON.parse(entry.body) as { realtimeArrivalList: RawArrivalRow[] };
    body.realtimeArrivalList = mutate(body.realtimeArrivalList);
    entry.body = JSON.stringify(body);
  }
}

/** 10/28 아침 용마산 promptOptIn origin trip(안내 시작 — 기존 PR-2 대조군 빌더 재사용, 창 미적용). */
async function replayMorning(fixture: ReplayFixture): Promise<ReplayRunResult> {
  const trip = makeRide20261102MorningTrip('replay-20261103-lookup', fixture.window.fromMs, { intent: 'promptOptIn' });
  return runCaptureReplay({ fixture, seedTrips: [trip], apns: 'capture' });
}

/** `target` 역 arrival 조회가 나간 cycle들의 KST tick. */
function arrivalLookupTicks(result: ReplayRunResult, target: string): string[] {
  return result.cycles
    .filter((c) => c.seoulCalls.some((s) => s.kind === 'arrival' && s.target === target))
    .map((c) => kstOf(c.simNowMs));
}

function positionCallCount(result: ReplayRunResult): number {
  return result.cycles.reduce((sum, c) => sum + c.seoulCalls.filter((s) => s.kind === 'position').length, 0);
}

/**
 * 발사 cycle(2번째 recorded cycle = 06:27:45)에 캡처된 arrival 본문에서 `trainCode`의 예측 도착 시각
 * (recptnDt + barvlDt) — 구현과 독립 산출.
 */
function predictedArrivalMs(fixture: ReplayFixture, station: string, trainCode: string, cycleIndex: number): number {
  const [from, to] = [fixture.cycleStartsMs[cycleIndex], fixture.cycleStartsMs[cycleIndex + 1]];
  const row = fixture.entries.find((e) => e.kind === 'arrival' && e.target === station && e.tMs >= from && e.tMs < to);
  if (row === undefined) throw new Error(`전제 실패 — cycle ${cycleIndex}에 ${station} arrival 없음`);
  const list = (JSON.parse(row.body) as { realtimeArrivalList: RawArrivalRow[] }).realtimeArrivalList;
  const found = list.find((r) => r.btrainNo === trainCode);
  if (found === undefined) throw new Error(`전제 실패 — ${station} arrival에 ${trainCode} 없음`);
  return KST_RECPTN(found.recptnDt) + Number(found.barvlDt) * 1000;
}

/** 현행(스케줄 없음) 코드에서 측정한 baseline — 10/28 아침 용마산 매 cycle 조회 + 3 발사. */
const MORNING_1028_BASELINE_LOOKUPS = [
  '06:26:46', '06:27:46', '06:28:46', '06:29:45', '06:30:46', '06:31:46', '06:32:46', '06:33:46',
  '06:34:46', '06:35:46', '06:36:46', '06:37:46', '06:38:46', '06:39:46', '06:40:46',
];
const MORNING_1028_FIRES: Array<[string, string]> = [['06:27:46', '7035'], ['06:33:46', '7039'], ['06:40:46', '7043']];

describe('#3036 PR-3c — 10/28 아침 용마산(실측): 발사 불변 + arrival 조회 감소', () => {
  it('발사 (tick, 열차) 집합이 스케줄 이전과 동일(7035 -> 7039 -> 7043)', async () => {
    const result = await replayMorning(morning1028Fixture());
    expect(result.lossyCapture).toBe(false);
    expect(boardingPromptsOf(result)).toEqual(MORNING_1028_FIRES);
  });

  it('7035 발사 후 7039 예측 도착 - 120s까지 arrival 조회를 건너뛰고, 이후 매분 재개', async () => {
    const fixture = morning1028Fixture();
    const resumeAtMs = predictedArrivalMs(fixture, '용마산', '7039', 1) - LEAD_MS; // 06:27:03 + 360s = 06:33:03, - 120s = 06:31:03
    const result = await replayMorning(fixture);
    const firstFire = result.cycles.find((c) => kstOf(c.simNowMs) === '06:27:46');
    if (firstFire === undefined) throw new Error('전제 실패');
    const expected = MORNING_1028_BASELINE_LOOKUPS.filter((kst) => {
      const tick = result.cycles.find((c) => kstOf(c.simNowMs) === kst);
      if (tick === undefined) throw new Error(`전제 실패 — ${kst} cycle 없음`);
      return !(tick.simNowMs > firstFire.simNowMs && tick.simNowMs < resumeAtMs);
    });
    expect(expected).toHaveLength(MORNING_1028_BASELINE_LOOKUPS.length - 3);
    expect(arrivalLookupTicks(result, '용마산')).toEqual(expected);
  });

  it('Seoul 추가 호출 0 — position 호출 수는 cycle당 호선 수 그대로(2호선+7호선), 건너뛴 cycle도 position 읽기는 유지', async () => {
    const result = await replayMorning(morning1028Fixture());
    expect(positionCallCount(result)).toBe(result.cycles.length * 2);
  });

  it('건너뛴 cycle은 질문을 놓친 게 아니다 — 보류 cycle의 사유는 D1 outcome용 stats에 남는다', async () => {
    const result = await replayMorning(morning1028Fixture());
    const deferred = result.cycles.filter((c) => c.stats.originGpsFreeArrivalLookupDeferred > 0);
    expect(deferred.map((c) => kstOf(c.simNowMs))).toEqual(['06:28:46', '06:29:45', '06:30:46']);
  });
});

describe('#3036 PR-3c — 합성 변형(실측 fixture 복제 + 해당 행만 변경)', () => {
  it('[합성] 조기 도착: 피드 ETA보다 2분 이상 일찍 온 7039도 position 확정으로 놓치지 않는다', async () => {
    const fixture = cloneFixture(morning1028Fixture());
    // 7039 barvlDt 360 -> 600 : 피드는 06:37:03 도착 예측(재개 06:35:03)인데 실제 position 확정은 06:33:46.
    mapArrivalRows(fixture, '용마산', (rows) => rows.map((r) => (r.btrainNo === '7039' ? { ...r, barvlDt: '600' } : r)));
    const result = await replayMorning(fixture);
    expect(boardingPromptsOf(result)).toEqual(MORNING_1028_FIRES);
    // 06:33:46: 보류 중이지만 position이 7039 도착을 보여 그 cycle에는 arrival을 조회하고 발사한다.
    const ticks = arrivalLookupTicks(result, '용마산');
    expect(ticks).toContain('06:33:46');
    // 06:28:46 ~ 06:32:46은 보류(재개 06:35:03 > 06:32:46, 도착 확정 position 없음).
    for (const skipped of ['06:28:46', '06:29:45', '06:30:46', '06:31:46', '06:32:46']) {
      expect(ticks).not.toContain(skipped);
    }
  });

  it('[합성] ETA 모름(다음 열차 행 없음): 저장하지 않고 매분 조회(현행)', async () => {
    const fixture = cloneFixture(morning1028Fixture());
    // 하행(석남행) 다음 열차 7039만 제거 — 상행 7012/7014는 방향 필터에서 어차피 제외된다.
    mapArrivalRows(fixture, '용마산', (rows) => rows.filter((r) => r.btrainNo !== '7039'));
    const result = await replayMorning(fixture);
    expect(boardingPromptsOf(result)).toEqual(MORNING_1028_FIRES);
    expect(arrivalLookupTicks(result, '용마산')).toEqual(MORNING_1028_BASELINE_LOOKUPS);
  });

  it('[합성] arrival 피드 실패(HTTP 522, 10/28 06:41:48 실례): 저장하지 않고 매분 조회, position으로 발사 유지', async () => {
    const fixture = cloneFixture(morning1028Fixture());
    for (const entry of fixture.entries) {
      if (entry.kind !== 'arrival' || entry.target !== '용마산') continue;
      entry.status = 522;
      entry.body = '';
    }
    const result = await replayMorning(fixture);
    expect(boardingPromptsOf(result)).toEqual(MORNING_1028_FIRES);
    expect(arrivalLookupTicks(result, '용마산')).toEqual(MORNING_1028_BASELINE_LOOKUPS);
  });

  it('[합성] position 스냅샷이 비어 있으면(self-poll 실패) 보류를 무시하고 매분 조회', async () => {
    const fixture = cloneFixture(morning1028Fixture());
    // 첫 cycle 이후 7호선 position 유실(harness의 90s stale 재서빙이 끝난 06:28:46~) -> 스냅샷이 비어 보류가 안전하지 않다.
    fixture.entries = fixture.entries.filter((e) => !(e.kind === 'position' && e.target === '7호선' && e.tMs > fixture.window.fromMs + 30_000));
    const result = await replayMorning(fixture);
    expect(boardingPromptsOf(result)).toEqual([['06:27:46', '7035']]);
    // 발사가 1건뿐이라 조회가 끝까지 이어진다 — 매 cycle(보류 없음).
    expect(arrivalLookupTicks(result, '용마산')).toHaveLength(result.cycles.length);
  });
});

describe('#3036 PR-3c — 11/02 저녁 뚝섬(실측): 다음 열차가 ETA 120s 이내면 스케줄이 걸리지 않는다', () => {
  function eveningTrip(at: number): Trip {
    return {
      token: 'replay-20261103-lookup-evening',
      route: { type: 'transfer', transferName: '건대입구', fromLine: '2', toLine: '7', stopsToTransfer: 2, stopsFromTransfer: 4 },
      destination: '용마산',
      waypoints: [
        { stationName: '성수', line: '2', kind: 'intermediate' },
        { stationName: '건대입구', line: '2', kind: 'transfer' },
        { stationName: '어린이대공원(세종대)', line: '7', kind: 'intermediate' },
        { stationName: '군자(능동)', line: '7', kind: 'intermediate' },
        { stationName: '중곡', line: '7', kind: 'intermediate' },
        { stationName: '용마산', line: '7', kind: 'destination' },
      ],
      expiresAt: at + 3_600_000,
      createdAt: at,
      alarmAtEpochMs: at,
      originStationName: '뚝섬',
      promptDisplay: { originStation: '뚝섬', line: '2' },
      apnsEnv: 'production',
      promptOptIn: true,
    } as Trip;
  }

  it('발사 불변(3368 -> 3370 -> 6604) + 조회 6 cycle 그대로', async () => {
    const fixture = loadCapsFixture('replay_20261102_lockless_jump_leg2');
    const result = await runCaptureReplay({ fixture, seedTrips: [eveningTrip(fixture.window.fromMs)], apns: 'capture' });
    expect(boardingPromptsOf(result)).toEqual([['19:44:46', '3368'], ['19:47:46', '3370'], ['19:49:45', '6604']]);
    expect(arrivalLookupTicks(result, '뚝섬')).toEqual(['19:44:46', '19:45:46', '19:46:46', '19:47:46', '19:48:45', '19:49:45']);
  });
});
