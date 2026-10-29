/**
 * #3221 PR-5 — 여정 LA 진행 막대 필드 산출 (`computeLegProgressContext`).
 *
 * 원본 `trip.route`(shift되지 않음)에서 leg별 정거장 수를 얻고, 남은 환승 waypoint 수로 현재 leg
 * 인덱스를 구한다. 10/28 실측 trip 179(아침, 7->2 환승 전)·180(저녁, 환승 후) seed로 고정한다.
 */
import { describe, expect, it } from 'vitest';
import { LINE_META } from '../lineAlias';
import { buildLiveActivityContentState } from '../liveActivity';
import { computeLegProgressContext } from '../tripMultiHop';
import type { Trip, Waypoint } from '../types';
import { makeRide20261028EveningTrip, makeRide20261028MorningTrip } from './helpers/ride20261028Trips';

const NOW = 1_700_000_000_000;

describe('computeLegProgressContext (#3221 PR-5)', () => {
  it('trip 179 (7호선 4역 -> 건대입구 환승 -> 2호선 2역): 현재 leg=7호선, 다음 leg=2호선', () => {
    const trip = makeRide20261028MorningTrip('t179', NOW);
    expect(computeLegProgressContext(trip)).toEqual({
      legStopsTotal: 4,
      nextLegStopsTotal: 2,
      nextLineColorHex: LINE_META['2'].color,
    });
  });

  it('trip 179 환승 통과 후(남은 환승 waypoint 0): 현재 leg=2호선 2역, 다음 leg 없음', () => {
    const trip = makeRide20261028MorningTrip('t179b', NOW);
    trip.waypoints = trip.waypoints.slice(3); // 성수, 뚝섬
    expect(computeLegProgressContext(trip)).toEqual({ legStopsTotal: 2 });
  });

  it('trip 180 (이미 환승 후 leg): 현재 leg=stopsFromTransfer 4, 다음 leg 없음', () => {
    const trip = makeRide20261028EveningTrip('t180', NOW);
    expect(computeLegProgressContext(trip)).toEqual({ legStopsTotal: 4 });
  });

  it('direct route: legStopsTotal = stops, 다음 leg 없음', () => {
    const trip: Trip = {
      token: 'd',
      route: { type: 'direct', line: '2', stops: 7 },
      destination: '강남',
      waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
      expiresAt: NOW,
      createdAt: NOW,
      alarmAtEpochMs: NOW,
    };
    expect(computeLegProgressContext(trip)).toEqual({ legStopsTotal: 7 });
  });

  it('multi-transfer: leg 0/1/2를 남은 환승 수로 선택하고 다음 leg 노선색을 transfers[k].toLine에서 얻는다', () => {
    const wps = (kinds: Array<Waypoint['kind']>): Waypoint[] =>
      kinds.map((kind, i) => ({ stationName: `S${i}`, line: '2', kind }));
    const base: Trip = {
      token: 'm',
      route: {
        type: 'multi-transfer',
        transfers: [
          { transferName: 'A', fromLine: '2', toLine: '4', stopsToTransfer: 3 },
          { transferName: 'B', fromLine: '4', toLine: '7', stopsToTransfer: 5 },
        ],
        stopsAfterLastTransfer: 6,
      },
      destination: 'Z',
      waypoints: wps(['intermediate', 'transfer', 'intermediate', 'transfer', 'destination']),
      expiresAt: NOW,
      createdAt: NOW,
      alarmAtEpochMs: NOW,
    };
    expect(computeLegProgressContext(base)).toEqual({
      legStopsTotal: 3,
      nextLegStopsTotal: 5,
      nextLineColorHex: LINE_META['4'].color,
    });
    expect(computeLegProgressContext({ ...base, waypoints: wps(['intermediate', 'transfer', 'destination']) })).toEqual({
      legStopsTotal: 5,
      nextLegStopsTotal: 6,
      nextLineColorHex: LINE_META['7'].color,
    });
    expect(computeLegProgressContext({ ...base, waypoints: wps(['intermediate', 'destination']) })).toEqual({
      legStopsTotal: 6,
    });
  });

  it('route와 waypoints가 모순돼 leg 인덱스가 범위 밖이면 필드를 생략한다 (거짓 막대보다 숨김)', () => {
    const trip: Trip = {
      token: 'x',
      route: { type: 'direct', line: '2', stops: 7 },
      destination: 'Z',
      waypoints: [
        { stationName: 'a', line: '2', kind: 'transfer' },
        { stationName: 'b', line: '2', kind: 'destination' },
      ],
      expiresAt: NOW,
      createdAt: NOW,
      alarmAtEpochMs: NOW,
    };
    expect(computeLegProgressContext(trip)).toEqual({});
  });

  it('알 수 없는 toLine이면 nextLineColorHex만 생략하고 정거장 수는 유지한다', () => {
    const trip = makeRide20261028MorningTrip('t', NOW);
    if (trip.route.type !== 'transfer') throw new Error('fixture');
    trip.route = { ...trip.route, toLine: 'ZZ' };
    expect(computeLegProgressContext(trip)).toEqual({ legStopsTotal: 4, nextLegStopsTotal: 2 });
  });
});

describe('buildLiveActivityContentState — 진행 막대 필드 (#3221 PR-5)', () => {
  it('trip 179: 일반 경로와 split 경로 모두 content에 legStopsTotal/nextLegStopsTotal/nextLineColorHex가 실린다', () => {
    const trip = makeRide20261028MorningTrip('t179', NOW);
    const waypoint = trip.waypoints[0];
    const expected = {
      legStopsTotal: 4,
      nextLegStopsTotal: 2,
      nextLineColorHex: LINE_META['2'].color,
    };
    expect(buildLiveActivityContentState(waypoint, 60, 5, trip)).toMatchObject(expected);
    const split: Trip = { ...trip, laClient: { split: true, boardingStart: 'push-to-start' } };
    expect(buildLiveActivityContentState(waypoint, 60, 5, split)).toMatchObject(expected);
  });

  it('trip 없는(legacy) 호출은 필드를 emit하지 않는다 (byte 하위호환)', () => {
    const wp: Waypoint = { stationName: 'A', line: '2', kind: 'intermediate' };
    const cs = buildLiveActivityContentState(wp, 60, 3);
    expect(Object.keys(cs)).not.toContain('legStopsTotal');
  });
});
