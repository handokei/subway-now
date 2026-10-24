/**
 * #3132 — 코레일 운영 노선 `barvlDt=0` = "시간 모름"을 0초로 해석해 LA 즉시트리거·푸시 본문 시각·LA ETA·
 * 표시 ETA를 오염시키던 회귀의 backend 실측 replay.
 *
 * fixture(`fixtures/korail_20261021/*.json`)는 2026-10-21 14:50 KST 서울 열린데이터 `realtimeStationArrival`
 * 원본 응답이다(API 키 없음). **불변** — 통과시키려고 조정 금지. device PR(`src/testUtils/fixtures/korail_20261021`)과
 * 같은 파일·같은 기대값을 공유해 두 파서의 drift를 막는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SeoulArrivalClient, parseRecptnDt, type ArrivalEntry } from '../seoul';
import {
  buildRecentPromptCandidates,
  estimateBoardingLockArrival,
  pickBestArrivalSignal,
  type ScheduledDeps,
} from '../scheduled';
import { buildLiveActivityContentState } from '../liveActivity';
import { isEtaUnknownRow, minKnownEtaSeconds, parseStopsAway } from '../arrivalEta';
import type { BoardingLockMeta, Waypoint } from '../types';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'korail_20261021');

interface RawRow {
  recptnDt: string;
  btrainNo: string;
  barvlDt: string;
  arvlCd: string;
}

function loadFixture(station: string): { realtimeArrivalList: RawRow[] } {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${station}.json`), 'utf8'));
}

function makeClient(
  station: string,
  positions: unknown[] = [],
): { client: SeoulArrivalClient; now: number } {
  const body = loadFixture(station);
  // recptnDt 시차 보정(drift)을 0으로 고정 — known 행의 초 값이 fixture 원값 그대로 남는다.
  const now = parseRecptnDt(body.realtimeArrivalList[0].recptnDt);
  const client = new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => now,
    fetchImpl: (async (url: string) =>
      url.includes('/realtimePosition/')
        ? new Response(JSON.stringify({ realtimePositionList: positions }), { status: 200 })
        : new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch,
  });
  return { client, now };
}

async function parseStation(station: string): Promise<ArrivalEntry[]> {
  return makeClient(station).client.fetchArrivals(station);
}

function byTrain(entries: ArrivalEntry[], trainCode: string, arvlCd?: number): ArrivalEntry {
  const hit = entries.find((e) => e.trainCode === trainCode && (arvlCd === undefined || e.arvlCd === arvlCd));
  if (!hit) throw new Error(`fixture row not found: ${trainCode}/${arvlCd}`);
  return hit;
}

describe('replay 20261021 backend 파서 (device와 같은 fixture/기대값)', () => {
  it('서울숲 1075 3행: 도착(1)=0, [3]번째 전역=null/3, 전역 도착(5)=null/1', async () => {
    const entries = await parseStation('서울숲');
    expect(byTrain(entries, '6546')).toMatchObject({ arvlCd: 1, arrivalSeconds: 0, stopsAway: null });
    expect(byTrain(entries, '6112')).toMatchObject({ arvlCd: 99, arrivalSeconds: null, stopsAway: 3 });
    expect(byTrain(entries, '6139')).toMatchObject({ arvlCd: 5, arrivalSeconds: null, stopsAway: 1 });
  });

  it('청량리 1001 11행: 실값 2(120·cd5, 240·cd99) / 진입·도착 0행 2 / unknown 7', async () => {
    const entries = (await parseStation('청량리')).filter((e) => e.subwayId === '1001');
    expect(entries).toHaveLength(11);
    const seconds = entries.map((e) => e.arrivalSeconds);
    expect(seconds.filter((s) => s === null)).toHaveLength(7);
    expect(seconds.filter((s) => s === 0)).toHaveLength(2);
    expect(seconds.filter((s): s is number => s !== null && s > 0).sort((a, b) => a - b)).toEqual([120, 240]);
    const unknownStops = entries
      .filter((e) => e.arrivalSeconds === null)
      .map((e) => e.stopsAway as number)
      .sort((a, b) => a - b);
    expect(unknownStops).toEqual([1, 2, 6, 14, 23, 23, 41]);
  });

  it('거부: 선릉 2호선 행(180/240/410/560) 불변, 왕십리·공덕 2·5·6호선은 전부 known', async () => {
    const seonneung = (await parseStation('선릉')).filter((e) => e.subwayId === '1002');
    expect(seonneung.map((e) => e.arrivalSeconds).sort((a, b) => (a as number) - (b as number))).toEqual([
      180, 240, 410, 560,
    ]);
    for (const station of ['왕십리', '공덕']) {
      const entries = await parseStation(station);
      const metro = entries.filter((e) => ['1002', '1005', '1006'].includes(e.subwayId ?? ''));
      expect(metro.length).toBeGreaterThan(0);
      for (const e of metro) expect(e.arrivalSeconds).not.toBeNull();
    }
  });

  it('거부: arvlCd 0/1/2 + barvlDt 0 은 0 유지 (공덕 1065 출발=0), 전역 출발(cd3)+0 은 null/1', async () => {
    const entries = await parseStation('공덕');
    expect(byTrain(entries, 'A2131', 2).arrivalSeconds).toBe(0);
    expect(byTrain(entries, 'A1027', 3)).toMatchObject({ arrivalSeconds: null, stopsAway: 1 });
  });
});

describe('pickBestArrivalSignal — unknown 행', () => {
  const waypoint: Waypoint = { stationName: '서울숲', line: 'bundang', kind: 'intermediate' };

  it('3순위 min-ETA는 unknown 행을 제외한다 (예전: unknown=0 이 최솟값으로 뽑혔다)', async () => {
    const entries = await parseStation('청량리');
    const line1 = entries.filter((e) => e.subwayId === '1001' && e.arvlCd === 99);
    const signal = pickBestArrivalSignal(line1, { stationName: '청량리', line: '1', kind: 'destination' });
    expect(signal).toEqual({ etaSeconds: 240, arvlCd: 99 });
  });

  it('전부 unknown이면 etaSeconds=null (0으로 접지 않는다)', async () => {
    const entries = (await parseStation('서울숲')).filter((e) => e.arvlCd === 99);
    expect(pickBestArrivalSignal(entries, waypoint)).toEqual({ etaSeconds: null, arvlCd: 99 });
  });

  it('2순위 early 신호(전역 도착, unknown)는 etaSeconds=null 로 노출 — 플랜의 "arvlCd 4/5는 null 불가" 가정이 틀렸음을 고정', async () => {
    const entries = (await parseStation('서울숲')).filter((e) => e.trainCode === '6139');
    expect(pickBestArrivalSignal(entries, waypoint)).toEqual({ etaSeconds: null, arvlCd: 5 });
  });
});

describe('estimateBoardingLockArrival — unknown 매칭', () => {
  const lock: BoardingLockMeta = {
    trainCode: '6139',
    line: 'bundang',
    subwayId: '1075',
    selectedDepartureTime: 0,
    segmentStations: ['선정릉', '서울숲'],
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  const waypoint: Waypoint = { stationName: '서울숲', line: 'bundang', kind: 'intermediate' };

  function deps(client: SeoulArrivalClient): ScheduledDeps {
    return { seoul: client } as unknown as ScheduledDeps;
  }

  it('arrived:false + 매칭 행 unknown + position 없음 → epoch=null (지어낸 now 금지, LA/reschedule 입력 없음)', async () => {
    const { client, now } = makeClient('서울숲');
    const result = await estimateBoardingLockArrival(deps(client), lock, waypoint, now);
    expect(result).toEqual({ epoch: null, arrived: false, arvlCd: 5 });
  });

  it('arrived:false + 매칭 행 unknown + position 있음 → position 추정 epoch 우선', async () => {
    const { client, now } = makeClient('서울숲', [
      { trainNo: '6139', statnNm: '선정릉', trainSttus: 1, updnLine: '1', lastRecptnDt: '' },
    ]);
    const result = await estimateBoardingLockArrival(deps(client), lock, waypoint, now);
    // 선정릉(idx0) -> 서울숲(idx1) = 1 hop * 90s
    expect(result).toEqual({ epoch: now + 90_000, arrived: false, arvlCd: 5 });
  });

  it('매칭 행이 known 이면 기존대로 arrivals ETA 우선 (position 이 있어도)', async () => {
    const { client, now } = makeClient('공덕', [
      { trainNo: '5109', statnNm: '왕십리', trainSttus: 1, updnLine: '1', lastRecptnDt: '' },
    ]);
    const known: BoardingLockMeta = { ...lock, trainCode: '5109', line: '5', subwayId: '1005', segmentStations: ['왕십리', '공덕'] };
    const result = await estimateBoardingLockArrival(
      deps(client),
      known,
      { stationName: '공덕', line: '5', kind: 'intermediate' },
      now,
    );
    expect(result).toEqual({ epoch: now + 120_000, arrived: false, arvlCd: 5 });
  });
});

describe('buildLiveActivityContentState — etaSeconds=null', () => {
  const waypoint: Waypoint = { stationName: '서울숲', line: 'bundang', kind: 'intermediate' };

  it('null 이면 etaMinutes 필드를 emit 하지 않는다 (예전: ?? 0 으로 0분 "곧 도착")', () => {
    const state = buildLiveActivityContentState(waypoint, null, 2);
    expect('etaMinutes' in state).toBe(false);
    expect(state.stopsRemaining).toBe(2);
  });

  it('숫자면 기존 동작 (0초 -> 0분, 150초 -> 3분)', () => {
    expect(buildLiveActivityContentState(waypoint, 0, 2).etaMinutes).toBe(0);
    expect(buildLiveActivityContentState(waypoint, 150, 2).etaMinutes).toBe(3);
  });
});

describe('buildRecentPromptCandidates — 정렬', () => {
  it('초 있는 행 -> stopsAway 오름차순 -> stopsAway도 모르는 행 맨 뒤, 어떤 행도 빠지지 않음', () => {
    const pool = [
      { trainCode: 'U-null', arrivalSeconds: null, stopsAway: null },
      { trainCode: 'U-9', arrivalSeconds: null, stopsAway: 9 },
      { trainCode: 'K-240', arrivalSeconds: 240, stopsAway: null },
      { trainCode: 'U-2', arrivalSeconds: null, stopsAway: 2 },
      { trainCode: 'K-0', arrivalSeconds: 0, stopsAway: null },
    ];
    expect(buildRecentPromptCandidates(pool, 1).trainCodes).toEqual(['K-0', 'K-240', 'U-2', 'U-9', 'U-null']);
  });
});

describe('arrivalEta 헬퍼', () => {
  it('isEtaUnknownRow: P3 (0/1/2 + 0 은 known, 그 외 0·NaN·음수·arvlCd 누락은 unknown)', () => {
    expect(isEtaUnknownRow(0, 99)).toBe(true);
    expect(isEtaUnknownRow(0, 5)).toBe(true);
    expect(isEtaUnknownRow(0, null)).toBe(true);
    expect(isEtaUnknownRow(Number.NaN, 99)).toBe(true);
    expect(isEtaUnknownRow(-1, 3)).toBe(true);
    for (const cd of [0, 1, 2]) expect(isEtaUnknownRow(0, cd)).toBe(false);
    expect(isEtaUnknownRow(240, 99)).toBe(false);
  });

  it('parseStopsAway: [N]번째 전역 / unknown 3·4·5 = 1 / known "전역 도착"은 null', () => {
    expect(parseStopsAway('[3]번째 전역 (선정릉)', 99, true)).toBe(3);
    expect(parseStopsAway('전역 도착', 5, true)).toBe(1);
    expect(parseStopsAway('전역 도착', 5, false)).toBeNull();
    expect(parseStopsAway('전역 도착', null, true)).toBeNull();
  });

  it('minKnownEtaSeconds: unknown 제외, 전부 unknown/빈 pool은 null', () => {
    expect(minKnownEtaSeconds([{ arrivalSeconds: null }, { arrivalSeconds: 90 }, { arrivalSeconds: 30 }])).toBe(30);
    expect(minKnownEtaSeconds([{ arrivalSeconds: null }])).toBeNull();
    expect(minKnownEtaSeconds([])).toBeNull();
  });

  it('estimateBoardingLockArrival: arvlCd 1 + 합성 null ETA 는 도착 = now', async () => {
    const entry = { arvlCd: 1, arrivalSeconds: null, trainCode: 'X' } as unknown as ArrivalEntry;
    const seoul = { fetchArrivals: async () => [entry], fetchPositions: async () => [] };
    const lock = { trainCode: 'X', line: '2', subwayId: '1002', selectedDepartureTime: 0, segmentStations: [], expiresAt: 1 } as BoardingLockMeta;
    const result = await estimateBoardingLockArrival(
      { seoul } as unknown as ScheduledDeps,
      lock,
      { stationName: '강남', line: '2', kind: 'intermediate' },
      1_000,
    );
    expect(result).toEqual({ epoch: 1_000, arrived: true, arvlCd: 1 });
  });
});
