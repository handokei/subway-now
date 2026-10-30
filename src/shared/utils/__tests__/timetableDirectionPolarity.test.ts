import type { LineNumber } from '../../types/station';
import { TIMETABLE_DIRECTION_MISMATCH_LINES } from '../../constants/timetableDirection';
import { directionOnLine } from '../directionOnLine';
import { getStationsOnLine } from '../stationRoute';
import { normalizeStationName } from '../normalizeStationName';
import { findBoardableDeparture } from '../timetableShared';
import type { Direction } from '../timetableShared';

/**
 * #1480 PR-C §9-3 — `directionOnLine`(up/down)과 시간표 JSON(up/down)의 극성 대조.
 *
 * 인접한 두 역 A→B(stations.json 순서) 각각에 대해, A→B 진행방향 d = directionOnLine(A→B)의
 * 시간표 열(d)에서 "A 출발 후 6분 안에 B가 따라오는" 비율이 반대 열보다 높아야 극성이 일치한다.
 * 노선별 인접쌍 다수결로 판정 — 불일치 노선은 시간표 대신 배차간격/2(U3)로 보낸다
 * (TIMETABLE_DIRECTION_MISMATCH_LINES). 상수가 실측 대조와 어긋나면 이 테스트가 깨진다.
 */
const TIMETABLE_LINES: readonly LineNumber[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const FOLLOW_WINDOW_MIN = 6;
const WEEKDAY_NOON = new Date(Date.UTC(2026, 9, 28, 3, 0, 0)); // 수요일 12:00 KST (lookup 존재 확인용)

// 시간표 열 전체를 얻는 공개 API가 없어 JSON을 직접 읽는다 (검증 전용).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loadTimetable = (line: LineNumber) => require(`../../../data/timetables/line-${line}.json`).stations as Record<
  string,
  { weekday: Record<Direction, string[]> }
>;

function minutesOf(entries: string[]): number[] {
  return entries
    .filter((e) => e !== '0000')
    .map((e) => Number(e.slice(0, 2)) * 60 + Number(e.slice(2)));
}

function followRatio(from: number[], to: number[]): number {
  if (from.length === 0) return 0;
  const hits = from.filter((t) => to.some((x) => x > t && x - t <= FOLLOW_WINDOW_MIN)).length;
  return hits / from.length;
}

function polarityVotes(line: LineNumber): { agree: number; disagree: number } {
  const timetable = loadTimetable(line);
  const lookup = (name: string) => timetable[name] ?? timetable[normalizeStationName(name)];
  const stations = getStationsOnLine(line);
  let agree = 0;
  let disagree = 0;
  for (let i = 0; i + 1 < stations.length; i++) {
    const a = lookup(stations[i].name);
    const b = lookup(stations[i + 1].name);
    const claimed = directionOnLine(line, stations[i].id, stations[i + 1].id);
    if (!a || !b || claimed === null) continue;
    const other: Direction = claimed === 'up' ? 'down' : 'up';
    const claimedScore = followRatio(minutesOf(a.weekday[claimed]), minutesOf(b.weekday[claimed]));
    const otherScore = followRatio(minutesOf(a.weekday[other]), minutesOf(b.weekday[other]));
    if (claimedScore === otherScore) continue;
    if (claimedScore > otherScore) agree += 1;
    else disagree += 1;
  }
  return { agree, disagree };
}

describe('시간표 up/down vs directionOnLine 극성 (§9-3)', () => {
  const votes = TIMETABLE_LINES.map((line) => ({ line, ...polarityVotes(line) }));

  it.each(TIMETABLE_LINES)('노선 %s: 인접쌍이 충분히 대조된다 (1쌍 이상)', (line) => {
    const { agree, disagree } = votes.find((v) => v.line === line)!;
    expect(agree + disagree).toBeGreaterThan(0);
  });

  it('9호선 극성이 원천에서 교정됐다: 다수결 일치 + 종점 0000 열이 올바른 방향', () => {
    const { agree, disagree } = votes.find((v) => v.line === '9')!;
    expect(agree).toBeGreaterThanOrEqual(33);
    expect(disagree).toBeLessThanOrEqual(4);
    const timetable = loadTimetable('9');
    const { weekday: gaehwa } = timetable['개화'];
    // ARRIVETIME 기반: 종점의 출발 방향 열은 0000, 도착 방향 열만 시각을 갖는다 (3호선 대화와 동일)
    expect(minutesOf(gaehwa.up).length).toBeGreaterThan(0);
    expect(minutesOf(gaehwa.down)).toEqual([]);
    const { weekday: veterans } = timetable['중앙보훈병원'];
    expect(minutesOf(veterans.down).length).toBeGreaterThan(0);
    expect(minutesOf(veterans.up)).toEqual([]);
  });

  it('TIMETABLE_DIRECTION_MISMATCH_LINES는 비어 있다 (모든 노선이 시간표를 쓴다)', () => {
    expect(TIMETABLE_DIRECTION_MISMATCH_LINES).toEqual([]);
  });

  it('다수결로 불일치한 노선 집합 == TIMETABLE_DIRECTION_MISMATCH_LINES', () => {
    const mismatched = votes.filter((v) => v.disagree > v.agree).map((v) => v.line);
    expect([...mismatched].sort()).toEqual([...TIMETABLE_DIRECTION_MISMATCH_LINES].sort());
  });

  it('일치 노선(예: 2호선 건대입구 → 성수 = 내선 up)은 양 방향 모두 시간표가 존재한다', () => {
    for (const direction of ['up', 'down'] as const) {
      expect(
        findBoardableDeparture({ stationName: '건대입구', line: '2', direction, from: WEEKDAY_NOON }).status,
      ).toBe('ok');
    }
  });
});
