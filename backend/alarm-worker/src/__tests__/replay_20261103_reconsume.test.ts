import { describe, expect, it } from 'vitest';
import { findReconsumedStations } from '../tripMetricsRegressionQuery';
import { REPLAY_20261103_RECONSUME_ROWS } from './fixtures/replay_20261103_reconsume_rows';

/**
 * #3006 PR-0 — 재진행(같은 역 재소비) 감시. 실측 D1 35행(불변 fixture)에서 정확히 2건.
 * 기준선: 10/31 강남구청 prepare-alarm x4 (1915/1921/1926/1929), 11/02 건대입구 x2 (1974/1981).
 */
describe('replay 2026-11-03 reconsume (#3006)', () => {
  it('실측 35행에서 정확히 2건: 강남구청 x4, 건대입구 x2', () => {
    const found = findReconsumedStations(REPLAY_20261103_RECONSUME_ROWS);
    expect(found.map(({ station, count, eventIds }) => ({ station, count, eventIds }))).toEqual([
      { station: '강남구청', count: 4, eventIds: [1915, 1921, 1926, 1929] },
      { station: '건대입구', count: 2, eventIds: [1974, 1981] },
    ]);
  });

  it('revert-red 축: advance 행을 술어에 포함하면 5건이 된다 (그래서 제외한다)', () => {
    const asPrepare = REPLAY_20261103_RECONSUME_ROWS.map((r) =>
      r.kind === 'advance' ? { ...r, kind: 'prepare-alarm' } : r,
    );
    expect(findReconsumedStations(asPrepare)).toHaveLength(5);
  });
});
