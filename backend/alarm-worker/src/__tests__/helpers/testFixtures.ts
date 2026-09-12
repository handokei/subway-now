// 공용 테스트 fixture — scheduled.test.ts / autoLock.test.ts 등이 공유한다.
import { SeoulArrivalClient, type ArrivalEntry } from '../../seoul';
import type { Trip } from '../../types';

export const FIXTURE_NOW = 1_700_000_000_000;

function buildArrivalList(arrivals: ArrivalEntry[]): unknown {
  return {
    realtimeArrivalList: arrivals.map((a) => ({
      barvlDt: String(a.arrivalSeconds),
      recptnDt: '',
      updnLine: a.isUp ? '상행' : '하행',
      trainLineNm: a.destination,
      btrainNo: a.trainCode,
      subwayNm: a.subwayNm,
      arvlCd: a.arvlCd,
    })),
  };
}

export function makeSeoulFixture(arrivals: ArrivalEntry[]): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => FIXTURE_NOW,
    fetchImpl: (async () =>
      new Response(JSON.stringify(buildArrivalList(arrivals)), {
        status: 200,
      })) as unknown as typeof fetch,
  });
}

/**
 * 역 이름별로 다른 arrivals를 반환하는 SeoulArrivalClient fixture.
 * RC1 confidence gate 테스트처럼 next-waypoint / origin 역 각각 다른 결과가 필요할 때 사용.
 * 맵에 없는 역명은 빈 배열을 반환한다.
 */
export function makeSeoulFixtureByStation(
  stationMap: Record<string, ArrivalEntry[]>,
): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => FIXTURE_NOW,
    fetchImpl: ((url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      // URL 형식: http://host/api/subway/key/json/realtimeStationArrival/0/10/{stationName}
      const match = urlStr.match(/realtimeStationArrival\/\d+\/\d+\/([^/?]+)/);
      const stationName = match ? decodeURIComponent(match[1]) : '';
      const arrivals = stationMap[stationName] ?? [];
      return Promise.resolve(
        new Response(JSON.stringify(buildArrivalList(arrivals)), { status: 200 }),
      );
    }) as unknown as typeof fetch,
  });
}

export function makeTripFixture(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'tok-auto',
    route: { type: 'direct', line: '2', stops: 5 },
    destination: 'dst',
    waypoints: [
      { stationName: '역삼', line: '2', kind: 'intermediate' },
      { stationName: '선릉', line: '2', kind: 'destination' },
    ],
    expiresAt: FIXTURE_NOW + 60 * 60_000,
    createdAt: FIXTURE_NOW,
    alarmAtEpochMs: FIXTURE_NOW + 60_000,
    ...overrides,
  };
}
