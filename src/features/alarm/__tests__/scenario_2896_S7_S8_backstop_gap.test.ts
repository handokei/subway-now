/**
 * #2896 — S7 / S8 시나리오: 지하 BG + backend outage 시 device 측 로컬 폴백 커버리지.
 *
 * 테스트 전용 — 프로덕션 코드 수정 없음. 판정표는 PR 본문 참고.
 *
 * 배경(읽기 전용으로 확인한 구조, device 범위):
 *  - ④ "device 사전 예약 알람(#584)" 채널은 ADR-026 Decision 2(#2202)로 **퇴역**했다
 *    (`stationPrescheduler.ts:1-18` 헤더) — `registerPrescheduledStationAlarms` /
 *    `reschedulePrescheduledAlarm`은 코드베이스에서 전량 삭제됐고, 남은 export 3개
 *    (`cancelAllPrescheduledAlarms` / `cancelPrescheduledByStationKind` / `readPrescheduledData`)
 *    는 "구버전 앱이 과거 예약해둔 잔여물 정리"용 방어 코드일 뿐 — 신규 trip은 애초에 아무것도
 *    등록하지 않는다.
 *  - ADR-026 Decision 3이 유일하게 유지한 로컬 백스톱은 `safetyNetScheduler.ts`다. 단,
 *    (a) `resolveAllTargets`(`stationAlarm.ts:75-100`)가 산출하는 waypoint는 **transfer/destination
 *    뿐** — 중간역(intermediate/station-passed)은 애초에 waypoint 자체가 생성되지 않는다
 *    (`AlarmLocalKind = 'transfer' | 'destination'`, `alarmLocalAuthority.ts:29`).
 *    (b) `useSafetyNetScheduler.ts:71` — `if (!sleepMode || ...) return cancel-only` — **sleepMode
 *    가 꺼진 trip(S6/S8 전제의 "지상 lock 트립")은 이 백스톱 자체가 처음부터 armed되지 않는다.**
 *
 * 이 테스트는 "로컬 폴백이 반드시 발사된다"는 S8 스펙을 실제로 구동해 현재 코드가 몇 건을
 * 만들어내는지 센다 — 대부분 0건이다(구조적 결함 또는 ADR-026의 의도된 trade-off, 판정은
 * PR 본문).
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

jest.mock('expo-notifications');

jest.mock('../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../utils/alarmLog', () => ({
  logScheduledAlarm: jest.fn(),
}));

jest.mock('../utils/stationNotification', () => ({
  buildAlarmContent: (event: { phaseId: string; stationName: string }) => ({
    title: `T:${event.phaseId}`,
    body: `B:${event.stationName}`,
  }),
}));

import {
  deriveSafetyNetWaypoints,
  registerSafetyNetAlarms,
} from '../utils/safetyNetScheduler';
import { cancelPrescheduledByStationKind } from '../utils/stationPrescheduler';
import { makeDirectRoute } from '../../../testUtils/routeFixtures';
import { canonicalStationName } from '../../../testUtils/canonicalStationName';

const mockedSchedule = Notifications.scheduleNotificationAsync as jest.MockedFunction<
  typeof Notifications.scheduleNotificationAsync
>;
const mockedGetAll = Notifications.getAllScheduledNotificationsAsync as jest.MockedFunction<
  typeof Notifications.getAllScheduledNotificationsAsync
>;
const mockedCancel = Notifications.cancelScheduledNotificationAsync as jest.MockedFunction<
  typeof Notifications.cancelScheduledNotificationAsync
>;
const mockedGetPresented = Notifications.getPresentedNotificationsAsync as jest.MockedFunction<
  typeof Notifications.getPresentedNotificationsAsync
>;

const START_TIME = new Date('2026-10-07T09:00:00Z').getTime();
const DESTINATION = canonicalStationName('용마산', '7');

beforeEach(() => {
  jest.clearAllMocks();
  jest.replaceProperty(Platform, 'OS', 'ios');
  mockedSchedule.mockResolvedValue('id');
  mockedGetAll.mockResolvedValue([]);
  mockedCancel.mockResolvedValue(undefined);
  mockedGetPresented.mockResolvedValue([]);
});

describe('S7 — 지하 BG + backend push 수신: 로컬 예약 취소가 공백을 만들지 않는다', () => {
  it('구버전 앱 잔존 presched가 있어도 취소만 할 뿐, 대체 로컬 알림을 새로 만들지 않는다', async () => {
    mockedGetAll.mockResolvedValue([
      {
        identifier: 'presched-tok1234567890ab-신당-station-passed',
        content: {
          data: {
            channel: 'presched-station',
            tripToken: 'tok1234567890ab',
            station: '신당',
            kind: 'station-passed',
            occurrenceIdx: 0,
          },
        },
      } as unknown as Notifications.NotificationRequest,
    ]);

    await cancelPrescheduledByStationKind('신당', 'station-passed');

    expect(mockedCancel).toHaveBeenCalledWith('presched-tok1234567890ab-신당-station-passed');
    // device는 취소 외에 새 로컬 알림을 전혀 만들지 않는다 — "공백을 만들지는 않는다"는 device
    // 쪽 절반만 증명한다. 사용자가 실제로 배너를 보는지는 backend 단일 alert push(①)의 APNs
    // 전달 성공 여부에 전적으로 달려 있고, 이는 device unit test 범위 밖이다.
    expect(mockedSchedule).not.toHaveBeenCalled();
  });

  it('신규(#2202 이후) trip은 애초에 presched를 등록하지 않으므로 취소 대상이 0건이다', async () => {
    // 등록 함수(registerPrescheduledStationAlarms)가 삭제된 뒤의 현실태 재현 — OS 큐에
    // presched-* 식별자가 아예 없다.
    mockedGetAll.mockResolvedValue([]);

    await cancelPrescheduledByStationKind('신당', 'station-passed');

    expect(mockedCancel).not.toHaveBeenCalled();
  });
});

describe('S8 — backend push 미수신: 로컬 폴백이 반드시 발사돼야 한다 (거부 케이스)', () => {
  it('direct 5정거장 route — 중간역은 safety-net waypoint 자체가 생성되지 않는다', () => {
    const route = makeDirectRoute(5, '7');
    const waypoints = deriveSafetyNetWaypoints(route, DESTINATION);

    // 유일한 waypoint는 destination 1건 — 중간 4개 역(intermediate/station-passed)은
    // 애초에 후보에도 들지 않는다. `SafetyNetWaypoint.kind: AlarmLocalKind`
    // (`alarmLocalAuthority.ts:29` = `'transfer' | 'destination'`)가 타입 수준에서도
    // 'station-passed'와 겹치지 않는다 — `w.kind === 'station-passed'` 비교 자체가
    // tsc TS2367(no overlap)로 컴파일 거부된다(실측, type-check red). 런타임으로는
    // "destination 1건뿐"이라는 사실만으로 충분히 증명된다.
    expect(waypoints).toHaveLength(1);
    expect(waypoints[0].kind).toBe('destination');
  });

  // #2905 ([측정→결정] 매역 push 전달률 측정 후 폴백 여부 결정 + collapse-id 분리) —
  // tasks/lessons.md L18 정책에 따라 `it.failing`으로 전환(사용자 2026-10-08 승인). 임의
  // CI 우회가 아니라 "알려진 결함을 등록해 green 유지"하는 절차다.
  //
  // ⓐ 현재 동작: 중간역(station-passed) 로컬 폴백은 구조적으로 0건이다 —
  //   `SafetyNetWaypoint.kind: AlarmLocalKind`(`alarmLocalAuthority.ts:29`)가
  //   `'transfer' | 'destination'`만 가질 수 있어 `'station-passed'`가 타입에 아예 없다
  //   (위 테스트의 tsc TS2367 실측과 동일 근거). outageConfirmed=true 최선의 경우에도
  //   `registerSafetyNetAlarms`가 중간역에 대해 `scheduleNotificationAsync`를 호출하는
  //   경로 자체가 없다.
  // ⓑ 이건 ADR-026(2026-08-07, Decision 2/3)의 **의도된 설계**다 — 매역 사전예약 채널을
  //   퇴역시키고 backend 단일 emitter로 수렴한 트레이드오프(`ADR-026-fire-authority-single-emitter.md:66`
  //   "miss 위험: ... safetyNet 하나에 의존" — 그 safetyNet 자체가 애초에 중간역을 커버하지
  //   않는다는 사실까지는 그 ADR이 명시하지 않았다). 코드만 고쳐서 해결할 수 있는 결함이
  //   아니라, "중간역에 백스톱이 필요한가"부터 제품 결정이 선행돼야 한다.
  // ⓒ 승격 조건: #2905의 실측(매역 push 전달률) 결과에 따라 폴백 신설이 결정되면, 이 테스트는
  //   `it.failing` → 일반 `it`으로 승격하고(구현 PR과 짝), 결정이 "폴백 불필요"로 나면 이
  //   테스트 자체를 스펙(expect 반대 방향)으로 재작성한다.
  it.failing('outageConfirmed=true(backend 침묵 확인된 최선의 경우)에도 중간역 로컬 폴백은 0건 발사된다 (RED, 추적: #2905)', async () => {
    await registerSafetyNetAlarms({
      tripToken: 'TOKEN-S8',
      route: makeDirectRoute(5, '7'),
      destinationName: DESTINATION,
      startTime: START_TIME,
      outageConfirmed: true,
      now: START_TIME,
    });

    const intermediateFireCalls = mockedSchedule.mock.calls.filter(([arg]) => {
      const data = (arg as { content: { data?: { kind?: string } } }).content.data;
      return data?.kind === 'station-passed';
    });

    // 스펙(S8): backend 미수신 시 로컬 폴백이 "반드시" 발사돼야 한다. 중간역에 대한 로컬
    // 폴백은 safetyNetScheduler 구조상 존재하지 않아 0건 — RED(`it.failing`이라 suite는 green).
    expect(intermediateFireCalls.length).toBeGreaterThan(0);
  });

  it('transfer/destination조차, outageConfirmed=true가 아니면(backend 정상 수신 중 가정) 0건 — "침묵 확인"이 선행돼야 한다', async () => {
    await registerSafetyNetAlarms({
      tripToken: 'TOKEN-S8-HEALTHY',
      route: makeDirectRoute(5, '7'),
      destinationName: DESTINATION,
      startTime: START_TIME,
      outageConfirmed: false,
      now: START_TIME,
    });
    // outageConfirmed 판정 자체는 호출자(useSafetyNetScheduler)가 silent push 수신 이력으로
    // 내리는데(ADR-026 Decision 3), 그 판정에 걸리는 지연 동안에도 로컬 폴백은 무장되지 않는다
    // — "침묵 확인 전"에는 destination/transfer조차 백스톱이 없다. S8이 요구하는 "침묵 금지"는
    // 이 판정 지연 구간에 대해서는 원천적으로 충족 불가능한 설계다.
    expect(mockedSchedule).not.toHaveBeenCalled();
  });
});
