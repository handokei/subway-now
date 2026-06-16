import type { Station } from '../../../../shared/types/station';
import {
  computeDeviceHopsBehindTarget,
  extractDeviceSignal,
} from '../pushConsistencyContext';

const NOW = 1_750_000_000_000;

const makeStation = (name: string, line: Station['line'] = '7'): Station => ({
  id: `${line}-${name}`,
  name,
  line,
  lineColor: '#000000',
  lat: 37.5,
  lng: 127.0,
});

describe('extractDeviceSignal (#1389)', () => {
  it('currentStation=null → currentStationName=null', () => {
    const result = extractDeviceSignal({
      currentStation: null,
      motionStationary: false,
      wifiStation: null,
      lastUpdateMs: NOW,
    });
    expect(result.currentStationName).toBeNull();
  });

  it('currentStation=string → 그대로 사용', () => {
    const result = extractDeviceSignal({
      currentStation: '용마산',
      motionStationary: false,
      wifiStation: null,
      lastUpdateMs: NOW,
    });
    expect(result.currentStationName).toBe('용마산');
  });

  it('currentStation=Station 객체 → name 필드 추출', () => {
    const result = extractDeviceSignal({
      currentStation: makeStation('중곡'),
      motionStationary: false,
      wifiStation: null,
      lastUpdateMs: NOW,
    });
    expect(result.currentStationName).toBe('중곡');
  });

  it('motionStationary=true → stationary', () => {
    const result = extractDeviceSignal({
      currentStation: '용마산',
      motionStationary: true,
      wifiStation: null,
      lastUpdateMs: NOW,
    });
    expect(result.motion).toBe('stationary');
  });

  it('motionStationary=false → unknown (walking/automotive 구분 불가)', () => {
    const result = extractDeviceSignal({
      currentStation: '용마산',
      motionStationary: false,
      wifiStation: null,
      lastUpdateMs: NOW,
    });
    expect(result.motion).toBe('unknown');
  });

  it('motionStationary=undefined → unknown', () => {
    const result = extractDeviceSignal({
      currentStation: '용마산',
      motionStationary: undefined,
      wifiStation: null,
      lastUpdateMs: NOW,
    });
    expect(result.motion).toBe('unknown');
  });

  it('wifiStation=Station → {stationName, line} 매핑', () => {
    const result = extractDeviceSignal({
      currentStation: null,
      motionStationary: false,
      wifiStation: makeStation('중곡', '7'),
      lastUpdateMs: NOW,
    });
    expect(result.wifiStation).toEqual({ stationName: '중곡', line: '7' });
  });

  it('wifiStation=null → null', () => {
    const result = extractDeviceSignal({
      currentStation: null,
      motionStationary: false,
      wifiStation: null,
      lastUpdateMs: NOW,
    });
    expect(result.wifiStation).toBeNull();
  });

  it('lastUpdateMs 그대로 전달 (helper 임의 fallback X)', () => {
    const result = extractDeviceSignal({
      currentStation: null,
      motionStationary: false,
      wifiStation: null,
      lastUpdateMs: NOW,
    });
    expect(result.lastUpdateMs).toBe(NOW);
  });
});

describe('computeDeviceHopsBehindTarget (#1389)', () => {
  const arc = [
    makeStation('태릉입구'),
    makeStation('먹골'),
    makeStation('중화'),
    makeStation('상봉'),
    makeStation('면목'),
    makeStation('사가정'),
    makeStation('용마산'),
    makeStation('중곡'),
    makeStation('군자'),
  ];

  it('arcStations=undefined → null (fallback)', () => {
    expect(
      computeDeviceHopsBehindTarget({
        arcStations: undefined,
        currentStationName: '용마산',
        target: { stationName: '중곡', line: '7호선' },
      }),
    ).toBeNull();
  });

  it('arcStations=null → null', () => {
    expect(
      computeDeviceHopsBehindTarget({
        arcStations: null,
        currentStationName: '용마산',
        target: { stationName: '중곡', line: '7호선' },
      }),
    ).toBeNull();
  });

  it('arcStations 빈 배열 → null', () => {
    expect(
      computeDeviceHopsBehindTarget({
        arcStations: [],
        currentStationName: '용마산',
        target: { stationName: '중곡', line: '7호선' },
      }),
    ).toBeNull();
  });

  it('currentStationName=null → null', () => {
    expect(
      computeDeviceHopsBehindTarget({
        arcStations: arc,
        currentStationName: null,
        target: { stationName: '중곡', line: '7호선' },
      }),
    ).toBeNull();
  });

  it('device station이 arc에 없음 → null (다른 라인 / 미확정 위치)', () => {
    expect(
      computeDeviceHopsBehindTarget({
        arcStations: arc,
        currentStationName: '강남',
        target: { stationName: '중곡', line: '7호선' },
      }),
    ).toBeNull();
  });

  it('target station이 arc에 없음 → null', () => {
    expect(
      computeDeviceHopsBehindTarget({
        arcStations: arc,
        currentStationName: '용마산',
        target: { stationName: '강남', line: '7호선' },
      }),
    ).toBeNull();
  });

  it('hops 0 (device == target)', () => {
    expect(
      computeDeviceHopsBehindTarget({
        arcStations: arc,
        currentStationName: '중곡',
        target: { stationName: '중곡', line: '7호선' },
      }),
    ).toBe(0);
  });

  it('hops 1 (device 한 칸 behind, 용마산 → 중곡)', () => {
    expect(
      computeDeviceHopsBehindTarget({
        arcStations: arc,
        currentStationName: '용마산',
        target: { stationName: '중곡', line: '7호선' },
      }),
    ).toBe(1);
  });

  it('hops 3 (device 멀리 behind, 면목 → 중곡)', () => {
    expect(
      computeDeviceHopsBehindTarget({
        arcStations: arc,
        currentStationName: '면목',
        target: { stationName: '중곡', line: '7호선' },
      }),
    ).toBe(3);
  });

  it('hops -1 (device가 target보다 한 칸 ahead, 군자 → 중곡)', () => {
    expect(
      computeDeviceHopsBehindTarget({
        arcStations: arc,
        currentStationName: '군자',
        target: { stationName: '중곡', line: '7호선' },
      }),
    ).toBe(-1);
  });

  it('hops 큰 음수 (device 멀리 ahead, 군자 → 먹골 = -7)', () => {
    expect(
      computeDeviceHopsBehindTarget({
        arcStations: arc,
        currentStationName: '군자',
        target: { stationName: '먹골', line: '7' },
      }),
    ).toBe(-7);
  });
});
