/**
 * #2068 — 다중소스 발사횟수 시퀀스 테스트 (Part of Epic #2061).
 *
 * ## 배경
 *
 * 사용자 체감 회귀 2건(#2061 본문): (1) 동일 알림 반복 발사 (2) 일반 모드에서 알람음.
 * 기존 fixture chain harness(`fixtureChainRunner.ts`)는 DebugModal dump **스냅샷 평가기**라
 * 이벤트 순서·발사 횟수·race를 재현할 수 없다(2026-07-29 4-audit). 본 파일은 fg polling /
 * bg pipeline / silent push 3소스가 같은 물리적 station 이벤트를 각자 경로로 주입할 때 실제
 * 발사(=expo-notifications mock 호출) 횟수를 assert한다.
 *
 * ## 소스별 gate 경로 (production 코드 그대로 mirror, 재구현 아님)
 *
 * 세 helper(`fireViaFgOrBgPath` / `fireViaOsScheduledPath` / `fireViaSilentPushPath`)는
 * production caller가 실제로 호출하는 순서 그대로 real exported gate 함수
 * (`crossCategoryStationDedup.ts`)를 호출한다 — 재구현이 아니라 "경유"다:
 *
 *   - fg polling(`useStationAlarm.ts:215` 부근) / bg pipeline(`stationPipeline.ts:319-499`):
 *     `isStationRecentlyFired` → `isTripScopedCrossCategoryRecentlyFired` →
 *     `isPhaseToPhaseCrossStationRecentlyFired` → `isAnyChannelRecentlyFired` →
 *     (모두 통과 시) `markStationFired` + 알림 발사. 두 경로 모두 같은 gate 함수를 공유한다
 *     (`silentPushTask.ts:1927` 주석 "FG fireAndLog / stationPipeline 모두에서
 *     markStationFired로 적재").
 *   - silent push(`silentPushTask.ts:1930-1986`): `isAnyChannelRecentlyFired`만 거치고
 *     (isStationRecentlyFired 등 나머지 3 게이트는 호출하지 않음) `markStationFired` + 발사.
 *   - **OS 사전예약**(`alarmScheduler.ts:152-168`, `tripBoundScheduler.ts`,
 *     `boardingLockScheduler.ts`): 위 dedup 게이트를 **전혀 거치지 않고**
 *     `Notifications.scheduleNotificationAsync`를 직접 호출한다 — 예약 후 OS가 자체 발사하기
 *     때문에 런타임 dedup이 원천적으로 불가능(#2061 본문 "OS 사전예약 3종 ... 런타임 dedup
 *     불가"). 본 파일은 이 gap을 직접 재현한다.
 *
 * ## 시나리오
 *
 *   (a) 같은 역 3소스(os-scheduled/fg/silent) 각 1회 주입 → 총 발사 ≤1 기대, 실제는 2건
 *       (os-scheduled가 gate를 우회해 fg와 별개로 발사) → red.
 *   (b) 앱 재시작 시뮬(`jest.isolateModules`로 모듈 registry만 새로 만들고 AsyncStorage mock
 *       data는 outer 스코프에 유지 — `jest.resetModules` + "AsyncStorage 유지" 의도를 다른
 *       테스트로 상태가 새지 않게 스코프 격리해 구현) 후 같은 이벤트 재주입 → 추가 발사 0
 *       기대, 실제는 in-memory dedup(`crossCategoryStationDedup`의 lastFire Map) 소실로
 *       재발사 → red. AsyncStorage 기반 `firedPushIds`는 대조군으로 재시작 후에도 dedup
 *       상태가 보존됨을 함께 확인(harness sanity check, green).
 *   (c) 일반 모드(sleepMode=off)에서 `sendAlarmNotification`(실제 production 함수, 재구현
 *       아님) 호출 → sound=alarm.wav 0건 기대, 실제는 allowSpeaker 기본값 때문에 sleepMode
 *       무관하게 sound='alarm.wav' → red.
 *
 * (a)(b) `it.failing` — 현 코드 기준 red 재현. Phase 1(#2063/#2064)·Phase 2(#2066)가 완료되면
 * unskip한다. (c)는 #2067(Phase 2-device D1)에서 `sendAlarmNotification` 자체를 삭제해 —
 * "재구현 없이 실제 함수를 호출해 검증"하던 원래 harness 전제가 성립하지 않게 됐다. 함수가
 * 없으므로 발사 경로 자체가 사라졌다는 것을 export 부재로 직접 확인하는 passing 테스트로 전환.
 */
import * as Notifications from 'expo-notifications';
import {
  isStationRecentlyFired,
  isTripScopedCrossCategoryRecentlyFired,
  isPhaseToPhaseCrossStationRecentlyFired,
  isAnyChannelRecentlyFired,
  markStationFired,
  _resetCrossCategoryDedupForTests,
  type FireCategory,
} from '../crossCategoryStationDedup';
import { addFiredPushId, hasFiredPushId } from '../firedPushIds';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';

jest.mock('expo-notifications');
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// stationNotification.ts는 시나리오(c)에서만 필요 — 무거운 의존성(live-activity, tts,
// alarmSound, breadcrumb 등)을 stationNotification.test.ts와 동일한 패턴으로 mock한다.
const mockVibrateAlarm = jest.fn();
const mockStopVibration = jest.fn();
jest.mock('../alarmSound', () => ({
  vibrateAlarm: (...args: unknown[]) => mockVibrateAlarm(...args),
  stopVibration: () => mockStopVibration(),
}));

const mockSpeakAlarm = jest.fn();
jest.mock('../tts', () => ({
  speakAlarm: (...args: unknown[]) => mockSpeakAlarm(...args),
}));

jest.mock('live-activity', () => ({
  startLiveActivity: jest.fn().mockResolvedValue(undefined),
  updateLiveActivity: jest.fn().mockResolvedValue(undefined),
  endLiveActivity: jest.fn().mockResolvedValue(undefined),
  isLiveActivityEnabled: jest.fn().mockReturnValue(true),
}));

jest.mock('../liveActivityPushChannel', () => ({
  ensureLiveActivityRegistered: jest.fn().mockResolvedValue(undefined),
  endLiveActivityWithDeregister: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../../shared/infra/monitoring/breadcrumb', () => ({
  addLogBreadcrumb: jest.fn(),
  addDomainBreadcrumb: jest.fn(),
}));

jest.mock('../../../widget/api/widgetStorage', () => ({
  saveStationToWidget: jest.fn().mockResolvedValue(undefined),
  clearWidgetStation: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../../data/exitSide.json', () => ({}));
jest.mock('../../../../data/platformExitSide.json', () => ({}));
jest.mock('../../../../data/quickExit.json', () => ({}));

// #2068 시나리오 (b) — "AsyncStorage mock 유지" 요구사항. 데이터 저장소를 이 테스트 파일의
// 바깥 스코프(outer closure)에 두어 jest.resetModules() 이후에도(모듈 registry만 리셋되고
// 이 변수는 real JS scope라 살아남는다) 동일 데이터를 유지한다 — 실기기의 AsyncStorage가
// 프로세스 재시작(JS heap 초기화)에도 디스크에 남아있는 것과 동등한 시뮬레이션.
// firedPushIds.ts는 real 구현을 그대로 사용(mock 안 함) — 이 AsyncStorage mock 위에서 동작.
const mockAsyncStorageData: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn((key: string) => Promise.resolve(mockAsyncStorageData[key] ?? null)),
  setItem: jest.fn((key: string, value: string) => {
    mockAsyncStorageData[key] = value;
    return Promise.resolve();
  }),
  removeItem: jest.fn((key: string) => {
    delete mockAsyncStorageData[key];
    return Promise.resolve();
  }),
}));

const DEST_ID = 'trip-fire-sequence';
const LINE = '2' as const;

function stationName(): string {
  return canonicalStationName('성수', LINE);
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetCrossCategoryDedupForTests();
  (Notifications.scheduleNotificationAsync as jest.Mock).mockResolvedValue('id');
  (Notifications.dismissNotificationAsync as jest.Mock).mockResolvedValue(undefined);
});

/**
 * fg polling(`useStationAlarm.ts`) / bg pipeline(`stationPipeline.ts`) 공통 gate 순서.
 * 두 real caller가 동일한 4-게이트 체인 + `markStationFired`를 공유하므로(위 파일 docstring
 * 근거) 단일 helper로 양쪽을 대표한다.
 */
function fireViaFgOrBgPath(
  destId: string,
  station: string,
  category: FireCategory,
  now: number,
): boolean {
  if (isStationRecentlyFired(destId, station, category, now)) return false;
  if (isTripScopedCrossCategoryRecentlyFired(destId, station, category, now)) return false;
  if (isPhaseToPhaseCrossStationRecentlyFired(destId, station, category, now)) return false;
  if (isAnyChannelRecentlyFired(destId, station, category, now)) return false;
  markStationFired(destId, station, category, now);
  void Notifications.scheduleNotificationAsync({
    content: { title: '알림', body: station },
    trigger: null,
  });
  return true;
}

/** silent push(`silentPushTask.ts:1930-1986`) gate 순서 — isAnyChannelRecentlyFired만 통과. */
function fireViaSilentPushPath(
  destId: string,
  station: string,
  category: FireCategory,
  now: number,
): boolean {
  if (isAnyChannelRecentlyFired(destId, station, category, now)) return false;
  markStationFired(destId, station, category, now);
  void Notifications.scheduleNotificationAsync({
    content: { title: '알림(silent push)', body: station },
    trigger: null,
  });
  return true;
}

/**
 * OS 사전예약(`alarmScheduler.ts:152-168` 등) — dedup 게이트 없이 직접 스케줄.
 * 실제로는 미래 trigger date로 예약하지만, 본 harness는 "게이트를 거치지 않고 발사
 * 카운트에 반영된다"는 사실만 재현하면 충분해 trigger:null(즉시)로 단순화한다.
 */
function fireViaOsScheduledPath(station: string): void {
  void Notifications.scheduleNotificationAsync({
    content: { title: '알람', body: station, sound: 'alarm.wav' },
    trigger: null,
  });
}

describe('시나리오 (a): 같은 역 3소스 각 1회 주입 → 총 발사 ≤1', () => {
  it.failing('os-scheduled + fg + silent 순차 주입 → 실제로는 2건 발사(gate 우회 gap)', () => {
    const station = stationName();
    const now = 1_000;

    fireViaOsScheduledPath(station); // OS 사전예약 — gate 미경유, 무조건 1건.
    fireViaFgOrBgPath(DEST_ID, station, 'station-passed', now); // gate open → 1건 더.
    fireViaSilentPushPath(DEST_ID, station, 'station-passed', now + 10); // fg가 마킹 → dedup.

    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });

  it('gate 우회 없이 fg만 단독 주입하면 정확히 1건(gate 자체는 정상 동작)', () => {
    const station = stationName();
    const now = 1_000;

    const fgFired = fireViaFgOrBgPath(DEST_ID, station, 'station-passed', now);
    const bgFired = fireViaFgOrBgPath(DEST_ID, station, 'station-passed', now + 5);
    const silentFired = fireViaSilentPushPath(DEST_ID, station, 'station-passed', now + 10);

    expect(fgFired).toBe(true);
    expect(bgFired).toBe(false);
    expect(silentFired).toBe(false);
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });
});

describe('시나리오 (b): 앱 재시작 시뮬 후 같은 이벤트 재주입 → 추가 발사 0', () => {
  it.failing('in-memory dedup(crossCategoryStationDedup)은 재시작 시 소실 → 추가 1건 재발사', () => {
    const station = stationName();
    const now = 2_000;

    // 재시작 전: fg 경로로 정상 발사 + 마킹.
    const firstFired = fireViaFgOrBgPath(DEST_ID, station, 'station-passed', now);
    expect(firstFired).toBe(true);
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);

    // 앱 재시작 시뮬 — jest.isolateModules로 이 콜백 안에서만 모듈 registry를 새로 만든다
    // (콜백 종료 후 원래 registry로 자동 복원 — scheduleFallback.test.ts:23-30과 동일 패턴,
    // 다른 describe/it으로 상태가 새지 않는다). AsyncStorage(firedPushIds 등)는 mock data가
    // 이 파일의 outer 스코프(`mockAsyncStorageData`)에 남아있어 유지되지만(대조군, 아래
    // 테스트), in-memory-only 모듈(crossCategoryStationDedup)은 콜백 안에서 재요청 시 새
    // 인스턴스로 lastFire Map이 빈다.
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- isolateModules
      // 콜백 안에서 프로덕션 모듈을 재요청해 "재시작 후 최초 require" 상태를 재현.
      const freshDedup = require('../crossCategoryStationDedup') as typeof import('../crossCategoryStationDedup');

      // 재시작 후: 같은 station-passed 이벤트가 다시 들어온다(예: SSoT/GPS 재평가).
      const afterRestartFired =
        !freshDedup.isStationRecentlyFired(DEST_ID, station, 'station-passed', now + 100) &&
        !freshDedup.isTripScopedCrossCategoryRecentlyFired(DEST_ID, station, 'station-passed', now + 100) &&
        !freshDedup.isPhaseToPhaseCrossStationRecentlyFired(DEST_ID, station, 'station-passed', now + 100) &&
        !freshDedup.isAnyChannelRecentlyFired(DEST_ID, station, 'station-passed', now + 100);
      if (afterRestartFired) {
        freshDedup.markStationFired(DEST_ID, station, 'station-passed', now + 100);
        void Notifications.scheduleNotificationAsync({
          content: { title: '알림', body: station },
          trigger: null,
        });
      }
    });

    // 추가 발사 0건을 기대하지만(사용자가 이미 이 알림을 받았으므로), 실제로는 총 2건.
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });

  it('대조군 — AsyncStorage 기반 firedPushIds는 재시작 후에도 dedup 상태가 보존된다', async () => {
    const pushId = 'push-fire-sequence-1';
    await addFiredPushId(pushId, 3_000);
    expect(await hasFiredPushId(pushId, 3_050)).toBe(true);

    // jest.isolateModules 콜백은 동기라 await를 직접 쓸 수 없다 — 콜백 안에서 만든 Promise
    // 참조만 밖으로 꺼내 await한다(freshFiredPushIds 자체는 콜백 스코프를 벗어나지 않음).
    let pendingResult: Promise<boolean>;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const freshFiredPushIds = require('../firedPushIds') as typeof import('../firedPushIds');
      // AsyncStorage mock의 데이터 저장소(`mockAsyncStorageData`)는 이 테스트 파일의 outer
      // 스코프에 유지되므로, 모듈만 새로 불러와도 같은 pushId가 여전히 dedup된다.
      pendingResult = freshFiredPushIds.hasFiredPushId(pushId, 3_100);
    });

    expect(await pendingResult!).toBe(true);
  });
});

describe('시나리오 (c): 일반 모드(sleepMode=off)에서 알람류(sound 있는 알림) 발사 0', () => {
  it('#2067 (Phase 2-device D1) — sendAlarmNotification 자체가 제거되어 발사 경로가 존재하지 않는다', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 무거운 의존성 체인을
    // 이 describe 블록에서만 로드하기 위해 지연 require.
    const stationNotificationModule = require('../stationNotification') as Record<string, unknown>;
    // 일반 모드(sleepMode=off)에서 alarm.wav를 쏘던 유일한 caller(sendAlarmNotification)가
    // #2067 D1에서 삭제됐다 — export 자체가 없으므로 이 회귀는 재발 불가능.
    expect(stationNotificationModule.sendAlarmNotification).toBeUndefined();
  });
});
