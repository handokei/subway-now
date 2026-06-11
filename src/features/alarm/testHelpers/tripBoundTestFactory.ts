/**
 * tripBoundScheduler / useTripBoundAlarmScheduler 테스트 공용 헬퍼.
 * SonarCloud #1187 — test 파일 dup 제거용.
 */
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import type { TripBoundStop } from '../utils/tripBoundScheduler';

/**
 * AppState.addEventListener를 가로채 FG-resume 시뮬레이션을 한 줄로 만들어준다.
 * Hook이 mount 시점에 listener를 등록하므로 fire() 호출 시점엔 항상 listener가 잡혀 있다.
 */
export function captureAppStateListener(): {
  fire: (state: AppStateStatus) => void;
  restore: () => void;
} {
  const ref: { current: ((state: AppStateStatus) => void) | null } = { current: null };
  const sub: NativeEventSubscription = { remove: jest.fn() };
  const spy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, cb) => {
      ref.current = cb;
      return sub;
    });
  return {
    fire: (state) => ref.current!(state),
    restore: () => spy.mockRestore(),
  };
}

/**
 * Build a uniform-length TripBoundStop list — first N-1 transfer, last destination.
 * Eliminates copy-pasted 5-stop arrays in window tests.
 */
export function makeUniformStops(names: string[]): TripBoundStop[] {
  return names.map((stationName, idx) => ({
    stationName,
    alarmType: idx === names.length - 1 ? 'destination' : 'transfer',
  }));
}

/** Build a uniform hop time array. */
export function makeUniformHops(count: number, hopMs = 120_000): number[] {
  return Array.from({ length: count }, () => hopMs);
}
