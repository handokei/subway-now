/**
 * #3100 PR-2 — 취침 알람 "N역 전부터" sync 경로 table. 같은 table을 상수 원본(MAX=3)과 mock(MAX=4) 두 번 돌린다
 * (`index.sleepAlarmSyncN.test.ts` / `index.sleepAlarmSyncN.max4.test.ts`).
 *
 * 기대값은 구현과 독립인 오라클이다. leg의 중간역 수 m, 한 번에 소비한 개수 k(1..m+1):
 *   소비 후 남은 정거장 r = m - k + 1 (k = m + 1 이면 타깃까지 소비 -> 대상 없음)
 *   설정 칸 집합 S 가 [r, m] 안에 하나라도 있으면 r 로 정확히 1회(catch-up), 없으면 0회.
 */
import { describe, expect, it } from 'vitest';
import {
  SLEEP_ALARM_MAX_STOPS_BEFORE as MAX,
  SLEEP_ALARM_MIN_STOPS_BEFORE as MIN,
  type SleepAlarmConfig,
} from '../../../../../src/shared/constants/sleepAlarm';
import { prepareAlarmCollapseId, sleepAlarmCollapseId } from '../../collapseId';
import { fireSyncConsumedPrecedingAlarms, sleepAlarmFireKey, type SyncSkippedFireDeps } from '../../scheduled';
import type { Trip, Waypoint } from '../../types';
import { InMemoryKV } from '../inMemoryKv';
import {
  ALARM_KEY_PREFIX,
  APNS_HOSTS,
  NOW,
  TOKEN,
  captureFetch,
  getApnsConfig,
  makeEnv,
  makeTrip,
  sleepAlerts,
  alarmAlerts,
  companions,
  spyKv,
  wp,
} from './sleepAlarmHarness';
import {
  FF_CHAIN_NAMES,
  SYNC_TOKEN,
  TRAIN_DEPARTED,
  lockActiveTrip,
  syncObserved,
  syncPromote,
  type SyncHttpResult,
} from './sleepAlarmSyncHttp';

interface ConfigCase {
  name: string;
  sleepAlarm: Trip['sleepAlarm'];
  /** 오라클 — 설정이 가리키는 남은 정거장 집합. */
  stops: number[];
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: Math.max(to - from + 1, 0) }, (_, i) => from + i);

/** 설정 4종 — 기본 / 매 역 MAX / 선택 {MAX} / 선택 {MAX, MIN}. */
export function syncConfigCases(): ConfigCase[] {
  return [
    { name: '기본', sleepAlarm: undefined, stops: [MIN] },
    { name: `매 역 ${MAX}`, sleepAlarm: { mode: 'every', stops: [MAX] }, stops: range(MIN, MAX) },
    { name: `선택 {${MAX}}`, sleepAlarm: { mode: 'selected', stops: [MAX] }, stops: [MAX] },
    { name: `선택 {${MAX},${MIN}}`, sleepAlarm: { mode: 'selected', stops: [MAX, MIN] }, stops: [MAX, MIN] },
  ];
}

/**
 * 소비 구간 뒤 남은 수 r 와 설정 칸 집합으로 발사할 남은 수를 구한다(없으면 undefined).
 * `legIntermediates` = 타깃이 속한 leg의 중간역 수, `remaining` = 마지막 소비 역에서 타깃까지 남은 정거장.
 */
export function expectedFire(stops: number[], legIntermediates: number, remaining: number): number | undefined {
  if (remaining < MIN) return undefined;
  return stops.some((stop) => stop >= remaining && stop <= legIntermediates) ? remaining : undefined;
}

const POOL = ['상봉', '면목', '사가정', '용마산', '중곡', '군자', '어린이대공원'];
const TARGET = '건대입구';

/** m개 중간역 + 타깃. */
function legWaypoints(m: number, kind: 'transfer' | 'destination'): Waypoint[] {
  return [...POOL.slice(-m).map((s) => wp(s, 'intermediate')), wp(TARGET, kind)];
}

const suffix = (r: number) => (r === MIN ? '' : `:s${r}`);
const sleepOffTrip = (waypoints: Waypoint[], sleepAlarm: Trip['sleepAlarm']) =>
  makeTrip(waypoints, { sleepModeEnabled: false, sleepAlarm });

function assertSleepFire(r: SyncHttpResult, fire: number | undefined, source: string): void {
  expect(r.status).toBe(200);
  expect(r.alarms.map((a) => a.collapseId)).toEqual(fire === undefined ? [] : [sleepAlarmCollapseId(SYNC_TOKEN, TARGET, fire)]);
  expect(r.alarmKeyCalls).toEqual(fire === undefined ? { get: 0, put: 0, delete: 0 } : { get: 1, put: 1, delete: 0 });
  if (fire === undefined) {
    expect(r.sleepRows).toEqual([]);
    return;
  }
  const data = (r.companions[0].body.data ?? {}) as Record<string, unknown>;
  if (fire === MIN) {
    expect(data).not.toHaveProperty('remainingStops');
    expect(r.sleepRows).toEqual([]);
  } else {
    expect(data.remainingStops).toBe(fire);
    expect(r.sleepRows.map((row) => row.meta)).toEqual([expect.objectContaining({ remaining: fire, outcome: 'fired', source })]);
  }
}

export function registerSleepAlarmSyncTable(): void {
  describe(`#3100 PR-2 sync 단위(fireSyncConsumedPrecedingAlarms) table (MAX=${MAX})`, () => {
    for (const cfg of syncConfigCases()) {
      for (const m of [...new Set([MIN, MAX - 1, MAX, MAX + 1])].filter((n) => n >= MIN)) {
        for (const kind of ['transfer', 'destination'] as const) {
          for (const k of range(MIN, m + 1)) {
            const fire = expectedFire(cfg.stops, m, m - k + 1);
            it(`취침 ON / ${cfg.name} / 중간역 ${m}개 / ${kind} / ${k}개 소비: ${fire === undefined ? '0회' : `남은 ${fire} 1회`}`, async () => {
              const waypoints = legWaypoints(m, kind);
              const kv = new InMemoryKV(() => NOW);
              const spy = spyKv(kv);
              const f = captureFetch();
              await fireSyncConsumedPrecedingAlarms(
                makeEnv(kv),
                makeTrip(waypoints, { sleepAlarm: cfg.sleepAlarm }),
                k,
                { apnsConfig: getApnsConfig(), apnsHosts: APNS_HOSTS, fetchImpl: f.fetchImpl } as SyncSkippedFireDeps,
                NOW,
                () => undefined,
                () => 'p',
              );
              const alerts = sleepAlerts(f.calls);
              expect(alerts.map((a) => a.collapseId)).toEqual(fire === undefined ? [] : [sleepAlarmCollapseId(TOKEN, TARGET, fire)]);
              if (fire === undefined) {
                expect(spy.alarmKeyCalls()).toEqual({ get: 0, put: 0, delete: 0 });
                return;
              }
              expect(spy.alarmKeyCalls()).toEqual({ get: 1, put: 1, delete: 0 });
              expect([...kv.store.keys()].filter((key) => key.startsWith(ALARM_KEY_PREFIX))).toEqual([
                `${ALARM_KEY_PREFIX}${TOKEN}:${TARGET}${suffix(fire)}`,
              ]);
              const data = companions(f.calls)[0].body.data as Record<string, unknown>;
              if (fire === MIN) expect(data).not.toHaveProperty('remainingStops');
              else {
                expect(data.remainingStops).toBe(fire);
                const aps = alerts[0].body.aps as { alert: { body: string } };
                expect(aps.alert.body).toContain(`${fire}정거장`);
              }
            });
          }
        }
      }

      it(`취침 OFF / ${cfg.name}: 설정을 무시하고 준비 알람이 기본 칸(바로 앞 역 소비)에서만 1회, 취침 알람 0`, async () => {
        const waypoints = legWaypoints(MAX, 'destination');
        for (const k of range(MIN, MAX + 1)) {
          const f = captureFetch();
          await fireSyncConsumedPrecedingAlarms(
            makeEnv(new InMemoryKV(() => NOW)),
            sleepOffTrip(waypoints, cfg.sleepAlarm),
            k,
            { apnsConfig: getApnsConfig(), apnsHosts: APNS_HOSTS, fetchImpl: f.fetchImpl } as SyncSkippedFireDeps,
            NOW,
            () => undefined,
            () => 'p',
          );
          expect(sleepAlerts(f.calls)).toEqual([]);
          expect(alarmAlerts(f.calls).map((a) => a.collapseId)).toEqual(
            k === MAX ? [prepareAlarmCollapseId(TOKEN, TARGET)] : [],
          );
        }
      });
    }

    it('같은 (타깃, 남은 수) 키를 cron이 이미 잡았으면 sync catch-up은 추가 발사 0, 다른 남은 수는 별도 발사', async () => {
      const waypoints = legWaypoints(MAX, 'destination');
      const sleepAlarm: SleepAlarmConfig = { mode: 'every', stops: [MAX] };
      const kv = new InMemoryKV(() => NOW);
      await kv.put(sleepAlarmFireKey(TOKEN, TARGET, MAX - 1), '1');
      const run = async (k: number) => {
        const f = captureFetch();
        await fireSyncConsumedPrecedingAlarms(
          makeEnv(kv),
          makeTrip(waypoints, { sleepAlarm }),
          k,
          { apnsConfig: getApnsConfig(), apnsHosts: APNS_HOSTS, fetchImpl: f.fetchImpl } as SyncSkippedFireDeps,
          NOW,
          () => undefined,
          () => 'p',
        );
        return sleepAlerts(f.calls).map((a) => a.collapseId);
      };
      expect(await run(2)).toEqual([]); // 남은 MAX-1 키가 이미 있다
      expect(await run(1)).toEqual([sleepAlarmCollapseId(TOKEN, TARGET, MAX)]); // 남은 MAX는 별도 1회
    });
  });

  describe(`#3100 PR-2 순수 점프(/boarding-lock/sync) HTTP table (MAX=${MAX})`, () => {
    const m = MAX + 1;
    for (const cfg of syncConfigCases()) {
      for (const k of range(MIN, m + 1)) {
        const fire = expectedFire(cfg.stops, m, m - k + 1);
        it(`취침 ON / ${cfg.name} / ${k}개 점프: ${fire === undefined ? '0회' : `남은 ${fire} 1회`}`, async () => {
          const waypoints = legWaypoints(m, 'destination');
          const r = await syncObserved(lockActiveTrip(waypoints, { sleepAlarm: cfg.sleepAlarm }), waypoints[k - 1].stationName);
          assertSleepFire(r, fire, 'sync-advance');
        });
      }
    }

    it.each(syncConfigCases())('취침 OFF / $name: 설정을 무시하고 바로 앞 역 소비에서만 준비 알람 1회', async ({ sleepAlarm }) => {
      const waypoints = legWaypoints(m, 'destination');
      for (const k of range(MIN, m)) {
        const r = await syncObserved(lockActiveTrip(waypoints, { sleepModeEnabled: false, sleepAlarm }), waypoints[k - 1].stationName);
        expect(r.alarms.map((a) => a.collapseId)).toEqual(k === m ? [prepareAlarmCollapseId(SYNC_TOKEN, TARGET)] : []);
        expect(r.sleepRows).toEqual([]);
      }
    });

    it('lock 없음: 설정이 있어도 어떤 칸도 안 울린다 (lock 없음 = 알림 없음)', async () => {
      const waypoints = legWaypoints(m, 'destination');
      const sleepAlarm: SleepAlarmConfig = { mode: 'every', stops: [MAX] };
      const r = await syncObserved(lockActiveTrip(waypoints, { sleepAlarm, boardingLock: undefined }), waypoints[MIN].stationName);
      expect(r.alarms).toEqual([]);
    });
  });

  describe(`#3100 PR-2 승격 fast-forward(/boarding-lock/sync trainCode) HTTP table (MAX=${MAX})`, () => {
    const m = FF_CHAIN_NAMES.length - 1;
    for (const cfg of syncConfigCases()) {
      FF_CHAIN_NAMES.slice(0, m).forEach((departed, p) => {
        const skip = p + 1;
        const fire = expectedFire(cfg.stops, m, m - skip + 1);
        it(`${cfg.name} / 열차가 ${departed} 출발 후 승격(skip ${skip}): ${fire === undefined ? '0회' : `남은 ${fire} 1회`}`, async () => {
          const r = await syncPromote('destination', { sleepAlarm: cfg.sleepAlarm }, { stationName: departed, trainSttus: TRAIN_DEPARTED });
          assertSleepFire(r, fire, 'sync-ff');
        });
      });
    }

    it('거부 — 열차가 타깃까지 지났으면(blockedAt) 설정과 무관하게 0', async () => {
      const sleepAlarm: SleepAlarmConfig = { mode: 'every', stops: [MAX] };
      const r = await syncPromote('destination', { sleepAlarm }, { stationName: TARGET, trainSttus: TRAIN_DEPARTED });
      expect(r.alarms).toEqual([]);
    });
  });

  // 혼합 분기: 환승이 소비 구간에 끼면 관측역(intermediate)은 cron에 위임되고, 환승 뒤 leg의 앞쪽 중간역은 슬라이스만 된다.
  describe(`#3100 PR-2 혼합 분기(환승 소비) HTTP table (MAX=${MAX})`, () => {
    const LEG2 = ['뚝섬유원지', '청담', '강남구청'];
    const LEG2_DEST = '학동';
    const legIntermediates = LEG2.length;
    const observedLeg2 = LEG2[LEG2.length - 1];
    /** 관측역(마지막 중간역)은 cron 위임 — 그 직전 역(청담)까지 슬라이스되어 마지막 소비가 된다. */
    const lastConsumedLeg2Index = LEG2.length - 2;
    const remainingAtLastConsumed = legIntermediates - lastConsumedLeg2Index;
    const sameLine = [
      wp('어린이대공원', 'intermediate'),
      wp('건대입구', 'transfer'),
      ...LEG2.map((n) => wp(n, 'intermediate')),
      wp(LEG2_DEST, 'destination'),
    ];
    const lineChange = [
      wp('어린이대공원', 'intermediate'),
      wp('건대입구', 'transfer'),
      ...['성수', '뚝섬', '한양대'].map((n) => wp(n, 'intermediate', '2')),
      wp('왕십리', 'destination', '2'),
    ];

    for (const cfg of syncConfigCases()) {
      const fire = expectedFire(cfg.stops, legIntermediates, remainingAtLastConsumed);
      it(`같은 호선 오라벨 환승(lock 유지) / ${cfg.name}: ${fire === undefined ? '0회' : `남은 ${fire} 1회`}`, async () => {
        const r = await syncObserved(lockActiveTrip(sameLine, { sleepAlarm: cfg.sleepAlarm }), observedLeg2);
        expect(r.stored?.waypoints[0]?.stationName).toBe(observedLeg2); // 전제: 환승이 소비됐다
        expect(r.stored?.boardingLock).toBeDefined();
        expect(r.alarms.map((a) => a.collapseId)).toEqual(
          fire === undefined ? [] : [sleepAlarmCollapseId(SYNC_TOKEN, LEG2_DEST, fire)],
        );
        if (fire !== undefined && fire !== MIN) {
          expect(r.sleepRows.map((row) => row.meta)).toEqual([expect.objectContaining({ remaining: fire, source: 'sync-mixed' })]);
        }
      });

      it(`노선 변경 환승(lock 해제) / ${cfg.name}: 0회`, async () => {
        const r = await syncObserved(lockActiveTrip(lineChange, { sleepAlarm: cfg.sleepAlarm }), '한양대');
        expect(r.stored?.waypoints[0]?.stationName).toBe('한양대');
        expect(r.stored?.boardingLock).toBeUndefined();
        expect(r.alarms).toEqual([]);
      });
    }

    // leg 출발역은 칸이 아니다(v1.3): 환승역 자신을 관측해 소비해도 다음 leg의 "환승역 -> 타깃" 쌍을 칸으로 세지 않는다.
    it.each(syncConfigCases())('환승역 자신을 관측(마지막 소비 = 환승역) / $name: 다음 leg 알람 0', async ({ sleepAlarm }) => {
      // 환승역 -> 타깃 거리가 MAX 이하인 짧은 leg-2 (출발역을 칸으로 세면 걸릴 수 있는 배치).
      const shortLeg2 = [
        wp('어린이대공원', 'intermediate'),
        wp('건대입구', 'transfer'),
        wp(LEG2[0], 'intermediate'),
        wp(LEG2[1], 'intermediate'),
        wp(LEG2_DEST, 'destination'),
      ];
      const r = await syncObserved(lockActiveTrip(shortLeg2, { sleepAlarm }), '건대입구');
      expect(r.stored?.waypoints[0]?.stationName).toBe(LEG2[0]); // 전제: 환승이 소비됐다
      expect(r.stored?.boardingLock).toBeDefined(); // lock 유지 -> 게이트는 열려 있다
      expect(r.alarms).toEqual([]);
      expect(r.alarmKeyCalls).toEqual({ get: 0, put: 0, delete: 0 });
    });

    it('취침 OFF + 설정 있음: 혼합 분기에서도 설정을 무시한다 (비인접 쌍으로 준비 알람 0)', async () => {
      const sleepAlarm: SleepAlarmConfig = { mode: 'every', stops: [MAX] };
      const r = await syncObserved(lockActiveTrip(sameLine, { sleepModeEnabled: false, sleepAlarm }), observedLeg2);
      expect(r.alarms).toEqual([]);
    });
  });
}
