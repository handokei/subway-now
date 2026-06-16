import { describe, expect, it } from 'vitest';
import type { BoardingLockMeta, PositionPoint } from '../types';
import {
  buildPushConsistencyContextFromSeries,
  computeDeviceHopsBehindTarget,
  extractDeviceSignal,
} from '../pushConsistencyContext';

const NOW = 1_750_000_000_000;

const mkPoint = (overrides: Partial<PositionPoint> = {}): PositionPoint => ({
  lat: 0,
  lng: 0,
  accuracy: 10,
  ts: NOW,
  motion: 'walking',
  ...overrides,
});

describe('extractDeviceSignal (#1389)', () => {
  it('빈 시리즈는 motion=unknown / currentStationName=null / lastUpdateMs=0', () => {
    const signal = extractDeviceSignal([], NOW);
    expect(signal).toEqual({
      currentStationName: null,
      motion: 'unknown',
      wifiStation: null,
      lastUpdateMs: 0,
    });
  });

  it('가장 최근 sample의 motion + lastUpdateMs를 사용 (motion=automotive, ts=NOW)', () => {
    const series: PositionPoint[] = [
      mkPoint({ ts: NOW - 60_000, motion: 'walking' }),
      mkPoint({ ts: NOW - 30_000, motion: 'automotive' }),
      mkPoint({ ts: NOW, motion: 'automotive' }),
    ];
    const signal = extractDeviceSignal(series, NOW);
    // motion은 evaluateWindow 최빈값. 최근 3개 중 automotive 2건 → automotive.
    expect(signal.motion).toBe('automotive');
    expect(signal.lastUpdateMs).toBe(NOW);
    expect(signal.wifiStation).toBeNull();
  });

  it('currentStationName: 가장 최근 stamp부터 backward backfill', () => {
    const series: PositionPoint[] = [
      mkPoint({ ts: NOW - 60_000, currentStationName: '용마산' }),
      mkPoint({ ts: NOW - 30_000 }), // stamp 없음
      mkPoint({ ts: NOW }), // stamp 없음
    ];
    const signal = extractDeviceSignal(series, NOW);
    expect(signal.currentStationName).toBe('용마산');
  });

  it('가장 최근 sample에 currentStationName이 있으면 그 값을 사용', () => {
    const series: PositionPoint[] = [
      mkPoint({ ts: NOW - 60_000, currentStationName: '용마산' }),
      mkPoint({ ts: NOW, currentStationName: '중곡' }),
    ];
    const signal = extractDeviceSignal(series, NOW);
    expect(signal.currentStationName).toBe('중곡');
  });

  it('stamp가 한 번도 없으면 currentStationName=null (게이트 #4/§5 허용 fallback)', () => {
    const series: PositionPoint[] = [
      mkPoint({ ts: NOW - 30_000, motion: 'stationary' }),
      mkPoint({ ts: NOW, motion: 'stationary' }),
    ];
    const signal = extractDeviceSignal(series, NOW);
    expect(signal.currentStationName).toBeNull();
    expect(signal.motion).toBe('stationary');
  });

  it('빈 string은 stamp 없음으로 처리 (graceful)', () => {
    const series: PositionPoint[] = [
      mkPoint({ ts: NOW - 30_000, currentStationName: '' }),
      mkPoint({ ts: NOW }),
    ];
    const signal = extractDeviceSignal(series, NOW);
    expect(signal.currentStationName).toBeNull();
  });
});

describe('computeDeviceHopsBehindTarget (#1389)', () => {
  const lock: Pick<BoardingLockMeta, 'segmentStations'> = {
    segmentStations: ['용마산', '중곡', '군자', '어린이대공원'],
  };

  it('device == target → 0', () => {
    const hops = computeDeviceHopsBehindTarget(
      lock,
      { stationName: '중곡', line: '7' },
      '중곡',
    );
    expect(hops).toBe(0);
  });

  it('device 1 hop behind target → 1', () => {
    const hops = computeDeviceHopsBehindTarget(
      lock,
      { stationName: '중곡', line: '7' },
      '용마산',
    );
    expect(hops).toBe(1);
  });

  it('device 2 hops behind target → 2', () => {
    const hops = computeDeviceHopsBehindTarget(
      lock,
      { stationName: '군자', line: '7' },
      '용마산',
    );
    expect(hops).toBe(2);
  });

  it('device ahead of target → 음수 (-1)', () => {
    const hops = computeDeviceHopsBehindTarget(
      lock,
      { stationName: '용마산', line: '7' },
      '중곡',
    );
    expect(hops).toBe(-1);
  });

  it('lock 부재 → null (fallback)', () => {
    const hops = computeDeviceHopsBehindTarget(
      undefined,
      { stationName: '중곡', line: '7' },
      '용마산',
    );
    expect(hops).toBeNull();
  });

  it('currentStationName=null → null (산출 불가)', () => {
    const hops = computeDeviceHopsBehindTarget(
      lock,
      { stationName: '중곡', line: '7' },
      null,
    );
    expect(hops).toBeNull();
  });

  it('device가 segmentStations에 없으면 → null', () => {
    const hops = computeDeviceHopsBehindTarget(
      lock,
      { stationName: '중곡', line: '7' },
      '강남',
    );
    expect(hops).toBeNull();
  });

  it('target이 segmentStations에 없으면 → null', () => {
    const hops = computeDeviceHopsBehindTarget(
      lock,
      { stationName: '강남', line: '2' },
      '용마산',
    );
    expect(hops).toBeNull();
  });
});

describe('buildPushConsistencyContextFromSeries (#1389)', () => {
  const lock: Pick<BoardingLockMeta, 'segmentStations'> = {
    segmentStations: ['용마산', '중곡', '군자'],
  };

  it('정지 trip + device 1 hop behind → motion=stationary + hops=1', () => {
    const series: PositionPoint[] = [
      mkPoint({ ts: NOW - 40_000, motion: 'stationary', currentStationName: '용마산' }),
      mkPoint({ ts: NOW - 20_000, motion: 'stationary', currentStationName: '용마산' }),
      mkPoint({ ts: NOW, motion: 'stationary', currentStationName: '용마산' }),
    ];
    const ctx = buildPushConsistencyContextFromSeries(
      series,
      lock,
      { stationName: '중곡', line: '7' },
      NOW,
    );
    expect(ctx.device.motion).toBe('stationary');
    expect(ctx.device.currentStationName).toBe('용마산');
    expect(ctx.trip.deviceHopsBehindTarget).toBe(1);
  });

  it('lock 부재 → hops=null (lockless 경로)', () => {
    const series: PositionPoint[] = [
      mkPoint({ ts: NOW, motion: 'walking', currentStationName: '용마산' }),
    ];
    const ctx = buildPushConsistencyContextFromSeries(
      series,
      undefined,
      { stationName: '중곡', line: '7' },
      NOW,
    );
    expect(ctx.trip.deviceHopsBehindTarget).toBeNull();
    expect(ctx.device.currentStationName).toBe('용마산');
  });
});
