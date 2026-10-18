/**
 * #3057 — 도착 확정 신호 주입 helper (합성 보강, 실측 캡처는 조작하지 않는다).
 *
 * 프롬프트는 도착 확정({arvlCd 1,2} 또는 position trainSttus 1,2)일 때만 발사된다. 9/13 실캡처
 * (`capture_20260913T1249Z_b00dd879`)는 환승역 도착 직전(8371 arvlCd=3 전역출발)에서 끝나
 * **도착 확정 순간이 캡처에 없다** — 옛 게이트(approaching {3,5})는 그 직전 관측으로 발사했지만
 * 새 게이트는 발사하지 않는다(사용자 결정, 이슈 #3057).
 *
 * 사슬을 닫기 위해 **캡처가 직전까지 보여준 그 열차**(환승역 arrivals에서 arvlCd=3인 leg-2 열차)가
 * 환승역에 도착(trainSttus=1)했다는 position 신호만 self-poll에 주입한다. 열차/방향/노선은 전부
 * 캡처 파싱에서 파생한다(하드코딩 없음) — 주입값은 캡처의 실제 관측(arvlCd=3 열차)에서 유도된다.
 */
import { ARRIVAL_CODE, TRAIN_STATUS } from '../../alarm';
import { matchLine } from '../../lineAlias';
import type { ReplayFixture } from '../../replayFixture';
import { SeoulArrivalClient } from '../../seoul';
import { writeSelfPollPosition } from '../../selfPollPosition';
import type { Env } from '../../types';
import { makeCaptureFetch } from './replayHarness';

export async function injectPrevDepartedTrainArrived(
  fixture: ReplayFixture,
  env: Env,
  tick: number,
  transferStation: string,
  leg2Line: string,
): Promise<void> {
  const seoul = new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => tick,
    fetchImpl: makeCaptureFetch(fixture, () => tick, { ceilingMs: tick + 60_000 }),
  });
  const arrivals = await seoul.fetchArrivals(transferStation);
  const approaching = arrivals.filter(
    (entry) => entry.arvlCd === ARRIVAL_CODE.PREV_DEPARTED && matchLine(entry.subwayNm, leg2Line),
  );
  if (approaching.length === 0) return;
  await writeSelfPollPosition(
    env.TRIPS,
    leg2Line,
    approaching.map((entry) => ({
      trainCode: entry.trainCode,
      stationName: transferStation,
      trainSttus: TRAIN_STATUS.ARRIVED,
      isUp: entry.isUp,
      recptnMs: tick,
    })),
    tick,
  );
}
