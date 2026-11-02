import { describe, expect, it, vi } from 'vitest';
import { buildReconsumeSql, findReconsumedStations } from '../tripMetricsRegressionQuery';
import { buildReconsumeCheckQuery, formatReconsumeReport, parseReconsumeCheckResponse } from '../checkTripMetricsRegression';
import { findTripReconsumes, maybeRunTripMetricsRegressionScan } from '../tripMetricsRegressionScan';
import { InMemoryKV } from './inMemoryKv';
import type { Env } from '../types';

let seq = 0;
const ev = (kind: string, station: string | null, over: Record<string, unknown> = {}, meta: unknown = null) => ({
  id: ++seq,
  ts: 1000 + seq,
  token_hash: 'tok1',
  kind,
  station,
  meta: meta === null ? null : JSON.stringify(meta),
  ...over,
});

describe('findReconsumedStations 술어 (#3006)', () => {
  it('같은 창 같은 역 prepare-alarm 2회 = 1건', () => {
    const rows = [ev('prepare-alarm', 'A'), ev('prepare-alarm', 'A'), ev('prepare-alarm', 'B')];
    expect(findReconsumedStations(rows).map((r) => [r.station, r.count])).toEqual([['A', 2]]);
  });

  it('trip-end 로 창이 나뉘면 같은 역이어도 0건', () => {
    const rows = [ev('prepare-alarm', 'A'), ev('trip-end', '2-010'), ev('prepare-alarm', 'A')];
    expect(findReconsumedStations(rows)).toEqual([]);
  });

  it('trip-register existedAtRequestStart=false 로 창이 나뉜다, true 는 나누지 않는다', () => {
    const split = [
      ev('prepare-alarm', 'A'),
      ev('trip-register', null, {}, { existedAtRequestStart: false }),
      ev('prepare-alarm', 'A'),
    ];
    expect(findReconsumedStations(split)).toEqual([]);
    const same = [
      ev('prepare-alarm', 'A'),
      ev('trip-register', null, {}, { existedAtRequestStart: true }),
      ev('prepare-alarm', 'A'),
    ];
    expect(findReconsumedStations(same)).toHaveLength(1);
  });

  it('meta 가 깨져 있어도 trip-register 는 분할로 보지 않고 throw 하지 않는다', () => {
    const rows = [ev('prepare-alarm', 'A'), ev('trip-register', null, { meta: '{bad' }), ev('prepare-alarm', 'A')];
    expect(findReconsumedStations(rows)).toHaveLength(1);
  });

  it('토큰이 다르면 합치지 않고, 입력 순서와 무관하게 ts/id 순으로 처리한다', () => {
    const a = ev('prepare-alarm', 'A', { token_hash: 't1' });
    const b = ev('prepare-alarm', 'A', { token_hash: 't2' });
    expect(findReconsumedStations([a, b])).toEqual([]);
    const c = ev('prepare-alarm', 'A', { token_hash: 't1' });
    const end = ev('trip-end', 'x', { token_hash: 't1', ts: a.ts + 0.5 });
    expect(findReconsumedStations([c, end, a])).toEqual([]);
  });

  it('station null prepare-alarm 은 무시한다', () => {
    expect(findReconsumedStations([ev('prepare-alarm', null), ev('prepare-alarm', null)])).toEqual([]);
  });
});

describe('SQL (#3006)', () => {
  it('buildReconsumeSql 은 advance 를 조회 대상에서 제외하고 3종 kind 만 읽는다', () => {
    const sql = buildReconsumeSql('?');
    expect(sql).toMatch(/FROM trip_events/);
    expect(sql).toMatch(/ts\s*>\s*\?/);
    expect(sql).toContain("'prepare-alarm'");
    expect(sql).toContain("'trip-end'");
    expect(sql).toContain("'trip-register'");
    expect(sql).not.toContain("'advance'");
  });

  it('옵션 B: buildReconsumeCheckQuery 는 리터럴 window 를 삽입한다', () => {
    expect(buildReconsumeCheckQuery(1700000000000)).toMatch(/ts\s*>\s*1700000000000/);
  });

  it('parseReconsumeCheckResponse: wrangler --json 응답 -> 재소비 목록', () => {
    const stdout = JSON.stringify([{ results: [ev('prepare-alarm', 'A'), ev('prepare-alarm', 'A')] }]);
    expect(parseReconsumeCheckResponse(stdout).map((r) => r.station)).toEqual(['A']);
  });

  it('formatReconsumeReport', () => {
    const found = findReconsumedStations([ev('prepare-alarm', 'A'), ev('prepare-alarm', 'A')]);
    expect(formatReconsumeReport(found, 0)).toContain('A x2');
    expect(formatReconsumeReport([], 0)).toContain('0건');
  });
});

describe('scan 배선 (#3006)', () => {
  const NOW = Date.UTC(2026, 10, 4, 0, 10);
  function makeDb(eventRows: unknown[]): D1Database {
    return {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: sql.includes('FROM trip_events') ? eventRows : [] }),
        }),
      })),
    } as unknown as D1Database;
  }

  it('findTripReconsumes 는 trip_events 를 조회해 술어를 적용한다', async () => {
    const db = makeDb([ev('prepare-alarm', 'A'), ev('prepare-alarm', 'A')]);
    const found = await findTripReconsumes(db, NOW);
    expect(found.map((f) => f.station)).toEqual(['A']);
  });

  it('maybeRunTripMetricsRegressionScan 이 재소비 결과를 반환한다 (배선 red)', async () => {
    const env = {
      TRIPS: new InMemoryKV(),
      DB: makeDb([ev('prepare-alarm', 'A'), ev('prepare-alarm', 'A')]),
    } as unknown as Env;
    const res = await maybeRunTripMetricsRegressionScan(env, NOW);
    expect(res.ran).toBe(true);
    expect(res.reconsumes?.map((r) => r.station)).toEqual(['A']);
  });
});
