/**
 * #2422 (E — 회귀 fixture) — "boardable 상태 ⇒ boarding-prompt fired" whole-chain 검증.
 *
 * lesson_ci_tests_parts_not_wire(2026-08-28): unit 테스트가 내부 함수를 mock으로 격리하면
 * "게이트를 통과했다고 가정한 상태에서 발사 호출이 됐다"만 증명하고, 게이트 자체가 실제로
 * 통과 가능한 입력을 만들어내는지는 검증하지 못한다 — CI green이어도 실제로는 안 뜰 수 있다.
 *
 * 이 fixture는 leaf(AsyncStorage, expo-notifications)만 mock하고 나머지는 실 모듈을 그대로
 * 구동한다: `buildBoardingPromptContext`(boardingPromptContext.ts, 실 route/station 좌표 계산) →
 * `evaluateLocalBoardingPromptGate`(localBoardingPromptGate.ts, 실 근접/방향/arrival 판정) →
 * `fireLocalBoardingPromptNotification`(stationNotification.ts, 실 dedup ledger + i18n content
 * 빌드) → `Notifications.scheduleNotificationAsync`가 BOARDING_PROMPT_CATEGORY + 실제 payload
 * shape로 호출됨을 관측한다.
 */

const storage = new Map<string, string>();
const mockGetItem = jest.fn((key: string) =>
  Promise.resolve(storage.has(key) ? storage.get(key)! : null),
);
const mockSetItem = jest.fn((key: string, value: string) => {
  storage.set(key, value);
  return Promise.resolve();
});
const mockRemoveItem = jest.fn((key: string) => {
  storage.delete(key);
  return Promise.resolve();
});
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (...args: [string]) => mockGetItem(...args),
  setItem: (...args: [string, string]) => mockSetItem(...args),
  removeItem: (...args: [string]) => mockRemoveItem(...args),
}));

const mockScheduleNotificationAsync = jest.fn().mockResolvedValue('scheduled');
const mockDismissNotificationAsync = jest.fn().mockResolvedValue(undefined);
jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: (...args: unknown[]) => mockScheduleNotificationAsync(...args),
  dismissNotificationAsync: (...args: unknown[]) => mockDismissNotificationAsync(...args),
}));

jest.mock('../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { renderHook, waitFor } from '@testing-library/react-native';
import { useLocalBoardingPromptGate } from '../hooks/useLocalBoardingPromptGate';
import { getStationById } from '../../../shared/utils/stationRoute';
import { makeDirectRoute } from '../../../testUtils/routeFixtures';
import { ACTIVE_TRIP_KEY } from '../../../shared/constants/storageKeys';
import { BOARDING_PROMPT_CATEGORY } from '../utils/notificationCategory';
import type { StationArrival } from '../../../shared/types/arrival';

// 대화(3-001) → 정발산(3-003), 3호선 단조 구간. boardingPromptContext.test.ts 선례와 동일 fixture —
// direction='down' 확정 케이스.
const current = getStationById('3-001')!; // 대화
const destination = getStationById('3-003')!; // 정발산
const route = makeDirectRoute(2, '3');

describe('#2422 whole-chain wire — boardable ⇒ local boarding-prompt fired', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storage.clear();
  });

  const boardableArrival: StationArrival = {
    up: [],
    down: [
      {
        destination: '정발산',
        arrivalMinutes: 2,
        arrivalSeconds: 120,
        statusMessage: '전역 출발',
        trainCode: '3026001',
        line: '3',
        receivedAtMs: Date.now(),
        arrivalCode: 3,
        isLastTrain: false,
        trainType: 'normal',
      },
    ],
  };

  it(
    'GREEN — 근접 GPS fix + 같은 노선/방향 도착열차 존재(boardable) + trip 등록됨(ACTIVE_TRIP_KEY) ' +
      '이면 실 체인이 BOARDING_PROMPT_CATEGORY 로컬 알림을 실제로 스케줄한다',
    async () => {
      storage.set(ACTIVE_TRIP_KEY, 'trip-2422-wire');

      renderHook(() =>
        useLocalBoardingPromptGate({
          route,
          currentStation: current,
          destination,
          lock: null,
          gpsFix: { lat: current.lat, lng: current.lng, accuracyM: 10 },
          arrival: boardableArrival,
        }),
      );

      await waitFor(() => {
        expect(mockScheduleNotificationAsync).toHaveBeenCalledTimes(1);
      });

      const [[call]] = mockScheduleNotificationAsync.mock.calls;
      expect(call.content.categoryIdentifier).toBe(BOARDING_PROMPT_CATEGORY);
      expect(call.content.data).toEqual({
        kind: 'boarding-prompt',
        originStation: current.name,
        line: '3',
        tripToken: 'trip-2422-wire',
        destinationDirection: 'down',
      });
      expect(call.trigger).toBeNull();
    },
  );

  it('RED 대조군 — ACTIVE_TRIP_KEY 미등록(backend register 전)이면 boardable해도 발사하지 않는다', async () => {
    renderHook(() =>
      useLocalBoardingPromptGate({
        route,
        currentStation: current,
        destination,
        lock: null,
        gpsFix: { lat: current.lat, lng: current.lng, accuracyM: 10 },
        arrival: boardableArrival,
      }),
    );

    // 발사 시도 자체는 일어나지만(ACTIVE_TRIP_KEY 조회까지 진행) 최종 스케줄 호출은 없어야 한다.
    await waitFor(() => {
      expect(mockGetItem).toHaveBeenCalledWith(ACTIVE_TRIP_KEY);
    });
    expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('RED 대조군 — GPS fix가 근접 마진 밖이면(멀리 떨어짐) boardable 판정 자체가 fail해 발사하지 않는다', async () => {
    storage.set(ACTIVE_TRIP_KEY, 'trip-2422-wire');

    renderHook(() =>
      useLocalBoardingPromptGate({
        route,
        currentStation: current,
        destination,
        lock: null,
        // 위도 0.01도 ≈ 1.1km 이동 — LOCAL_BOARDING_PROMPT_PROXIMITY_MARGIN_M(150m)를 훌쩍 초과.
        gpsFix: { lat: current.lat + 0.01, lng: current.lng, accuracyM: 10 },
        arrival: boardableArrival,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
  });
});
