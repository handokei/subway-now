/**
 * #3100 v2 / v2.1 — "선택한 역에서만": 칸 N은 타깃당 1회, 남은 수 <= N 이 된 첫 평가에서 울린다.
 * 한 평가에서 여러 칸이 새로 충족되면 알람 1회 + 칸 전부 기록. 칸 dedup은 칸 키(`:s{N}`) 단위이고, 주 채널 실패 시 그 평가가
 * 선점한 칸 키를 모두 되돌린다. 기본값/매 역은 단일 키 흐름(get/put 1쌍) 그대로 — table 테스트가 고정한다.
 */
import { describe, expect, it } from 'vitest';
import {
  SLEEP_ALARM_MAX_STOPS_BEFORE as MAX,
  SLEEP_ALARM_MIN_STOPS_BEFORE as MIN,
  type SleepAlarmConfig,
} from '../../../../src/shared/constants/sleepAlarm';
import { sleepAlarmCollapseId } from '../collapseId';
import { fireSyncConsumedPrecedingAlarms, sleepAlarmFireKey, type SyncSkippedFireDeps } from '../scheduled';
import { InMemoryKV } from './inMemoryKv';
import {
  APNS_HOSTS,
  NOW,
  TOKEN,
  advance,
  captureFetch,
  companions,
  fakeD1,
  getApnsConfig,
  makeEnv,
  makeTrip,
  sleepAlerts,
  spyKv,
  useApnsHarness,
  wp,
} from './helpers/sleepAlarmHarness';

useApnsHarness();

const TARGET = '뚝섬';
const selected = (...stops: number[]): SleepAlarmConfig => ({ mode: 'selected', stops });
const SHORT_LEG = [wp('성수', 'intermediate'), wp(TARGET, 'destination')]; // 남은 1
const LONG_LEG = [wp('a', 'intermediate'), wp('b', 'intermediate'), wp('c', 'intermediate'), wp(TARGET, 'destination')];

describe('maybeFireSleepAlarm — 선택 모드 칸 dedup (#3100 v2.1)', () => {
  it('짧은 leg {MAX}: 첫 평가(남은 MIN)에서 1회, 문구는 실제 남은 수, 칸 MAX 키 선점, D1 clamp 행(cells)', async () => {
    const kv = new InMemoryKV(() => NOW);
    const spy = spyKv(kv);
    const f = captureFetch();
    const d1 = fakeD1();
    await advance(makeTrip(SHORT_LEG, { sleepAlarm: selected(MAX) }), kv, f.fetchImpl, { db: d1.db });

    expect(sleepAlerts(f.calls).map((c) => c.collapseId)).toEqual([sleepAlarmCollapseId(TOKEN, TARGET, MIN)]);
    expect(companions(f.calls)[0].body.data).not.toHaveProperty('remainingStops'); // 실제 남은 수 = MIN
    expect(kv.store.has(sleepAlarmFireKey(TOKEN, TARGET, MAX))).toBe(true);
    expect(kv.store.has(sleepAlarmFireKey(TOKEN, TARGET, MIN))).toBe(false);
    expect(spy.alarmKeyCalls()).toEqual({ get: 1, put: 1, delete: 0 });
    expect(d1.rows.filter((r) => r.kind === 'sleep-alarm').map((r) => r.meta)).toEqual([
      expect.objectContaining({ outcome: 'fired', remaining: MIN, cells: [MAX] }),
    ]);
  });

  it('두 칸 동시 충족 {MAX,MIN} 짧은 leg: 알람 1회·get 2·put 2·D1 1행(cells 둘 다)', async () => {
    const kv = new InMemoryKV(() => NOW);
    const spy = spyKv(kv);
    const f = captureFetch();
    const d1 = fakeD1();
    await advance(makeTrip(SHORT_LEG, { sleepAlarm: selected(MAX, MIN) }), kv, f.fetchImpl, { db: d1.db });

    expect(sleepAlerts(f.calls)).toHaveLength(1);
    expect(spy.alarmKeyCalls()).toEqual({ get: 2, put: 2, delete: 0 });
    expect(kv.store.has(sleepAlarmFireKey(TOKEN, TARGET, MAX))).toBe(true);
    expect(kv.store.has(sleepAlarmFireKey(TOKEN, TARGET, MIN))).toBe(true);
    expect(d1.rows.filter((r) => r.kind === 'sleep-alarm').map((r) => r.meta?.cells)).toEqual([[MAX, MIN]]);
  });

  it('칸 MAX가 이미 기록된 뒤 더 가까운 평가(남은 MAX-1)는 skip — get 1, put 0, 알람 0', async () => {
    const kv = new InMemoryKV(() => NOW);
    await kv.put(sleepAlarmFireKey(TOKEN, TARGET, MAX), '1');
    const spy = spyKv(kv);
    const f = captureFetch();
    await advance(makeTrip(LONG_LEG.slice(1), { sleepAlarm: selected(MAX) }), kv, f.fetchImpl); // 남은 MAX-1
    expect(sleepAlerts(f.calls)).toEqual([]);
    expect(spy.alarmKeyCalls()).toEqual({ get: 1, put: 0, delete: 0 });
  });

  it('{MAX,MIN} 긴 leg: MAX 기록 후 남은 MIN 평가는 새 칸 MIN 하나만 선점해 1회 (get 2, put 1)', async () => {
    const kv = new InMemoryKV(() => NOW);
    await kv.put(sleepAlarmFireKey(TOKEN, TARGET, MAX), '1');
    const spy = spyKv(kv);
    const f = captureFetch();
    await advance(makeTrip(LONG_LEG.slice(-2), { sleepAlarm: selected(MAX, MIN) }), kv, f.fetchImpl); // 남은 MIN
    expect(sleepAlerts(f.calls).map((c) => c.collapseId)).toEqual([sleepAlarmCollapseId(TOKEN, TARGET, MIN)]);
    expect(spy.alarmKeyCalls()).toEqual({ get: 2, put: 1, delete: 0 });
  });

  it('긴 leg {MAX}를 끝까지 걸어도 정확히 1회 (칸 get을 생략하면 다음 역에서 재발사 — revert-red 대상)', async () => {
    const kv = new InMemoryKV(() => NOW);
    const f = captureFetch();
    for (let j = 0; j < LONG_LEG.length - 1; j++) {
      await advance(makeTrip(LONG_LEG.slice(j), { sleepAlarm: selected(MAX) }), kv, f.fetchImpl, { now: NOW + j });
    }
    expect(sleepAlerts(f.calls).map((c) => c.collapseId)).toEqual([sleepAlarmCollapseId(TOKEN, TARGET, MAX)]);
  });

  it('주 채널 실패(5xx): 이번 평가가 선점한 칸 키를 전부 delete + D1 rolled-back 행 (get 2, put 2, delete 2)', async () => {
    const kv = new InMemoryKV(() => NOW);
    const spy = spyKv(kv);
    const d1 = fakeD1();
    await advance(makeTrip(SHORT_LEG, { sleepAlarm: selected(MAX, MIN) }), kv, captureFetch(500).fetchImpl, { db: d1.db });
    expect(spy.alarmKeyCalls()).toEqual({ get: 2, put: 2, delete: 2 });
    expect([...kv.store.keys()].filter((k) => k.startsWith('alarmFireKey:'))).toEqual([]);
    expect(d1.rows.filter((r) => r.kind === 'sleep-alarm').map((r) => r.meta)).toEqual([
      expect.objectContaining({ outcome: 'rolled-back', remaining: MIN, cells: [MAX, MIN] }),
    ]);
  });

  it('rollback 뒤 같은 평가를 다시 하면 재발사된다 (문서화된 한계: clamp 칸은 실패한 알람의 재시도로 수용)', async () => {
    const kv = new InMemoryKV(() => NOW);
    await advance(makeTrip(SHORT_LEG, { sleepAlarm: selected(MAX) }), kv, captureFetch(500).fetchImpl);
    const f = captureFetch();
    await advance(makeTrip(SHORT_LEG, { sleepAlarm: selected(MAX) }), kv, f.fetchImpl);
    expect(sleepAlerts(f.calls)).toHaveLength(1);
  });

  it('거부 — lock 없음: 선택 모드도 알람 0, KV 접근 0 (lock 없음 = 알림 없음)', async () => {
    const kv = new InMemoryKV(() => NOW);
    const spy = spyKv(kv);
    const f = captureFetch();
    await advance(makeTrip(SHORT_LEG, { sleepAlarm: selected(MAX), boardingLock: undefined }), kv, f.fetchImpl);
    expect(sleepAlerts(f.calls)).toEqual([]);
    expect(spy.alarmKeyCalls()).toEqual({ get: 0, put: 0, delete: 0 });
  });

  it('거부 — 매 역 MAX 짧은 leg는 기존 동작: 남은 MIN 칸만 (키 s{MAX} 없음, get 1·put 1)', async () => {
    const kv = new InMemoryKV(() => NOW);
    const spy = spyKv(kv);
    const f = captureFetch();
    await advance(makeTrip(SHORT_LEG, { sleepAlarm: { mode: 'every', stops: [MAX] } }), kv, f.fetchImpl);
    expect(sleepAlerts(f.calls)).toHaveLength(1);
    expect(kv.store.has(sleepAlarmFireKey(TOKEN, TARGET, MAX))).toBe(false);
    expect(spy.alarmKeyCalls()).toEqual({ get: 1, put: 1, delete: 0 });
  });
});

describe('fireSyncConsumedPrecedingAlarms — 선택 모드 clamp는 준비 알람 경로를 새로 타지 않는다 (#3100 v2.1 item 4)', () => {
  async function runSync(sleepAlarm: SleepAlarmConfig | undefined) {
    const d1 = fakeD1();
    const f = captureFetch();
    await fireSyncConsumedPrecedingAlarms(
      makeEnv(new InMemoryKV(() => NOW), d1.db),
      makeTrip(SHORT_LEG, { sleepAlarm }),
      MIN,
      { apnsConfig: getApnsConfig(), apnsHosts: APNS_HOSTS, fetchImpl: f.fetchImpl } as SyncSkippedFireDeps,
      NOW,
      () => undefined,
      () => 'p',
    );
    return { d1, f };
  }

  it('선택 {MAX} 짧은 leg(clamp, 남은 MIN): 취침 알람 1회 + prepare-alarm D1 행 0', async () => {
    const { d1, f } = await runSync(selected(MAX));
    expect(sleepAlerts(f.calls)).toHaveLength(1);
    expect(d1.rows.filter((r) => r.kind === 'prepare-alarm')).toEqual([]);
    expect(d1.rows.filter((r) => r.kind === 'sleep-alarm').map((r) => r.meta?.cells)).toEqual([[MAX]]);
  });

  it('대조 — 기본값(칸 = MIN 하나): 기존대로 prepare-alarm skipped/sleep 행 1건 (동작 불변)', async () => {
    const { d1 } = await runSync(undefined);
    expect(d1.rows.filter((r) => r.kind === 'prepare-alarm').map((r) => r.meta)).toEqual([
      expect.objectContaining({ outcome: 'skipped', reason: 'sleep' }),
    ]);
  });
});
