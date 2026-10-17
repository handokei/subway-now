/**
 * #2806 (REOPENED 잔여 절반) — whole-trip replay. `stationNotification.test.ts`/
 * `liveActivityPushChannel.test.ts`는 각자 자기 파일만 real로 두고 상대편을 mock해 "부품
 * green"만 증명한다(`lesson_parts_green_whole_inert_last_consumer`). 이 파일은 그 경계를
 * 지워 `updateStationNotification`(stationNotification.ts) → `ensureLiveActivityRegistered`
 * (liveActivityPushChannel.ts)를 **둘 다 real**로 두고 native `live-activity`/backend
 * `alarmBackend`만 mock해, 두 모듈의 실제 배선이 09/30 실측 트립을 사용자-가시 결과(폴백
 * 알림 0건 / kill 0회 / LA 갱신 지속)로 재현하는지 검증한다.
 *
 * ## 실측 출처
 * dump `f2176242-930.txt`, 트립 `e25e1158`(용마산 7호선 → 건대입구 환승 → 2호선 → 뚝섬).
 * KV la-push-counters: sent15/failed0 — backend push는 정상 발송됐으나 device 잠금화면
 * 렌더는 0(죽은 Activity 토큰으로 발송됐기 때문, #2806 스펙 root 1~3).
 *
 * ## 타임라인 (KST)
 * - 06:31:27 boarding-prompt push 수신(FG)
 * - 06:34:09 lock-create 7039(7) @용마산 → 이후 앱 BG(주머니)
 * - 06:34~06:48 LA update 0건 (live-activity-updated 로그 없음 — 이 PR이 고치는 증상)
 * - 06:39:40 / 06:40:53×3 / 06:41:19 / 06:41:24×3 / 06:41:29 la-fallback-notification 폭주
 *   (9건, BG에서 LA kill 후 native start가 throw → catch → 일반 알림 폴백)
 * - 06:41:02 lock-release:transfer 7039(7)
 * - 06:49~06:54 FG 복귀 후 live-activity-updated 70건(정상 — FG는 애초에 문제없었다)
 *
 * fixture 데이터는 실측이고 불변 — 통과시키려 타임라인/횟수를 조정하지 않는다.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { updateStationNotification } from '../stationNotification';
import {
  ensureLiveActivityRegistered,
  __resetLiveActivityPushChannelForTests,
} from '../liveActivityPushChannel';
import { ACTIVE_TRIP_KEY } from '../../../../shared/constants/storageKeys';
import type { Station } from '../../../../shared/types/station';

jest.mock('expo-notifications');
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// 이 replay의 관심사는 LA kill-recreate 여부와 사용자-가시 폴백 발사 여부다 — alarmLog는
// AsyncStorage 배치 flush(디바운스 타이머)를 갖고 있어 fake timer 없이 실호출하면 열린 핸들이
// 남는다. liveActivityPushChannel.ts/stationNotification.ts 둘 다 같은 파일을 참조하므로 한
// 번의 mock으로 두 real 모듈이 공유한다.
const mockLogLiveActivityUpdated = jest.fn();
const mockLogLiveActivityAuthorityState = jest.fn();
const mockLogFiredLaFallbackNotification = jest.fn();
const mockLogSuppressedLaFallbackContentDedup = jest.fn();
jest.mock('../alarmLog', () => ({
  logLiveActivityUpdated: () => mockLogLiveActivityUpdated(),
  logLiveActivityAuthorityState: (...args: unknown[]) =>
    mockLogLiveActivityAuthorityState(...args),
  logFiredLaFallbackNotification: (...args: unknown[]) =>
    mockLogFiredLaFallbackNotification(...args),
  logSuppressedLaFallbackContentDedup: (...args: unknown[]) =>
    mockLogSuppressedLaFallbackContentDedup(...args),
}));

// #1288 register 재시도(REGISTER_RETRY_BASE_DELAY_MS 등)의 backend 왕복만 끊는다 — LA
// 세션/kill-recreate 판정 자체는 이 mock과 무관하게 real liveActivityPushChannel.ts가 그대로
// 수행한다.
const mockRegisterLiveActivityToken = jest.fn().mockResolvedValue({ ok: true });
const mockClearLiveActivityToken = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../../api/alarmBackend', () => ({
  registerLiveActivityToken: (...args: unknown[]) =>
    mockRegisterLiveActivityToken(...args),
  clearLiveActivityToken: (...args: unknown[]) => mockClearLiveActivityToken(...args),
}));

// native LA 경계만 mock. hasActiveLiveActivity는 실측 타임라인의 각 시점에서 네이티브 진실을
// 시나리오 작성자가 직접 통제한다(리플레이 관례) — Swift 내부 update→start fall-through는 이
// 경계 밖(별도 native 변경, device verify 대상)이라 여기서 흉내내지 않는다.
const mockStartLiveActivity = jest.fn().mockResolvedValue(undefined);
const mockUpdateLiveActivity = jest.fn().mockResolvedValue(undefined);
const mockEndLiveActivity = jest.fn().mockResolvedValue(undefined);
const mockIsLiveActivityEnabled = jest.fn().mockReturnValue(true);
const mockHasActiveLiveActivity = jest.fn().mockReturnValue(false);
const mockAddPushTokenListener = jest.fn().mockReturnValue({ remove: jest.fn() });

const nativeLiveActivityMock = {
  startLiveActivity: (...args: unknown[]) => mockStartLiveActivity(...args),
  updateLiveActivity: (...args: unknown[]) => mockUpdateLiveActivity(...args),
  endLiveActivity: () => mockEndLiveActivity(),
  isLiveActivityEnabled: () => mockIsLiveActivityEnabled(),
  hasActiveLiveActivity: () => mockHasActiveLiveActivity(),
  addPushTokenListener: (...args: unknown[]) => mockAddPushTokenListener(...args),
};
// stationNotification.ts는 `import * as LiveActivity from 'live-activity'`, liveActivityPushChannel.ts는
// `from '../../../../modules/live-activity'` — 같은 실물 파일을 가리키는 두 import specifier를 각각
// mock해 어느 쪽 resolution을 타도 같은 mock 상태를 공유하게 한다.
jest.mock('live-activity', () => nativeLiveActivityMock);
jest.mock('../../../../../modules/live-activity', () => nativeLiveActivityMock);

const YONGMASAN: Station = {
  id: 'yongmasan-7',
  name: '용마산',
  line: '7',
  lineColor: '#747F00',
  lat: 37.5744,
  lng: 127.0937,
};

const TRIP_TOKEN_E25E1158 = 'e25e1158';

describe('#2806 whole-trip replay — 09/30 e25e1158 트립 (BG LA kill 봉합)', () => {
  beforeEach(async () => {
    // real liveActivityPushChannel.ts가 push-token first-emit backstop(setTimeout 5s)을 건다 —
    // fake timer 없이 두면 이 replay가 절대 emit하지 않는 token을 기다리며 프로세스가 살아
    // 있는다(다른 real-채널 replay/liveActivityPushChannel.test.ts와 동일 관례).
    jest.useFakeTimers();
    jest.replaceProperty(Platform, 'OS', 'ios');
    jest.clearAllMocks();
    mockRegisterLiveActivityToken.mockResolvedValue({ ok: true });
    mockClearLiveActivityToken.mockResolvedValue({ ok: true });
    mockStartLiveActivity.mockResolvedValue(undefined);
    mockUpdateLiveActivity.mockResolvedValue(undefined);
    mockEndLiveActivity.mockResolvedValue(undefined);
    mockIsLiveActivityEnabled.mockReturnValue(true);
    mockHasActiveLiveActivity.mockReturnValue(false);
    (Notifications.scheduleNotificationAsync as jest.Mock).mockResolvedValue('la-fallback');
    __resetLiveActivityPushChannelForTests();
    await AsyncStorage.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it(
    '06:31 FG pre-boarding start → 06:34 lock(tripToken) → 06:34~06:41 BG 연속 9tick: ' +
      'kill 0회 + 폴백 0건(실측 9건 → 0) + LA 갱신 지속',
    async () => {
      // 06:31:27 — FG pre-boarding 훅(useLiveActivityPreBoardingLifecycle)이 실제로 하는 방식
      // 그대로: 채널(ensureLiveActivityRegistered)을 거치지 않고 native update를 직접 호출한다.
      // 이 호출 이후 채널 세션(activeTeardown/activeTripToken)은 여전히 미등록 상태다 — #2806
      // root 2가 지적하는 바로 그 상태.
      await nativeLiveActivityMock.updateLiveActivity({
        stationName: '감지 중',
        lineName: '',
        lineColorHex: '#8E8E93',
        distanceM: 0,
        destinationName: '뚝섬',
        boardingPhase: 'pre-boarding',
      });
      mockHasActiveLiveActivity.mockReturnValue(true); // 이제 native에는 살아있는 LA가 있다.
      mockUpdateLiveActivity.mockClear();
      mockStartLiveActivity.mockClear();

      // 06:34:09 — lock-create 7039(7) @용마산. tripToken이 ACTIVE_TRIP_KEY에 실린다.
      await AsyncStorage.setItem(ACTIVE_TRIP_KEY, TRIP_TOKEN_E25E1158);

      // 06:34~06:41 — 앱이 주머니 속(BG)에서 backgroundLocationTask가 하듯
      // updateStationNotification을 연속 호출한다. 실측에서 la-fallback-notification이
      // 정확히 9회(06:39:40 / 06:40:53×3 / 06:41:19 / 06:41:24×3 / 06:41:29) 터졌으므로 같은
      // 횟수로 재생한다.
      for (let tick = 0; tick < 9; tick += 1) {
        await updateStationNotification(YONGMASAN, 120 - tick * 5);
      }

      // 사용자-가시 assert ① — 살아있는 LA를 죽이지 않는다(native end 미호출).
      expect(mockEndLiveActivity).not.toHaveBeenCalled();
      // 사용자-가시 assert ② — kill-recreate 재시도(native start)도 없다.
      expect(mockStartLiveActivity).not.toHaveBeenCalled();
      // 사용자-가시 assert ③ — 실측 9건이던 일반 알림 폴백이 fix 후 0건.
      expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
      // 사용자-가시 assert ④ — 잠금화면이 얼지 않는다: BG 9tick 동안 LA content가 최소 1회
      // 이상 실제로 갱신된다(adopt 경로 → native update).
      expect(mockUpdateLiveActivity.mock.calls.length).toBeGreaterThanOrEqual(1);
    },
  );

  it('회귀 안전 — 다른 tripToken의 기존 채널 세션이 있으면 prev kill+deregister는 여전히 수행된다', async () => {
    // trip-A 세션을 real ensureLiveActivityRegistered로 정식 부트스트랩(native start 성공).
    mockHasActiveLiveActivity.mockReturnValue(false);
    await ensureLiveActivityRegistered('trip-A', {
      stationName: '용마산',
      lineName: '7호선',
      lineColorHex: '#747F00',
      distanceM: 100,
    });
    expect(mockStartLiveActivity).toHaveBeenCalledTimes(1);

    // 진짜 trip 전환(트립 A→B) — 이 replay가 지키려는 "무조건 adopt"가 아니라, 다른 tripToken
    // 전환은 여전히 kill+deregister가 맞다(#2806 금지 목록 — 이 경로는 건드리지 않는다).
    mockHasActiveLiveActivity.mockReturnValue(true);
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'trip-B');
    await updateStationNotification(YONGMASAN, 80);

    expect(mockEndLiveActivity).toHaveBeenCalledTimes(1);
    expect(mockClearLiveActivityToken).toHaveBeenCalledWith('trip-A');
  });
});
