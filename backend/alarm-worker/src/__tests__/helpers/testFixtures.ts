// 공용 테스트 fixture — scheduled.test.ts / autoLock.test.ts 등이 공유한다.
import { SeoulArrivalClient, type ArrivalEntry } from '../../seoul';
import type { Trip } from '../../types';

export const FIXTURE_NOW = 1_700_000_000_000;

export function makeSeoulFixture(arrivals: ArrivalEntry[]): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => FIXTURE_NOW,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          realtimeArrivalList: arrivals.map((a) => ({
            barvlDt: String(a.arrivalSeconds),
            recptnDt: '',
            updnLine: a.isUp ? '상행' : '하행',
            trainLineNm: a.destination,
            btrainNo: a.trainCode,
            subwayNm: a.subwayNm,
            arvlCd: a.arvlCd,
          })),
        }),
        { status: 200 },
      )) as unknown as typeof fetch,
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
