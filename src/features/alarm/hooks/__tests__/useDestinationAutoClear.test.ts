import { renderHook } from '@testing-library/react-native';
import {
  useDestinationAutoClear,
  pickDestinationArvlCd,
  type UseDestinationAutoClearInputs,
} from '../useDestinationAutoClear';
import type { Station } from '../../../../shared/types/station';
import type { StationArrival, ArrivalInfo } from '../../../../shared/types/arrival';
import {
  NEAR_STATION_RADIUS_M,
  STATIONARY_THRESHOLD_MS,
} from '../../../../shared/constants/arrivalDetect';

const mockUseArrivalInfo = jest.fn();
jest.mock('../../../arrival/hooks/useArrivalInfo', () => ({
  useArrivalInfo: (...args: unknown[]) => mockUseArrivalInfo(...args),
}));

const mockLoggerInfo = jest.fn();
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const destination: Station = {
  id: 'dest-1',
  name: '강남',
  line: '2',
  lineColor: '#000',
  lat: 37.498,
  lng: 127.028,
};
const altDestination: Station = { ...destination, id: 'dest-2', name: '잠실' };

const T0 = 1_700_000_000_000;

function withDateNow<T>(value: number, fn: () => T): T {
  const spy = jest.spyOn(Date, 'now').mockReturnValue(value);
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

/** 단일 train ArrivalInfo factory. arvlCd 외 필드는 detect와 무관. */
function makeTrain(arrivalCode: number): ArrivalInfo {
  return {
    destination: '왕십리행',
    arrivalMinutes: 0,
    arrivalSeconds: 0,
    statusMessage: '도착',
    trainCode: 'T-1',
    line: '2',
    receivedAtMs: T0,
    arrivalCode,
    isLastTrain: false,
    trainType: 'normal',
  };
}

function arrivalWithCodes(upCodes: number[], downCodes: number[] = []): StationArrival {
  return {
    up: upCodes.map(makeTrain),
    down: downCodes.map(makeTrain),
  };
}

function setArrival(arrival: StationArrival | null): void {
  mockUseArrivalInfo.mockReturnValue({ arrival, isMock: false, loading: false });
}

function baseInputs(overrides: Partial<UseDestinationAutoClearInputs> = {}): UseDestinationAutoClearInputs {
  return {
    destination,
    userLocation: { lat: destination.lat, lng: destination.lng },
    motionStationary: false,
    onAutoClear: jest.fn(),
    ...overrides,
  };
}

/**
 * 4단 setup (setArrival → onAutoClear → initial inputs → mountAtT0) 통합 helper.
 * SonarCloud가 잡는 rerender 기반 테스트들의 중복 boilerplate 제거(arrival 코드/onAutoClear/initial inputs를
 * 인자로 받아 같은 mount 시퀀스를 반환).
 */
function mountStationaryDetect(params: {
  arvlCodes: number[];
  inputOverrides?: Partial<UseDestinationAutoClearInputs>;
}) {
  setArrival(arrivalWithCodes(params.arvlCodes));
  const onAutoClear = jest.fn();
  const initial = baseInputs({
    onAutoClear,
    motionStationary: true,
    ...params.inputOverrides,
  });
  const { rerender } = withDateNow(T0, () =>
    renderHook((p: UseDestinationAutoClearInputs) => useDestinationAutoClear(p), {
      initialProps: initial,
    }),
  );
  return { onAutoClear, initial, rerender };
}

describe('pickDestinationArvlCd', () => {
  it('arrival=null이면 null', () => {
    expect(pickDestinationArvlCd(null)).toBeNull();
  });

  it('up/down 모두 비어 있으면 null', () => {
    expect(pickDestinationArvlCd(arrivalWithCodes([], []))).toBeNull();
  });

  it('ARRIVED(1) 우선 선택 — ENTERING(0)과 섞여도 1 반환', () => {
    expect(pickDestinationArvlCd(arrivalWithCodes([0, 1, 99]))).toBe(1);
  });

  it('ENTERING(0)만 있으면 0 반환', () => {
    expect(pickDestinationArvlCd(arrivalWithCodes([99, 2, 0]))).toBe(0);
  });

  it('우선순위 0인 코드만 있으면 null — detect가 "이 역 아님"으로 분류', () => {
    expect(pickDestinationArvlCd(arrivalWithCodes([2, 3, 99]))).toBeNull();
  });

  it('up/down 합쳐서 가장 강한 신호 반환', () => {
    expect(pickDestinationArvlCd(arrivalWithCodes([99], [1]))).toBe(1);
  });
});

describe('useDestinationAutoClear', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setArrival(null);
  });

  it('destination=null이면 onAutoClear 호출 안 함 + useArrivalInfo(null, null)로 폴링 정지', () => {
    const onAutoClear = jest.fn();
    withDateNow(T0, () => {
      renderHook(() => useDestinationAutoClear(baseInputs({ destination: null, onAutoClear })));
    });
    expect(onAutoClear).not.toHaveBeenCalled();
    expect(mockUseArrivalInfo).toHaveBeenCalledWith(null, null);
  });

  it('arvlCd 약함(99) → 발사 안 함', () => {
    setArrival(arrivalWithCodes([99]));
    const onAutoClear = jest.fn();
    withDateNow(T0 + STATIONARY_THRESHOLD_MS, () => {
      renderHook(() => useDestinationAutoClear(baseInputs({ onAutoClear, motionStationary: true })));
    });
    expect(onAutoClear).not.toHaveBeenCalled();
  });

  it('motionStationary=false면 발사 안 함 (정지 시간 카운트 안 함)', () => {
    setArrival(arrivalWithCodes([1]));
    const onAutoClear = jest.fn();
    withDateNow(T0, () => {
      renderHook(() => useDestinationAutoClear(baseInputs({ onAutoClear, motionStationary: false })));
    });
    expect(onAutoClear).not.toHaveBeenCalled();
  });

  it('첫 stationary 진입에서는 발사 안 함 (정지 시간 = 0)', () => {
    setArrival(arrivalWithCodes([1]));
    const onAutoClear = jest.fn();
    withDateNow(T0, () => {
      renderHook(() => useDestinationAutoClear(baseInputs({ onAutoClear, motionStationary: true })));
    });
    expect(onAutoClear).not.toHaveBeenCalled();
  });

  it('motionStationary 진입 후 60s 지나면 onAutoClear 1회 호출 + log + cleared station 전달', () => {
    const { onAutoClear, initial, rerender } = mountStationaryDetect({ arvlCodes: [1] });
    withDateNow(T0 + STATIONARY_THRESHOLD_MS, () => {
      // userLocation을 미세 변경해 effect 재실행 트리거 (좌표 가까운 jitter).
      rerender({ ...initial, userLocation: { lat: destination.lat + 0.00001, lng: destination.lng } });
    });
    expect(onAutoClear).toHaveBeenCalledTimes(1);
    // #1058: cleared station snapshot이 인자로 전달돼야 함 (undo 복원용).
    expect(onAutoClear).toHaveBeenCalledWith(destination);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'destination=강남 자동 해제 (confidence=high)',
    );
  });

  it('userLocation이 50m 밖이면 발사 안 함', () => {
    // 100m offset (1 deg lat ≈ 111km → 0.001 ≈ 111m → 안전하게 0.002)
    const far = { lat: destination.lat + 0.002, lng: destination.lng };
    const { onAutoClear, initial, rerender } = mountStationaryDetect({
      arvlCodes: [1],
      inputOverrides: { userLocation: far },
    });
    withDateNow(T0 + STATIONARY_THRESHOLD_MS, () => {
      rerender({ ...initial, userLocation: { ...far, lat: far.lat + 0.00001 } });
    });
    expect(onAutoClear).not.toHaveBeenCalled();
  });

  it('motionStationary가 중간에 끊기면 카운터 리셋 → 60s 새로 대기', () => {
    const { onAutoClear, initial, rerender } = mountStationaryDetect({ arvlCodes: [1] });
    // 30s 경과 후 잠깐 walking
    withDateNow(T0 + STATIONARY_THRESHOLD_MS / 2, () => {
      rerender({ ...initial, motionStationary: false });
    });
    // 다시 stationary, 30s 더 흐름 — 총 경과는 STATIONARY_THRESHOLD_MS지만 카운트는 리셋되어 0부터 시작
    withDateNow(T0 + STATIONARY_THRESHOLD_MS, () => {
      rerender({ ...initial, motionStationary: true });
    });
    expect(onAutoClear).not.toHaveBeenCalled();
  });

  it('한 trip에서 1회만 발사 — 같은 destination에서 후속 rerender는 no-op', () => {
    const { onAutoClear, initial, rerender } = mountStationaryDetect({ arvlCodes: [1] });
    withDateNow(T0 + STATIONARY_THRESHOLD_MS, () => {
      rerender({ ...initial, userLocation: { lat: destination.lat + 0.00001, lng: destination.lng } });
    });
    expect(onAutoClear).toHaveBeenCalledTimes(1);
    // 같은 destination에서 추가 update — fired ref가 막아 재발사 안 함
    withDateNow(T0 + STATIONARY_THRESHOLD_MS + 30_000, () => {
      rerender({ ...initial, userLocation: { lat: destination.lat + 0.00002, lng: destination.lng } });
    });
    expect(onAutoClear).toHaveBeenCalledTimes(1);
  });

  it('destination 변경 시 fired ref 리셋 — 새 destination도 1회 발사 가능', () => {
    const { onAutoClear, initial, rerender } = mountStationaryDetect({ arvlCodes: [1] });
    withDateNow(T0 + STATIONARY_THRESHOLD_MS, () => {
      rerender({ ...initial, userLocation: { lat: destination.lat + 0.00001, lng: destination.lng } });
    });
    expect(onAutoClear).toHaveBeenCalledTimes(1);

    // 새 destination — userLocation도 새 dest 부근으로 이동
    const newInputs: UseDestinationAutoClearInputs = {
      ...initial,
      destination: altDestination,
      userLocation: { lat: altDestination.lat, lng: altDestination.lng },
    };
    withDateNow(T0 + STATIONARY_THRESHOLD_MS + 1_000, () => {
      rerender(newInputs);
    });
    // 새 trip 첫 진입 — stationary ref가 새 timestamp만 기록
    withDateNow(T0 + STATIONARY_THRESHOLD_MS + 1_000 + STATIONARY_THRESHOLD_MS, () => {
      rerender({
        ...newInputs,
        userLocation: { lat: altDestination.lat + 0.00001, lng: altDestination.lng },
      });
    });
    expect(onAutoClear).toHaveBeenCalledTimes(2);
  });

  it('destination null로 전환 시 stationary ref 리셋 — 같은 destination 재설정 시 새 카운트', () => {
    const { onAutoClear, initial, rerender } = mountStationaryDetect({ arvlCodes: [1] });
    // stationary 30s 누적 후 destination null로 전환
    withDateNow(T0 + STATIONARY_THRESHOLD_MS / 2, () => {
      rerender({ ...initial, destination: null });
    });
    // 같은 destination 재설정 — 카운터 0부터 다시 시작
    withDateNow(T0 + STATIONARY_THRESHOLD_MS / 2 + 1_000, () => {
      rerender(initial);
    });
    // 60s 더 흘러야 발사 — 50s만 흐른 시점은 안 됨
    withDateNow(T0 + STATIONARY_THRESHOLD_MS / 2 + 1_000 + STATIONARY_THRESHOLD_MS - 10_000, () => {
      rerender({ ...initial, userLocation: { lat: destination.lat + 0.00001, lng: destination.lng } });
    });
    expect(onAutoClear).not.toHaveBeenCalled();
  });

  it('userLocation=null이면 detect 입력 불충분 → 발사 안 함', () => {
    const { onAutoClear, initial, rerender } = mountStationaryDetect({
      arvlCodes: [1],
      inputOverrides: { userLocation: null },
    });
    withDateNow(T0 + STATIONARY_THRESHOLD_MS, () => {
      rerender({ ...initial });
    });
    expect(onAutoClear).not.toHaveBeenCalled();
  });

  it('확인용 — NEAR_STATION_RADIUS_M(50m) 경계 직전이면 발사', () => {
    // ~40m 정도 — 100m 보수.  111000 m/deg lat → 40m ≈ 0.00036 deg
    const near = { lat: destination.lat + 0.00036, lng: destination.lng };
    expect(NEAR_STATION_RADIUS_M).toBe(50); // sanity — 변경 시 본 테스트 보정 필요
    const { onAutoClear, initial, rerender } = mountStationaryDetect({
      arvlCodes: [0], // ENTERING도 통과
      inputOverrides: { userLocation: near },
    });
    withDateNow(T0 + STATIONARY_THRESHOLD_MS, () => {
      rerender({ ...initial, userLocation: { ...near, lat: near.lat + 0.00001 } });
    });
    expect(onAutoClear).toHaveBeenCalledTimes(1);
  });
});
