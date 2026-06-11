/**
 * #1170 — boardingPromptMonitor 단위 테스트.
 */

import {
  computeBoardingPromptMonitor,
  exportRecentDays,
  toLocalDayKey,
} from '../boardingPromptMonitor';
import type { AlarmLogEntry, AlarmLogReason, AlarmLogSource } from '../alarmLog';

// ── factory ──
// 모든 case가 entry 1개씩만 다른 필드로 만들어 컴파일러가 typo를 잡도록 한다.
function entry(overrides: Partial<AlarmLogEntry> & Pick<AlarmLogEntry, 'ts'>): AlarmLogEntry {
  return {
    source: 'boarding-prompt' as AlarmLogSource,
    outcome: 'fired',
    ...overrides,
  };
}

function displayed(ts: number, extra: Partial<AlarmLogEntry> = {}): AlarmLogEntry {
  return entry({ ts, outcome: 'fired', ...extra });
}

function response(
  ts: number,
  reason: Extract<AlarmLogReason, 'response-boarded' | 'response-dismissed'>,
  extra: Partial<AlarmLogEntry> = {},
): AlarmLogEntry {
  return entry({ ts, outcome: 'received', reason, ...extra });
}

const T0 = new Date('2026-06-12T10:00:00+09:00').getTime();

describe('computeBoardingPromptMonitor — totals', () => {
  it('빈 입력 → 0 카운트 + null rate', () => {
    const stats = computeBoardingPromptMonitor([]);
    expect(stats).toEqual({
      displayed: 0,
      responded: 0,
      boarded: 0,
      dismissed: 0,
      responseRatePct: null,
      boardedRatePct: null,
      byDay: {},
    });
  });

  it.each<[string, AlarmLogEntry, Partial<ReturnType<typeof computeBoardingPromptMonitor>>]>([
    [
      'displayed 1건만',
      displayed(T0),
      { displayed: 1, responded: 0, responseRatePct: 0 },
    ],
    [
      'boarded 응답 1건',
      response(T0, 'response-boarded'),
      { responded: 1, boarded: 1, dismissed: 0 },
    ],
    [
      'dismissed 응답 1건',
      response(T0, 'response-dismissed'),
      { responded: 1, boarded: 0, dismissed: 1 },
    ],
  ])('단일 entry 분류 — %s', (_label, e, expected) => {
    const stats = computeBoardingPromptMonitor([e]);
    expect(stats).toMatchObject(expected);
  });

  it('다른 source / 다른 reason은 무시', () => {
    const entries: AlarmLogEntry[] = [
      // 다른 source
      { ts: T0, source: 'fg', outcome: 'fired' },
      // boarding-prompt fired인데 reason이 있음 → autolock telemetry (#1167 채널) — 제외
      { ts: T0, source: 'boarding-prompt', outcome: 'fired', reason: 'dedup-station' },
      // received인데 reason이 다른 측정 채널
      { ts: T0, source: 'boarding-prompt', outcome: 'received' },
      // received + reason이 response-* 외 (다른 telemetry 채널) — 제외
      { ts: T0, source: 'boarding-prompt', outcome: 'received', reason: 'dedup-station' },
      // 진짜 displayed
      displayed(T0),
    ];
    const stats = computeBoardingPromptMonitor(entries);
    expect(stats.displayed).toBe(1);
    expect(stats.responded).toBe(0);
  });

  it('count 필드 (burst inline counter)를 곱해 누적', () => {
    const stats = computeBoardingPromptMonitor([
      displayed(T0, { count: 3 }),
      response(T0, 'response-boarded', { count: 2 }),
    ]);
    expect(stats.displayed).toBe(3);
    expect(stats.responded).toBe(2);
    expect(stats.boarded).toBe(2);
  });

  it('responseRate / boardedRate 계산 (소수점 1자리 반올림)', () => {
    // displayed=3, responded=2(boarded=1, dismissed=1)
    // responseRate = 66.7%, boardedRate = 50%
    const stats = computeBoardingPromptMonitor([
      displayed(T0),
      displayed(T0 + 1),
      displayed(T0 + 2),
      response(T0 + 3, 'response-boarded'),
      response(T0 + 4, 'response-dismissed'),
    ]);
    expect(stats.responseRatePct).toBeCloseTo(66.7, 1);
    expect(stats.boardedRatePct).toBe(50);
  });

  it('displayed=0인데 응답이 있으면 responseRate=null (분모 0)', () => {
    const stats = computeBoardingPromptMonitor([
      response(T0, 'response-boarded'),
    ]);
    expect(stats.responseRatePct).toBeNull();
    expect(stats.boardedRatePct).toBe(100);
  });
});

describe('computeBoardingPromptMonitor — byDay', () => {
  it('같은 로컬 날짜의 entry는 한 bucket에 누적', () => {
    const stats = computeBoardingPromptMonitor([
      displayed(T0),
      displayed(T0 + 60_000),
      response(T0 + 120_000, 'response-boarded'),
    ]);
    const key = toLocalDayKey(T0);
    expect(stats.byDay[key]).toEqual({
      displayed: 2,
      responded: 1,
      boarded: 1,
      dismissed: 0,
    });
  });

  it('다른 날짜는 별도 bucket', () => {
    const t1 = T0;
    const t2 = T0 + 26 * 60 * 60 * 1000; // 다음 날
    const stats = computeBoardingPromptMonitor([displayed(t1), displayed(t2)]);
    expect(Object.keys(stats.byDay).sort()).toEqual(
      [toLocalDayKey(t1), toLocalDayKey(t2)].sort(),
    );
  });
});

describe('toLocalDayKey', () => {
  it('YYYY-MM-DD 형식 (sv-SE locale)', () => {
    expect(toLocalDayKey(T0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('exportRecentDays', () => {
  it('요청 일수만큼 row 반환, 데이터 없는 날은 0 채움', () => {
    const stats = computeBoardingPromptMonitor([displayed(T0)]);
    const rows = exportRecentDays(stats, 3, T0);
    expect(rows).toHaveLength(3);
    // 마지막(=오늘)에 displayed=1, 나머지는 0
    expect(rows[rows.length - 1]).toMatchObject({ displayed: 1 });
    expect(rows[0]).toMatchObject({ displayed: 0, responded: 0 });
  });

  it('과거 → 현재 순서', () => {
    const rows = exportRecentDays(computeBoardingPromptMonitor([]), 5, T0);
    const keys = rows.map((r) => r.dayKey);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  it('default now 사용 (now 인자 미지정 호환)', () => {
    const rows = exportRecentDays(computeBoardingPromptMonitor([]), 1);
    expect(rows).toHaveLength(1);
  });
});
