import { describe, expect, it, vi } from 'vitest';
import { buildLaPushDigest, recordLaPushIfChanged } from '../laPushLog';
import { makeFakeLaPushDb } from './fakeLaPushDb';

const CS = { stationName: '군자(능동)', lineName: '5호선', stopsRemaining: 5, etaMinutes: 15 };

describe('#2747 PR-2 recordLaPushIfChanged', () => {
  it('db 미바인딩이면 no-op', async () => {
    await expect(recordLaPushIfChanged(undefined, { token: 't', path: 'update', contentState: CS }, 1)).resolves.toBeUndefined();
  });

  it('첫 push는 1행 기록: kind=la-push, meta.activity=journey, digest 필드 + etaMinutes', async () => {
    const { db, laPushRows } = makeFakeLaPushDb();
    await recordLaPushIfChanged(db, { token: 't', path: 'update', contentState: CS }, 1000);
    const [row] = laPushRows();
    expect(row.station).toBe('군자(능동)');
    expect(row.line).toBe('5호선');
    expect(row.ts).toBe(1000);
    expect(JSON.parse(row.meta as string)).toEqual({
      path: 'update',
      stationName: '군자(능동)',
      stopsRemaining: 5,
      hasEta: true,
      activity: 'journey',
      etaMinutes: 15,
    });
  });

  it('같은 digest 연속이면 0행 추가 (etaMinutes 값이 바뀌어도 유무가 같으면 중복)', async () => {
    const { db, laPushRows } = makeFakeLaPushDb();
    await recordLaPushIfChanged(db, { token: 't', path: 'update', contentState: CS }, 1);
    await recordLaPushIfChanged(db, { token: 't', path: 'update', contentState: { ...CS, etaMinutes: 12 } }, 2);
    expect(laPushRows()).toHaveLength(1);
  });

  it.each([
    ['path', { path: 'advance' as const, contentState: CS }],
    ['stationName', { path: 'update' as const, contentState: { ...CS, stationName: '성수' } }],
    ['stopsRemaining', { path: 'update' as const, contentState: { ...CS, stopsRemaining: 4 } }],
    ['etaMinutes 유무', { path: 'update' as const, contentState: { stationName: CS.stationName, lineName: CS.lineName, stopsRemaining: 5 } }],
  ])('digest 필드 %s가 다르면 새 행', async (_label, next) => {
    const { db, laPushRows } = makeFakeLaPushDb();
    await recordLaPushIfChanged(db, { token: 't', path: 'update', contentState: CS }, 1);
    await recordLaPushIfChanged(db, { token: 't', ...next }, 2);
    expect(laPushRows()).toHaveLength(2);
  });

  it('token(hash)별로 직전 행을 따로 비교한다', async () => {
    const { db, laPushRows } = makeFakeLaPushDb();
    await recordLaPushIfChanged(db, { token: 'a', path: 'update', contentState: CS }, 1);
    await recordLaPushIfChanged(db, { token: 'b', path: 'update', contentState: CS }, 2);
    expect(laPushRows()).toHaveLength(2);
  });

  it('end: contentState 비어 있어도 기록 (stationName null, hasEta false, etaMinutes/line 생략)', async () => {
    const { db, laPushRows } = makeFakeLaPushDb();
    await recordLaPushIfChanged(db, { token: 't', path: 'end', contentState: {} }, 1);
    const [row] = laPushRows();
    expect(row.station).toBeNull();
    expect(row.line).toBeNull();
    expect(JSON.parse(row.meta as string)).toEqual({ path: 'end', stationName: null, stopsRemaining: null, hasEta: false, activity: 'journey' });
  });

  it('직전 행 meta가 null이면 직전 없음으로 보고 기록', async () => {
    const { db, rows, laPushRows } = makeFakeLaPushDb();
    rows.push({ id: 1, tokenHash: '', ts: 0, kind: 'la-push', station: null, line: null, meta: null });
    // hash를 맞추기 위해 실제 기록 후 meta를 지운다
    await recordLaPushIfChanged(db, { token: 't', path: 'update', contentState: CS }, 1);
    laPushRows().forEach((r) => (r.meta = null));
    await recordLaPushIfChanged(db, { token: 't', path: 'update', contentState: CS }, 2);
    expect(laPushRows().filter((r) => r.ts === 2)).toHaveLength(1);
  });

  it('SELECT 실패 시 경고 후 그래도 기록 (관측 누락 방지)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db, laPushRows } = makeFakeLaPushDb({ failSelect: true });
    await recordLaPushIfChanged(db, { token: 't', path: 'update', contentState: CS }, 1);
    expect(laPushRows()).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('buildLaPushDigest: 문자열/숫자가 아닌 값은 null로 정규화', () => {
    expect(buildLaPushDigest('update', { stationName: 1 as unknown as string, stopsRemaining: 'x' as unknown as number })).toEqual({
      path: 'update',
      stationName: null,
      stopsRemaining: null,
      hasEta: false,
    });
  });
});
