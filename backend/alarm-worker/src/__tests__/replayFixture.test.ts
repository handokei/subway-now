import { describe, expect, it } from 'vitest';
import { buildReplayFixture, parseReplayFixture, parseSeoulCaptureCycle, type ReplayFixture } from '../replayFixture';
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

function makeCycle(
  cycleStartMs: number,
  entries: SeoulCaptureEntry[],
  overrides: Partial<SeoulCaptureCycle> = {},
): SeoulCaptureCycle {
  return {
    schemaVersion: 1,
    cycleStartMs,
    scanned: entries.length,
    seoulCalls: entries.length,
    entries,
    ...overrides,
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

  it('entries가 없으면 cycleStartMs 범위로 window fallback하고 cycleStartsMs는 빈 배열', () => {
    const cycles = [makeCycle(5000, []), makeCycle(1000, [])];

    const fixture = buildReplayFixture(cycles);

    expect(fixture.window).toEqual({ fromMs: 1000, toMs: 5000 });
    expect(fixture.entries).toEqual([]);
    // entry가 하나도 없는 cycle은 cycleStartsMs에 포함하지 않는다(#2580 리뷰) — window는
    // 자동산출 목적으로만 cycleStartMs를 참조하고, tick 기준점(cycleStartsMs)은 entry
    // 소속 여부로 판단한다.
    expect(fixture.cycleStartsMs).toEqual([]);
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

  it('entry는 window 안인데 cycleStartMs만 window 밖이어도 그 cycle을 cycleStartsMs에 포함한다', () => {
    // cycle 시작(900)은 window(1000~2000) 밖이지만, 폴링이 비동기라 entry의 실제 fetch
    // 시각(tMs=1500)은 window 안에 들어온 시나리오. cycleStartMs 자체로 필터하면 이 tick이
    // entries에는 남는데 cycleStartsMs에서는 탈락해 P0-c 재생 정렬이 깨진다(#2580 리뷰).
    const cycles = [makeCycle(900, [makeEntry(1500)])];

    const fixture = buildReplayFixture(cycles, { fromMs: 1000, toMs: 2000 });

    expect(fixture.entries.map((e) => e.tMs)).toEqual([1500]);
    expect(fixture.cycleStartsMs).toEqual([900]);
  });

  it('entry가 window 밖으로 전부 걸러지면 그 cycle의 cycleStartMs가 window 안이어도 cycleStartsMs에서 제외한다', () => {
    const cycles = [makeCycle(1500, [makeEntry(5000)])];

    const fixture = buildReplayFixture(cycles, { fromMs: 1000, toMs: 2000 });

    expect(fixture.entries).toEqual([]);
    expect(fixture.cycleStartsMs).toEqual([]);
  });

  it('window 한쪽만 지정하면 그 방향만 제약하고 반대쪽은 실제 데이터 범위로 자동 산출한다', () => {
    const cycles = [makeCycle(1000, [makeEntry(1000), makeEntry(2000), makeEntry(3000)])];

    const fromOnly = buildReplayFixture(cycles, { fromMs: 1500 });
    expect(fromOnly.entries.map((e) => e.tMs)).toEqual([2000, 3000]);
    expect(fromOnly.window).toEqual({ fromMs: 1500, toMs: 3000 });

    const toOnly = buildReplayFixture(cycles, { toMs: 2500 });
    expect(toOnly.entries.map((e) => e.tMs)).toEqual([1000, 2000]);
    expect(toOnly.window).toEqual({ fromMs: 1000, toMs: 2500 });
  });

  it('droppedEntries가 있는 cycle들의 합을 채우고, 없으면 필드를 생략한다', () => {
    const withDrops = [
      makeCycle(1000, [makeEntry(1000)], { droppedEntries: 2 }),
      makeCycle(2000, [makeEntry(2000)], { droppedEntries: 3 }),
    ];
    expect(buildReplayFixture(withDrops).droppedEntries).toBe(5);

    const withoutDrops = [makeCycle(1000, [makeEntry(1000)])];
    expect(buildReplayFixture(withoutDrops).droppedEntries).toBeUndefined();
  });

  it('droppedEntries는 window에 걸친 cycle 기준(cycleStartMs)으로 합산한다', () => {
    const cycles = [
      makeCycle(1000, [makeEntry(1000)], { droppedEntries: 2 }),
      makeCycle(5000, [makeEntry(5000)], { droppedEntries: 9 }),
    ];
    const fixture = buildReplayFixture(cycles, { fromMs: 0, toMs: 2000 });
    expect(fixture.droppedEntries).toBe(2);
  });

  it('scanned===-1인 실패 cycle들의 cycleStartMs를 failedCycleStartsMs로 채우고, 없으면 생략한다', () => {
    const withFailure = [
      makeCycle(1000, [makeEntry(1000)], { scanned: -1 }),
      makeCycle(2000, [makeEntry(2000)]),
    ];
    expect(buildReplayFixture(withFailure).failedCycleStartsMs).toEqual([1000]);

    const withoutFailure = [makeCycle(1000, [makeEntry(1000)])];
    expect(buildReplayFixture(withoutFailure).failedCycleStartsMs).toBeUndefined();
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

  it('window.fromMs가 window.toMs보다 크면 Error', () => {
    expect(() => parseReplayFixture({ ...validFixture(), window: { fromMs: 2000, toMs: 1000 } })).toThrow(
      'fromMs',
    );
  });

  it('window.fromMs/toMs가 NaN/Infinity면 Error', () => {
    expect(() => parseReplayFixture({ ...validFixture(), window: { fromMs: NaN, toMs: 1000 } })).toThrow('fromMs');
    expect(() => parseReplayFixture({ ...validFixture(), window: { fromMs: 0, toMs: Infinity } })).toThrow('toMs');
  });

  it('entries가 tMs 오름차순이 아니면 Error', () => {
    const fixture = validFixture();
    fixture.entries = [makeEntry(2000), makeEntry(1000)];
    fixture.window = { fromMs: 1000, toMs: 2000 };
    expect(() => parseReplayFixture(fixture)).toThrow('오름차순');
  });

  it('entries[i].tMs가 NaN이면 Error', () => {
    const fixture = validFixture();
    fixture.entries = [{ ...makeEntry(1000), tMs: NaN } as unknown as SeoulCaptureEntry];
    expect(() => parseReplayFixture(fixture)).toThrow('tMs');
  });

  it('cycleStartsMs 원소가 NaN이면 Error', () => {
    expect(() => parseReplayFixture({ ...validFixture(), cycleStartsMs: [NaN] })).toThrow('cycleStartsMs');
  });

  it('droppedEntries/failedCycleStartsMs가 있으면 그대로 파싱한다', () => {
    const fixture: ReplayFixture = { ...validFixture(), droppedEntries: 3, failedCycleStartsMs: [1000] };
    expect(parseReplayFixture(fixture)).toEqual(fixture);
  });

  it('droppedEntries가 number 아니면 Error', () => {
    expect(() => parseReplayFixture({ ...validFixture(), droppedEntries: 'x' })).toThrow('droppedEntries');
  });

  it('failedCycleStartsMs가 number[] 아니면 Error', () => {
    expect(() => parseReplayFixture({ ...validFixture(), failedCycleStartsMs: ['x'] })).toThrow(
      'failedCycleStartsMs',
    );
  });
});

describe('parseSeoulCaptureCycle', () => {
  function validCycle(): SeoulCaptureCycle {
    return makeCycle(1000, [makeEntry(1000)]);
  }

  it('유효한 cycle을 그대로 파싱한다', () => {
    const cycle = validCycle();
    expect(parseSeoulCaptureCycle(cycle)).toEqual(cycle);
  });

  it('droppedEntries가 있으면 보존한다', () => {
    const cycle = makeCycle(1000, [makeEntry(1000)], { droppedEntries: 2 });
    expect(parseSeoulCaptureCycle(cycle)).toEqual(cycle);
  });

  it('root이 object가 아니면 Error', () => {
    expect(() => parseSeoulCaptureCycle(null)).toThrow('object여야');
  });

  it('schemaVersion 불일치 → Error', () => {
    expect(() => parseSeoulCaptureCycle({ ...validCycle(), schemaVersion: 2 })).toThrow('schemaVersion');
  });

  it('cycleStartMs가 number 아니면 Error', () => {
    expect(() => parseSeoulCaptureCycle({ ...validCycle(), cycleStartMs: 'x' })).toThrow('cycleStartMs');
  });

  it('scanned가 number 아니면 Error', () => {
    expect(() => parseSeoulCaptureCycle({ ...validCycle(), scanned: 'x' })).toThrow('scanned');
  });

  it('seoulCalls가 number 아니면 Error', () => {
    expect(() => parseSeoulCaptureCycle({ ...validCycle(), seoulCalls: 'x' })).toThrow('seoulCalls');
  });

  it('entries가 배열 아니면 Error', () => {
    expect(() => parseSeoulCaptureCycle({ ...validCycle(), entries: 'x' })).toThrow('entries');
  });

  it('entries[i] 검증에 parseCaptureEntry 검증 로직을 재사용한다 (entry 필드 위반 → Error)', () => {
    expect(() =>
      parseSeoulCaptureCycle({ ...validCycle(), entries: [{ ...makeEntry(1000), kind: 'bogus' }] }),
    ).toThrow('kind');
  });

  it('droppedEntries가 number 아니면 Error', () => {
    expect(() => parseSeoulCaptureCycle({ ...validCycle(), droppedEntries: 'x' })).toThrow('droppedEntries');
  });
});
