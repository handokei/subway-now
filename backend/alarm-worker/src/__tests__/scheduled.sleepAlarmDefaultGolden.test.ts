/**
 * #3100 PR-1 — 기본값(설정 없음 / `{선택한 역, [1역 전]}`) 취침 알람 golden.
 *
 * 변경 전 코드(origin/dev)에서 green으로 고정한다. 이후 N역 전 일반화(PR-1 구현)가 기본값의
 * payload / dedup 키 / collapse-id / 문구 / companion wire / KV 호출 수 / D1 행을 **바이트 단위로**
 * 바꾸지 않았음을 같은 단언이 증명한다. 기대값은 실측 출력을 그대로 박은 것이며 통과시키려
 * 조정하지 않는다.
 */
import { describe, expect, it } from 'vitest';
import { sleepAlarmCollapseId } from '../collapseId';
import { fireSyncConsumedPrecedingAlarms, sleepAlarmFireKey, type SyncSkippedFireDeps } from '../scheduled';
import type { Trip, Waypoint } from '../types';
import { InMemoryKV } from './inMemoryKv';
import {
  NOW,
  TOKEN,
  advance,
  APNS_HOSTS,
  captureFetch,
  companions,
  fakeD1,
  getApnsConfig,
  makeEnv,
  makeTrip,
  sleepAlerts as alarmAlerts,
  spyKv,
  useApnsHarness,
  wp,
} from './helpers/sleepAlarmHarness';

useApnsHarness();

describe('#3100 golden — 기본값 키 문자열', () => {
  it('dedup 키 / collapse-id는 (token, 타깃)만으로 만들어진다 (remaining 접미사 없음)', () => {
    expect(sleepAlarmFireKey('tok', '건대입구')).toBe('alarmFireKey:tok:건대입구');
    expect(sleepAlarmCollapseId('tok', '건대입구')).toBe('alarm-tok-건대입구');
  });

  it('긴 역명도 64바이트로 절단되는 기존 규칙 그대로', () => {
    const id = sleepAlarmCollapseId('0123456789abcdefXYZ', '남한산성입구(성남법원.검찰청)');
    expect(new TextEncoder().encode(id).length).toBeLessThanOrEqual(64);
    expect(id.startsWith('alarm-0123456789abcdef-')).toBe(true);
  });
});

describe('#3100 golden — 기본값 push 바이트 (alert + companion)', () => {
  const CASES: { name: string; waypoints: Waypoint[]; locale: Trip['locale']; title: string; body: string; kind: string }[] = [
    { name: '하차 ko', waypoints: [wp('군자', 'intermediate'), wp('어린이대공원', 'destination')], locale: 'ko', title: '도착 임박', body: '곧 어린이대공원에 도착합니다. 하차 준비하세요!', kind: 'destination' },
    { name: '환승 ko', waypoints: [wp('군자', 'intermediate'), wp('건대입구', 'transfer')], locale: 'ko', title: '환승 임박', body: '곧 건대입구에 도착합니다. 환승 준비하세요!', kind: 'transfer' },
    { name: '하차 en', waypoints: [wp('군자', 'intermediate'), wp('어린이대공원', 'destination')], locale: 'en', title: 'Arrival imminent', body: 'Arriving at 어린이대공원 — exit soon!', kind: 'destination' },
    { name: '환승 ja', waypoints: [wp('군자', 'intermediate'), wp('건대입구', 'transfer')], locale: 'ja', title: 'まもなく乗換', body: 'まもなく건대입구に到着します。乗換の準備をしてください!', kind: 'transfer' },
    { name: '하차 zh', waypoints: [wp('군자', 'intermediate'), wp('어린이대공원', 'destination')], locale: 'zh', title: '即将到达', body: '即将到达어린이대공원。请准备下车!', kind: 'destination' },
  ];

  for (const c of CASES) {
    it(`${c.name}: alert 헤더/본문과 companion 본문이 바이트 동일`, async () => {
      const kv = new InMemoryKV(() => NOW);
      const f = captureFetch();
      const trip = makeTrip(c.waypoints, { locale: c.locale });
      const target = c.waypoints[1];
      await advance(trip, kv, f.fetchImpl);

      const [alert] = alarmAlerts(f.calls);
      expect(alarmAlerts(f.calls)).toHaveLength(1);
      expect(alert.collapseId).toBe(`alarm-${TOKEN}-${target.stationName}`);
      expect(alert.priority).toBe('10');
      expect(alert.threadId).toBe(TOKEN);
      expect(alert.rawBody).toBe(
        JSON.stringify({
          aps: {
            alert: { title: c.title, body: c.body },
            sound: 'alarm.wav',
            'interruption-level': 'time-sensitive',
          },
          data: { pushId: 'g-1' },
          body: { pushId: 'g-1' },
        }),
      );

      const [companion] = companions(f.calls);
      expect(companions(f.calls)).toHaveLength(1);
      expect(companion.priority).toBe('5');
      expect(companion.rawBody).toBe(
        JSON.stringify({
          aps: { 'content-available': 1 },
          data: {
            kind: 'sleep-alarm-companion',
            originStation: '군자',
            targetKind: c.kind,
            nextLine: '7',
            nextStation: target.stationName,
            tripToken: TOKEN,
            pushId: 'g-2',
            sentAt: NOW,
            title: c.title,
            body: c.body,
          },
        }),
      );
      // 기본값 companion wire에는 칸 구분 필드가 없다.
      expect(companion.rawBody).not.toContain('remainingStops');
    });
  }
});

describe('#3100 golden — 기본값 KV 호출 수 / D1 행', () => {
  const waypoints = [wp('군자', 'intermediate'), wp('어린이대공원', 'destination')];

  it('발사 1회: 알람 키 get 1 + put 1 + delete 0 (전체 KV도 변경 전과 동일)', async () => {
    const kv = new InMemoryKV(() => NOW);
    const spy = spyKv(kv);
    const f = captureFetch();
    await advance(makeTrip(waypoints), kv, f.fetchImpl);
    expect(spy.alarmKeyCalls()).toEqual({ get: 1, put: 1, delete: 0 });
    expect(spy.totals()).toEqual(KV_TOTALS_FIRE);
  });

  it('같은 쌍 재평가(dedup): 알람 키 get 1 + put 0 + delete 0, push 추가 0', async () => {
    const kv = new InMemoryKV(() => NOW);
    const f = captureFetch();
    await advance(makeTrip(waypoints), kv, f.fetchImpl);
    const spy = spyKv(kv);
    const before = f.calls.length;
    await advance(makeTrip(waypoints), kv, f.fetchImpl);
    expect(spy.alarmKeyCalls()).toEqual({ get: 1, put: 0, delete: 0 });
    expect(f.calls.length).toBe(before);
  });

  it('주 채널 실패(rollback): 알람 키 get 1 + put 1 + delete 1', async () => {
    const kv = new InMemoryKV(() => NOW);
    const spy = spyKv(kv);
    const f = captureFetch(500);
    await advance(makeTrip(waypoints), kv, f.fetchImpl);
    expect(spy.alarmKeyCalls()).toEqual({ get: 1, put: 1, delete: 1 });
    expect(kv.store.has(sleepAlarmFireKey(TOKEN, '어린이대공원'))).toBe(false);
  });

  it('취침 OFF: 알람 키 접근 0 (준비 알람 키만)', async () => {
    const kv = new InMemoryKV(() => NOW);
    const spy = spyKv(kv);
    const f = captureFetch();
    await advance(makeTrip(waypoints, { sleepModeEnabled: false }), kv, f.fetchImpl);
    expect(spy.alarmKeyCalls()).toEqual({ get: 0, put: 0, delete: 0 });
  });

  it('sync catch-up 1회: 알람 키 get 1 + put 1', async () => {
    const kv = new InMemoryKV(() => NOW);
    const spy = spyKv(kv);
    const f = captureFetch();
    const chain = [wp('중곡', 'intermediate'), wp('군자', 'intermediate'), wp('어린이대공원', 'intermediate'), wp('건대입구', 'destination')];
    await fireSyncConsumedPrecedingAlarms(
      makeEnv(kv),
      makeTrip(chain),
      3,
      { apnsConfig: getApnsConfig(), apnsHosts: APNS_HOSTS, fetchImpl: f.fetchImpl } as SyncSkippedFireDeps,
      NOW,
      () => undefined,
      () => 'p',
    );
    expect(spy.alarmKeyCalls()).toEqual({ get: 1, put: 1, delete: 0 });
    expect(alarmAlerts(f.calls)).toHaveLength(1);
  });

  it('기본값은 D1 sleep-alarm 행을 만들지 않는다 (발사/dedup/rollback 모두)', async () => {
    const kv = new InMemoryKV(() => NOW);
    const d1 = fakeD1();
    await advance(makeTrip(waypoints), kv, captureFetch().fetchImpl, { db: d1.db });
    await advance(makeTrip(waypoints), kv, captureFetch().fetchImpl, { db: d1.db }); // dedup
    await advance(makeTrip(waypoints, { token: 'other' }), new InMemoryKV(() => NOW), captureFetch(500).fetchImpl, { db: d1.db }); // rollback
    expect(d1.rows.filter((r) => r.kind === 'sleep-alarm')).toEqual([]);
  });
});

/** 변경 전 코드 실측 — 기본값 발사 1회의 전체 KV get/put/delete 호출 수. */
const KV_TOTALS_FIRE = { get: 3, put: 3, delete: 0 };
