/**
 * #3100 PR-2 — 혼합 분기 중단 경로 (`/boarding-lock/sync`의 transfer/destination 소비 루프가 조기에 끝나는 경우).
 *
 * 루프는 정상 종료(관측역 intermediate defer) 외에 (a) drift 가드 break (b) `consumed === false` break
 * (c) 루프 중 throw 로 `applied < requested` 인 채 끝날 수 있다. 이때 이미 슬라이스된 intermediate의 "다음 타깃"은
 * 사용자가 이미 도착한 쌍이라(타깃이 요청 구간 안) 어떤 설정에서도 알람이 나가면 안 된다 —
 * `crossingForConsumed`의 `requestedCount` 가드가 이를 막는다(되돌리면 기본 설정 행이 red).
 * `advanceBoardingLockWaypoint`만 제어하고 나머지는 실제 코드다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLEEP_ALARM_MAX_STOPS_BEFORE as MAX, type SleepAlarmConfig } from '../../../../src/shared/constants/sleepAlarm';
import { useApnsHarness, wp } from './helpers/sleepAlarmHarness';
import { lockActiveTrip, syncObserved } from './helpers/sleepAlarmSyncHttp';

type AdvanceMode = 'consumed-false' | 'throw' | 'consumed-without-slice';
const control = vi.hoisted(() => ({ mode: 'consumed-false' as AdvanceMode }));

vi.mock('../scheduled', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scheduled')>()),
  advanceBoardingLockWaypoint: async () => {
    if (control.mode === 'throw') throw new Error('boom');
    return { consumed: control.mode === 'consumed-without-slice', tripEnded: false };
  },
}));

useApnsHarness();
beforeEach(() => {
  control.mode = 'consumed-false';
});
afterEach(() => vi.unstubAllGlobals());

const EVERY_MAX: SleepAlarmConfig = { mode: 'every', stops: [MAX] };
const CONFIGS: { name: string; sleepAlarm: SleepAlarmConfig | undefined }[] = [
  { name: '기본', sleepAlarm: undefined },
  { name: `매 역 ${MAX}`, sleepAlarm: EVERY_MAX },
];

// [A, B, T, ...] 에서 T 소비가 막히면 A, B만 슬라이스된다. 마지막 소비 B의 다음 타깃 T는 요청 구간(0..T) 안.
const chain = () => [
  wp('중곡', 'intermediate'),
  wp('군자', 'intermediate'),
  wp('건대입구', 'transfer'),
  wp('뚝섬유원지', 'intermediate'),
  wp('학동', 'destination'),
];

describe.each(CONFIGS)('#3100 PR-2 혼합 분기 중단 경로 / $name', ({ sleepAlarm }) => {
  it('(b) consumed=false 유예: 이미 슬라이스된 군자는 요청 구간 안의 타깃(건대입구)의 직전역 — 알람 0', async () => {
    control.mode = 'consumed-false';
    const r = await syncObserved(lockActiveTrip(chain(), { sleepAlarm }), '건대입구');
    expect(r.stored?.waypoints.map((w) => w.stationName)).toEqual(['건대입구', '뚝섬유원지', '학동']); // 전제: 중곡·군자만 소비
    expect(r.alarms).toEqual([]);
    expect(r.alarmKeyCalls).toEqual({ get: 0, put: 0, delete: 0 });
  });

  it('(c) 루프 중 throw: 진행분(중곡·군자)만 persist되고 알람 0', async () => {
    control.mode = 'throw';
    const r = await syncObserved(lockActiveTrip(chain(), { sleepAlarm }), '건대입구');
    expect(r.stored?.waypoints.map((w) => w.stationName)).toEqual(['건대입구', '뚝섬유원지', '학동']);
    expect(r.alarms).toEqual([]);
  });

  it('(a) drift 가드 break: 환승이 소비됐다고 보고하고 배열은 그대로면 다음 원소에서 멈추고 알람 0', async () => {
    control.mode = 'consumed-without-slice';
    const r = await syncObserved(lockActiveTrip(chain(), { sleepAlarm }), '뚝섬유원지');
    expect(r.status).toBe(200);
    expect(r.alarms).toEqual([]);
  });
});
