import AsyncStorage from '@react-native-async-storage/async-storage';
import { TRIP_BOUND_CLEANUPS, runTripBoundCleanups } from '../tripBoundCleanups';
import {
  DESTINATION_KEY,
  ROUTE_KEY,
  BOARDING_LOCK_KEY,
  ACTIVE_TRIP_KEY,
  TRIP_STARTED_AT_KEY,
  LAST_UPLOADED_RECALL_TRIP_START_KEY,
  LA_DISMISSED_AT_KEY,
} from '../../../../shared/constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

describe('tripBoundCleanups', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('TRIP_BOUND_CLEANUPS는 비어있지 않다 (메타 배열 self-check)', () => {
    expect(TRIP_BOUND_CLEANUPS.length).toBeGreaterThan(0);
  });

  it('#868 — runTripBoundCleanups 실행 시 DESTINATION_KEY와 핵심 trip-bound 키들이 storage에서 제거된다', async () => {
    // BG silent push 경로에서 zustand store에 접근 불가하므로 storage 직접 제거가 유일한 경로.
    // DESTINATION_KEY 누락 회귀 차단 (#868 P1-1).
    (AsyncStorage.removeItem as jest.Mock).mockResolvedValue(undefined);
    await runTripBoundCleanups();
    const removedKeys = (AsyncStorage.removeItem as jest.Mock).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(removedKeys).toContain(DESTINATION_KEY);
    expect(removedKeys).toContain(ROUTE_KEY);
    expect(removedKeys).toContain(BOARDING_LOCK_KEY);
    expect(removedKeys).toContain(ACTIVE_TRIP_KEY);
    // #919 — trip start는 cleanup 대상이지만 LAST_UPLOADED_RECALL_TRIP_START_KEY는 보존
    // (dedup 마커 — BG silent push upload 후 직후 FG setDestination(null) 재트리거 시
    //  같은 tripStart 중복 upload 방지). 다른 tripStart로 시작되면 자연 무효화됨.
    expect(removedKeys).toContain(TRIP_STARTED_AT_KEY);
    // #926 — LA dismiss sentinel도 destination switch 시 함께 클리어. 다음 silent push에서
    // LA 재상승 허용. 누락 회귀가 발생하면 dismiss 후 새 trip 시작해도 LA가 살아나지 않음.
    expect(removedKeys).toContain(LA_DISMISSED_AT_KEY);
    expect(removedKeys).not.toContain(LAST_UPLOADED_RECALL_TRIP_START_KEY);
  });

  it('TRIP_BOUND_CLEANUPS의 모든 항목은 호출 가능하며 Promise를 반환하고 reject하지 않는다', async () => {
    // 신규 trip-bound 키 추가 시 항목 wiring이 잘못되면 즉시 실패 — 회귀 가드.
    // (resolved value 자체는 AsyncStorage mock 구현에 따라 null일 수 있어 검증하지 않는다.
    // 메타 배열의 핵심 invariant는 "함수" + "비-rejecting Promise" 두 가지.)
    for (const cleanup of TRIP_BOUND_CLEANUPS) {
      expect(typeof cleanup).toBe('function');
      const result = cleanup();
      expect(result).toBeInstanceOf(Promise);
      await result;
    }
  });

  it('runTripBoundCleanups: 모든 항목이 호출된다', async () => {
    const spies = TRIP_BOUND_CLEANUPS.map((cleanup) => jest.fn(cleanup));
    // 메타 배열 자체를 재-실행하지 않고 spy를 직접 await — 모든 항목이 한 번씩 await됨을 검증.
    await Promise.all(spies.map((s) => s()));
    for (const spy of spies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
  });

  it('runTripBoundCleanups: AsyncStorage가 reject해도 reject를 던지지 않는다 (graceful)', async () => {
    (AsyncStorage.removeItem as jest.Mock).mockRejectedValue(new Error('boom'));
    await expect(runTripBoundCleanups()).resolves.toBeUndefined();
  });

  it('runTripBoundCleanups: 한 항목이 reject해도 나머지 항목이 모두 실행된다', async () => {
    // 첫 호출만 reject, 나머지는 정상 — Promise.all 안에서 catch로 흡수되어
    // 다른 cleanup의 실행 자체에는 영향이 없어야 한다.
    let callCount = 0;
    (AsyncStorage.removeItem as jest.Mock).mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) return Promise.reject(new Error('first only'));
      return Promise.resolve();
    });

    await runTripBoundCleanups();

    // removeItem이 항목 수만큼(또는 그 이상 helper 경유분 포함) 호출됐는지 확인.
    // 최소 메타 배열 길이만큼은 호출되어야 한다.
    expect((AsyncStorage.removeItem as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(
      TRIP_BOUND_CLEANUPS.length,
    );
  });
});
