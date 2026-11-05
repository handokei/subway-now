/**
 * #3221 — 기기 여정 LA 필드(`computeJourneyLaFields`)와 backend LA 필드
 * (`computeLegProgressContext` / `computeNextStopContext`)의 의미 일치(parity).
 *
 * 같은 여정을 한 역씩 진행시키며(backend는 지난 waypoint를 pop, 기기는 현재역을 전진) 두 쪽이 낸
 * 진행 막대 분모·다음 역·환승 후 노선/방면이 매 단계 같아야 한다. 어느 한쪽이 산식을 바꾸면 여기서 깨진다.
 * 입력 route: trip 179 용마산(7)->건대입구->뚝섬(2), trip 180 성수(2)->건대입구->용마산(7) (D1 trip_metrics / RCA §0)
 * + 환승 2회 이상 multi-transfer 1건. etaMinutes는 backend가 서버 시각표로 따로 합산하므로 비교 대상이 아니다.
 */
import i18next from 'i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { computeLegProgressContext, computeNextStopContext } from '../tripMultiHop';
import type { Trip, Waypoint } from '../types';
import { computeJourneyLaFields } from '../../../../src/features/route/utils/journeyLaFields';
import { routeToWaypoints } from '../../../../src/features/route/utils/routeWaypoints';
import { findRoutes, findStationByNameAndLine } from '../../../../src/shared/utils/stationRoute';
import type { LineNumber, Station } from '../../../../src/shared/types/station';
import ko from '../../../../src/shared/i18n/locales/ko.json';

// device logger는 Sentry breadcrumb(@sentry/react-native)을 import해 node 환경에서 파싱이 안 된다. 로직과 무관 -> no-op.
vi.mock('../../../../src/shared/utils/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

interface Case {
  name: string;
  routeType: 'transfer' | 'multi-transfer';
  origin: [string, LineNumber];
  dest: [string, LineNumber];
}
const CASES: Case[] = [
  { name: 'trip 179 용마산(7)->건대입구->뚝섬(2)', routeType: 'transfer', origin: ['용마산', '7'], dest: ['뚝섬', '2'] },
  { name: 'trip 180 성수(2)->건대입구->용마산(7)', routeType: 'transfer', origin: ['성수', '2'], dest: ['용마산', '7'] },
  { name: 'multi-transfer 인천(1)->수서(3)', routeType: 'multi-transfer', origin: ['인천', '1'], dest: ['수서', '3'] },
];

function station(name: string, line: LineNumber): Station {
  const found = findStationByNameAndLine(name, line);
  if (!found) throw new Error(`station missing: ${name} ${line}`);
  return found;
}

// device LA 문자열(노선명·역명)은 i18n으로 만들어진다. backend는 한국어 정식명을 쓰므로 ko로 맞춰 비교한다.
beforeAll(async () => {
  await i18next.init({ lng: 'ko', resources: { ko: { translation: ko } } });
});

describe('device computeJourneyLaFields <-> backend computeLegProgressContext/computeNextStopContext parity (#3221)', () => {
  for (const c of CASES) {
    it(`${c.name}: 출발부터 도착 직전까지 매 단계 진행 막대 분모·다음 역·환승 후 노선/방면이 같다`, () => {
      const origin = station(...c.origin);
      const destination = station(...c.dest);
      const candidate = findRoutes(origin.id, destination.id).find((r) => r.route.type === c.routeType);
      if (!candidate) throw new Error('route missing');
      const { route } = candidate;
      const registered = routeToWaypoints(route, destination.name, origin) as Waypoint[];

      let compared = 0;
      // k = 지나간 waypoint 수. k=0 -> 현재역은 출발역. k>0 -> 마지막으로 지난 waypoint의 역(환승역이면 갈아탄 노선 쪽).
      for (let k = 0; k < registered.length; k++) {
        const remaining = registered.slice(k);
        let current: Station;
        if (k === 0) {
          current = origin;
        } else {
          const passed = registered[k - 1];
          const [{ line: nextLine }] = remaining;
          const line = (passed.kind === 'transfer' ? nextLine : passed.line) as LineNumber;
          current = station(passed.stationName, line);
        }
        const trip = { route, waypoints: remaining } as unknown as Trip;
        const be = { ...computeLegProgressContext(trip), ...computeNextStopContext(trip) };
        const { etaMinutes: _eta, ...dev } = computeJourneyLaFields(route, current, destination);
        expect(dev, `${c.name} k=${k} current=${current.name}(${current.line})`).toEqual(be);
        compared += 1;
      }
      expect(compared).toBe(registered.length);
    });
  }
});
