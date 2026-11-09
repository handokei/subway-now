/**
 * #3055 / #3300 옵션 D PR-5 후속 — 위치 따라잡기(`catchUpToLockTrain`, claim = `advanceHead{count}`)가 선점한 구간의 발사도 "retry once"를 받는다.
 *
 * 입력은 10/31 09:57:45 tick 실측(불변 fixture, `catchupReplay20261031`). 선점 applied 뒤 건너뛴 역 알림(`fireSyncSkippedStationPasses`)과
 * 준비 알람(`fireSyncConsumedPrecedingAlarms` -> `maybeFireSleepAlarm`)이 transient(5xx)로 실패하면, 그 구간은 이미 셀에서 소비됐으므로 다음 tick이
 * 같은 발사를 다시 만들 수 없다. 5가지 계약(재시도 성공 / 성공시 0 / 재시도 실패시 3번째 0 / 400 재시도 0 / lock@N control)을 발사 지점마다 고정한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sleepAlarmCollapseId, stationNotifCollapseId } from '../collapseId';
import type { Trip } from '../types';
import { catchupRows, replayTick, seedTrip, TOKEN } from './helpers/catchupReplay20261031';
import type { CapturedPush } from './helpers/replayHarness';
import { useApnsHarness } from './helpers/sleepAlarmHarness';

useApnsHarness();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface Site {
  name: string;
  /** 이 발사 지점의 push만 고른다. */
  isTarget: (push: CapturedPush) => boolean;
  trip: () => Trip;
  dedupStamped?: string[];
  /** D1 cron-catchup 행으로 재시도 여부(meta.retry)를 볼 수 있는 발사인지. */
  hasCatchupRow: boolean;
}

/** 강남구청 따라잡기 소비 뒤 학동이 목적지인 짧은 노선 — 강남구청 소비가 학동(목적지) 1역 전 알람을 만든다. */
const sleepTrip = (): Trip => {
  const trip = seedTrip('강남구청', { sleep: true });
  const [head, next] = trip.waypoints;
  return { ...trip, waypoints: [head, { ...next, kind: 'destination' }] };
};

const SITES: Site[] = [
  {
    name: 'catchUpToLockTrain -> 건너뛴 역 매역 alert (fireSyncSkippedStationPasses)',
    isTarget: (p) => p.headers.pushType === 'alert' && p.headers.collapseId === stationNotifCollapseId(TOKEN, '강남구청'),
    trip: () => seedTrip('청담'),
    hasCatchupRow: true,
  },
  {
    name: 'catchUpToLockTrain -> 소비 구간 취침 알람 alert (fireSyncConsumedPrecedingAlarms)',
    isTarget: (p) => p.headers.pushType === 'alert' && p.headers.collapseId === sleepAlarmCollapseId(TOKEN, '학동'),
    trip: sleepTrip,
    dedupStamped: ['강남구청'],
    hasCatchupRow: false,
  },
  {
    name: 'catchUpToLockTrain -> 소비 구간 취침 알람 companion',
    isTarget: (p) => (p.body.data as { kind?: string } | undefined)?.kind === 'sleep-alarm-companion',
    trip: sleepTrip,
    dedupStamped: ['강남구청'],
    hasCatchupRow: false,
  },
];

async function exercise(site: Site, cells: 'progress@1' | 'lock@1', statuses: number[]) {
  let seen = 0;
  const r = await replayTick(site.trip(), {
    cells,
    ...(site.dedupStamped ? { dedupStamped: site.dedupStamped } : {}),
    apnsStatusFor: (push) => (site.isTarget(push) ? (statuses[seen++] ?? 200) : 200),
  });
  const attempts = r.cycle.pushes.filter(site.isTarget).length;
  const retried = r.events.filter((e) => e.kind === 'cron-fire-attempt' && e.meta.path === 'cron-catchup' && e.meta.retry === true).length;
  return { attempts, retried, rows: catchupRows(r) };
}

describe.each(SITES)('#3055 PR-5 후속 retry once — $name', (site) => {
  it('progress@1: 첫 전송 500 -> 같은 tick 재전송 1회 (총 2회)', async () => {
    const r = await exercise(site, 'progress@1', [500, 200]);
    expect(r.attempts).toBe(2);
    if (site.hasCatchupRow) expect(r.retried).toBe(1);
  });

  it('progress@1: 첫 전송 성공 -> 재전송 0 (1회)', async () => {
    const r = await exercise(site, 'progress@1', [200]);
    expect(r.attempts).toBe(1);
    expect(r.retried).toBe(0);
  });

  it('progress@1: 재전송도 500 -> 3번째 시도 없음 (2회)', async () => {
    const r = await exercise(site, 'progress@1', [500, 500, 500, 500]);
    expect(r.attempts).toBe(2);
  });

  it('progress@1: 영구 오류(400)는 재시도하지 않는다 (1회)', async () => {
    const r = await exercise(site, 'progress@1', [400, 200]);
    expect(r.attempts).toBe(1);
    expect(r.retried).toBe(0);
  });

  it('control(lock@1, legacy): 첫 전송 500이어도 같은 tick 재전송 없음 (1회)', async () => {
    const r = await exercise(site, 'lock@1', [500, 200]);
    expect(r.attempts).toBe(1);
    expect(r.retried).toBe(0);
  });
});
