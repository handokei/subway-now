/**
 * #3357 항목 3 — 자동 감시(#2795) 규칙: lockless trip + 환승역 관측(hop-end) 있음 + leg-2 프롬프트 흔적 0 -> 회귀.
 *
 * 입력 `fixtures/watch_20261112_leg2_prompt_missing/events.json` = 프로덕션 D1 `trip_events` 실측 원문(2026-11-06~11-12 보존 구간 전체,
 * 관련 kind만). 불변 — 통과시키려 조정 금지. 이 구간의 유일한 결함 트립이 11/12 b00dd879(뚝섬 -> 건대입구 환승 -> 용마산,
 * 17:25:31 hop-end 후 leg-2 이벤트 0 — #3350).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildLeg2WatchSql, findLocklessLeg2Misses, LEG2_EVIDENCE_GRACE_MS, type TripEventRow } from '../tripMetricsRegressionQuery';
import { findTripLeg2Misses } from '../tripMetricsRegressionScan';

const rows = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'watch_20261112_leg2_prompt_missing', 'events.json'), 'utf-8'),
) as TripEventRow[];

const SCAN_NOW = Date.UTC(2026, 10, 13, 0, 10); // 11/13 00:10Z = KST 09:10 (매일 스캔 시각)
const DAY_MS = 24 * 3600_000;
const HOP_END_ROW_ID = 2420; // 11/12 17:25:31 la-boarding-start 건대입구 path hop-end-prompt
const HOP_END_TS = rows.find((r) => r.id === HOP_END_ROW_ID)!.ts;

function row(partial: Partial<TripEventRow> & Pick<TripEventRow, 'kind'>, offsetMs: number): TripEventRow {
  return { id: 900000 + offsetMs, ts: HOP_END_TS + offsetMs, token_hash: 'b00dd879', station: null, line: null, meta: null, ...partial };
}

describe('findLocklessLeg2Misses (#3357-3)', () => {
  it('★backfill: 11/06~11/12 실측에서 정확히 11/12 b00dd879 건대입구 1건만 회귀로 잡는다', () => {
    const misses = findLocklessLeg2Misses(rows, SCAN_NOW, SCAN_NOW - 7 * DAY_MS);
    expect(misses).toEqual([
      expect.objectContaining({ tokenHash: 'b00dd879', station: '건대입구', transferLine: '2', transferAt: HOP_END_TS, eventIds: [HOP_END_ROW_ID] }),
    ]);
  });

  it('거부: lock이 hop-end 이전에 붙은 트립(11/10 19:27 lock 3358 -> 건대입구 hop-end, 11/07 군자)은 lockless가 아니므로 잡지 않는다', () => {
    const lockTrips = rows.filter((r) => r.ts < HOP_END_TS - 3 * 3600_000);
    expect(lockTrips.some((r) => r.kind === 'la-boarding-start' && String(r.meta).includes('hop-end-prompt'))).toBe(true);
    expect(findLocklessLeg2Misses(lockTrips, SCAN_NOW, 0)).toEqual([]);
  });

  it('거부: 같은 역에 leg-2 leg-boarding-prompt 행(leg!=origin)이 있으면 회귀가 아니다', () => {
    const withLeg2 = [
      ...rows,
      row({ kind: 'leg-boarding-prompt', station: '건대입구', line: '7', meta: JSON.stringify({ leg: 'leg2', outcome: 'weak-axis-blocked' }) }, 5_000),
    ];
    expect(findLocklessLeg2Misses(withLeg2, SCAN_NOW, SCAN_NOW - 7 * DAY_MS)).toEqual([]);
  });

  it('거부: leg 키 없는 leg-boarding-prompt(11/07 군자 5호선 형태)도 leg-2 흔적이다', () => {
    const withLeg2 = [
      ...rows,
      row({ kind: 'leg-boarding-prompt', station: '건대입구', line: '7', meta: JSON.stringify({ outcome: 'suppressed-not-imminent' }) }, 5_000),
    ];
    expect(findLocklessLeg2Misses(withLeg2, SCAN_NOW, SCAN_NOW - 7 * DAY_MS)).toEqual([]);
  });

  it('거부: 같은 역 7호선 la-boarding-start(path boarding-prompt)가 있으면 회귀가 아니다', () => {
    const withStart = [
      ...rows,
      row({ kind: 'la-boarding-start', station: '건대입구', line: '7', meta: JSON.stringify({ path: 'boarding-prompt', ok: true }) }, 30_000),
    ];
    expect(findLocklessLeg2Misses(withStart, SCAN_NOW, SCAN_NOW - 7 * DAY_MS)).toEqual([]);
  });

  it('거부: origin leg 행이나 다른 역의 leg-boarding-prompt는 leg-2 흔적이 아니다(여전히 회귀)', () => {
    const noise = [
      ...rows,
      row({ kind: 'leg-boarding-prompt', station: '건대입구', line: '2', meta: JSON.stringify({ leg: 'origin', outcome: 'fired' }) }, 5_000),
      row({ kind: 'leg-boarding-prompt', station: '군자(능동)', line: '7', meta: JSON.stringify({ leg: 'leg2', outcome: 'fired' }) }, 6_000),
    ];
    expect(findLocklessLeg2Misses(noise, SCAN_NOW, SCAN_NOW - 7 * DAY_MS).map((m) => m.station)).toEqual(['건대입구']);
  });

  it('유예: 아직 끝나지 않은 트립은 hop-end 후 grace 이내면 판정을 보류한다(진행 중 오탐 방지)', () => {
    const trip = rows.filter((r) => r.ts >= HOP_END_TS - 3 * 60_000 && r.ts <= HOP_END_TS);
    expect(trip.some((r) => r.kind === 'trip-end')).toBe(false);
    const insideGrace = HOP_END_TS + LEG2_EVIDENCE_GRACE_MS - 1;
    const afterGrace = HOP_END_TS + LEG2_EVIDENCE_GRACE_MS + 1;
    expect(findLocklessLeg2Misses(trip, insideGrace, 0)).toEqual([]);
    expect(findLocklessLeg2Misses(trip, afterGrace, 0).map((m) => m.station)).toEqual(['건대입구']);
  });

  it('trip-end가 있으면(트립 종료) grace 이내여도 즉시 판정한다 — 실측 11/12 17:41:08 종료', () => {
    const ended = rows.filter((r) => r.ts >= HOP_END_TS - 3 * 60_000);
    expect(ended.some((r) => r.kind === 'trip-end')).toBe(true);
    expect(findLocklessLeg2Misses(ended, HOP_END_TS + 1_000, 0).map((m) => m.station)).toEqual(['건대입구']);
  });

  it('window 하한 이전의 hop-end는 보고하지 않는다(어제 스캔이 이미 다룬 트립)', () => {
    expect(findLocklessLeg2Misses(rows, SCAN_NOW, HOP_END_TS + 1)).toEqual([]);
  });
});

describe('findLocklessLeg2Misses 경계 (#3357-3)', () => {
  const base = rows.filter((r) => r.ts >= HOP_END_TS - 3 * 60_000);

  it('거부: hop-end 뒤 7호선 lock-attached(leg-2 탭 lock)가 있으면 회귀가 아니다', () => {
    const withLock = [...base, row({ kind: 'lock-attached', station: '건대입구', line: '7', meta: JSON.stringify({ path: 'confirm', trainCode: '7254' }) }, 20_000)];
    expect(findLocklessLeg2Misses(withLock, SCAN_NOW, 0)).toEqual([]);
  });

  it('거부: 환승 전 노선(2호선) 재부착 lock-attached는 leg-2 흔적이 아니다 — 단 hop-end 이전이면 lockless가 아니어서 제외', () => {
    const afterOnly = [...base, row({ kind: 'lock-attached', station: '건대입구', line: '2', meta: null }, 20_000)];
    expect(findLocklessLeg2Misses(afterOnly, SCAN_NOW, 0).map((m) => m.station)).toEqual(['건대입구']);
    const before = [...base, row({ kind: 'lock-attached', station: '성수', line: '2', meta: null }, -60_000)];
    expect(findLocklessLeg2Misses(before, SCAN_NOW, 0)).toEqual([]);
  });

  it('meta가 깨진 hop-end 신호/역 없는 신호/다른 역 흔적은 방어적으로 처리한다', () => {
    const odd = [
      ...base.filter((r) => r.id !== HOP_END_ROW_ID),
      row({ kind: 'hop-end-prompt', station: '건대입구', line: '2', meta: '{not json' }, 0),
      row({ kind: 'hop-end-prompt', station: null, line: '2', meta: null }, 1_000),
      row({ kind: 'trip-register', station: '건대입구', line: '7', meta: null }, 2_000),
      row({ kind: 'la-boarding-start', station: '건대입구', line: '7', meta: '{not json' }, 2_500),
      row({ kind: 'la-boarding-start', station: '군자(능동)', line: '7', meta: JSON.stringify({ path: 'boarding-prompt' }) }, 3_000),
    ];
    expect(findLocklessLeg2Misses(odd, SCAN_NOW, 0).map((m) => m.station)).toEqual(['건대입구']);
  });
});

describe('hop-end-prompt lockless-skip 신호 (#3359 연계)', () => {
  // #3359 머지 후 lockless trip은 la-boarding-start hop-end 없이 hop-end-prompt(outcome lockless-skip) 행만 남긴다.
  const afterRows = rows.filter((r) => r.ts >= HOP_END_TS - 3 * 60_000 && r.id !== HOP_END_ROW_ID);
  const skipRow = row({ kind: 'hop-end-prompt', station: '건대입구', line: '2', meta: JSON.stringify({ outcome: 'lockless-skip' }) }, 0);

  it('★lockless-skip 행 + leg-2 흔적 0 -> 회귀로 플래그', () => {
    const misses = findLocklessLeg2Misses([...afterRows, skipRow], SCAN_NOW, 0);
    expect(misses).toEqual([expect.objectContaining({ station: '건대입구', transferLine: '2', eventIds: [skipRow.id] })]);
  });

  it('lockless-skip 행 + leg-2 프롬프트 있음 -> 플래그하지 않는다', () => {
    const leg2 = row({ kind: 'leg-boarding-prompt', station: '건대입구', line: '7', meta: JSON.stringify({ leg: 'leg2', outcome: 'fired' }) }, 10_000);
    expect(findLocklessLeg2Misses([...afterRows, skipRow, leg2], SCAN_NOW, 0)).toEqual([]);
  });
});

describe('buildLeg2WatchSql / findTripLeg2Misses (#3357-3)', () => {
  it('SQL은 trip_events에서 판정에 쓰는 kind만, window 하한에 트립 길이 pre-roll을 둬 조회한다', () => {
    const sql = buildLeg2WatchSql('?');
    expect(sql).toContain('FROM trip_events');
    for (const kind of ['hop-end-prompt', 'la-boarding-start', 'leg-boarding-prompt', 'lock-attached', 'trip-register', 'trip-end']) {
      expect(sql).toContain(`'${kind}'`);
    }
    expect(sql).toMatch(/ts > \? - \d+/);
  });

  it('D1 결과가 비어 있거나 results가 없으면 빈 목록이다', async () => {
    const db = { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({}) }) }) } as unknown as D1Database;
    expect(await findTripLeg2Misses(db, SCAN_NOW)).toEqual([]);
  });

  it('D1 조회 결과로 회귀를 반환하고 bind에는 window 하한 1개만 넘긴다', async () => {
    const bind = vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: rows }) });
    const db = { prepare: vi.fn().mockReturnValue({ bind }) } as unknown as D1Database;
    const misses = await findTripLeg2Misses(db, SCAN_NOW);
    expect(misses.map((m) => m.station)).toEqual(['건대입구']);
    expect(bind).toHaveBeenCalledWith(SCAN_NOW - DAY_MS);
  });
});
