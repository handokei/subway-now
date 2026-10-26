/**
 * #3100 PR-2 — sync 경로(`/boarding-lock/sync` 순수 점프 / 승격 fast-forward / 혼합 분기) 기본값 golden.
 *
 * 변경 전 코드(origin/dev 39a6615e)에서 green으로 고정한다. PR-2의 N역 전 일반화가 기본 설정(`sleepAlarm` 없음)의
 * 발사 집합 / collapse-id / 알람 키 KV 호출 수 / companion wire / D1 행을 바꾸지 않았음을 같은 단언이 증명한다.
 * 기대값은 변경 전 실측 출력이며 통과시키려 조정하지 않는다.
 */
import { describe, expect, it } from 'vitest';
import { prepareAlarmCollapseId, sleepAlarmCollapseId } from '../collapseId';
import { useApnsHarness, wp } from './helpers/sleepAlarmHarness';
import {
  FF_CHAIN_NAMES,
  SYNC_TOKEN,
  TRAIN_DEPARTED,
  lockActiveTrip,
  syncObserved,
  syncPromote,
} from './helpers/sleepAlarmSyncHttp';

useApnsHarness();

const TARGET = '건대입구';
const NO_KEY_CALLS = { get: 0, put: 0, delete: 0 };
const ONE_FIRE_KEY_CALLS = { get: 1, put: 1, delete: 0 };

describe('#3100 PR-2 golden — 순수 점프(/boarding-lock/sync), 기본 설정', () => {
  const chain = () => FF_CHAIN_NAMES.map((name, i) => wp(name, i === FF_CHAIN_NAMES.length - 1 ? 'destination' : 'intermediate'));

  // 점프 k = 관측역이 chain[k-1]. 타깃 직전역(어린이대공원, k=3)을 소비할 때만 catch-up 1회, 그 외 0.
  it.each([
    { jump: 1, fires: 0 },
    { jump: 2, fires: 0 },
    { jump: 3, fires: 1 },
    { jump: 4, fires: 0 },
  ])('취침 ON 점프 $jump: 알람 $fires회', async ({ jump, fires }) => {
    const r = await syncObserved(lockActiveTrip(chain()), FF_CHAIN_NAMES[jump - 1]);
    expect(r.status).toBe(200);
    expect(r.alarms.map((a) => a.collapseId)).toEqual(fires === 1 ? [sleepAlarmCollapseId(SYNC_TOKEN, TARGET)] : []);
    expect(r.alarmKeyCalls).toEqual(fires === 1 ? ONE_FIRE_KEY_CALLS : NO_KEY_CALLS);
    expect(r.sleepRows).toEqual([]);
    if (fires === 1) expect(r.companions[0].body.data).not.toHaveProperty('remainingStops');
  });

  it('취침 OFF 점프 3: 준비 알람 1회(취침 알람 키 접근 0)', async () => {
    const r = await syncObserved(lockActiveTrip(chain(), { sleepModeEnabled: false }), FF_CHAIN_NAMES[2]);
    expect(r.alarms.map((a) => a.collapseId)).toEqual([prepareAlarmCollapseId(SYNC_TOKEN, TARGET)]);
    expect(r.alarmKeyCalls).toEqual(NO_KEY_CALLS);
  });

  it('lock 없음 점프 3: 알람 0 (lock 없음 = 알림 없음)', async () => {
    const r = await syncObserved(lockActiveTrip(chain(), { boardingLock: undefined }), FF_CHAIN_NAMES[2]);
    expect(r.alarms).toEqual([]);
  });
});

describe('#3100 PR-2 golden — 승격 fast-forward(/boarding-lock/sync trainCode), 기본 설정', () => {
  // 열차가 chain[p]를 출발한 채 승격 -> chain[0..p] skip. skip이 타깃 직전역까지 닿을 때(p=2)만 catch-up 1회.
  it.each([
    { departed: '중곡', fires: 0 },
    { departed: '군자', fires: 0 },
    { departed: '어린이대공원', fires: 1 },
  ])('열차가 $departed 출발 후 승격: 알람 $fires회', async ({ departed, fires }) => {
    const r = await syncPromote('destination', {}, { stationName: departed, trainSttus: TRAIN_DEPARTED });
    expect(r.status).toBe(200);
    expect(r.alarms.map((a) => a.collapseId)).toEqual(fires === 1 ? [sleepAlarmCollapseId(SYNC_TOKEN, TARGET)] : []);
    expect(r.alarmKeyCalls).toEqual(fires === 1 ? ONE_FIRE_KEY_CALLS : NO_KEY_CALLS);
    expect(r.sleepRows).toEqual([]);
  });
});

describe('#3100 PR-2 golden — 혼합 분기(환승 소비), 기본 설정: 알람 0', () => {
  const SAME_LINE = [
    wp('어린이대공원', 'intermediate'),
    wp('건대입구', 'transfer'),
    wp('뚝섬유원지', 'intermediate'),
    wp('청담', 'intermediate'),
    wp('강남구청', 'intermediate'),
    wp('학동', 'destination'),
  ];
  const LINE_CHANGE = [
    wp('어린이대공원', 'intermediate'),
    wp('건대입구', 'transfer'),
    wp('성수', 'intermediate', '2'),
    wp('뚝섬', 'intermediate', '2'),
    wp('한양대', 'intermediate', '2'),
    wp('왕십리', 'destination', '2'),
  ];

  it.each([
    { name: '같은 호선 오라벨 환승(lock 유지)', waypoints: SAME_LINE, observed: '강남구청', lockKept: true },
    { name: '노선 변경 환승(lock 해제)', waypoints: LINE_CHANGE, observed: '한양대', lockKept: false },
  ])('$name: 기본 칸 대상이 없어 알람 0', async ({ waypoints, observed, lockKept }) => {
    const r = await syncObserved(lockActiveTrip(waypoints), observed);
    expect(r.status).toBe(200);
    // 전제: 환승이 실제로 소비됐고(관측역이 head) lock 상태가 시나리오대로다 — 아니면 이 행은 공허하다.
    expect(r.stored?.waypoints[0]?.stationName).toBe(observed);
    expect(r.stored?.boardingLock !== undefined).toBe(lockKept);
    expect(r.alarms).toEqual([]);
    expect(r.alarmKeyCalls).toEqual(NO_KEY_CALLS);
  });
});
