/**
 * #2629 PR-3 — 2026-10-31 09:57:45 tick 단독 replay: lock 열차 위치 따라잡기.
 *
 * 운영 상태 그대로(D1 1926 = head 강남구청, lock 7077) + 실캡처 1793408265543(7077 학동 sttus=1, recptn 09:57:13)을
 * 한 tick만 재생한다. 따라잡기가 없으면 이 tick은 강남구청만 소비하고 학동 알림은 한 cycle 뒤로 밀린다.
 * 입력은 #3282가 만든 불변 fixture(`replay_20261031_reregister_storm/caps`)를 그대로 쓴다 — 통과시키려 조정 금지.
 * assert는 실제로 나간 APNs 요청(종류·tick·횟수) 기준이다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sleepAlarmCollapseId } from '../collapseId';
import { useApnsHarness } from './helpers/sleepAlarmHarness';
import {
  alertStations,
  catchupRows,
  replayTick,
  seedTrip,
  SEGMENT_STATIONS,
  TOKEN,
} from './helpers/catchupReplay20261031';

useApnsHarness();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('#2629 10/31 09:57:45 tick 단독 — 학동은 이 tick에 나간다', () => {
  it('head 강남구청(이미 09:55:45에 발사·dedup) + 열차 학동 sttus1: 학동 alert 1건 + 강남구청 중복 push 0', async () => {
    const r = await replayTick(seedTrip('강남구청'), { dedupStamped: ['강남구청'] });
    expect(alertStations(r)).toEqual(['학동']);
  });

  it('실패 사유 단언: 따라잡기 소비 역(강남구청) 1행이 path=cron-catchup, outcome=skipped-reason(dedup)으로 남는다', async () => {
    const r = await replayTick(seedTrip('강남구청'), { dedupStamped: ['강남구청'] });
    expect(catchupRows(r)).toEqual([{ station: '강남구청', outcome: 'skipped-reason' }]);
  });

  it('취침 변형: 같은 tick에 논현 1역 전 알람(alarm.wav)이 정확히 1건', async () => {
    const r = await replayTick(seedTrip('강남구청', { sleep: true }), { dedupStamped: ['강남구청'] });
    const alarmId = sleepAlarmCollapseId(TOKEN, '논현');
    expect(r.cycle.pushes.filter((p) => p.headers.collapseId === alarmId)).toHaveLength(1);
  });

  it('2역 뒤처진 head(청담): 발사 상한 1 — 가장 최근 역(강남구청)만 발사, 청담은 skipped-by-shift, 이어서 학동 정규 발사', async () => {
    const r = await replayTick(seedTrip('청담'));
    expect({ alerts: alertStations(r), catchup: catchupRows(r) }).toEqual({
      alerts: ['강남구청', '학동'],
      catchup: [
        { station: '강남구청', outcome: 'sent' },
        { station: '청담', outcome: 'skipped-by-shift' },
      ],
    });
  });
});

describe('#2629 거부 — 게이트 하나만 깨면 현행(1 tick 1 waypoint)으로 남는다', () => {
  it('G1: lock trainCode가 캡처의 열차와 다르면 따라잡지 않는다 (학동 alert 0, cron-catchup 행 0)', async () => {
    const r = await replayTick(seedTrip('강남구청', { trainCode: '9999' }));
    expect({ alerts: alertStations(r), catchup: catchupRows(r) }).toEqual({ alerts: [], catchup: [] });
  });

  it('G2: segment가 반대 방향이면(isUp 불일치) 따라잡지 않는다 — 학동 alert 0, cron-catchup 행 0', async () => {
    const r = await replayTick(seedTrip('강남구청', { segment: [...SEGMENT_STATIONS].reverse() }));
    expect({ alerts: alertStations(r).includes('학동'), catchup: catchupRows(r) }).toEqual({ alerts: false, catchup: [] });
  });
});

describe('#2629 부가 단언', () => {
  it('취침 변형: 알림 정책으로 mute돼도 따라잡기 소비 역은 감시 마커 1행(skipped-reason)을 남긴다', async () => {
    const r = await replayTick(seedTrip('강남구청', { sleep: true }));
    expect(catchupRows(r)).toEqual([{ station: '강남구청', outcome: 'skipped-reason' }]);
  });

  it('mid-cycle: 이 tick에 전진한 trip의 새 head(논현)가 mid pass 후보 스냅샷에 들어간다', async () => {
    const r = await replayTick(seedTrip('강남구청'), { dedupStamped: ['강남구청'] });
    expect(r.cycle.stats.midCycleSnapshot.map((s) => s.waypoint.stationName)).toEqual(['논현']);
  });
});
