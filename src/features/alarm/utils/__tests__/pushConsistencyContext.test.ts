import type { Station } from '../../../../shared/types/station';
import {
  computeDeviceHopsBehindTarget,
  extractDeviceSignal,
} from '../pushConsistencyContext';

const NOW = 1_750_000_000_000;

const stationFor = (name: string, line: Station['line'] = '7'): Station => ({
  id: `${line}-${name}`,
  name,
  line,
  lineColor: '#000000',
  lat: 37.5,
  lng: 127,
});

describe('extractDeviceSignal (#1389)', () => {
  it.each<[string, Parameters<typeof extractDeviceSignal>[0], string | null]>([
    [
      'currentStation=null → currentStationName=null',
      { currentStation: null, motionStationary: false, wifiStation: null, lastUpdateMs: NOW },
      null,
    ],
    [
      'currentStation=string → 그대로',
      { currentStation: '용마산', motionStationary: false, wifiStation: null, lastUpdateMs: NOW },
      '용마산',
    ],
    [
      'currentStation=Station 객체 → name 필드',
      { currentStation: stationFor('중곡'), motionStationary: false, wifiStation: null, lastUpdateMs: NOW },
      '중곡',
    ],
  ])('%s', (_, input, expected) => {
    expect(extractDeviceSignal(input).currentStationName).toBe(expected);
  });

  it.each<[string, boolean | undefined, 'stationary' | 'unknown']>([
    ['motionStationary=true → stationary', true, 'stationary'],
    ['motionStationary=false → unknown', false, 'unknown'],
    ['motionStationary=undefined → unknown', undefined, 'unknown'],
  ])('%s', (_, motionStationary, expected) => {
    const result = extractDeviceSignal({
      currentStation: '용마산',
      motionStationary,
      wifiStation: null,
      lastUpdateMs: NOW,
    });
    expect(result.motion).toBe(expected);
  });

  it('wifiStation=Station → {stationName, line} 매핑', () => {
    const result = extractDeviceSignal({
      currentStation: null,
      motionStationary: false,
      wifiStation: stationFor('중곡', '7'),
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
  // 7호선 일부 (태릉입구 ~ 군자) — hop 산출에 사용되는 arc 픽스처
  const arcOf7Line: readonly Station[] = [
    '태릉입구',
    '먹골',
    '중화',
    '상봉',
    '면목',
    '사가정',
    '용마산',
    '중곡',
    '군자',
  ].map((n) => stationFor(n));

  const target7 = { stationName: '중곡', line: '7호선' as const };

  // 단일 헬퍼로 케이스 객체 → 결과 1:1 매핑. it.each + 한 줄 expect 패턴으로
  // 동일 helper(`pushConsistency.test.ts`)와 fixture 텍스트 형태 분리한다.
  it.each<[string, Parameters<typeof computeDeviceHopsBehindTarget>[0], number | null]>([
    // null 반환 케이스 (arcStations 부재/빈 / currentStation 부재 / station 미매칭)
    ['arcStations=undefined', { arcStations: undefined, currentStationName: '용마산', target: target7 }, null],
    ['arcStations=null', { arcStations: null, currentStationName: '용마산', target: target7 }, null],
    ['arcStations=[]', { arcStations: [], currentStationName: '용마산', target: target7 }, null],
    ['currentStationName=null', { arcStations: arcOf7Line, currentStationName: null, target: target7 }, null],
    [
      'device station이 arc에 없음 (다른 라인 / 미확정)',
      { arcStations: arcOf7Line, currentStationName: '강남', target: target7 },
      null,
    ],
    [
      'target station이 arc에 없음',
      { arcStations: arcOf7Line, currentStationName: '용마산', target: { stationName: '강남', line: '7호선' } },
      null,
    ],
    // 수치 케이스 (device <-> target hop 산출)
    ['hops 0 (device == target)', { arcStations: arcOf7Line, currentStationName: '중곡', target: target7 }, 0],
    ['hops 1 (용마산 → 중곡)', { arcStations: arcOf7Line, currentStationName: '용마산', target: target7 }, 1],
    ['hops 3 (면목 → 중곡)', { arcStations: arcOf7Line, currentStationName: '면목', target: target7 }, 3],
    ['hops -1 (군자 → 중곡, ahead)', { arcStations: arcOf7Line, currentStationName: '군자', target: target7 }, -1],
    [
      'hops -7 (군자 → 먹골, 멀리 ahead)',
      { arcStations: arcOf7Line, currentStationName: '군자', target: { stationName: '먹골', line: '7' } },
      -7,
    ],
  ])('%s', (_, input, expected) => {
    expect(computeDeviceHopsBehindTarget(input)).toBe(expected);
  });
});
