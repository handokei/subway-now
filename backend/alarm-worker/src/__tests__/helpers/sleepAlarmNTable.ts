/**
 * #3100 PR-1 — 취침 알람 "N역 전부터" table. 같은 table을 상수 원본(MAX=3)과 mock(MAX=4) 두 번 돌린다
 * (`scheduled.sleepAlarmN.test.ts` / `scheduled.sleepAlarmN.max4.test.ts`) — 칸 수·점프·접미사가
 * 특정 최대치에 묶여 있으면 MAX=4 실행에서 red가 된다.
 *
 * 기대값은 구현과 독립인 오라클이다: 설정 -> 발사해야 하는 남은 정거장 집합 S, leg의 중간역 수 m
 * -> cron 전진 tick j(0-base)의 남은 수는 m - j. S와 [MIN, m]의 교집합 칸만 정확히 1회 발사.
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
  advance,
  captureFetch,
  companions,
  fakeD1,
  getApnsConfig,
  makeEnv,
  makeLock,
  makeTrip,
  sleepAlerts,
  walkTrip,
  wp,
} from './sleepAlarmHarness';

interface FireEvent {
  /** 발사 tick(0-base) — 그 tick의 남은 수는 m - tick. */
  tick: number;
  remaining: number;
  /** 이번 발사가 새로 선점하는 칸(내림차순). 매 역/기본은 [remaining] 하나. */
  cells: number[];
}

interface ConfigCase {
  name: string;
  /** register에서 정규화된 저장 형태(없으면 기본값). */
  sleepAlarm: Trip['sleepAlarm'];
  /** 오라클 — 발사해야 하는 남은 정거장 집합. */
  stops: number[];
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: Math.max(to - from + 1, 0) }, (_, i) => from + i);

/** 설정 4종 — 기본 / 매 역 MAX / 선택 {MAX} / 선택 {MAX, MIN}. */
function configCases(): ConfigCase[] {
  return [
    { name: '기본', sleepAlarm: undefined, stops: [MIN] },
    { name: `매 역 ${MAX}`, sleepAlarm: { mode: 'every', stops: [MAX] }, stops: range(MIN, MAX) },
    { name: `선택 {${MAX}}`, sleepAlarm: { mode: 'selected', stops: [MAX] }, stops: [MAX] },
    { name: `선택 {${MAX},${MIN}}`, sleepAlarm: { mode: 'selected', stops: [MAX, MIN] }, stops: [MAX, MIN] },
  ];
}

/** leg 중간역 수 m 후보 — 0(1정거장 leg), 1, MAX-1, MAX, MAX+1. */
function intermediateCounts(): number[] {
  return [...new Set([0, 1, MAX - 1, MAX, MAX + 1])].sort((a, b) => a - b);
}

const STATION_POOL = ['면목', '사가정', '용마산', '중곡', '군자', '어린이대공원'];
const TARGET = '건대입구';

function legWaypoints(m: number, targetKind: 'transfer' | 'destination'): Waypoint[] {
  const intermediates = m === 0 ? [] : STATION_POOL.slice(-m);
  return [...intermediates.map((s) => wp(s, 'intermediate')), wp(TARGET, targetKind)];
}

const suffix = (r: number) => (r === MIN ? '' : `:s${r}`);

/**
 * 오라클. 매 역/기본: 칸 N은 tick(남은 수 == N)에서 정확히 그 칸만(`to <= N < from`). 선택(#3100 v2.1): 칸 N은 타깃당 1회,
 * 남은 수 r <= N 이 된 첫 tick에 울리고, 한 tick에 새로 충족된 칸은 한 알람에 모두 기록(문구는 실제 남은 수 r).
 */
function expectedFires(cfg: ConfigCase, m: number): FireEvent[] {
  if (cfg.sleepAlarm?.mode !== 'selected') {
    return cfg.stops
      .filter((r) => r >= MIN && r <= m)
      .sort((a, b) => b - a)
      .map((r) => ({ tick: m - r, remaining: r, cells: [r] }));
  }
  const claimed = new Set<number>();
  const events: FireEvent[] = [];
  for (let tick = 0; tick < m; tick++) {
    const r = m - tick;
    const cells = cfg.stops.filter((n) => r <= n && !claimed.has(n));
    if (cells.length === 0) continue;
    cells.forEach((n) => claimed.add(n));
    events.push({ tick, remaining: r, cells });
  }
  return events;
}

/** 평가마다 후보 칸(이미 선점한 칸 포함) 수만큼 get — 선택 모드. 매 역/기본은 발사 칸당 1. */
function expectedGets(cfg: ConfigCase, m: number): number {
  if (cfg.sleepAlarm?.mode !== 'selected') return expectedFires(cfg, m).length;
  return range(MIN, m).reduce((sum, r) => sum + cfg.stops.filter((n) => r <= n).length, 0);
}

const isRecorded = (e: FireEvent): boolean => e.remaining !== MIN || e.cells.some((c) => c !== e.remaining);

export function registerSleepAlarmNTable(): void {
  describe(`#3100 N역 전 cron table (MAX=${MAX})`, () => {
    for (const cfg of configCases()) {
      for (const m of intermediateCounts()) {
        for (const targetKind of ['transfer', 'destination'] as const) {
          const waypoints = legWaypoints(m, targetKind);
          const events = expectedFires(cfg, m);
          const fires = events.map((e) => e.remaining);

          it(`취침 ON / ${cfg.name} / 중간역 ${m}개 / ${targetKind}: 남은 수 ${JSON.stringify(fires)} 각 1회 (tick별 누적)`, async () => {
            const d1 = fakeD1();
            const trip = makeTrip(waypoints, { sleepAlarm: cfg.sleepAlarm });
            const { perTick, calls, kv, spy } = await walkTrip(trip, d1.db);

            // tick j에서 남은 수 = m - j -> 그 tick에 발사되는 칸.
            perTick.forEach((t, j) => {
              const expected = events.filter((e) => e.tick <= j).map((e) => sleepAlarmCollapseId(TOKEN, TARGET, e.remaining));
              expect(t.alarmsSoFar).toEqual(expected);
            });

            // 문구: 기본 칸(MIN)은 early 문구(#3100 사용자 결정 2026-10-26), 비기본 칸은 실제 남은 수를 담는다 + companion 칸 구분.
            const alerts = sleepAlerts(calls);
            expect(alerts).toHaveLength(fires.length);
            const comps = companions(calls);
            expect(comps).toHaveLength(fires.length);
            fires.forEach((r, idx) => {
              const aps = alerts[idx].body.aps as { alert: { title: string; body: string } };
              const data = comps[idx].body.data as Record<string, unknown>;
              if (r === MIN) {
                expect(data).not.toHaveProperty('remainingStops');
                expect(aps.alert.body).toBe(
                  targetKind === 'transfer'
                    ? `다음 역 ${TARGET}에서 환승하세요!`
                    : `다음 역 ${TARGET}에서 하차하세요!`,
                );
              } else {
                expect(data.remainingStops).toBe(r);
                expect(aps.alert.title).toContain(`${r}정거장`);
                expect(aps.alert.title).toContain(TARGET);
              }
            });

            // dedup 키: 칸마다 별도(MIN은 접미사 없음). KV: 평가마다 후보 칸 수만큼 get, 새로 선점한 칸 수만큼 put.
            const claimed = events.flatMap((e) => e.cells);
            const stored = [...kv.store.keys()].filter((k) => k.startsWith(ALARM_KEY_PREFIX)).sort();
            expect(stored).toEqual(claimed.map((c) => `${ALARM_KEY_PREFIX}${TOKEN}:${TARGET}${suffix(c)}`).sort());
            expect(spy.alarmKeyCalls()).toEqual({ get: expectedGets(cfg, m), put: claimed.length, delete: 0 });

            // D1: 비기본 칸(또는 선택 모드 clamp 발사 = 칸 != 남은 수)만 'sleep-alarm' 행 1건씩. 기본 칸/기본 설정은 0.
            const sleepRows = d1.rows.filter((row) => row.kind === 'sleep-alarm');
            const recorded = events.filter(isRecorded);
            expect(sleepRows.map((row) => row.meta?.remaining)).toEqual(recorded.map((e) => e.remaining));
            sleepRows.forEach((row, idx) => {
              expect(row.meta).toMatchObject({ outcome: 'fired', targetStation: TARGET });
              if (recorded[idx].cells.some((c) => c !== recorded[idx].remaining)) {
                expect(row.meta?.cells).toEqual(recorded[idx].cells);
              }
            });
          });
        }
      }

      it(`취침 OFF / ${cfg.name}: 설정을 무시하고 준비 알람이 기본 칸(MIN)에서만 1회`, async () => {
        const waypoints = legWaypoints(MAX, 'destination');
        const trip = makeTrip(waypoints, { sleepModeEnabled: false, sleepAlarm: cfg.sleepAlarm });
        const { calls } = await walkTrip(trip);
        const alerts = calls.filter((c) => c.pushType === 'alert' && /^(alarm|prepare)-/.test(c.collapseId ?? ''));
        expect(alerts.map((c) => c.collapseId)).toEqual([prepareAlarmCollapseId(TOKEN, TARGET)]);
        expect(companions(calls)).toEqual([]);
      });
    }
  });

  describe(`#3100 N역 전 — lock 게이트 / 중복 / catch-up 상호 dedup (MAX=${MAX})`, () => {
    const every: SleepAlarmConfig = { mode: 'every', stops: [MAX] };
    const chain = () => legWaypoints(MAX, 'destination'); // 중간역 MAX개 + 타깃

    /** 같은 leg를 cron처럼 한 칸씩 전진시키며 completeWaypointAdvance를 호출한다. */
    async function advanceChain(kv: InMemoryKV, fetchImpl: typeof fetch, overrides: Partial<Trip> = {}) {
      const wps = chain();
      for (let j = 0; j < wps.length - 1; j++) {
        await advance(makeTrip(wps.slice(j), { sleepAlarm: every, ...overrides }), kv, fetchImpl, { now: NOW + j });
      }
    }

    it('환승을 낀 다중 leg를 끝까지 걷는다: 칸은 타깃이 속한 leg 안에서만 센다 (leg 경계에서 끊김)', async () => {
      const names = (prefix: string) => range(MIN, MAX).map((n) => wp(`${prefix}${n}`, 'intermediate'));
      const wps = [...names('a'), wp('T1', 'transfer'), ...names('b'), wp('T2', 'destination', '2')];
      const kv = new InMemoryKV(() => NOW);
      const f = captureFetch();
      for (let j = 0; j < wps.length; j++) {
        if (wps[j].kind !== 'intermediate') continue; // 타깃 자신은 전진 대상 아님
        await advance(makeTrip(wps.slice(j), { sleepAlarm: every }), kv, f.fetchImpl, { now: NOW + j });
      }
      const perLeg = range(MIN, MAX).reverse();
      const expected = ['T1', 'T2'].flatMap((target) => perLeg.map((r) => sleepAlarmCollapseId(TOKEN, target, r)));
      expect(sleepAlerts(f.calls).map((c) => c.collapseId)).toEqual(expected);
    });

    it('lock 없음 / lock 만료: 어떤 칸도 안 울린다 (#3140)', async () => {
      for (const boardingLock of [undefined, { ...makeLock(chain().map((w) => w.stationName)), expiresAt: NOW - 1 }]) {
        const kv = new InMemoryKV(() => NOW);
        const f = captureFetch();
        await advanceChain(kv, f.fetchImpl, { boardingLock });
        expect(sleepAlerts(f.calls)).toEqual([]);
      }
    });

    it('대조(lock 있음): 매 역 MAX가 MAX..MIN 칸을 각각 1회, 칸마다 다른 collapse-id', async () => {
      const kv = new InMemoryKV(() => NOW);
      const f = captureFetch();
      await advanceChain(kv, f.fetchImpl);
      const expected = range(MIN, MAX).reverse().map((r) => sleepAlarmCollapseId(TOKEN, TARGET, r));
      expect(sleepAlerts(f.calls).map((c) => c.collapseId)).toEqual(expected);
      expect(new Set(expected).size).toBe(MAX);
    });

    it('같은 leg를 두 번 재평가해도 (타깃, 남은 수)별 중복 0, 다른 남은 수는 별도 1회씩', async () => {
      const kv = new InMemoryKV(() => NOW);
      const f = captureFetch();
      await advanceChain(kv, f.fetchImpl);
      await advanceChain(kv, f.fetchImpl);
      expect(sleepAlerts(f.calls)).toHaveLength(MAX);
    });

    it('cron이 먼저 발사한 뒤 sync catch-up이 같은 (타깃, MIN) 쌍을 평가해도 추가 발사 0', async () => {
      const kv = new InMemoryKV(() => NOW);
      const f = captureFetch();
      await advanceChain(kv, f.fetchImpl);
      const wps = chain();
      await fireSyncConsumedPrecedingAlarms(
        makeEnv(kv),
        makeTrip(wps, { sleepAlarm: every }),
        wps.length - 1,
        { apnsConfig: getApnsConfig(), apnsHosts: APNS_HOSTS, fetchImpl: f.fetchImpl } as SyncSkippedFireDeps,
        NOW,
        () => undefined,
        () => 'p',
      );
      expect(sleepAlerts(f.calls)).toHaveLength(MAX);
    });

    it('전송 실패(5xx) 시 기본 칸과 비기본 칸 모두 같은 재시도 큐 항목을 만든다 (payload shape 현행 동일, 칸 필드 없음)', async () => {
      const retryShape = async (waypoints: Waypoint[]) => {
        const kv = new InMemoryKV(() => NOW);
        const pending = new InMemoryKV(() => NOW);
        await advance(makeTrip(waypoints, { sleepAlarm: every }), kv, captureFetch(500).fetchImpl, { pending });
        const entries = [...pending.store.values()].map((e) => JSON.parse(e.value) as { payload: Record<string, unknown> });
        return entries.map((e) => Object.keys(e.payload).sort());
      };
      const wps = chain();
      const nonDefault = await retryShape(wps); // 비기본 칸(MAX)
      const defaultSlot = await retryShape(wps.slice(-2)); // 기본 칸(MIN): [직전역, 타깃]
      expect(nonDefault).toHaveLength(2); // alert + companion
      expect(defaultSlot).toHaveLength(2);
      expect(nonDefault).toEqual(defaultSlot);
    });

    it('주 채널 실패 시 그 칸의 dedup만 rollback (다른 칸 키는 유지)', async () => {
      const kv = new InMemoryKV(() => NOW);
      const ok = captureFetch();
      const wps = chain();
      await advance(makeTrip(wps, { sleepAlarm: every }), kv, ok.fetchImpl); // 칸 MAX 성공
      const fail = captureFetch(500);
      await advance(makeTrip(wps.slice(1), { sleepAlarm: every }), kv, fail.fetchImpl); // 칸 MAX-1 실패
      expect(kv.store.has(sleepAlarmFireKey(TOKEN, TARGET, MAX))).toBe(true);
      expect(kv.store.has(sleepAlarmFireKey(TOKEN, TARGET, MAX - 1))).toBe(false);
    });
  });
}
