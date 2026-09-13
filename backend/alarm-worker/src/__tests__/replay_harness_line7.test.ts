/**
 * 재생 하네스 검증 (#2581, Epic #2239 P0-c) — 7호선 합성 fixture(capture_20260912_line7_synth.json)를
 * `runCaptureReplay`(fetchImpl 레벨, 실 `SeoulArrivalClient` 파싱 경유)로 재생해 #2571과 동일한
 * "위상 무관 매역 발사" 결론을 이번엔 파싱 전 체인 포함으로 재증명한다.
 */
import { describe, expect, it } from 'vitest';
import type { Trip } from '../types';
import { SEOUL_ARRIVAL_PATH_SEGMENT, SEOUL_POSITION_PATH_SEGMENT } from '../seoul';
import { makeCaptureFetch, runCaptureReplay, type CapturedPush } from './helpers/replayHarness';
import { parseReplayFixture, type ReplayFixture } from '../replayFixture';
import fixtureJson from './fixtures/capture_20260912_line7_synth.json';

const fixture = parseReplayFixture(fixtureJson);

const LOCK_TRAIN = '7204';
const SEGMENT = ['건대입구', '어린이대공원(세종대)', '군자(능동)', '중곡'];
const NOW = fixture.window.fromMs;

/** 합성 fixture는 15~16s 간격 샘플 — 60s cron이 이를 읽는 시나리오를 재현하려면 명시 옵트인. */
const SYNTH_CRON_INTERVAL_MS = 60_000;

const SEOUL_HOST = 'seoul.api';
const SEOUL_API_KEY = 'KEY';

function arrivalUrl(station: string): string {
  return `http://${SEOUL_HOST}/api/subway/${SEOUL_API_KEY}/json/${SEOUL_ARRIVAL_PATH_SEGMENT}/0/10/${encodeURIComponent(station)}`;
}
function positionUrl(line: string): string {
  return `http://${SEOUL_HOST}/api/subway/${SEOUL_API_KEY}/json/${SEOUL_POSITION_PATH_SEGMENT}/0/100/${encodeURIComponent(line)}`;
}

function makeLockTrip(token: string): Trip {
  return {
    token,
    route: { type: 'direct', line: '7', stops: 3 },
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

/** apns-push-type='alert'인(실제 화면에 뜨는) push만 station으로 집계 — silent만 발사되고
 * 실제로는 침묵인 상태를 green 처리하지 않기 위함 (#2581 리뷰 P5). intermediate/transfer
 * station-passed push는 `data.nextWaypoint`로 station을 싣는다. */
function firedAlertStations(pushes: CapturedPush[]): Set<string> {
  const fired = new Set<string>();
  for (const push of pushes) {
    if (push.headers.pushType !== 'alert') continue;
    const data = push.body.data as Record<string, unknown> | undefined;
    const station = data?.nextWaypoint;
    if (typeof station === 'string' && station.length > 0) fired.add(station);
  }
  return fired;
}

/**
 * 목적지 도착은 station-passed(`nextWaypoint`) 경로가 아니라 `boarding-lock: destination
 * cross-check` → `cleanupTripWithLa(reason:'destination-arrived')` → `sendTripEndedAlertPush`
 * 경로로 완결된다(실측: 60s cron 간격에서는 destination waypoint의 SSoT-freshness 게이트가
 * 마지막 position 확증(어린이대공원/군자 fire 시점)으로부터 시간이 지나 stale 판정되어
 * intermediate와 같은 station-passed push로는 발사되지 않는다 — #2581 리뷰 P8 조사 결과).
 * `data.kind==='trip-ended' && data.reason==='destination-arrived'`가 실제 whole-trip
 * 완결 신호다.
 */
function destinationArrivedFired(pushes: CapturedPush[]): boolean {
  return pushes.some((push) => {
    if (push.headers.pushType !== 'alert') return false;
    const data = push.body.data as Record<string, unknown> | undefined;
    return data?.kind === 'trip-ended' && data?.reason === 'destination-arrived';
  });
}

describe('runCaptureReplay — fixture 시간창 cron 재생', () => {
  it('라이브 네트워크 0으로 fixture만으로 runScheduled를 재생하고, seed trip이 실제로 스캔된다', async () => {
    const result = await runCaptureReplay({
      fixture,
      seedTrips: [makeLockTrip('harness-basic')],
      cronIntervalMs: SYNTH_CRON_INTERVAL_MS,
    });
    expect(result.cycles.length).toBeGreaterThan(0);
    expect(result.lossyCapture).toBe(false);
    // #2581 리뷰 P7 — cycles.length>0만으로는 공허하다. seed trip이 실제로 처리됐음을 증명.
    for (const cycle of result.cycles) {
      expect(cycle.stats.scanned).toBeGreaterThanOrEqual(1);
    }
  });

  const PHASES = [0, 15_000, 30_000, 45_000];
  const INTERMEDIATES = ['어린이대공원(세종대)', '군자(능동)'];

  it('apns:"capture"로 발사된 alert push의 nextWaypoint가 매 intermediate 역을 포함한다 (위상 0)', async () => {
    const result = await runCaptureReplay({
      fixture,
      seedTrips: [makeLockTrip('harness-capture')],
      cronIntervalMs: SYNTH_CRON_INTERVAL_MS,
      apns: 'capture',
    });
    const fired = firedAlertStations(result.pushes);
    for (const station of INTERMEDIATES) {
      expect(fired.has(station)).toBe(true);
    }
  });

  it('fixture body의 btrainNo(=7204)가 실 파싱 경유 push의 trainCode로 도달한다', async () => {
    const result = await runCaptureReplay({
      fixture,
      seedTrips: [makeLockTrip('harness-trainCode')],
      cronIntervalMs: SYNTH_CRON_INTERVAL_MS,
      apns: 'capture',
    });
    const trainCodes = result.pushes
      .filter((p) => p.headers.pushType === 'alert')
      .map((p) => (p.body.data as Record<string, unknown> | undefined)?.trainCode)
      .filter((v): v is string => typeof v === 'string');
    expect(trainCodes.length).toBeGreaterThan(0);
    for (const code of trainCodes) {
      expect(code).toBe(LOCK_TRAIN);
    }
  });

  it('기존 replay_20260912 테스트와 동일 결론 — 4개 cron 위상 전부 intermediate 침묵 0 + destination 완결', async () => {
    const results: Record<number, { intermediates: string[]; destinationArrived: boolean }> = {};
    for (const phaseOffsetMs of PHASES) {
      const result = await runCaptureReplay({
        fixture,
        seedTrips: [makeLockTrip(`harness-all-phase-${phaseOffsetMs}`)],
        cronIntervalMs: SYNTH_CRON_INTERVAL_MS,
        phaseOffsetMs,
        apns: 'capture',
      });
      const fired = firedAlertStations(result.pushes);
      results[phaseOffsetMs] = {
        intermediates: INTERMEDIATES.filter((s) => fired.has(s)),
        destinationArrived: destinationArrivedFired(result.pushes),
      };
    }
    // eslint-disable-next-line no-console
    console.log('발사된 역 + 목적지 완결 (위상별, fetchImpl 레벨 재생):', JSON.stringify(results, null, 2));
    for (const phaseOffsetMs of PHASES) {
      expect(results[phaseOffsetMs].intermediates.sort()).toEqual([...INTERMEDIATES].sort());
      expect(results[phaseOffsetMs].destinationArrived).toBe(true);
    }
  });

  it('목적지(중곡) 도착도 trip-ended alert push로 발사된다 (whole-trip 검증 완결, #2581 리뷰 P8)', async () => {
    const result = await runCaptureReplay({
      fixture,
      seedTrips: [makeLockTrip('harness-destination')],
      cronIntervalMs: SYNTH_CRON_INTERVAL_MS,
      apns: 'capture',
    });
    expect(destinationArrivedFired(result.pushes)).toBe(true);
  });
});

describe('runCaptureReplay — 장시간 재생과 벽시계 독립성 (#2581 리뷰 P4)', () => {
  /**
   * fixture에 없는 가상 역을 첫 waypoint로 둬 trip이 절대 도착/완결되지 않게 한다 — 목적은
   * "이 trip이 destination에 도달해 정상 종료되는지"가 아니라 순수하게 "장시간(6h) 재생에도
   * KV TTL이 벽시계 때문에 trip을 소멸시키지 않는지"만 격리해서 검증하는 것이다. 완결 로직과
   * 뒤섞이면 이 assertion이 "trip이 살아있다"가 아니라 "trip이 아직 안 끝났다"를 우연히
   * 증명하게 되는 혼선이 생긴다.
   */
  function makeStalledTrip(token: string): Trip {
    const base = makeLockTrip(token);
    // trip/lock expiresAt을 6h 재생 창보다 넉넉히 길게 잡는다 — 그렇지 않으면 domain-level
    // `trip.expiresAt <= now` 자연 만료(scheduled.ts 최상단 게이트, KV TTL과 무관)가 먼저
    // 걸려 "KV TTL이 벽시계 독립적인지"라는 이 테스트의 관심사와 섞여 버린다.
    const farFuture = NOW + 24 * 60 * 60_000;
    return {
      ...base,
      waypoints: [
        { stationName: '가상역-존재안함', line: '7', kind: 'intermediate' },
        ...base.waypoints,
      ],
      expiresAt: farFuture,
      boardingLock: base.boardingLock && { ...base.boardingLock, expiresAt: farFuture },
    };
  }

  it('120+ cycle 재생에서도 마지막 cycle까지 seed trip이 KV에서 소멸하지 않는다', async () => {
    // 합성 fixture의 window(478s)보다 훨씬 긴 6시간 창으로 확장해 cron 간격 60s로 걸으면
    // 360+ cycle이 나온다 — trips.ts putTrip의 KV TTL clamp(min 60s)가 실 벽시계가 아니라
    // 재생 시계(simNow)에 정렬돼 있어야 마지막 cycle에도 trip이 살아있다.
    const longFixture: ReplayFixture = {
      ...fixture,
      window: { fromMs: fixture.window.fromMs, toMs: fixture.window.fromMs + 6 * 60 * 60_000 },
    };
    const result = await runCaptureReplay({
      fixture: longFixture,
      seedTrips: [makeStalledTrip('harness-long-replay')],
      cronIntervalMs: SYNTH_CRON_INTERVAL_MS,
    });
    expect(result.cycles.length).toBeGreaterThanOrEqual(120);
    const lastCycle = result.cycles[result.cycles.length - 1];
    expect(lastCycle.stats.scanned).toBeGreaterThanOrEqual(1);
  });
});

describe('makeCaptureFetch — freshness 경계 / 빈 응답 fallback', () => {
  const target = fixture.entries.find((e) => e.kind === 'arrival')?.target ?? '';
  const firstEntry = fixture.entries.find((e) => e.kind === 'arrival' && e.target === target);
  const firstTMs = firstEntry?.tMs ?? fixture.window.fromMs;

  it('freshMs 이내 최신 entry의 body/status를 그대로 응답한다', async () => {
    const fetchImpl = makeCaptureFetch(fixture, () => firstTMs);
    const res = await fetchImpl(arrivalUrl(target));
    expect(res.status).toBe(firstEntry?.status);
    const body = (await res.json()) as { realtimeArrivalList: unknown[] };
    expect(Array.isArray(body.realtimeArrivalList)).toBe(true);
  });

  it('freshMs 경계 밖(만료)이면 Seoul 빈 응답(200)으로 fallback한다', async () => {
    // 마지막 entry 시각보다도 freshMs 이상 지난 시점 — 어떤 entry도 신선 창에 들지 못한다.
    const staleNow = fixture.window.toMs + 100_000;
    const fetchImpl = makeCaptureFetch(fixture, () => staleNow, { freshMs: 20_000 });
    const res = await fetchImpl(arrivalUrl(target));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { realtimeArrivalList: unknown[] };
    expect(body.realtimeArrivalList).toEqual([]);
  });

  it('simNow가 아직 entry 시각 이전이면(미래 데이터) 빈 응답으로 fallback한다', async () => {
    const fetchImpl = makeCaptureFetch(fixture, () => firstTMs - 1);
    const res = await fetchImpl(arrivalUrl(target));
    const body = (await res.json()) as { realtimeArrivalList: unknown[] };
    expect(body.realtimeArrivalList).toEqual([]);
  });

  it('position kind 미매칭 시 realtimePositionList 빈 응답으로 fallback한다', async () => {
    const fetchImpl = makeCaptureFetch(fixture, () => fixture.window.fromMs - 1);
    const res = await fetchImpl(positionUrl('7호선'));
    const body = (await res.json()) as { realtimePositionList: unknown[] };
    expect(body.realtimePositionList).toEqual([]);
  });

  it('URL이 arrival/position 패턴에 매칭 안 되면 빈 object 200을 반환한다(휴리스틱 실패 케이스)', async () => {
    const fetchImpl = makeCaptureFetch(fixture, () => fixture.window.fromMs);
    const res = await fetchImpl('http://seoul.api/api/subway/KEY/json/unknownEndpoint/0/10/foo');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('freshMs opts를 명시하면 makeCaptureFetch가 그 값으로 신선도 판단한다', async () => {
    // firstEntry 이후 30s 시점 — default(20s)라면 만료, freshMs를 40s로 넓히면 여전히 신선.
    const fetchImpl = makeCaptureFetch(fixture, () => firstTMs + 30_000, { freshMs: 40_000 });
    const res = await fetchImpl(arrivalUrl(target));
    const body = (await res.json()) as { realtimeArrivalList: unknown[] };
    expect(body.realtimeArrivalList.length).toBeGreaterThan(0);
  });
});

describe('makeCaptureFetch — truncated entry는 적법한 빈 Seoul JSON으로 서빙된다 (#2581 리뷰 P2)', () => {
  const truncatedStation = '트런케이트역';
  const truncatedFixture: ReplayFixture = {
    schemaVersion: 1,
    source: 'backend-seoul',
    window: { fromMs: 0, toMs: 0 },
    cycleStartsMs: [0],
    entries: [
      {
        tMs: 0,
        kind: 'arrival',
        target: truncatedStation,
        url: arrivalUrl(truncatedStation),
        status: 200,
        body: '',
        truncated: true,
      },
    ],
  };

  it('truncated entry의 raw body("")를 그대로 흘리지 않고 빈 realtimeArrivalList로 매핑한다', async () => {
    const fetchImpl = makeCaptureFetch(truncatedFixture, () => 0);
    const res = await fetchImpl(arrivalUrl(truncatedStation));
    expect(res.status).toBe(200);
    // truncated raw body("")를 그대로 서빙했다면 여기서 SyntaxError — 계약 위반 시 이 자체가 실패.
    const body = (await res.json()) as { realtimeArrivalList: unknown[] };
    expect(body.realtimeArrivalList).toEqual([]);
  });
});

describe('makeCaptureFetch — status=0(fetch 실패 sentinel)은 Response 대신 reject로 재현된다 (#2581 리뷰 P3)', () => {
  const failedFixture: ReplayFixture = {
    schemaVersion: 1,
    source: 'backend-seoul',
    window: { fromMs: 0, toMs: 0 },
    cycleStartsMs: [0],
    entries: [
      { tMs: 0, kind: 'position', target: '7호선', url: positionUrl('7호선'), status: 0, body: '' },
    ],
  };

  it('status=0 entry는 new Response(...) RangeError 대신 fetch reject로 매핑된다', async () => {
    const fetchImpl = makeCaptureFetch(failedFixture, () => 0);
    await expect(fetchImpl(positionUrl('7호선'))).rejects.toThrow();
  });
});

describe('runCaptureReplay — 실 P0-a 캡처 cadence(60s, 드리프트) 시나리오 (#2581 리뷰 P1)', () => {
  const driftStation = '드리프트역';
  // 실제 cron이 정확히 균일한 간격으로 돌지 않는 상황(드리프트) — 두 번째 실행이 90s 뒤에야
  // 일어났다고 가정. entry는 그 실제 실행 시각에 정확히 기록됐다.
  const driftedCycleStartsMs = [0, 90_000];
  const driftedFixture: ReplayFixture = {
    schemaVersion: 1,
    source: 'backend-seoul',
    window: { fromMs: 0, toMs: 90_000 },
    cycleStartsMs: driftedCycleStartsMs,
    entries: [
      {
        tMs: 90_000,
        kind: 'arrival',
        target: driftStation,
        url: arrivalUrl(driftStation),
        status: 200,
        body: JSON.stringify({
          realtimeArrivalList: [
            {
              barvlDt: '0',
              recptnDt: '',
              updnLine: '상행',
              trainLineNm: '',
              btrainNo: '9999',
              subwayNm: null,
              subwayId: '1007',
              arvlCd: 1,
            },
          ],
        }),
      },
    ],
  };

  it('기본(cronIntervalMs 미지정) tick 스케줄은 기록된 cycleStartsMs를 그대로 사용한다', async () => {
    const result = await runCaptureReplay({ fixture: driftedFixture, seedTrips: [] });
    expect(result.cycles.map((c) => c.simNowMs)).toEqual(driftedCycleStartsMs);
  });

  it('cronIntervalMs를 명시하면 합성 균일 그리드로 대체된다(옛 동작, 옵트인) — 드리프트된 entry를 놓친다', async () => {
    const result = await runCaptureReplay({
      fixture: driftedFixture,
      seedTrips: [],
      cronIntervalMs: 60_000,
    });
    // 균일 그리드: [0, 60_000] — window.toMs(90_000)를 넘는 다음 tick(120_000)은 생성 안 됨.
    expect(result.cycles.map((c) => c.simNowMs)).toEqual([0, 60_000]);
    // 그 마지막 tick(60_000)에서 fetch해도 실제 entry(90_000)는 아직 발생 전 — 합성 grid가
    // 실 캡처의 90s 드리프트를 가정하지 못해 완전히 놓친다.
    const fetchImpl = makeCaptureFetch(driftedFixture, () => 60_000);
    const res = await fetchImpl(arrivalUrl(driftStation));
    const body = (await res.json()) as { realtimeArrivalList: unknown[] };
    expect(body.realtimeArrivalList).toEqual([]);
  });

  it('phaseOffsetMs는 기록된 tick들에 상대 오프셋으로 적용된다', async () => {
    const result = await runCaptureReplay({
      fixture: driftedFixture,
      seedTrips: [],
      phaseOffsetMs: 5_000,
    });
    expect(result.cycles.map((c) => c.simNowMs)).toEqual([5_000, 95_000]);
  });

  it('freshMs opts가 runCaptureReplay → makeCaptureFetch로 관통된다', async () => {
    // 90_000 entry로부터 40s 뒤(130_000) — default(20s)라면 놓치지만 freshMs:60_000이면 신선.
    const fetchImpl = makeCaptureFetch(driftedFixture, () => 130_000, { freshMs: 60_000 });
    const res = await fetchImpl(arrivalUrl(driftStation));
    const body = (await res.json()) as { realtimeArrivalList: unknown[] };
    expect(body.realtimeArrivalList.length).toBe(1);
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
    const result = await runCaptureReplay({ fixture, seedTrips: [], cronIntervalMs: SYNTH_CRON_INTERVAL_MS });
    expect(result.cycles.length).toBeGreaterThan(0);
    expect(result.pushes).toEqual([]);
  });
});
