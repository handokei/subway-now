/**
 * #3155 — 앵커역 출발 열차 기록(updateStationTrainLogs)/조회(departedFromStation)/관측 분류
 * (classifyAnchorSighting). 입력은 realtimePosition 항목(PositionEntry)뿐인 순수 함수.
 */
import { describe, expect, it } from 'vitest';
import {
  ANCHOR_DEPARTURE_WINDOW_MS,
  anchorFromSegment,
  classifyAnchorSighting,
  departedFromStation,
  planPromotionFastForward,
  updateStationTrainLogs,
  type AnchorForSighting,
} from '../anchorDepartures';
import type { PositionEntry } from '../seoul';

const NOW = 1_800_000_000_000;
const ANCHOR = '건대입구';
const TRACKED = new Set([ANCHOR]);
const APPROACHING = 0;
const ARRIVED = 1;
const DEPARTED = 2;

function pos(trainCode: string, stationName: string, trainSttus: number, overrides: Partial<PositionEntry> = {}): PositionEntry {
  return { trainCode, stationName, trainSttus, isUp: true, recptnMs: NOW, ...overrides };
}

describe('updateStationTrainLogs — 앵커역 출발 기록', () => {
  it('추적 역에서 trainSttus=2(출발)인 열차는 recptnMs를 출발 시각으로 기록한다', () => {
    const logs = updateStationTrainLogs(undefined, [pos('2011', ANCHOR, DEPARTED, { recptnMs: NOW - 5_000 })], TRACKED, NOW);
    expect(logs?.[ANCHOR].departed).toEqual([{ trainCode: '2011', isUp: true, departedAt: NOW - 5_000 }]);
  });

  it('직전 tick에 역에 있던(도착/진입) 열차가 이번 tick 다른 역에서 보이면 두 시각의 중간을 출발 시각으로 기록한다', () => {
    const t0 = NOW - 60_000;
    const first = updateStationTrainLogs(undefined, [pos('2011', ANCHOR, ARRIVED, { recptnMs: t0 })], TRACKED, t0);
    expect(first?.[ANCHOR].present).toEqual([{ trainCode: '2011', isUp: true, seenAt: t0 }]);
    expect(first?.[ANCHOR].departed).toEqual([]);

    const second = updateStationTrainLogs(first, [pos('2011', '성수', ARRIVED)], TRACKED, NOW);
    expect(second?.[ANCHOR].departed).toEqual([{ trainCode: '2011', isUp: true, departedAt: t0 + 30_000 }]);
    expect(second?.[ANCHOR].present).toEqual([]);
  });

  it('피드에서 완전히 사라진 열차(어느 역에서도 안 보임)는 출발로 단정하지 않는다', () => {
    const t0 = NOW - 60_000;
    const first = updateStationTrainLogs(undefined, [pos('2011', ANCHOR, ARRIVED, { recptnMs: t0 })], TRACKED, t0);
    const second = updateStationTrainLogs(first, [pos('3013', '강변', ARRIVED)], TRACKED, NOW);
    expect(second?.[ANCHOR].departed).toEqual([]);
    expect(second?.[ANCHOR].present.map((p) => p.trainCode)).toEqual(['2011']);
  });

  it('앵커를 한 번도 거치는 것을 관측하지 못한 열차(이미 다음 역)는 기록하지 않는다', () => {
    const logs = updateStationTrainLogs(undefined, [pos('9999', '성수', ARRIVED)], TRACKED, NOW);
    expect(logs).toBeUndefined();
  });

  it('추적 대상이 아닌 역의 열차는 기록하지 않는다', () => {
    const logs = updateStationTrainLogs(undefined, [pos('2011', '구의', DEPARTED)], TRACKED, NOW);
    expect(logs).toBeUndefined();
  });

  it('10분(ANCHOR_DEPARTURE_WINDOW_MS)을 넘긴 출발 기록은 다음 갱신에서 정리된다', () => {
    const old = { [ANCHOR]: { present: [], departed: [{ trainCode: '2011', isUp: true, departedAt: NOW - ANCHOR_DEPARTURE_WINDOW_MS - 1 }] } };
    const logs = updateStationTrainLogs(old, [pos('3013', '강변', ARRIVED)], TRACKED, NOW);
    expect(logs).toBeUndefined();
  });

  it('같은 열차의 중복 출발 관측은 먼저 기록한 출발 시각을 보존한다', () => {
    const first = updateStationTrainLogs(undefined, [pos('2011', ANCHOR, DEPARTED, { recptnMs: NOW - 90_000 })], TRACKED, NOW - 60_000);
    const second = updateStationTrainLogs(first, [pos('2011', ANCHOR, DEPARTED, { recptnMs: NOW - 90_000 })], TRACKED, NOW);
    expect(second?.[ANCHOR].departed).toEqual([{ trainCode: '2011', isUp: true, departedAt: NOW - 90_000 }]);
  });

  it('120초보다 오래된 position(recptnMs)은 현재 관측으로 쓰지 않는다', () => {
    const logs = updateStationTrainLogs(undefined, [pos('2011', ANCHOR, DEPARTED, { recptnMs: NOW - 121_000 })], TRACKED, NOW);
    expect(logs).toBeUndefined();
  });
});

describe('departedFromStation — 목록용 조회', () => {
  const logs = {
    [ANCHOR]: {
      present: [],
      departed: [
        { trainCode: 'old', isUp: true, departedAt: NOW - ANCHOR_DEPARTURE_WINDOW_MS - 1 },
        { trainCode: '2011', isUp: true, departedAt: NOW - 60_000 },
        { trainCode: 'opp', isUp: false, departedAt: NOW - 30_000 },
        { trainCode: '2007', isUp: true, departedAt: NOW - 240_000 },
      ],
    },
  };

  it('같은 방향만, 10분 이내만, 최근 출발 순으로 반환한다 (10분 초과/반대 방향 거부)', () => {
    expect(departedFromStation(logs, ANCHOR, true, NOW).map((d) => d.trainCode)).toEqual(['2011', '2007']);
  });

  it('기록이 없는 역/로그 부재는 빈 배열', () => {
    expect(departedFromStation(logs, '성수', true, NOW)).toEqual([]);
    expect(departedFromStation(undefined, ANCHOR, true, NOW)).toEqual([]);
  });
});

describe('classifyAnchorSighting — 앵커에서 본 열차인가', () => {
  const anchor: AnchorForSighting = { station: ANCHOR, isUp: true, segmentStations: [ANCHOR, '성수', '뚝섬'] };
  const logs = {
    [ANCHOR]: { present: [], departed: [{ trainCode: '2011', isUp: true, departedAt: NOW - 60_000 }] },
  };

  it('앵커 역에 서 있는(도착/진입) 같은 방향 열차 = at-anchor', () => {
    expect(classifyAnchorSighting('3013', anchor, [pos('3013', ANCHOR, ARRIVED)], undefined, NOW)).toBe('at-anchor');
  });

  it('출발 기록(10분 내)이 있는 열차 = departed — 이미 다음 역에 가 있어도', () => {
    expect(classifyAnchorSighting('2011', anchor, [pos('2011', '뚝섬', ARRIVED)], logs, NOW)).toBe('departed');
  });

  it('앵커 이전(진행 구간 밖) 역에서 접근 중인 같은 방향 열차 = approaching', () => {
    expect(classifyAnchorSighting('3013', anchor, [pos('3013', '강변', APPROACHING)], undefined, NOW)).toBe('approaching');
  });

  it('앵커를 지나 진행 구간 안에 있는데 출발 기록이 없는 열차 = null (앵커를 한 번도 못 본 코드)', () => {
    expect(classifyAnchorSighting('9999', anchor, [pos('9999', '성수', ARRIVED)], undefined, NOW)).toBeNull();
  });

  it('10분 초과 출발 기록은 근거가 되지 못한다', () => {
    const stale = { [ANCHOR]: { present: [], departed: [{ trainCode: '2011', isUp: true, departedAt: NOW - ANCHOR_DEPARTURE_WINDOW_MS - 1 }] } };
    expect(classifyAnchorSighting('2011', anchor, [pos('2011', '성수', ARRIVED)], stale, NOW)).toBeNull();
  });

  it('반대 방향 열차는 앵커에 서 있어도 null', () => {
    expect(classifyAnchorSighting('8001', anchor, [pos('8001', ANCHOR, ARRIVED, { isUp: false })], undefined, NOW)).toBeNull();
  });

  it('피드에 없는 코드는 null', () => {
    expect(classifyAnchorSighting('0000', anchor, [pos('3013', '강변', APPROACHING)], undefined, NOW)).toBeNull();
  });
});

describe('updateStationTrainLogs — recptnMs 누락/중복 경계', () => {
  it('recptnMs 0(누락)은 이번 tick 관측(now)으로 취급한다', () => {
    const logs = updateStationTrainLogs(undefined, [pos('2011', ANCHOR, DEPARTED, { recptnMs: 0 })], TRACKED, NOW);
    expect(logs?.[ANCHOR].departed).toEqual([{ trainCode: '2011', isUp: true, departedAt: NOW }]);
    const present = updateStationTrainLogs(undefined, [pos('2011', ANCHOR, ARRIVED, { recptnMs: 0 })], TRACKED, NOW);
    expect(present?.[ANCHOR].present).toEqual([{ trainCode: '2011', isUp: true, seenAt: NOW }]);
  });

  it('이미 출발로 기록된 열차가 present에도 남아 있다가 다른 역에서 보여도 출발 시각을 덮어쓰지 않는다', () => {
    const prev = {
      [ANCHOR]: {
        present: [{ trainCode: '2011', isUp: true, seenAt: NOW - 90_000 }],
        departed: [{ trainCode: '2011', isUp: true, departedAt: NOW - 80_000 }],
      },
    };
    const logs = updateStationTrainLogs(prev, [pos('2011', '성수', ARRIVED)], TRACKED, NOW);
    expect(logs?.[ANCHOR].departed).toEqual([{ trainCode: '2011', isUp: true, departedAt: NOW - 80_000 }]);
    expect(logs?.[ANCHOR].present).toEqual([]);
  });

  it('계속 역에 서 있는 열차는 출발로 보지 않고 seenAt만 갱신한다 (반대 방향 열차도 방향별로 따로 추적)', () => {
    const t0 = NOW - 30_000;
    const first = updateStationTrainLogs(
      undefined,
      [pos('2011', ANCHOR, ARRIVED, { recptnMs: t0 }), pos('8001', ANCHOR, ARRIVED, { recptnMs: t0, isUp: false })],
      TRACKED,
      t0,
    );
    const second = updateStationTrainLogs(
      first,
      [pos('2011', ANCHOR, ARRIVED), pos('8001', ANCHOR, ARRIVED, { isUp: false })],
      TRACKED,
      NOW,
    );
    expect(second?.[ANCHOR].departed).toEqual([]);
    expect(second?.[ANCHOR].present.map((p) => [p.trainCode, p.isUp, p.seenAt])).toEqual([
      ['2011', true, NOW],
      ['8001', false, NOW],
    ]);
  });

  it('10분 넘게 피드에 안 보인 present는 정리된다', () => {
    const prev = { [ANCHOR]: { present: [{ trainCode: '2011', isUp: true, seenAt: NOW - ANCHOR_DEPARTURE_WINDOW_MS - 1 }], departed: [] } };
    expect(updateStationTrainLogs(prev, [], TRACKED, NOW)).toBeUndefined();
  });
});

describe('planPromotionFastForward — 승격 시 열차가 이미 지난 역 건너뛰기', () => {
  const segment = ['용마산', '중곡', '군자', '어린이대공원', '건대입구'];
  const wp = (stationName: string, kind: 'intermediate' | 'transfer' | 'destination') => ({ stationName, line: '7', kind });
  const waypoints = [wp('중곡', 'intermediate'), wp('군자', 'intermediate'), wp('어린이대공원', 'intermediate'), wp('건대입구', 'destination')];

  it('열차가 군자에 도착(sts=1)해 있으면 지난 중곡만 건너뛴다 — 군자는 아직 안 지났다', () => {
    expect(planPromotionFastForward(waypoints, segment, pos('7039', '군자', ARRIVED))).toEqual({ skip: 1 });
  });

  it('열차가 군자를 출발(sts=2)했으면 중곡·군자를 건너뛴다', () => {
    expect(planPromotionFastForward(waypoints, segment, pos('7039', '군자', DEPARTED))).toEqual({ skip: 2 });
  });

  it('앵커에 있거나 앵커 이전/모르는 역이면 건너뛰지 않는다 (#3056 신선 탭 불변)', () => {
    expect(planPromotionFastForward(waypoints, segment, pos('7039', '용마산', ARRIVED))).toEqual({ skip: 0 });
    expect(planPromotionFastForward(waypoints, segment, pos('7039', '사가정', APPROACHING))).toEqual({ skip: 0 });
    expect(planPromotionFastForward(waypoints, segment, undefined)).toEqual({ skip: 0 });
  });

  it('열차가 이미 지난 환승/도착 waypoint가 있으면 아무것도 건너뛰지 않고 blockedAt을 보고한다', () => {
    const withTransfer = [wp('중곡', 'intermediate'), wp('군자', 'transfer'), wp('건대입구', 'destination')];
    expect(planPromotionFastForward(withTransfer, segment, pos('7039', '어린이대공원', ARRIVED))).toEqual({
      skip: 0,
      blockedAt: '군자',
    });
    expect(planPromotionFastForward(withTransfer, segment, pos('7039', '건대입구', DEPARTED))).toEqual({
      skip: 0,
      blockedAt: '군자',
    });
  });

  it('구간(현재 leg) 밖에 있는데 앵커를 지난 기록이 있으면 leg 끝(환승)을 넘어선 열차 — blockedAt 보고', () => {
    const leg = ['용마산', '중곡', '군자'];
    const wps = [wp('중곡', 'intermediate'), wp('군자', 'transfer')];
    expect(planPromotionFastForward(wps, leg, pos('7039', '어린이대공원', ARRIVED), true)).toEqual({
      skip: 0,
      blockedAt: '군자',
    });
    // 앵커 통과 기록이 없으면(앵커 이전 역의 접근 열차) 구간 밖이어도 건드리지 않는다.
    expect(planPromotionFastForward(wps, leg, pos('7039', '사가정', APPROACHING), false)).toEqual({ skip: 0 });
  });

  it('waypoint가 구간에 없으면 거기서 멈춘다', () => {
    expect(planPromotionFastForward([wp('없는역', 'intermediate')], segment, pos('7039', '군자', DEPARTED))).toEqual({ skip: 0 });
  });
});

describe('anchorFromSegment', () => {
  it('노선에 없는 역이라 방향을 못 구하면 null', () => {
    expect(anchorFromSegment('2', ['없는역', '또없는역'])).toBeNull();
  });

  it('진행 구간 [앵커, 다음역...]에서 앵커/방향(isUp)을 만든다', () => {
    const anchor = anchorFromSegment('2', ['건대입구', '성수', '뚝섬']);
    expect(anchor).toMatchObject({ station: '건대입구', segmentStations: ['건대입구', '성수', '뚝섬'] });
    expect(typeof anchor?.isUp).toBe('boolean');
  });

  it('방향을 알 수 없으면(구간 1개/미매핑) null — fail-closed', () => {
    expect(anchorFromSegment('2', ['건대입구'])).toBeNull();
  });
});
