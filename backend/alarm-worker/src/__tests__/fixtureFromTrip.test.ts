import { describe, expect, it } from 'vitest';
import {
  CAPTURE_KEY_PRE_ROLL_MS,
  MEANINGFUL_ROW_MIN_COUNT,
  TOKEN_HASH_PATTERN,
  TRIP_GAP_MS,
  TRIP_WINDOW_MARGIN_MS,
  buildFixtureSlug,
  buildRegistryEntrySkeleton,
  buildTripEventsQuery,
  computeTripCaptureWindow,
  describeSegments,
  extractFireAttempts,
  extractLines,
  extractSegmentStations,
  isSignificantTripSegment,
  parseEnvValue,
  parseTripEventsResponse,
  resolveTokenHash,
  segmentTripEvents,
  selectDefaultTripSegment,
  selectTripSegment,
  type TripEventRow,
  type TripSegment,
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
  it('station이 있는 row만, 첫 등장 순서로 dedup(trip-end 없음 → suspiciousCodeRowCount 0)', () => {
    const rows = [
      makeRow({ station: '교대', line: '2호선' }),
      makeRow({ station: null, line: null }),
      makeRow({ station: '강남', line: '2호선' }),
      makeRow({ station: '교대', line: '2호선' }),
    ];

    expect(extractSegmentStations(rows)).toEqual({ stations: ['교대', '강남'], suspiciousCodeRowCount: 0 });
    expect(extractLines(rows)).toEqual(['2호선']);
  });

  it('전부 null이면 빈 배열', () => {
    expect(extractSegmentStations([makeRow()])).toEqual({ stations: [], suspiciousCodeRowCount: 0 });
    expect(extractLines([makeRow()])).toEqual([]);
  });

  it('#2598 결함2 1차 규칙 — kind===trip-end row는 station 필드 값과 무관하게 역명 후보에서 제외한다', () => {
    const rows = [
      makeRow({ station: '교대', line: '2호선' }),
      makeRow({ station: '2-010', line: null, kind: 'trip-end' }),
      makeRow({ station: '건대입구', line: null, kind: 'trip-end' }), // trip-end인데 station이 코드가 아니어도 제외
      makeRow({ station: '강남', line: '2호선' }),
    ];

    expect(extractSegmentStations(rows)).toEqual({ stations: ['교대', '강남'], suspiciousCodeRowCount: 0 });
  });

  it('#2598 결함2 2차 가드 — trip-end가 아닌데 station이 코드 패턴(N-NNN)이면 제외하고 suspiciousCodeRowCount로 보고한다', () => {
    const rows = [
      makeRow({ station: '교대', line: '2호선' }),
      makeRow({ station: '7-015', line: null, kind: 'sync-received' }), // 전제 위반 — trip-end 아닌데 코드
      makeRow({ station: '강남', line: '2호선' }),
    ];

    expect(extractSegmentStations(rows)).toEqual({ stations: ['교대', '강남'], suspiciousCodeRowCount: 1 });
  });
});

describe('segmentTripEvents (#2598 결함1)', () => {
  it('trip-end 마커 없이 한 trip만 있으면 세그먼트 1개', () => {
    const rows = [makeRow({ ts: 1000, station: '교대' }), makeRow({ ts: 2000, station: '강남' })];

    expect(segmentTripEvents(rows)).toEqual([{ rows }]);
  });

  it('trip-end 마커로 여러 trip을 분리하고, trip-end row는 그 세그먼트에 포함된다', () => {
    const rowA1 = makeRow({ ts: 1000, station: '교대' });
    const rowAEnd = makeRow({ ts: 1500, kind: 'trip-end', station: '2-010' });
    const rowB1 = makeRow({ ts: 2000, station: '용마산' });
    const rowB2 = makeRow({ ts: 2500, station: '중곡' });

    const segments = segmentTripEvents([rowA1, rowAEnd, rowB1, rowB2]);

    expect(segments).toEqual([{ rows: [rowA1, rowAEnd] }, { rows: [rowB1, rowB2] }]);
  });

  it('trip-end 뒤에 남은 row가 없으면 마지막 세그먼트가 trip-end로 끝난다(빈 잔여 세그먼트 없음)', () => {
    const rowA1 = makeRow({ ts: 1000 });
    const rowAEnd = makeRow({ ts: 1500, kind: 'trip-end' });

    expect(segmentTripEvents([rowA1, rowAEnd])).toEqual([{ rows: [rowA1, rowAEnd] }]);
  });

  it('빈 배열이면 빈 세그먼트 배열', () => {
    expect(segmentTripEvents([])).toEqual([]);
  });

  describe('#2598 리뷰 — trip-end 마커 없이도 30분(TRIP_GAP_MS) 초과 gap이면 세그먼트를 분리한다', () => {
    it('인접 row 간격이 TRIP_GAP_MS를 넘으면 trip-end 없어도 새 세그먼트로 분리', () => {
      const rowA1 = makeRow({ ts: 1_000, station: '교대' });
      const rowA2 = makeRow({ ts: 2_000, station: '강남' }); // trip-end 기록 누락(앱 kill 등 가정)
      const rowB1 = makeRow({ ts: 2_000 + TRIP_GAP_MS + 1, station: '용마산' });
      const rowB2 = makeRow({ ts: 3_000 + TRIP_GAP_MS + 1, station: '중곡' });

      const segments = segmentTripEvents([rowA1, rowA2, rowB1, rowB2]);

      expect(segments).toEqual([{ rows: [rowA1, rowA2] }, { rows: [rowB1, rowB2] }]);
    });

    it('간격이 정확히 TRIP_GAP_MS면(경계값) 아직 같은 세그먼트', () => {
      const rowA1 = makeRow({ ts: 1_000 });
      const rowA2 = makeRow({ ts: 1_000 + TRIP_GAP_MS });

      expect(segmentTripEvents([rowA1, rowA2])).toEqual([{ rows: [rowA1, rowA2] }]);
    });

    it('trip-end로 세그먼트가 닫힌 직후 gap 검사는 다음 세그먼트의 첫 row 기준으로 새로 시작한다(중복 분리 없음)', () => {
      const rowA1 = makeRow({ ts: 1_000 });
      const rowAEnd = makeRow({ ts: 1_500, kind: 'trip-end' });
      const rowB1 = makeRow({ ts: 1_500 + TRIP_GAP_MS + 1, station: '용마산' }); // 직전 trip-end와 30분+ 차이나지만 정상 분리 대상은 trip-end 자체

      const segments = segmentTripEvents([rowA1, rowAEnd, rowB1]);

      expect(segments).toEqual([{ rows: [rowA1, rowAEnd] }, { rows: [rowB1] }]);
    });
  });
});

describe('isSignificantTripSegment (#2598 리뷰 — 잔여 파편 세그먼트 오선택 방지)', () => {
  it(`trip-end가 아닌 row가 ${MEANINGFUL_ROW_MIN_COUNT}개 이상이면 significant`, () => {
    const segment: TripSegment = { rows: [makeRow({ ts: 1000 }), makeRow({ ts: 2000 })] };

    expect(isSignificantTripSegment(segment)).toBe(true);
  });

  it('trip-end가 아닌 row가 기준 미만이면 insignificant', () => {
    const segment: TripSegment = { rows: [makeRow({ ts: 1000 })] };

    expect(isSignificantTripSegment(segment)).toBe(false);
  });

  it('trip-end row는 유의미한 row 카운트에서 제외된다(trip-end 1개만 있으면 insignificant)', () => {
    const segment: TripSegment = {
      rows: [makeRow({ ts: 1000, kind: 'sync-received' }), makeRow({ ts: 1500, kind: 'trip-end' })],
    };

    expect(isSignificantTripSegment(segment)).toBe(false);
  });
});

describe('describeSegments (#2598 리뷰 — CLI 세그먼트 목록 요약)', () => {
  it('세그먼트별 rowCount/기간/significant/terminated를 요약한다', () => {
    const significantSegment: TripSegment = {
      rows: [makeRow({ ts: 1000 }), makeRow({ ts: 2000 }), makeRow({ ts: 2500, kind: 'trip-end' })],
    };
    const insignificantUnterminatedSegment: TripSegment = { rows: [makeRow({ ts: 3000 })] };

    expect(describeSegments([significantSegment, insignificantUnterminatedSegment])).toEqual([
      { rowCount: 3, fromMs: 1000, toMs: 2500, significant: true, terminated: true },
      { rowCount: 1, fromMs: 3000, toMs: 3000, significant: false, terminated: false },
    ]);
  });

  it('빈 세그먼트 배열이면 빈 배열', () => {
    expect(describeSegments([])).toEqual([]);
  });
});

describe('selectDefaultTripSegment (#2598 결함1/리뷰 — --trip-index 미지정 시 기본 선택)', () => {
  it('최신 세그먼트가 significant면 그것을 선택한다', () => {
    const segA: TripSegment = { rows: [makeRow({ ts: 1000 }), makeRow({ ts: 1100 })] };
    const segB: TripSegment = { rows: [makeRow({ ts: 2000 }), makeRow({ ts: 2100 })] };

    expect(selectDefaultTripSegment([segA, segB])).toEqual({ segment: segB });
  });

  it('최신 세그먼트가 insignificant(잔여 파편)면 건너뛰고 그 이전 significant 세그먼트를 선택한다', () => {
    const segA: TripSegment = { rows: [makeRow({ ts: 1000 }), makeRow({ ts: 1100 })] };
    const fragmentSeg: TripSegment = { rows: [makeRow({ ts: 9000, kind: 'trip-end' })] };

    expect(selectDefaultTripSegment([segA, fragmentSeg])).toEqual({ segment: segA });
  });

  it('모든 세그먼트가 insignificant면 no_significant_segment', () => {
    const fragmentSeg: TripSegment = { rows: [makeRow({ ts: 9000 })] };

    expect(selectDefaultTripSegment([fragmentSeg])).toEqual({ error: 'no_significant_segment' });
  });

  it('빈 배열이면 no_significant_segment', () => {
    expect(selectDefaultTripSegment([])).toEqual({ error: 'no_significant_segment' });
  });
});

describe('selectTripSegment (#2598 결함1 — --trip-index)', () => {
  const segA = { rows: [makeRow({ ts: 1000 })] };
  const segB = { rows: [makeRow({ ts: 2000 })] };
  const segC = { rows: [makeRow({ ts: 3000 })] };
  const segments = [segA, segB, segC];

  it('tripIndexFromEnd=0(기본값)이면 최신(마지막) 세그먼트', () => {
    expect(selectTripSegment(segments, 0)).toEqual({ segment: segC });
  });

  it('tripIndexFromEnd=1이면 뒤에서 두 번째 세그먼트', () => {
    expect(selectTripSegment(segments, 1)).toEqual({ segment: segB });
  });

  it('tripIndexFromEnd가 보유 세그먼트 수 이상이면 trip_index_out_of_range', () => {
    expect(selectTripSegment(segments, 3)).toEqual({ error: 'trip_index_out_of_range' });
  });

  it('tripIndexFromEnd가 음수면 trip_index_out_of_range', () => {
    expect(selectTripSegment(segments, -1)).toEqual({ error: 'trip_index_out_of_range' });
  });

  it('세그먼트가 없으면(빈 배열) 어떤 index도 out_of_range', () => {
    expect(selectTripSegment([], 0)).toEqual({ error: 'trip_index_out_of_range' });
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

describe('CAPTURE_KEY_PRE_ROLL_MS', () => {
  it('90초(ms)다 — GET /admin/seoul-capture/keys from 계산에 쓰는 상수', () => {
    expect(CAPTURE_KEY_PRE_ROLL_MS).toBe(90_000);
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

describe('parseEnvValue', () => {
  it('KEY=value 한 줄에서 값을 그대로 추출한다', () => {
    expect(parseEnvValue('EXPO_PUBLIC_ADMIN_TOKEN=abc123', 'EXPO_PUBLIC_ADMIN_TOKEN')).toBe('abc123');
  });

  it('다른 키/값이 섞인 여러 줄에서 원하는 키만 찾는다', () => {
    const content = ['EXPO_PUBLIC_SEOUL_DATA_API_KEY=other', 'EXPO_PUBLIC_ADMIN_TOKEN=abc123', 'FOO=bar'].join('\n');

    expect(parseEnvValue(content, 'EXPO_PUBLIC_ADMIN_TOKEN')).toBe('abc123');
  });

  it('#으로 시작하는 줄 전체는 주석으로 무시한다', () => {
    const content = ['# EXPO_PUBLIC_ADMIN_TOKEN=commented-out', 'EXPO_PUBLIC_ADMIN_TOKEN=real-value'].join('\n');

    expect(parseEnvValue(content, 'EXPO_PUBLIC_ADMIN_TOKEN')).toBe('real-value');
  });

  it('인라인 # 주석을 값에서 잘라내고 trim한다(따옴표 없을 때)', () => {
    expect(parseEnvValue('EXPO_PUBLIC_ADMIN_TOKEN=abc123 # 코멘트', 'EXPO_PUBLIC_ADMIN_TOKEN')).toBe('abc123');
  });

  it('양끝 큰따옴표를 벗기고, 따옴표 안 #은 보존한다(dotenv 의미론)', () => {
    expect(parseEnvValue('EXPO_PUBLIC_ADMIN_TOKEN="abc#123"', 'EXPO_PUBLIC_ADMIN_TOKEN')).toBe('abc#123');
  });

  it('양끝 작은따옴표/백틱도 벗긴다', () => {
    expect(parseEnvValue("EXPO_PUBLIC_ADMIN_TOKEN='abc123'", 'EXPO_PUBLIC_ADMIN_TOKEN')).toBe('abc123');
    expect(parseEnvValue('EXPO_PUBLIC_ADMIN_TOKEN=`abc123`', 'EXPO_PUBLIC_ADMIN_TOKEN')).toBe('abc123');
  });

  it('값이 빈 문자열이면 빈 문자열을 반환한다(존재 자체는 확인됨)', () => {
    expect(parseEnvValue('EXPO_PUBLIC_ADMIN_TOKEN=', 'EXPO_PUBLIC_ADMIN_TOKEN')).toBe('');
  });

  it('키가 없으면 undefined', () => {
    expect(parseEnvValue('FOO=bar', 'EXPO_PUBLIC_ADMIN_TOKEN')).toBeUndefined();
  });

  it('빈 줄/= 없는 줄은 건너뛴다', () => {
    const content = ['', '   ', 'not-a-kv-line', 'EXPO_PUBLIC_ADMIN_TOKEN=abc123'].join('\n');

    expect(parseEnvValue(content, 'EXPO_PUBLIC_ADMIN_TOKEN')).toBe('abc123');
  });

  it('CRLF 줄바꿈도 처리한다', () => {
    expect(parseEnvValue('FOO=bar\r\nEXPO_PUBLIC_ADMIN_TOKEN=abc123\r\n', 'EXPO_PUBLIC_ADMIN_TOKEN')).toBe('abc123');
  });
});
