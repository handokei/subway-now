import { describe, expect, it } from 'vitest';
import {
  CAPTURE_KEY_PRE_ROLL_MS,
  TOKEN_HASH_PATTERN,
  TRIP_WINDOW_MARGIN_MS,
  buildFixtureSlug,
  buildRegistryEntrySkeleton,
  buildTripEventsQuery,
  computeTripCaptureWindow,
  extractFireAttempts,
  extractLines,
  extractSegmentStations,
  filterCaptureKeysInWindow,
  parseTripEventsResponse,
  resolveTokenHash,
  type TripEventRow,
} from '../fixtureFromTrip';

function makeRow(overrides: Partial<TripEventRow> = {}): TripEventRow {
  return { ts: 1000, kind: 'sync-received', station: null, line: null, meta: null, ...overrides };
}

describe('resolveTokenHash', () => {
  it('--trip만 주면 hashTripToken 결과를 tokenHash로 반환한다', () => {
    const result = resolveTokenHash('some-trip-token', undefined);

    expect(result).toEqual({ tokenHash: expect.stringMatching(TOKEN_HASH_PATTERN) });
  });

  it('같은 tripToken은 항상 같은 tokenHash(결정론)', () => {
    const a = resolveTokenHash('abc', undefined);
    const b = resolveTokenHash('abc', undefined);

    expect(a).toEqual(b);
  });

  it('--token-hash만 주면(8자리 소문자 hex) 그대로 tokenHash로 반환한다', () => {
    expect(resolveTokenHash(undefined, 'aabbccdd')).toEqual({ tokenHash: 'aabbccdd' });
  });

  it('둘 다 없으면 missing_input', () => {
    expect(resolveTokenHash(undefined, undefined)).toEqual({ error: 'missing_input' });
  });

  it('둘 다 있으면 conflicting_input', () => {
    expect(resolveTokenHash('some-trip-token', 'aabbccdd')).toEqual({ error: 'conflicting_input' });
  });

  it('--token-hash가 8자리 소문자 hex가 아니면 invalid_token_hash', () => {
    expect(resolveTokenHash(undefined, 'AABBCCDD')).toEqual({ error: 'invalid_token_hash' });
    expect(resolveTokenHash(undefined, 'short')).toEqual({ error: 'invalid_token_hash' });
    expect(resolveTokenHash(undefined, 'toolong123')).toEqual({ error: 'invalid_token_hash' });
  });
});

describe('buildTripEventsQuery', () => {
  it('tokenHash로 SELECT SQL을 만든다', () => {
    const sql = buildTripEventsQuery('aabbccdd');

    expect(sql).toBe(
      "SELECT ts, kind, station, line, meta FROM trip_events WHERE token_hash = 'aabbccdd' ORDER BY ts ASC",
    );
  });
});

describe('parseTripEventsResponse', () => {
  it('정상 wrangler d1 execute --json 출력을 TripEventRow[]로 파싱한다', () => {
    const stdout = JSON.stringify([
      {
        results: [
          { ts: 1000, kind: 'sync-received', station: null, line: null, meta: null },
          { ts: 2000, kind: 'cron-fire-attempt', station: '교대', line: '2호선', meta: '{"outcome":"sent"}' },
        ],
        success: true,
      },
    ]);

    const rows = parseTripEventsResponse(stdout, 'aabbccdd');

    expect(rows).toEqual([
      { ts: 1000, kind: 'sync-received', station: null, line: null, meta: null },
      { ts: 2000, kind: 'cron-fire-attempt', station: '교대', line: '2호선', meta: '{"outcome":"sent"}' },
    ]);
  });

  it('JSON 파싱 자체가 실패하면 D1 조회 실패 메시지', () => {
    expect(() => parseTripEventsResponse('not json', 'aabbccdd')).toThrow(/D1 조회 실패.*파싱/);
  });

  it('최상위가 배열이 아니면 D1 조회 실패 메시지', () => {
    expect(() => parseTripEventsResponse(JSON.stringify({ results: [] }), 'aabbccdd')).toThrow(/D1 조회 실패/);
  });

  it('최상위 배열이 비어 있으면 D1 조회 실패 메시지', () => {
    expect(() => parseTripEventsResponse(JSON.stringify([]), 'aabbccdd')).toThrow(/D1 조회 실패/);
  });

  it('results 필드가 없으면 D1 조회 실패 메시지', () => {
    expect(() => parseTripEventsResponse(JSON.stringify([{ success: true }]), 'aabbccdd')).toThrow(
      /D1 조회 실패.*results/,
    );
  });

  it('results가 빈 배열이면(캡처 없음) tokenHash를 포함한 명확한 메시지', () => {
    expect(() => parseTripEventsResponse(JSON.stringify([{ results: [] }]), 'aabbccdd')).toThrow(
      /trip_events에 해당 trip 이벤트가 없습니다 \(tokenHash=aabbccdd\)/,
    );
  });

  it('row가 object가 아니면 인덱스를 포함한 에러', () => {
    expect(() => parseTripEventsResponse(JSON.stringify([{ results: [null] }]), 'aabbccdd')).toThrow(
      /row\[0\]가 object가 아닙니다/,
    );
  });

  it('row.ts가 number가 아니면 명확한 에러', () => {
    expect(() =>
      parseTripEventsResponse(JSON.stringify([{ results: [{ ts: '1000', kind: 'sync-received' }] }]), 'aabbccdd'),
    ).toThrow(/row\[0\]\.ts가 number가 아닙니다/);
  });

  it('row.kind가 string이 아니면 명확한 에러', () => {
    expect(() =>
      parseTripEventsResponse(JSON.stringify([{ results: [{ ts: 1000, kind: 42 }] }]), 'aabbccdd'),
    ).toThrow(/row\[0\]\.kind가 string이 아닙니다/);
  });
});

describe('computeTripCaptureWindow', () => {
  it('ts min/max에 ±margin을 적용한다(중간에 최솟값, 끝에 최댓값 갱신 모두 커버)', () => {
    const rows = [makeRow({ ts: 5000 }), makeRow({ ts: 1000 }), makeRow({ ts: 8000 })];

    const window = computeTripCaptureWindow(rows, 2000);

    expect(window).toEqual({ fromMs: -1000, toMs: 10_000 });
  });

  it('marginMs 기본값은 TRIP_WINDOW_MARGIN_MS(2분)', () => {
    const window = computeTripCaptureWindow([makeRow({ ts: 10_000 })]);

    expect(window).toEqual({ fromMs: 10_000 - TRIP_WINDOW_MARGIN_MS, toMs: 10_000 + TRIP_WINDOW_MARGIN_MS });
  });

  it('빈 배열이면 에러', () => {
    expect(() => computeTripCaptureWindow([])).toThrow(/비어 있어/);
  });
});


describe('extractSegmentStations / extractLines', () => {
  it('station이 있는 row만, 첫 등장 순서로 dedup', () => {
    const rows = [
      makeRow({ station: '교대', line: '2호선' }),
      makeRow({ station: null, line: null }),
      makeRow({ station: '강남', line: '2호선' }),
      makeRow({ station: '교대', line: '2호선' }),
    ];

    expect(extractSegmentStations(rows)).toEqual(['교대', '강남']);
    expect(extractLines(rows)).toEqual(['2호선']);
  });

  it('전부 null이면 빈 배열', () => {
    expect(extractSegmentStations([makeRow()])).toEqual([]);
    expect(extractLines([makeRow()])).toEqual([]);
  });
});

describe('extractFireAttempts', () => {
  it('kind=cron-fire-attempt인 row만 outcome과 함께 추출한다', () => {
    const rows = [
      makeRow({ ts: 1000, kind: 'sync-received' }),
      makeRow({ ts: 2000, kind: 'cron-fire-attempt', station: '교대', line: '2호선', meta: '{"outcome":"sent"}' }),
      makeRow({ ts: 3000, kind: 'cron-fire-attempt', station: '강남', line: '2호선', meta: null }),
    ];

    expect(extractFireAttempts(rows)).toEqual([
      { ts: 2000, station: '교대', line: '2호선', outcome: 'sent' },
      { ts: 3000, station: '강남', line: '2호선', outcome: null },
    ]);
  });

  it('meta가 malformed JSON이면 outcome null로 fallback', () => {
    const rows = [makeRow({ kind: 'cron-fire-attempt', meta: 'not json' })];

    expect(extractFireAttempts(rows)).toEqual([{ ts: 1000, station: null, line: null, outcome: null }]);
  });

  it('meta.outcome이 string이 아니면 null로 fallback', () => {
    const rows = [makeRow({ kind: 'cron-fire-attempt', meta: JSON.stringify({ outcome: 42 }) })];

    expect(extractFireAttempts(rows)).toEqual([{ ts: 1000, station: null, line: null, outcome: null }]);
  });
});

describe('buildFixtureSlug', () => {
  it('YYYYMMDDTHHmmZ_tokenHash 형식(window 시작 시분 UTC 포함)', () => {
    const slug = buildFixtureSlug('aabbccdd', { fromMs: Date.parse('2026-09-13T01:23:00Z'), toMs: 0 });

    expect(slug).toBe('capture_20260913T0123Z_aabbccdd');
  });

  it('시/분이 한 자리여도 zero-pad', () => {
    const slug = buildFixtureSlug('aabbccdd', { fromMs: Date.parse('2026-09-13T00:05:00Z'), toMs: 0 });

    expect(slug).toBe('capture_20260913T0005Z_aabbccdd');
  });
});

describe('filterCaptureKeysInWindow', () => {
  const window = { fromMs: 100_000, toMs: 200_000 };

  it('window ± preRollMs 범위 안의 key만 남긴다', () => {
    const keys = [
      'seoul-capture/2026-09-13/5000.json', // window.fromMs - preRoll(90_000) = 10_000보다 작음 → 제외
      'seoul-capture/2026-09-13/15000.json', // 10_000~200_000 안 → 포함
      'seoul-capture/2026-09-13/150000.json', // 포함
      'seoul-capture/2026-09-13/250000.json', // toMs(200_000) 초과 → 제외
    ];

    expect(filterCaptureKeysInWindow(keys, window)).toEqual([
      'seoul-capture/2026-09-13/15000.json',
      'seoul-capture/2026-09-13/150000.json',
    ]);
  });

  it('preRollMs를 명시하면 그 값을 쓴다', () => {
    const keys = ['seoul-capture/2026-09-13/99000.json'];

    expect(filterCaptureKeysInWindow(keys, window, 500)).toEqual([]);
    expect(filterCaptureKeysInWindow(keys, window, 2000)).toEqual(['seoul-capture/2026-09-13/99000.json']);
  });

  it('basename이 숫자가 아니면 제외한다', () => {
    expect(filterCaptureKeysInWindow(['seoul-capture/2026-09-13/not-a-number.json'], window)).toEqual([]);
  });

  it('기본 preRollMs는 CAPTURE_KEY_PRE_ROLL_MS', () => {
    const key = `seoul-capture/2026-09-13/${window.fromMs - CAPTURE_KEY_PRE_ROLL_MS}.json`;

    expect(filterCaptureKeysInWindow([key], window)).toEqual([key]);
  });
});

describe('buildRegistryEntrySkeleton', () => {
  it('필수 필드(slug/fixturePath/cronIntervalMs=recorded/firedStations)를 포함한 텍스트를 만든다', () => {
    const text = buildRegistryEntrySkeleton({
      slug: 'capture_20260913_aabbccdd',
      fixtureFileName: 'capture_20260913_aabbccdd.fixture.json',
      tokenHash: 'aabbccdd',
      segmentStations: ['교대', '강남'],
      lines: ['2호선'],
      isLossy: false,
    });

    expect(text).toContain("slug: 'capture_20260913_aabbccdd'");
    expect(text).toContain("fixturePath: 'capture_20260913_aabbccdd.fixture.json'");
    expect(text).toContain("cronIntervalMs: 'recorded'");
    expect(text).toContain('firedStations: ["교대","강남"]');
    expect(text).toContain('2호선');
    expect(text).not.toContain('allowLossy');
  });

  it('isLossy=true면 allowLossy: true 라인을 포함한다', () => {
    const text = buildRegistryEntrySkeleton({
      slug: 'capture_20260913_aabbccdd',
      fixtureFileName: 'capture_20260913_aabbccdd.fixture.json',
      tokenHash: 'aabbccdd',
      segmentStations: [],
      lines: [],
      isLossy: true,
    });

    expect(text).toContain('allowLossy: true');
    expect(text).toContain('(미확인)');
  });
});
