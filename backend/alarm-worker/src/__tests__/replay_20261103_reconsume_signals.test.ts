import { describe, expect, it } from 'vitest';
import { buildReconsumeSql, findReconsumedStations } from '../tripMetricsRegressionQuery';
import { REPLAY_20261103_RECONSUME_ROWS } from './fixtures/replay_20261103_reconsume_rows';
import { REPLAY_20261103_CRON_ROWS } from './fixtures/replay_20261103_cron_rows';

/**
 * #3006 술어 교체 — #3277 이 비취침 트립의 prepare-alarm 기록을 철거해 신호가 사라졌다.
 * 실측 두 fixture(불변)를 합쳐 prepare-alarm 을 지운 "철거 후 세계"에서도 11/02 사건을 잡는지 본다.
 */
const ALL = [...REPLAY_20261103_RECONSUME_ROWS, ...REPLAY_20261103_CRON_ROWS];
const withoutPrepare = ALL.filter((r) => r.kind !== 'prepare-alarm');
const pick = (rows: typeof ALL) =>
  findReconsumedStations(rows).map(({ station, count, signal }) => ({ station, count, signal }));

describe('replay 2026-11-03 reconsume 술어 교체 (#3006)', () => {
  it('prepare-alarm 이 있는 세계: 기존 2건 유지 + 같은 사건의 sync-dedup 신호(성수 x2) 추가', () => {
    expect(pick(ALL)).toEqual([
      { station: '강남구청', count: 4, signal: 'prepare-alarm-repeat' },
      { station: '건대입구', count: 2, signal: 'prepare-alarm-repeat' },
      { station: '성수', count: 2, signal: 'sync-dedup-repeat' },
    ]);
  });

  it('prepare-alarm 철거 후 세계(#3277): 11/02 건대입구 사건은 성수 sync-dedup x2 로 잡힌다', () => {
    const found = findReconsumedStations(withoutPrepare);
    expect(found.map(({ station, count, signal }) => ({ station, count, signal }))).toEqual([
      { station: '성수', count: 2, signal: 'sync-dedup-repeat' },
    ]);
    expect(found[0].eventIds).toEqual([1973, 1980]);
  });

  it('정상 dwell(sent 1 + station-passed-dedup 1: 중곡·군자·어린이대공원·청담)은 거짓양성이 아니다', () => {
    const normalDedup = withoutPrepare.filter(
      (r) => r.kind === 'cron-fire-attempt' && (r.meta ?? '').includes('"reason":"station-passed-dedup"'),
    );
    expect(normalDedup.length).toBeGreaterThanOrEqual(5);
    const stations = pick(withoutPrepare).map((f) => f.station);
    expect(stations).toEqual(['성수']);
  });

  it('알려진 사각: 10/31 강남구청은 철거 후 세계에서 cron 행만으로는 안 잡힌다 (sent+dedup 2행 = 정상 dwell과 동일)', () => {
    expect(pick(withoutPrepare).map((f) => f.station)).not.toContain('강남구청');
  });
});

let seq = 100000;
const ev = (kind: string, station: string | null, meta: unknown = null, over: Record<string, unknown> = {}) => ({
  id: ++seq,
  ts: seq,
  token_hash: 'tokX',
  kind,
  station,
  meta: meta === null ? null : JSON.stringify(meta),
  ...over,
});
const syncDedup = (s: string | null) =>
  ev('cron-fire-attempt', s, { outcome: 'skipped-reason', reason: 'sync-station-passed-dedup' });

describe('재소비 신호 단위 (#3006)', () => {
  it('progress-reconcile 행은 1건만으로 신호다 (되돌림 복구의 직접 증거)', () => {
    const found = findReconsumedStations([ev('progress-reconcile', '건대입구', { advancedBy: 1 })]);
    expect(found.map(({ station, count, signal }) => ({ station, count, signal }))).toEqual([
      { station: '건대입구', count: 1, signal: 'progress-reconcile' },
    ]);
  });

  it('lock-reanchor 는 lock epoch 시작의 정상 재고정이라 신호가 아니다', () => {
    expect(findReconsumedStations([ev('lock-reanchor', '용마산', { fromKey: 'a', toKey: 'b' })])).toEqual([]);
  });

  it('sync-dedup 이 1회뿐이면 신호가 아니다 / 2회부터 신호', () => {
    expect(findReconsumedStations([syncDedup('A')])).toEqual([]);
    expect(findReconsumedStations([syncDedup('A'), syncDedup('A')])).toHaveLength(1);
  });

  it('sync-dedup 은 다른 reason(station-passed-dedup)·다른 역·다른 창을 섞어 세지 않는다', () => {
    const other = ev('cron-fire-attempt', 'A', { outcome: 'skipped-reason', reason: 'station-passed-dedup' });
    expect(findReconsumedStations([syncDedup('A'), other, syncDedup('B')])).toEqual([]);
    expect(findReconsumedStations([syncDedup('A'), ev('trip-end', 'x'), syncDedup('A')])).toEqual([]);
  });

  it('깨진 meta·null meta 의 cron 행은 무시하고 throw 하지 않는다', () => {
    const bad = ev('cron-fire-attempt', 'A', null, { meta: '{bad' });
    const none = ev('cron-fire-attempt', 'A');
    expect(findReconsumedStations([bad, none, bad, none])).toEqual([]);
  });

  it('station null 인 progress-reconcile·sync-dedup 은 무시한다', () => {
    expect(findReconsumedStations([ev('progress-reconcile', null)])).toEqual([]);
    expect(findReconsumedStations([syncDedup(null), syncDedup(null)])).toEqual([]);
  });

  it('SQL: 새 신호 kind 를 조회하고 advance·lock-reanchor 는 조회하지 않는다', () => {
    const sql = buildReconsumeSql('?');
    for (const k of ['prepare-alarm', 'cron-fire-attempt', 'progress-reconcile', 'trip-end', 'trip-register']) {
      expect(sql).toContain(`'${k}'`);
    }
    expect(sql).not.toContain("'advance'");
    expect(sql).not.toContain("'lock-reanchor'");
  });
});
