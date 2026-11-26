/**
 * #3373 — 2026-11-24 19:05~19:22 KST 트립(D1 trip_metrics id 212, token_hash b00dd879, 뚝섬(2) -> 건대입구 환승 -> 용마산(7), 취침) replay.
 *
 * 사고: 이 트립의 1역 전 취침 알람(성수 -> 건대입구 환승 / 중곡 -> 용마산 하차)이 BG에서 진동만 났다. 서버 alert가 표시됐는지 사후에
 * 알 수 없었다 — 기본 칸은 D1 `trip_events` sleep-alarm 행이 0이었고(`recordNonDefaultSleepAlarm`의 기본 칸 return), alert 실패 로그는
 * worker 로그(비영속)뿐이었다. 이 트립의 D1 `trip_events`(token_hash b00dd879, ts 1795514723303~)에 kind='sleep-alarm' 행이 0건임을 확인했다.
 *
 * 입력은 불변 실측: 노선은 D1 route-signature-mismatch(id 2681) incomingSig 원문
 * `건대입구|2|transfer / 어린이대공원(세종대)|7 / 군자(능동)|7 / 중곡|7 / 용마산|7|destination` + leg-1 성수(2호선, 뚝섬 다음 역)다.
 * 통과시키려 조정 금지. 기대: 1역 전 두 칸 모두 D1 sleep-alarm 행 1건씩(성수 -> 건대입구, 중곡 -> 용마산).
 */
import { describe, expect, it } from 'vitest';
import { InMemoryKV } from './inMemoryKv';
import {
  NOW,
  advance,
  captureFetch,
  companions,
  fakeD1,
  makeTrip,
  sleepAlerts,
  useApnsHarness,
  wp,
} from './helpers/sleepAlarmHarness';

useApnsHarness();

/** D1 2681 incomingSig의 leg-2 + leg-1(2호선) 구간. 각 leg의 첫 waypoint가 "방금 진입한 직전역". */
const LEG1 = [wp('성수', 'intermediate', '2'), wp('건대입구', 'transfer', '2')];
const LEG2 = [
  wp('어린이대공원(세종대)', 'intermediate'),
  wp('군자(능동)', 'intermediate'),
  wp('중곡', 'intermediate'),
  wp('용마산', 'destination'),
];

describe('#3373 replay 11/24 b00dd879 — 1역 전 알람이 D1 sleep-alarm 행으로 남는다', () => {
  it('성수 진입 -> 건대입구(환승) 1역 전: alert+companion 발사 + D1 행 1건(alertStatus/companionStatus)', async () => {
    const d1 = fakeD1();
    const f = captureFetch();
    await advance(makeTrip(LEG1, { token: 'b00dd879-leg1' }), new InMemoryKV(() => NOW), f.fetchImpl, { db: d1.db });
    expect(sleepAlerts(f.calls)).toHaveLength(1);
    expect(companions(f.calls)).toHaveLength(1);
    const rows = d1.rows.filter((r) => r.kind === 'sleep-alarm');
    expect(rows).toHaveLength(1);
    expect(rows[0].station).toBe('성수');
    expect(rows[0].meta).toMatchObject({
      outcome: 'fired',
      remaining: 1,
      targetStation: '건대입구',
      targetKind: 'transfer',
      alertStatus: 200,
      companionStatus: 200,
    });
  });

  it('중곡 진입 -> 용마산(하차) 1역 전: D1 행 1건', async () => {
    const d1 = fakeD1();
    const f = captureFetch();
    await advance(makeTrip(LEG2.slice(2), { token: 'b00dd879-leg2' }), new InMemoryKV(() => NOW), f.fetchImpl, { db: d1.db });
    expect(sleepAlerts(f.calls)).toHaveLength(1);
    const rows = d1.rows.filter((r) => r.kind === 'sleep-alarm');
    expect(rows).toHaveLength(1);
    expect(rows[0].station).toBe('중곡');
    expect(rows[0].meta).toMatchObject({ outcome: 'fired', remaining: 1, targetStation: '용마산', targetKind: 'destination' });
  });
});
