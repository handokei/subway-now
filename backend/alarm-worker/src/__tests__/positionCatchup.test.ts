/**
 * #2629 PR-3 — lock 열차 위치 따라잡기 계획(planPositionCatchup) 게이트 단위 테스트.
 * 사용자 결정(2026-11-03): trainCode·방향 일치로 head보다 1역 이상 앞서 있으면 따라잡는다. 시간 기반 아님(ADR-015).
 * 게이트마다 "통과"와 "거부" 케이스를 둔다 — 거부 케이스는 게이트 하나만 깨뜨린 입력이다.
 */
import { describe, expect, it } from 'vitest';
import { planPositionCatchup } from '../positionCatchup';
import { POSITION_FRESHNESS_MS } from '../boardingAnchorResolver';
import type { PositionEntry } from '../seoul';
import type { BoardingLockMeta, Waypoint } from '../types';

const NOW = 1_800_000_000_000;
// 7호선 하행(청담 -> 논현). 10/31 실측 노선의 일부.
const SEGMENT = ['청담', '강남구청', '학동', '논현'];
const wp = (stationName: string, kind: Waypoint['kind'] = 'intermediate'): Waypoint => ({ stationName, line: '7', kind });
const lock = (overrides: Partial<BoardingLockMeta> = {}): BoardingLockMeta => ({
  trainCode: '7077',
  line: '7',
  subwayId: '1007',
  selectedDepartureTime: NOW,
  segmentStations: SEGMENT,
  expiresAt: NOW + 3_600_000,
  ...overrides,
});
const position = (overrides: Partial<PositionEntry> = {}): PositionEntry => ({
  trainCode: '7077',
  stationName: '학동',
  trainSttus: 1,
  isUp: false,
  recptnMs: NOW - 32_000,
  ...overrides,
});
const waypoints = (...entries: Array<string | [string, Waypoint['kind']]>): Waypoint[] =>
  entries.map((e) => (typeof e === 'string' ? wp(e) : wp(e[0], e[1])));
const names = (ws: Waypoint[]) => ws.map((w) => w.stationName);

describe('planPositionCatchup — 통과', () => {
  it('head(강남구청)보다 1역 앞(학동)에 lock 열차가 있으면 강남구청을 지나친 것으로 돌려준다', () => {
    const plan = planPositionCatchup({
      trip: { waypoints: waypoints('강남구청', '학동', ['논현', 'destination']) },
      lock: lock(),
      positions: [position()],
      now: NOW,
    });
    expect(names(plan)).toEqual(['강남구청']);
  });

  it('2역 이상 앞서면 오래된 순으로 전부 돌려준다 (발사 상한은 호출자의 cap)', () => {
    const plan = planPositionCatchup({
      trip: { waypoints: waypoints('청담', '강남구청', '학동', ['논현', 'destination']) },
      lock: lock(),
      positions: [position()],
      now: NOW,
    });
    expect(names(plan)).toEqual(['청담', '강남구청']);
  });

  it('recptn이 정확히 POSITION_FRESHNESS_MS 전이면 통과(경계 포함)', () => {
    const plan = planPositionCatchup({
      trip: { waypoints: waypoints('강남구청', '학동', ['논현', 'destination']) },
      lock: lock(),
      positions: [position({ recptnMs: NOW - POSITION_FRESHNESS_MS })],
      now: NOW,
    });
    expect(names(plan)).toEqual(['강남구청']);
  });
});

describe('planPositionCatchup — 게이트별 거부 (각 케이스는 게이트 하나만 깨뜨린다)', () => {
  const base = { trip: { waypoints: waypoints('강남구청', '학동', ['논현', 'destination']) }, lock: lock(), now: NOW };

  it('G1 신원: trainCode가 lock과 다르면 거부', () => {
    expect(planPositionCatchup({ ...base, positions: [position({ trainCode: '7078' })] })).toEqual([]);
  });

  it('G1 신원: 같은 trainCode 행이 없으면 거부', () => {
    expect(planPositionCatchup({ ...base, positions: [] })).toEqual([]);
  });

  it('G2 방향: 열차 isUp이 구간 방향과 반대면 거부', () => {
    expect(planPositionCatchup({ ...base, positions: [position({ isUp: true })] })).toEqual([]);
  });

  it('G2 방향: 방향을 못 구하면(segment 1역) fail-closed 거부', () => {
    expect(planPositionCatchup({ ...base, lock: lock({ segmentStations: ['학동'] }), positions: [position()] })).toEqual([]);
  });

  it('G3 신선: recptn이 POSITION_FRESHNESS_MS보다 1ms 오래되면 거부', () => {
    expect(
      planPositionCatchup({ ...base, positions: [position({ recptnMs: NOW - POSITION_FRESHNESS_MS - 1 })] }),
    ).toEqual([]);
  });

  it('G3 신선: recptn 누락(0)은 신뢰 불가로 거부', () => {
    expect(planPositionCatchup({ ...base, positions: [position({ recptnMs: 0 })] })).toEqual([]);
  });

  it('G4 경로: 열차 역이 segment 밖이면 거부', () => {
    expect(planPositionCatchup({ ...base, positions: [position({ stationName: '반포' })] })).toEqual([]);
  });

  it('G4 경로: head가 segment 밖이면 거부', () => {
    expect(
      planPositionCatchup({
        ...base,
        trip: { waypoints: waypoints('고속터미널', '학동', ['논현', 'destination']) },
        positions: [position()],
      }),
    ).toEqual([]);
  });

  it('G4 경로: 열차가 head와 같은 역이면 따라잡을 것이 없다', () => {
    expect(planPositionCatchup({ ...base, positions: [position({ stationName: '강남구청' })] })).toEqual([]);
  });

  it('G4 경로: 열차가 head보다 뒤(아직 도달 전)면 거부', () => {
    expect(
      planPositionCatchup({
        ...base,
        trip: { waypoints: waypoints('학동', ['논현', 'destination']) },
        positions: [position({ stationName: '강남구청' })],
      }),
    ).toEqual([]);
  });

  it('G6 종류: 지나친 구간에 transfer가 끼면 그 앞(intermediate)까지만 돌려준다', () => {
    const plan = planPositionCatchup({
      ...base,
      trip: { waypoints: waypoints('청담', ['강남구청', 'transfer'], '학동', ['논현', 'destination']) },
      positions: [position()],
    });
    expect(names(plan)).toEqual(['청담']);
  });

  it('G6 종류: head 자체가 transfer면 따라잡지 않는다', () => {
    const plan = planPositionCatchup({
      ...base,
      trip: { waypoints: waypoints(['강남구청', 'transfer'], '학동', ['논현', 'destination']) },
      positions: [position()],
    });
    expect(plan).toEqual([]);
  });

  it('G6 종류: 열차가 destination 역에 있어도 destination은 따라잡기 대상이 아니다', () => {
    const plan = planPositionCatchup({
      ...base,
      trip: { waypoints: waypoints('강남구청', '학동', ['논현', 'destination']) },
      positions: [position({ stationName: '논현' })],
    });
    expect(names(plan)).toEqual(['강남구청', '학동']);
  });
});
