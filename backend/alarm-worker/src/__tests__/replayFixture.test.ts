import { describe, expect, it } from 'vitest';
import { buildReplayFixture, parseReplayFixture, type ReplayFixture } from '../replayFixture';
import type { SeoulCaptureCycle, SeoulCaptureEntry } from '../seoulCapture';

function makeEntry(tMs: number, overrides: Partial<SeoulCaptureEntry> = {}): SeoulCaptureEntry {
  return {
    tMs,
    kind: 'arrival',
    target: '교대',
    url: 'http://example.com/masked',
    status: 200,
    body: '{}',
    ...overrides,
  };
}

function makeCycle(cycleStartMs: number, entries: SeoulCaptureEntry[]): SeoulCaptureCycle {
  return {
    schemaVersion: 1,
    cycleStartMs,
    scanned: entries.length,
    seoulCalls: entries.length,
    entries,
  };
}

describe('buildReplayFixture', () => {
  it('시간 역순 cycle 3개를 병합해 entries tMs 오름차순 + cycleStartsMs 3개 + window 자동 산출', () => {
    const cycles = [
      makeCycle(3000, [makeEntry(3100)]),
      makeCycle(1000, [makeEntry(1100), makeEntry(1050)]),
      makeCycle(2000, [makeEntry(2100)]),
    ];

    const fixture = buildReplayFixture(cycles);

    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.source).toBe('backend-seoul');
    expect(fixture.entries.map((e) => e.tMs)).toEqual([1050, 1100, 2100, 3100]);
    expect(fixture.cycleStartsMs).toEqual([1000, 2000, 3000]);
    expect(fixture.window).toEqual({ fromMs: 1050, toMs: 3100 });
  });

  it('entries가 없으면 cycleStartMs 범위로 window fallback', () => {
    const cycles = [makeCycle(5000, []), makeCycle(1000, [])];

    const fixture = buildReplayFixture(cycles);

    expect(fixture.window).toEqual({ fromMs: 1000, toMs: 5000 });
    expect(fixture.entries).toEqual([]);
  });

  it('cycle/entries가 모두 없으면 window은 0~0', () => {
    const fixture = buildReplayFixture([]);
    expect(fixture.window).toEqual({ fromMs: 0, toMs: 0 });
    expect(fixture.cycleStartsMs).toEqual([]);
    expect(fixture.entries).toEqual([]);
  });

  it('window 지정 시 범위 밖 entry/cycleStartMs를 제외한다', () => {
    const cycles = [
      makeCycle(1000, [makeEntry(1000), makeEntry(1500)]),
      makeCycle(5000, [makeEntry(5000)]),
    ];

    const fixture = buildReplayFixture(cycles, { fromMs: 1000, toMs: 2000 });

    expect(fixture.entries.map((e) => e.tMs)).toEqual([1000, 1500]);
    expect(fixture.cycleStartsMs).toEqual([1000]);
    expect(fixture.window).toEqual({ fromMs: 1000, toMs: 2000 });
  });

  it('truncated entry를 그대로 보존한다', () => {
    const cycles = [makeCycle(1000, [makeEntry(1000, { truncated: true, body: '' })])];

    const fixture = buildReplayFixture(cycles);

    expect(fixture.entries[0]).toMatchObject({ truncated: true, body: '' });
  });
});

describe('parseReplayFixture', () => {
  function validFixture(): ReplayFixture {
    return {
      schemaVersion: 1,
      source: 'backend-seoul',
      window: { fromMs: 1000, toMs: 2000 },
      cycleStartsMs: [1000],
      entries: [makeEntry(1000)],
    };
  }

  it('유효한 fixture를 그대로 파싱한다', () => {
    const fixture = validFixture();
    expect(parseReplayFixture(fixture)).toEqual(fixture);
  });

  it('truncated 필드가 있는 entry도 보존한다', () => {
    const fixture = validFixture();
    fixture.entries = [makeEntry(1000, { truncated: true })];
    expect(parseReplayFixture(fixture).entries[0]).toMatchObject({ truncated: true });
  });

  it.each([
    ['root이 object가 아님', null],
    ['root이 object가 아님(배열)', [1, 2]],
  ])('%s → Error', (_label, raw) => {
    expect(() => parseReplayFixture(raw)).toThrow('object여야');
  });

  it('schemaVersion 불일치 → Error', () => {
    expect(() => parseReplayFixture({ ...validFixture(), schemaVersion: 2 })).toThrow('schemaVersion');
  });

  it('source 불일치 → Error', () => {
    expect(() => parseReplayFixture({ ...validFixture(), source: 'device' })).toThrow('source');
  });

  it('window 누락 → Error', () => {
    expect(() => parseReplayFixture({ ...validFixture(), window: undefined })).toThrow('window');
  });

  it('window.fromMs가 number 아님 → Error', () => {
    expect(() => parseReplayFixture({ ...validFixture(), window: { fromMs: '1', toMs: 2 } })).toThrow('fromMs');
  });

  it('window.toMs가 number 아님 → Error', () => {
    expect(() => parseReplayFixture({ ...validFixture(), window: { fromMs: 1, toMs: '2' } })).toThrow('toMs');
  });

  it('cycleStartsMs가 배열 아님 → Error', () => {
    expect(() => parseReplayFixture({ ...validFixture(), cycleStartsMs: 'x' })).toThrow('cycleStartsMs');
  });

  it('cycleStartsMs 원소가 number 아님 → Error', () => {
    expect(() => parseReplayFixture({ ...validFixture(), cycleStartsMs: [1, '2'] })).toThrow('cycleStartsMs');
  });

  it('entries가 배열 아님 → Error', () => {
    expect(() => parseReplayFixture({ ...validFixture(), entries: 'x' })).toThrow('entries');
  });

  it('entries[i]가 object 아님 → Error', () => {
    expect(() => parseReplayFixture({ ...validFixture(), entries: [1] })).toThrow('entries[0]');
  });

  it('entries[i].tMs가 number 아님 → Error', () => {
    const fixture = validFixture();
    fixture.entries = [{ ...makeEntry(1000), tMs: '1000' } as unknown as SeoulCaptureEntry];
    expect(() => parseReplayFixture(fixture)).toThrow('tMs');
  });

  it('entries[i].kind가 유효값 아님 → Error', () => {
    const fixture = validFixture();
    fixture.entries = [{ ...makeEntry(1000), kind: 'bogus' } as unknown as SeoulCaptureEntry];
    expect(() => parseReplayFixture(fixture)).toThrow('kind');
  });

  it('entries[i].target가 string 아님 → Error', () => {
    const fixture = validFixture();
    fixture.entries = [{ ...makeEntry(1000), target: 1 } as unknown as SeoulCaptureEntry];
    expect(() => parseReplayFixture(fixture)).toThrow('target');
  });

  it('entries[i].url가 string 아님 → Error', () => {
    const fixture = validFixture();
    fixture.entries = [{ ...makeEntry(1000), url: 1 } as unknown as SeoulCaptureEntry];
    expect(() => parseReplayFixture(fixture)).toThrow('url');
  });

  it('entries[i].status가 number 아님 → Error', () => {
    const fixture = validFixture();
    fixture.entries = [{ ...makeEntry(1000), status: '200' } as unknown as SeoulCaptureEntry];
    expect(() => parseReplayFixture(fixture)).toThrow('status');
  });

  it('entries[i].body가 string 아님 → Error', () => {
    const fixture = validFixture();
    fixture.entries = [{ ...makeEntry(1000), body: 1 } as unknown as SeoulCaptureEntry];
    expect(() => parseReplayFixture(fixture)).toThrow('body');
  });

  it('entries[i].truncated가 boolean 아님 → Error', () => {
    const fixture = validFixture();
    fixture.entries = [{ ...makeEntry(1000), truncated: 'yes' } as unknown as SeoulCaptureEntry];
    expect(() => parseReplayFixture(fixture)).toThrow('truncated');
  });
});
