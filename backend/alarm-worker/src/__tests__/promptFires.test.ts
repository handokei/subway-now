/** #3221 PR-3a — prompt_fires 모듈 단위(쓰기·읽기·정리 + 실패 방향). */
import { describe, expect, it, vi } from 'vitest';
import { captureXEvent } from '../sentry';
import { TRIP_EVENT_RETENTION_MS } from '../tripEventLog';
import { cleanupPromptFires, readLatestPromptFire, recordPromptFire } from '../promptFires';

vi.mock('../sentry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sentry')>();
  return { ...actual, captureXEvent: vi.fn() };
});

const ROW = { tokenHash: 'h', station: '군자', line: '7', trainCode: '7246', issuedAt: 1000, decision: 'imminent' };

function db(over: { run?: unknown; first?: unknown } = {}) {
  const run = over.run ?? vi.fn().mockResolvedValue({ success: true, meta: { changes: 2 } });
  const first = over.first ?? vi.fn().mockResolvedValue(null);
  const bind = vi.fn().mockReturnValue({ run, first });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { prepare, bind, run, first } as unknown as D1Database & { bind: ReturnType<typeof vi.fn>; prepare: ReturnType<typeof vi.fn> };
}

describe('recordPromptFire', () => {
  it('prompt_fires에 6값을 INSERT한다 (line은 코드 그대로)', async () => {
    const d = db();
    await recordPromptFire(d, ROW);
    expect(d.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO prompt_fires'));
    expect(d.bind).toHaveBeenCalledWith('h', '군자', '7', '7246', 1000, 'imminent');
  });
  it('trainCode null(ambiguity)은 NULL로 기록한다', async () => {
    const d = db();
    await recordPromptFire(d, { ...ROW, trainCode: null });
    expect(d.bind).toHaveBeenCalledWith('h', '군자', '7', null, 1000, 'imminent');
  });
  it('db 미바인딩이면 no-op', async () => {
    await expect(recordPromptFire(undefined, ROW)).resolves.toBeUndefined();
  });
  it('쓰기 실패는 삼키고 Sentry D1-write-failure{table:prompt_fires}', async () => {
    const d = db({ run: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(recordPromptFire(d, ROW)).resolves.toBeUndefined();
    expect(captureXEvent).toHaveBeenCalledWith('D1-write-failure', expect.objectContaining({ table: 'prompt_fires' }));
  });
});

describe('readLatestPromptFire', () => {
  it('(token, station, line)의 최신 행을 {trainCode, issuedAt, decision}으로 돌려준다', async () => {
    const d = db({ first: vi.fn().mockResolvedValue({ train_code: '7246', issued_at: 1000, decision: 'imminent' }) });
    await expect(readLatestPromptFire(d, 'h', '군자', '7')).resolves.toEqual({
      trainCode: '7246',
      issuedAt: 1000,
      decision: 'imminent',
    });
    expect(d.prepare).toHaveBeenCalledWith(expect.stringMatching(/ORDER BY issued_at DESC.*LIMIT 1/s));
    expect(d.bind).toHaveBeenCalledWith('h', '군자', '7');
  });
  it('train_code NULL 행은 trainCode null', async () => {
    const d = db({ first: vi.fn().mockResolvedValue({ train_code: null, issued_at: 5, decision: 'imminent' }) });
    await expect(readLatestPromptFire(d, 'h', '군자', '7')).resolves.toEqual({
      trainCode: null,
      issuedAt: 5,
      decision: 'imminent',
    });
  });
  it('행 없음 / db 없음 / 읽기 실패 -> null (fail-closed)', async () => {
    await expect(readLatestPromptFire(db(), 'h', '군자', '7')).resolves.toBeNull();
    await expect(readLatestPromptFire(undefined, 'h', '군자', '7')).resolves.toBeNull();
    const bad = db({ first: vi.fn().mockRejectedValue(new Error('x')) });
    await expect(readLatestPromptFire(bad, 'h', '군자', '7')).resolves.toBeNull();
  });
});

describe('cleanupPromptFires (R4c)', () => {
  it('trip_events와 같은 7일 상수로 cutoff DELETE, 삭제 행 수 반환', async () => {
    const d = db();
    await expect(cleanupPromptFires(d, 10_000_000)).resolves.toBe(2);
    expect(d.prepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM prompt_fires'));
    expect(d.bind).toHaveBeenCalledWith(10_000_000 - TRIP_EVENT_RETENTION_MS);
  });
  it('db 없음 / meta 없음 / 실패 -> 0', async () => {
    await expect(cleanupPromptFires(undefined, 1)).resolves.toBe(0);
    await expect(cleanupPromptFires(db({ run: vi.fn().mockResolvedValue({ success: true }) }), 1)).resolves.toBe(0);
    await expect(cleanupPromptFires(db({ run: vi.fn().mockRejectedValue(new Error('x')) }), 1)).resolves.toBe(0);
  });
});
