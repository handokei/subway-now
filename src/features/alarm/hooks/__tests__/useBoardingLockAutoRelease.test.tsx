import { renderHook } from '@testing-library/react-native';
import {
  useBoardingLockAutoRelease,
  type UseBoardingLockAutoReleaseInputs,
} from '../useBoardingLockAutoRelease';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import type { Station } from '../../../../shared/types/station';
import {
  ARRIVAL_PROXIMITY_THRESHOLD_M,
  AUTO_RELEASE_GRACE_MS,
  LEG_TRANSITION_STATIONARY_GATE_MS,
} from '../../../../shared/constants/boardingLock';

const mockLoggerInfo = jest.fn();
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockLogLegTransition = jest.fn();
jest.mock('../../utils/alarmLog', () => ({
  logLegTransition: (input: unknown) => mockLogLegTransition(input),
}));

const lockA: BoardingLock = {
  destinationId: 'dest-1',
  trainCode: 'A',
  boardingStationId: 'origin-1',
  boardingLine: '2',
  boardedAt: 1_000,
  expectedDurationMs: 600_000,
};
const lockB: BoardingLock = { ...lockA, trainCode: 'B' };

const destinationStation: Station = {
  id: 'dest-1',
  name: '강남',
  line: '2',
  lineColor: '#000',
  lat: 37.5,
  lng: 127.0,
};
const otherStation: Station = {
  id: 'other-1',
  name: '역삼',
  line: '2',
  lineColor: '#000',
  lat: 37.5,
  lng: 127.0,
};

type Inputs = UseBoardingLockAutoReleaseInputs;

const T0 = 1_700_000_000_000;
const proximityKm = (ARRIVAL_PROXIMITY_THRESHOLD_M - 1) / 1000;
const farKm = (ARRIVAL_PROXIMITY_THRESHOLD_M + 50) / 1000;

function withDateNow<T>(value: number, fn: () => T): T {
  const spy = jest.spyOn(Date, 'now').mockReturnValue(value);
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

function baseInputs(overrides: Partial<Inputs> = {}): Inputs {
  return {
    lock: lockA,
    destinationId: 'dest-1',
    currentStation: destinationStation,
    distanceKm: proximityKm,
    releaseLock: jest.fn(),
    ...overrides,
  };
}

/**
 * rerender 지원 테스트의 공통 setup — T0에 hook을 마운트하고 rerender 함수를 돌려준다.
 * SonarCloud CPD가 잡는 동일 4줄 renderHook 호출을 한 곳에 두어 중복을 제거한다.
 */
function mountAtT0(initial: Inputs) {
  return withDateNow(T0, () =>
    renderHook((p: Inputs) => useBoardingLockAutoRelease(p), { initialProps: initial }),
  );
}

describe('useBoardingLockAutoRelease', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lock=null이면 release 안 함', () => {
    const releaseLock = jest.fn();
    withDateNow(T0, () => {
      renderHook(() => useBoardingLockAutoRelease(baseInputs({ lock: null, releaseLock })));
    });
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('destinationId=null이면 release 안 함', () => {
    const releaseLock = jest.fn();
    withDateNow(T0, () => {
      renderHook(() => useBoardingLockAutoRelease(baseInputs({ destinationId: null, releaseLock })));
    });
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('currentStation=null이면 release 안 함', () => {
    const releaseLock = jest.fn();
    withDateNow(T0, () => {
      renderHook(() => useBoardingLockAutoRelease(baseInputs({ currentStation: null, releaseLock })));
    });
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('distanceKm=null이면 release 안 함', () => {
    const releaseLock = jest.fn();
    withDateNow(T0, () => {
      renderHook(() => useBoardingLockAutoRelease(baseInputs({ distanceKm: null, releaseLock })));
    });
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('현재역이 목적지와 다르면 release 안 함', () => {
    const releaseLock = jest.fn();
    withDateNow(T0, () => {
      renderHook(() =>
        useBoardingLockAutoRelease(baseInputs({ currentStation: otherStation, releaseLock })),
      );
    });
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('현재역 매칭이지만 거리가 임계값 이상이면 release 안 함', () => {
    const releaseLock = jest.fn();
    withDateNow(T0, () => {
      renderHook(() => useBoardingLockAutoRelease(baseInputs({ distanceKm: farKm, releaseLock })));
    });
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('도착 조건 첫 진입에서는 release 안 함 (ts만 기록)', () => {
    const releaseLock = jest.fn();
    withDateNow(T0, () => {
      renderHook(() => useBoardingLockAutoRelease(baseInputs({ releaseLock })));
    });
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('도착 지속 시간이 grace 미만이면 release 안 함', () => {
    const releaseLock = jest.fn();
    const { rerender } = mountAtT0(baseInputs({ releaseLock }));
    // grace 미만 시점에 fusion update — distanceKm을 살짝 바꿔 effect 재실행 트리거.
    withDateNow(T0 + AUTO_RELEASE_GRACE_MS - 1, () => {
      rerender(baseInputs({ releaseLock, distanceKm: proximityKm - 0.01 }));
    });
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('도착 지속 시간이 grace 이상이면 release 호출', () => {
    const releaseLock = jest.fn();
    const { rerender } = mountAtT0(baseInputs({ releaseLock }));
    withDateNow(T0 + AUTO_RELEASE_GRACE_MS, () => {
      rerender(baseInputs({ releaseLock, distanceKm: proximityKm - 0.01 }));
    });
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith('destination grace 충족 → lock 자동 release');
  });

  it('grace 만료 후 같은 조건 유지되어도 중복 release 안 함 (ref 리셋되어 새 카운트)', () => {
    const releaseLock = jest.fn();
    const { rerender } = mountAtT0(baseInputs({ releaseLock }));
    withDateNow(T0 + AUTO_RELEASE_GRACE_MS, () => {
      rerender(baseInputs({ releaseLock, distanceKm: proximityKm - 0.01 }));
    });
    expect(releaseLock).toHaveBeenCalledTimes(1);

    // 추가 fusion update — release 직후라 ref가 null로 리셋. 새 ts를 기록만 함.
    withDateNow(T0 + AUTO_RELEASE_GRACE_MS + 1_000, () => {
      rerender(baseInputs({ releaseLock, distanceKm: proximityKm - 0.02 }));
    });
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('도착 후 거리 이탈하면 카운터 리셋 — 재진입 시 grace 새로 대기', () => {
    const releaseLock = jest.fn();
    const { rerender } = mountAtT0(baseInputs({ releaseLock }));
    // grace 절반 시점에 이탈
    withDateNow(T0 + AUTO_RELEASE_GRACE_MS / 2, () => {
      rerender(baseInputs({ releaseLock, distanceKm: farKm }));
    });
    // 재진입
    withDateNow(T0 + AUTO_RELEASE_GRACE_MS / 2 + 1_000, () => {
      rerender(baseInputs({ releaseLock, distanceKm: proximityKm }));
    });
    // 처음 grace의 절반 + 1초만 더 흘렀음 → 아직 release 안 됨
    withDateNow(T0 + AUTO_RELEASE_GRACE_MS - 1, () => {
      rerender(baseInputs({ releaseLock, distanceKm: proximityKm - 0.01 }));
    });
    expect(releaseLock).not.toHaveBeenCalled();

    // 재진입 시점 + grace 만큼 더 흘러야 release
    withDateNow(T0 + AUTO_RELEASE_GRACE_MS / 2 + 1_000 + AUTO_RELEASE_GRACE_MS, () => {
      rerender(baseInputs({ releaseLock, distanceKm: proximityKm - 0.02 }));
    });
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('도착 후 다른 역으로 변경되면 카운터 리셋', () => {
    const releaseLock = jest.fn();
    const { rerender } = mountAtT0(baseInputs({ releaseLock }));
    withDateNow(T0 + AUTO_RELEASE_GRACE_MS / 2, () => {
      rerender(baseInputs({ releaseLock, currentStation: otherStation }));
    });
    withDateNow(T0 + AUTO_RELEASE_GRACE_MS, () => {
      rerender(baseInputs({ releaseLock, currentStation: destinationStation }));
    });
    // 재진입 후 grace 만큼 안 흘렀음
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('trainCode 변경(새 trip/leg) 시 카운터 리셋 — 이전 trip ts 누수 차단', () => {
    const releaseLock = jest.fn();
    const { rerender } = mountAtT0(baseInputs({ releaseLock }));
    // 새 lock으로 교체
    withDateNow(T0 + AUTO_RELEASE_GRACE_MS / 2, () => {
      rerender(baseInputs({ releaseLock, lock: lockB }));
    });
    // 새 trip에서 grace 만큼 흘러야 release
    withDateNow(T0 + AUTO_RELEASE_GRACE_MS, () => {
      rerender(baseInputs({ releaseLock, lock: lockB, distanceKm: proximityKm - 0.01 }));
    });
    expect(releaseLock).not.toHaveBeenCalled();

    withDateNow(T0 + AUTO_RELEASE_GRACE_MS / 2 + AUTO_RELEASE_GRACE_MS, () => {
      rerender(baseInputs({ releaseLock, lock: lockB, distanceKm: proximityKm - 0.02 }));
    });
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('lock null → 활성으로 전환되어도 첫 활성 진입에서 ts만 기록 (즉시 release X)', () => {
    const releaseLock = jest.fn();
    const { rerender } = mountAtT0(baseInputs({ releaseLock, lock: null }));
    // 사용자가 막 탑승 — 도착 조건 충족하나 첫 진입
    withDateNow(T0 + 100, () => {
      rerender(baseInputs({ releaseLock }));
    });
    expect(releaseLock).not.toHaveBeenCalled();
  });

  // ── #899 (Seam C) — 환승 waypoint 자동 release 분기 ──

  const transferStation: Station = {
    id: 'transfer-1',
    name: '왕십리',
    line: '2',
    lineColor: '#000',
    lat: 37.6,
    lng: 127.0,
  };
  const transferRoute = {
    type: 'transfer' as const,
    transferName: '왕십리',
    fromLine: '2' as const,
    toLine: '5' as const,
    stopsToTransfer: 3,
    stopsFromTransfer: 4,
    secondsToTransfer: 360,
    secondsFromTransfer: 480,
  };

  it('환승 leg waypoint 도달 + proximity → grace 후 release', () => {
    const releaseLock = jest.fn();
    const inputs = baseInputs({
      releaseLock,
      currentStation: transferStation,
      route: transferRoute,
    });
    const { rerender } = mountAtT0(inputs);
    withDateNow(T0 + AUTO_RELEASE_GRACE_MS, () => {
      rerender({ ...inputs, distanceKm: proximityKm - 0.01 });
    });
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith('transfer grace 충족 → lock 자동 release');
  });

  it('route=null이면 환승 분기 불가 — 비목적지에서 release 안 함', () => {
    const releaseLock = jest.fn();
    const inputs = baseInputs({
      releaseLock,
      currentStation: transferStation,
      route: null,
    });
    const { rerender } = mountAtT0(inputs);
    withDateNow(T0 + AUTO_RELEASE_GRACE_MS, () => {
      rerender({ ...inputs, distanceKm: proximityKm - 0.01 });
    });
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('환승 leg fromLine과 lock.boardingLine 불일치면 release 안 함 (동명이역 회피)', () => {
    const releaseLock = jest.fn();
    const wrongLine = { ...transferRoute, fromLine: '5' as const };
    const inputs = baseInputs({
      releaseLock,
      currentStation: transferStation,
      route: wrongLine,
    });
    const { rerender } = mountAtT0(inputs);
    withDateNow(T0 + AUTO_RELEASE_GRACE_MS, () => {
      rerender({ ...inputs, distanceKm: proximityKm - 0.01 });
    });
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('multi-transfer route — 첫 환승역 매칭 시에도 release', () => {
    const releaseLock = jest.fn();
    const multiRoute = {
      type: 'multi-transfer' as const,
      transfers: [
        {
          transferName: '왕십리',
          fromLine: '2' as const,
          toLine: '5' as const,
          stopsToTransfer: 3,
          secondsToTransfer: 360,
        },
        {
          transferName: '광화문',
          fromLine: '5' as const,
          toLine: '3' as const,
          stopsToTransfer: 2,
          secondsToTransfer: 240,
        },
      ],
      stopsAfterLastTransfer: 4,
      secondsAfterLastTransfer: 480,
    };
    const inputs = baseInputs({
      releaseLock,
      currentStation: transferStation,
      route: multiRoute,
    });
    const { rerender } = mountAtT0(inputs);
    withDateNow(T0 + AUTO_RELEASE_GRACE_MS, () => {
      rerender({ ...inputs, distanceKm: proximityKm - 0.01 });
    });
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('direct route는 transfer 분기 없음 — 비목적지에서 release 안 함', () => {
    const releaseLock = jest.fn();
    const directRoute = {
      type: 'direct' as const,
      stops: 5,
      line: '2' as const,
      travelSeconds: 600,
    };
    const inputs = baseInputs({
      releaseLock,
      currentStation: transferStation,
      route: directRoute,
    });
    const { rerender } = mountAtT0(inputs);
    withDateNow(T0 + AUTO_RELEASE_GRACE_MS, () => {
      rerender({ ...inputs, distanceKm: proximityKm - 0.01 });
    });
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('lock 활성 → null로 전환 시 ref 리셋 (재활성 시 다시 grace 대기)', () => {
    const releaseLock = jest.fn();
    const { rerender } = mountAtT0(baseInputs({ releaseLock }));
    // 사용자가 명시 하차로 lock 해제
    withDateNow(T0 + AUTO_RELEASE_GRACE_MS / 2, () => {
      rerender(baseInputs({ releaseLock, lock: null }));
    });
    // 같은 destination으로 다시 탑승
    withDateNow(T0 + AUTO_RELEASE_GRACE_MS, () => {
      rerender(baseInputs({ releaseLock }));
    });
    // grace 새로 시작 — 아직 release 안 됨
    withDateNow(T0 + AUTO_RELEASE_GRACE_MS + AUTO_RELEASE_GRACE_MS - 1, () => {
      rerender(baseInputs({ releaseLock, distanceKm: proximityKm - 0.01 }));
    });
    expect(releaseLock).not.toHaveBeenCalled();
  });

  // ── #1887 (RC-14 paradigm 4) — transfer 분기 motion stationary 30s gate + leg-transition log ──

  it('transfer 분기 + motionStationary=true + grace + 30s gate 모두 충족 시 release + leg-transition log', () => {
    const releaseLock = jest.fn();
    const inputs = baseInputs({
      releaseLock,
      currentStation: transferStation,
      route: transferRoute,
      motionStationary: true,
    });
    const { rerender } = mountAtT0(inputs);
    // grace 만료 시점에 30s gate도 같이 충족되어야 release.
    // T0 진입 → grace+30s 모두 같은 ts0에서 카운트 시작하므로 max(grace, gate) 시점에 fire.
    const fireAt = T0 + Math.max(AUTO_RELEASE_GRACE_MS, LEG_TRANSITION_STATIONARY_GATE_MS);
    withDateNow(fireAt, () => {
      rerender({ ...inputs, distanceKm: proximityKm - 0.01 });
    });
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(mockLogLegTransition).toHaveBeenCalledWith({
      fromLine: '2',
      transferStationName: '왕십리',
    });
  });

  it('transfer 분기 + motionStationary=false면 grace 충족돼도 release 안 함 (30s gate 미충족)', () => {
    const releaseLock = jest.fn();
    const inputs = baseInputs({
      releaseLock,
      currentStation: transferStation,
      route: transferRoute,
      motionStationary: false,
    });
    const { rerender } = mountAtT0(inputs);
    withDateNow(T0 + AUTO_RELEASE_GRACE_MS + LEG_TRANSITION_STATIONARY_GATE_MS, () => {
      rerender({ ...inputs, distanceKm: proximityKm - 0.01 });
    });
    expect(releaseLock).not.toHaveBeenCalled();
    expect(mockLogLegTransition).not.toHaveBeenCalled();
  });

  it('transfer 분기 + motionStationary=true 늦게 latch — gate 시작 ts부터 30s 충족 시 release', () => {
    const releaseLock = jest.fn();
    const inputs = baseInputs({
      releaseLock,
      currentStation: transferStation,
      route: transferRoute,
      motionStationary: false,
    });
    const { rerender } = mountAtT0(inputs);
    // T0 + grace 시점에 motion이 stationary로 latch — gate ref가 이때부터 시작.
    const latchAt = T0 + AUTO_RELEASE_GRACE_MS;
    withDateNow(latchAt, () => {
      rerender({ ...inputs, motionStationary: true });
    });
    // gate ms 충족 안 됨 (29s) — 아직 release X.
    withDateNow(latchAt + LEG_TRANSITION_STATIONARY_GATE_MS - 1, () => {
      rerender({ ...inputs, motionStationary: true, distanceKm: proximityKm - 0.01 });
    });
    expect(releaseLock).not.toHaveBeenCalled();
    // gate ms 충족 — release fire.
    withDateNow(latchAt + LEG_TRANSITION_STATIONARY_GATE_MS, () => {
      rerender({ ...inputs, motionStationary: true, distanceKm: proximityKm - 0.02 });
    });
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(mockLogLegTransition).toHaveBeenCalledWith({
      fromLine: '2',
      transferStationName: '왕십리',
    });
  });

  it('transfer 분기 + motionStationary=undefined(미측정)면 기존 동작 (grace만 충족 시 release, log 없음 X — log는 transfer 분기 release 시 항상 적재)', () => {
    const releaseLock = jest.fn();
    const inputs = baseInputs({
      releaseLock,
      currentStation: transferStation,
      route: transferRoute,
      // motionStationary 미전달 → undefined
    });
    const { rerender } = mountAtT0(inputs);
    withDateNow(T0 + AUTO_RELEASE_GRACE_MS, () => {
      rerender({ ...inputs, distanceKm: proximityKm - 0.01 });
    });
    expect(releaseLock).toHaveBeenCalledTimes(1);
    // transfer 분기 release는 motionStationary 게이트와 무관하게 leg-transition log 적재.
    expect(mockLogLegTransition).toHaveBeenCalledWith({
      fromLine: '2',
      transferStationName: '왕십리',
    });
  });

  it('destination 분기는 motion stationary 게이트 미적용 (paradigm 4는 transfer 한정)', () => {
    const releaseLock = jest.fn();
    // destination 매칭 + motionStationary=false인데도 grace만으로 release 발화 — paradigm 4는 transfer 분기 전용.
    const { rerender } = mountAtT0(baseInputs({ releaseLock, motionStationary: false }));
    withDateNow(T0 + AUTO_RELEASE_GRACE_MS, () => {
      rerender(baseInputs({ releaseLock, motionStationary: false, distanceKm: proximityKm - 0.01 }));
    });
    expect(releaseLock).toHaveBeenCalledTimes(1);
    // destination 분기 release는 leg-transition log 미적재.
    expect(mockLogLegTransition).not.toHaveBeenCalled();
  });
});
