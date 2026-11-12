/**
 * #3352 — 2026-11-12 트립 b00dd879(뚝섬 -> 건대입구 환승 -> 용마산) 탑승 목록 "방금 지나간 열차" (a 슬롯).
 *
 * 사고: 탑승 열차 2336(내선)이 뚝섬을 떠난 뒤 사용자가 트립을 만들었는데, 출발 관측 이력(#3155 stationLogs)에 뚝섬 출발이
 * 없어 목록 a 슬롯이 비었다. 사용자 결정: 목록은 매 조회 시점의 position 피드 스냅샷 하나로 만든다 —
 * a = 같은 방향, 기준역 S를 지나 S+1 사이에 있는 열차 1대, b/c = 접근 열차(기존).
 *
 * 입력은 불변 실측 — `fixtures/replay_20261112_leg2_transfer_boundary/capture.fixture.json`(R2 seoul-capture, 2호선 position).
 * 통과시키려 조정 금지.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isTrainSeenAtAnchor, loadAnchorDepartures } from '../anchorDeparturesQuery';
import { parseReplayFixture } from '../replayFixture';
import { SeoulArrivalClient } from '../seoul';
import { writeSelfPollPosition } from '../selfPollPosition';
import type { Trip, Waypoint } from '../types';
import { InMemoryKV } from './inMemoryKv';

const fixture = parseReplayFixture(
  JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'replay_20261112_leg2_transfer_boundary', 'capture.fixture.json'), 'utf-8'),
  ),
);

/** 2호선 position 응답 원문 -> backend 파서(SeoulArrivalClient) -> self-poll stamp. */
async function stampAt(tMs: number): Promise<KVNamespace> {
  const entry = fixture.entries.find((e) => e.kind === 'position' && e.target === '2호선' && Math.abs(e.tMs - tMs) < 3000);
  if (!entry) throw new Error(`fixture에 ${tMs} 근방 2호선 position이 없다`);
  const client = new SeoulArrivalClient({
    apiKey: 'k',
    host: 'swopenapi.seoul.go.kr',
    now: () => entry.tMs,
    fetchImpl: (async () => new Response(entry.body, { status: 200 })) as unknown as typeof fetch,
  });
  const positions = await client.fetchPositions('2');
  const kv = new InMemoryKV(() => entry.tMs);
  await writeSelfPollPosition(kv as unknown as KVNamespace, '2', positions, entry.tMs);
  return kv as unknown as KVNamespace;
}

const WAYPOINTS: Waypoint[] = [
  { stationName: '성수', line: '2', kind: 'intermediate' },
  { stationName: '건대입구', line: '2', kind: 'transfer' },
  { stationName: '어린이대공원', line: '7', kind: 'intermediate' },
  { stationName: '용마산', line: '7', kind: 'destination' },
] as unknown as Waypoint[];

function tripAt(origin: string, now: number): Trip {
  return {
    token: 'replay-3352',
    route: { type: 'transfer', transferName: '건대입구', fromLine: '2', toLine: '7', stopsToTransfer: 2, stopsFromTransfer: 4 } as unknown as Trip['route'],
    destination: '용마산',
    waypoints: WAYPOINTS,
    expiresAt: now + 3_600_000,
    createdAt: now - 60_000,
    alarmAtEpochMs: now,
    promptDisplay: { originStation: origin, line: '2' },
  } as unknown as Trip;
}

const T_1722 = 1794471767620;
const T_1723 = 1794471826843;
const T_1724 = 1794471886195;

describe('#3352 b00dd879 — 탑승 목록 a(방금 지나간 열차)는 position 스냅샷 하나로 만든다', () => {
  it('17:22:46 / 17:23:45 cycle(기준 뚝섬): a 없음 — 3334(건대입구, 2정거장 앞)가 나오면 실패', async () => {
    for (const t of [T_1722, T_1723]) {
      const view = await loadAnchorDepartures(await stampAt(t), tripAt('뚝섬', t), t);
      expect(view?.station).toBe('뚝섬');
      expect(view?.departed.map((d) => d.trainCode)).toEqual([]);
    }
  });

  it('★17:24:45 cycle(2336 성수 sts=2): 기준 뚝섬이면 a=2336', async () => {
    const view = await loadAnchorDepartures(await stampAt(T_1724), tripAt('뚝섬', T_1724), T_1724);
    expect(view?.departed.map((d) => d.trainCode)).toEqual(['2336']);
    expect(view?.departed[0].currentStation).toBe('성수');
  });

  it('★17:24:45 cycle: 기준 성수(GPS 이동)여도 a=2336(S에서 sts=2 출발)', async () => {
    const view = await loadAnchorDepartures(await stampAt(T_1724), tripAt('성수', T_1724), T_1724);
    expect(view?.departed.map((d) => d.trainCode)).toEqual(['2336']);
  });

  it('거부: 반대 방향 열차(성수 3369 sts=1, 한양대 3363)는 a가 아니다', async () => {
    const view = await loadAnchorDepartures(await stampAt(T_1724), tripAt('뚝섬', T_1724), T_1724);
    expect(view?.departed.map((d) => d.trainCode)).not.toContain('3369');
    expect(view?.departed.map((d) => d.trainCode)).not.toContain('3363');
  });

  it('★a=2336 탭 -> sync corroboration 통과(기준 뚝섬 [뚝섬, 성수, 건대입구])', async () => {
    const kv = await stampAt(T_1724);
    expect(await isTrainSeenAtAnchor(kv, '2336', '2', ['뚝섬', '성수', '건대입구'], T_1724)).toBe(true);
  });

  it('거부: 17:23:45 cycle에서 3334(2정거장 앞)를 탭해도 corroboration 미통과(오선택 방지)', async () => {
    const kv = await stampAt(T_1723);
    expect(await isTrainSeenAtAnchor(kv, '3334', '2', ['뚝섬', '성수', '건대입구'], T_1723)).toBe(false);
  });
});
