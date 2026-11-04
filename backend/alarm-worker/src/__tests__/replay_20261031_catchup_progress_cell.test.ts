/**
 * #3055 / #3300 옵션 D PR-4b — 위치 따라잡기(`catchUpToLockTrain`)도 진행 셀에서 head를 먼저 선점한다(claim-then-fire).
 *
 * 입력은 `replay_20261031_position_catchup.test.ts`와 같은 불변 실측(10/31 09:57:45 tick, head 강남구청 + 열차 7077 학동 sttus=1).
 * progress@1에서도 같은 발사(학동 alert 1건, 취침 알람 1건, 감시 마커 행)가 나가고, 소비한 구간이 셀에 영속된다:
 *  - head 강남구청 -> 강남구청을 따라잡아 소비 -> 이 tick의 정규 평가가 학동을 소비 -> 셀 head는 논현.
 *  - 이미 다른 경로가 같은 구간을 소비한 셀(head 논현)이면 낡은 스냅샷(head 강남구청)의 따라잡기는 noop — 발사 0.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sleepAlarmCollapseId } from '../collapseId';
import { lockEpochKey } from '../progressOps';
import { fetchCells, runProgressOp } from '../tripDoCells';
import { waypointSignatureKey } from '../trips';
import type { Env } from '../types';
import { alertStations, catchupRows, replayTick, seedTrip, TOKEN } from './helpers/catchupReplay20261031';
import { useApnsHarness } from './helpers/sleepAlarmHarness';

useApnsHarness();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Run = Awaited<ReturnType<typeof replayTick>>;
const cellEnv = (r: Run): Pick<Env, 'TRIPS' | 'TRIP_DO'> => ({ TRIPS: undefined as unknown as KVNamespace, TRIP_DO: r.cells!.doNs.ns });

describe('#3055 PR-4b 10/31 09:57:45 — progress@1 위치 따라잡기', () => {
  it('학동 alert 1건 + 강남구청 중복 push 0, 감시 마커 1행 — lock@1과 같은 발사', async () => {
    const control = await replayTick(seedTrip('강남구청'), { dedupStamped: ['강남구청'], cells: 'lock@1' });
    const r = await replayTick(seedTrip('강남구청'), { dedupStamped: ['강남구청'], cells: 'progress@1' });
    expect(alertStations(r)).toEqual(['학동']);
    expect(alertStations(r)).toEqual(alertStations(control));
    expect(catchupRows(r)).toEqual([{ station: '강남구청', outcome: 'skipped-reason' }]);
  });

  it('소비한 구간이 셀에 영속된다: 셀 waypoints = [논현]', async () => {
    const r = await replayTick(seedTrip('강남구청'), { dedupStamped: ['강남구청'], cells: 'progress@1' });
    const { progress } = await fetchCells(cellEnv(r), TOKEN);
    expect(progress?.waypoints.map((w) => w.stationName)).toEqual(['논현']);
  });

  it('취침 변형: 논현 1역 전 알람(alarm.wav)이 정확히 1건', async () => {
    const r = await replayTick(seedTrip('강남구청', { sleep: true }), { dedupStamped: ['강남구청'], cells: 'progress@1' });
    const alarmId = sleepAlarmCollapseId(TOKEN, '논현');
    expect(r.cycle.pushes.filter((p) => p.headers.collapseId === alarmId)).toHaveLength(1);
  });

  it('2역 뒤처진 head(청담): 가장 최근 역(강남구청)만 발사, 청담은 skipped-by-shift — 구간 소비가 한 op로 선점된다', async () => {
    const r = await replayTick(seedTrip('청담'), { cells: 'progress@1' });
    expect({ alerts: alertStations(r), catchup: catchupRows(r) }).toEqual({
      alerts: ['강남구청', '학동'],
      catchup: [
        { station: '강남구청', outcome: 'sent' },
        { station: '청담', outcome: 'skipped-by-shift' },
      ],
    });
  });

  it('G1(거부): lock trainCode가 캡처 열차와 다르면 따라잡지 않는다 — 셀 head는 그대로 강남구청', async () => {
    const r = await replayTick(seedTrip('강남구청', { trainCode: '9999' }), { cells: 'progress@1' });
    expect({ alerts: alertStations(r), catchup: catchupRows(r) }).toEqual({ alerts: [], catchup: [] });
    const { progress } = await fetchCells(cellEnv(r), TOKEN);
    expect(progress?.waypoints[0].stationName).toBe('강남구청');
  });
});

describe('#3055 PR-4b — 낡은 스냅샷 따라잡기는 선점에서 물러선다', () => {
  it('같은 구간을 다른 경로가 먼저 소비하면(셀 head 앞섬) cron은 소비·발사하지 않는다', async () => {
    const trip = seedTrip('강남구청');
    const r = await replayTick(trip, {
      dedupStamped: ['강남구청'],
      cells: 'progress@1',
      beforeFirstTick: async (env) => {
        // 다른 경로(sync 등)가 강남구청·학동을 이미 소비한 셀. 이 tick의 overlay는 셀 head(논현)를 본다.
        await runProgressOp(
          env,
          TOKEN,
          { type: 'seedProgressFromKv', source: 'test', epoch: 1, snapshot: {
              createdAt: trip.createdAt,
              waypoints: trip.waypoints,
              routeWaypoints: trip.waypoints,
              // 시드 시점에 lock이 있으면 진행 중인 epoch(재고정 판정 대상 아님) — 운영 시드(`seedCells`)와 같다.
              lockEpochKey: lockEpochKey(trip.boardingLock!),
            },
          },
          trip.createdAt,
        );
        await runProgressOp(
          env,
          TOKEN,
          { type: 'advanceHead', source: 'test-sync', expectedHeadKey: waypointSignatureKey(trip.waypoints[0]), count: 2 },
          trip.createdAt,
        );
      },
    });
    expect(catchupRows(r)).toEqual([]);
    expect(alertStations(r)).not.toContain('강남구청');
    expect(alertStations(r)).not.toContain('학동');
  });
});

describe('#3055 PR-4b — lock epoch 표식(lockEpochKey)', () => {
  it('표식 없는 셀 + 재고정 대상이 아닌 lock(head가 노선 시작)이면 재고정 없이 tick 끝에 표식이 stamp된다', async () => {
    const trip = seedTrip('중곡');
    const r = await replayTick(trip, {
      cells: 'progress@1',
      beforeFirstTick: async (env) => {
        await runProgressOp(
          env,
          TOKEN,
          { type: 'seedProgressFromKv', source: 'test', epoch: 1, snapshot: { createdAt: trip.createdAt, waypoints: trip.waypoints, routeWaypoints: trip.waypoints } },
          trip.createdAt,
        );
      },
    });
    expect(r.events.filter((e) => e.kind === 'lock-reanchor')).toEqual([]);
    const { progress } = await fetchCells(cellEnv(r), TOKEN);
    expect(progress?.lockEpochKey).toBe(lockEpochKey(trip.boardingLock!));
  });
});

