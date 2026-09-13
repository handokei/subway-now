/**
 * 재생 하네스 검증 (#2581, Epic #2239 P0-c) — 7호선 합성 fixture(capture_20260912_line7_synth.json)를
 * `runCaptureReplay`(fetchImpl 레벨, 실 `SeoulArrivalClient` 파싱 경유)로 재생해 #2571과 동일한
 * "위상 무관 매역 발사" 결론을 이번엔 파싱 전 체인 포함으로 재증명한다.
 */
import { describe, expect, it } from 'vitest';
import type { Trip } from '../types';
import { makeCaptureFetch, runCaptureReplay, type CapturedPush } from './helpers/replayHarness';
import { parseReplayFixture } from '../replayFixture';
import fixtureJson from './fixtures/capture_20260912_line7_synth.json';

const fixture = parseReplayFixture(fixtureJson);

const LOCK_TRAIN = '7204';
const SEGMENT = ['건대입구', '어린이대공원(세종대)', '군자(능동)', '중곡'];
const NOW = fixture.window.fromMs;

function makeLockTrip(token: string): Trip {
  return {
    token,
    route: { type: 'direct', line: '7', stops: 3 } as unknown as Trip['route'],
    destination: '중곡',
    waypoints: [
      { stationName: '어린이대공원(세종대)', line: '7', kind: 'intermediate' },
      { stationName: '군자(능동)', line: '7', kind: 'intermediate' },
      { stationName: '중곡', line: '7', kind: 'destination' },
    ],
    boardingLock: {
      trainCode: LOCK_TRAIN,
      line: '7',
      subwayId: '1007',
      selectedDepartureTime: NOW,
      segmentStations: SEGMENT,
      expiresAt: NOW + 60 * 60_000,
    },
    expiresAt: NOW + 60 * 60_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW,
  };
}

function firedStations(pushes: CapturedPush[]): Set<string> {
  const fired = new Set<string>();
  for (const push of pushes) {
    const nextWaypoint = push.body.data as Record<string, unknown> | undefined;
    const station = nextWaypoint?.nextWaypoint;
    if (typeof station === 'string' && station.length > 0) fired.add(station);
  }
  return fired;
}

describe('runCaptureReplay — fixture 시간창 cron 재생', () => {
  it('라이브 네트워크 0으로 fixture만으로 runScheduled를 재생한다', async () => {
    const result = await runCaptureReplay({
      fixture,
      seedTrips: [makeLockTrip('harness-basic')],
    });
    expect(result.cycles.length).toBeGreaterThan(0);
    expect(result.lossyCapture).toBe(false);
  });

  const PHASES = [0, 15_000, 30_000, 45_000];
  const INTERMEDIATES = ['어린이대공원(세종대)', '군자(능동)'];

  it('apns:"capture"로 발사된 push의 nextWaypoint가 매 intermediate 역을 포함한다 (위상 0)', async () => {
    const result = await runCaptureReplay({
      fixture,
      seedTrips: [makeLockTrip('harness-capture')],
      apns: 'capture',
    });
    const fired = firedStations(result.pushes);
    for (const station of INTERMEDIATES) {
      expect(fired.has(station)).toBe(true);
    }
  });

  it('fixture body의 btrainNo(=7204)가 실 파싱 경유 push의 trainCode로 도달한다', async () => {
    const result = await runCaptureReplay({
      fixture,
      seedTrips: [makeLockTrip('harness-trainCode')],
      apns: 'capture',
    });
    const trainCodes = result.pushes
      .map((p) => (p.body.data as Record<string, unknown> | undefined)?.trainCode)
      .filter((v): v is string => typeof v === 'string');
    expect(trainCodes.length).toBeGreaterThan(0);
    for (const code of trainCodes) {
      expect(code).toBe(LOCK_TRAIN);
    }
  });

  it('기존 replay_20260912 테스트와 동일 결론 — 4개 cron 위상 전부 매역 침묵 0', async () => {
    const results: Record<number, string[]> = {};
    for (const phaseOffsetMs of PHASES) {
      const result = await runCaptureReplay({
        fixture,
        seedTrips: [makeLockTrip(`harness-all-phase-${phaseOffsetMs}`)],
        phaseOffsetMs,
        apns: 'capture',
      });
      const fired = firedStations(result.pushes);
      results[phaseOffsetMs] = INTERMEDIATES.filter((s) => fired.has(s));
    }
    // eslint-disable-next-line no-console
    console.log('발사된 intermediate 역 (위상별, fetchImpl 레벨 재생):', JSON.stringify(results, null, 2));
    for (const phaseOffsetMs of PHASES) {
      expect(results[phaseOffsetMs].sort()).toEqual([...INTERMEDIATES].sort());
    }
  });
});

describe('makeCaptureFetch — freshness 경계 / 빈 응답 fallback', () => {
  const target = fixture.entries.find((e) => e.kind === 'arrival')?.target ?? '';
  const firstEntry = fixture.entries.find((e) => e.kind === 'arrival' && e.target === target);
  const firstTMs = firstEntry?.tMs ?? fixture.window.fromMs;

  it('freshMs 이내 최신 entry의 body/status를 그대로 응답한다', async () => {
    const fetchImpl = makeCaptureFetch(fixture, () => firstTMs);
    const res = await fetchImpl(
      `http://seoul.api/api/subway/KEY/json/realtimeStationArrival/0/10/${encodeURIComponent(target)}`,
    );
    expect(res.status).toBe(firstEntry?.status);
    const body = (await res.json()) as { realtimeArrivalList: unknown[] };
    expect(Array.isArray(body.realtimeArrivalList)).toBe(true);
  });

  it('freshMs 경계 밖(만료)이면 Seoul 빈 응답(200)으로 fallback한다', async () => {
    // 마지막 entry 시각보다도 freshMs 이상 지난 시점 — 어떤 entry도 신선 창에 들지 못한다.
    const staleNow = fixture.window.toMs + 100_000;
    const fetchImpl = makeCaptureFetch(fixture, () => staleNow, { freshMs: 20_000 });
    const res = await fetchImpl(
      `http://seoul.api/api/subway/KEY/json/realtimeStationArrival/0/10/${encodeURIComponent(target)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { realtimeArrivalList: unknown[] };
    expect(body.realtimeArrivalList).toEqual([]);
  });

  it('simNow가 아직 entry 시각 이전이면(미래 데이터) 빈 응답으로 fallback한다', async () => {
    const fetchImpl = makeCaptureFetch(fixture, () => firstTMs - 1);
    const res = await fetchImpl(
      `http://seoul.api/api/subway/KEY/json/realtimeStationArrival/0/10/${encodeURIComponent(target)}`,
    );
    const body = (await res.json()) as { realtimeArrivalList: unknown[] };
    expect(body.realtimeArrivalList).toEqual([]);
  });

  it('position kind 미매칭 시 realtimePositionList 빈 응답으로 fallback한다', async () => {
    const fetchImpl = makeCaptureFetch(fixture, () => fixture.window.fromMs - 1);
    const res = await fetchImpl('http://seoul.api/api/subway/KEY/json/realtimePosition/0/100/7%ED%98%B8%EC%84%A0');
    const body = (await res.json()) as { realtimePositionList: unknown[] };
    expect(body.realtimePositionList).toEqual([]);
  });

  it('URL이 arrival/position 패턴에 매칭 안 되면 빈 object 200을 반환한다(휴리스틱 실패 케이스)', async () => {
    const fetchImpl = makeCaptureFetch(fixture, () => fixture.window.fromMs);
    const res = await fetchImpl('http://seoul.api/api/subway/KEY/json/unknownEndpoint/0/10/foo');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
});

describe('runCaptureReplay — lossyCapture 신호', () => {
  it('fixture에 droppedEntries가 있으면 lossyCapture=true', async () => {
    const lossyFixture = { ...fixture, droppedEntries: 3 };
    const result = await runCaptureReplay({ fixture: lossyFixture, seedTrips: [] });
    expect(result.lossyCapture).toBe(true);
  });

  it('fixture에 failedCycleStartsMs가 있으면 lossyCapture=true', async () => {
    const lossyFixture = { ...fixture, failedCycleStartsMs: [fixture.window.fromMs] };
    const result = await runCaptureReplay({ fixture: lossyFixture, seedTrips: [] });
    expect(result.lossyCapture).toBe(true);
  });

  it('seedTrips가 비어도(예: lossy 신호 전용 케이스) 정상 재생된다', async () => {
    const result = await runCaptureReplay({ fixture, seedTrips: [] });
    expect(result.cycles.length).toBeGreaterThan(0);
    expect(result.pushes).toEqual([]);
  });
});
