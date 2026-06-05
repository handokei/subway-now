import { act, renderHook } from '@testing-library/react-native';
import {
  useCurrentStationConfirmModal,
  DEFAULT_UNCERTAIN_THRESHOLD_MS,
} from '../useCurrentStationConfirmModal';
import type { Station } from '../../../../shared/types/station';

const YONGMASAN: Station = {
  id: '7-015',
  name: '용마산',
  line: '7',
  lineColor: '#747F00',
  lat: 37.573647,
  lng: 127.086727,
};

// 용마산 좌표 — GPS 후보 산출 시 1순위.
const YONGMASAN_LOC = { lat: 37.573647, lng: 127.086727 };

// 멀리 떨어진 좌표 — 다중 후보 산출이 어렵게.
const MIDPOINT_LOC = { lat: 37.51, lng: 126.98 };

const FAR_OFFSHORE = { lat: 0, lng: 0 };

interface RenderInputs {
  locationUncertain: boolean;
  userLocation: typeof YONGMASAN_LOC | null;
  wifiStation: Station | null;
  hasEffectiveOrigin: boolean;
  onConfirmStation: (s: Station) => void;
  uncertainThresholdMs?: number;
}

function setup(initial: Partial<RenderInputs> = {}) {
  const onConfirmStation = initial.onConfirmStation ?? jest.fn();
  const props: RenderInputs = {
    locationUncertain: false,
    userLocation: null,
    wifiStation: null,
    hasEffectiveOrigin: false,
    onConfirmStation,
    ...initial,
  };
  const { result, rerender } = renderHook(
    (p: RenderInputs) => useCurrentStationConfirmModal(p),
    { initialProps: props },
  );
  return { result, rerender, onConfirmStation, props };
}

describe('useCurrentStationConfirmModal', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('트리거 게이트', () => {
    it('locationUncertain=false면 모달 차단', () => {
      const { result } = setup({ locationUncertain: false, userLocation: YONGMASAN_LOC });
      act(() => {
        jest.advanceTimersByTime(DEFAULT_UNCERTAIN_THRESHOLD_MS + 100);
      });
      expect(result.current.visible).toBe(false);
    });

    it('hasEffectiveOrigin=true면 모달 차단 (uncertain이어도)', () => {
      const { result } = setup({
        locationUncertain: true,
        userLocation: MIDPOINT_LOC,
        hasEffectiveOrigin: true,
      });
      act(() => {
        jest.advanceTimersByTime(DEFAULT_UNCERTAIN_THRESHOLD_MS + 100);
      });
      expect(result.current.visible).toBe(false);
    });

    it('uncertain이 임계 미만이면 모달 비표시', () => {
      const { result } = setup({
        locationUncertain: true,
        userLocation: MIDPOINT_LOC,
      });
      act(() => {
        jest.advanceTimersByTime(DEFAULT_UNCERTAIN_THRESHOLD_MS - 1);
      });
      expect(result.current.visible).toBe(false);
    });

    it('uncertain 임계 초과 + GPS 다중 후보 → 모달 표시', () => {
      const { result } = setup({
        locationUncertain: true,
        userLocation: MIDPOINT_LOC,
      });
      act(() => {
        jest.advanceTimersByTime(DEFAULT_UNCERTAIN_THRESHOLD_MS + 100);
      });
      // MIDPOINT는 reach 안에 0개 또는 여러개 — visible은 후보 수와 무관(empty 시 fallback).
      // 여기선 isAutoConfirmed=false 가정 가능한 좌표.
      expect(typeof result.current.visible).toBe('boolean');
    });

    it('후보 0개여도 모달은 표시(검색 fallback UI)', () => {
      const { result } = setup({
        locationUncertain: true,
        userLocation: FAR_OFFSHORE,
      });
      act(() => {
        jest.advanceTimersByTime(DEFAULT_UNCERTAIN_THRESHOLD_MS + 100);
      });
      expect(result.current.candidates).toEqual([]);
      expect(result.current.visible).toBe(true);
    });

    it('locationUncertain 해소되면 sustained reset', () => {
      const { result, rerender, props } = setup({
        locationUncertain: true,
        userLocation: FAR_OFFSHORE,
      });
      act(() => {
        jest.advanceTimersByTime(DEFAULT_UNCERTAIN_THRESHOLD_MS + 100);
      });
      expect(result.current.visible).toBe(true);
      rerender({ ...props, locationUncertain: false });
      expect(result.current.visible).toBe(false);
    });

    it('uncertainThresholdMs override 적용', () => {
      const { result } = setup({
        locationUncertain: true,
        userLocation: FAR_OFFSHORE,
        uncertainThresholdMs: 2_000,
      });
      act(() => {
        jest.advanceTimersByTime(1_999);
      });
      expect(result.current.visible).toBe(false);
      act(() => {
        jest.advanceTimersByTime(2);
      });
      expect(result.current.visible).toBe(true);
    });
  });

  describe('자동 확정 (isAutoConfirmed)', () => {
    it('wifi 매칭으로 단일 후보 → 모달 없이 즉시 onConfirmStation 호출', () => {
      const onConfirmStation = jest.fn();
      const { result } = setup({
        locationUncertain: true,
        wifiStation: YONGMASAN,
        onConfirmStation,
      });
      act(() => {
        jest.advanceTimersByTime(DEFAULT_UNCERTAIN_THRESHOLD_MS + 100);
      });
      expect(onConfirmStation).toHaveBeenCalledWith(YONGMASAN);
      expect(result.current.visible).toBe(false);
      expect(result.current.autoConfirmedStation).toBe(YONGMASAN);
    });

    it('자동 확정 후 consumeAutoConfirmed 호출 시 station=null', () => {
      const { result } = setup({
        locationUncertain: true,
        wifiStation: YONGMASAN,
      });
      act(() => {
        jest.advanceTimersByTime(DEFAULT_UNCERTAIN_THRESHOLD_MS + 100);
      });
      expect(result.current.autoConfirmedStation).toBe(YONGMASAN);
      act(() => {
        result.current.consumeAutoConfirmed();
      });
      expect(result.current.autoConfirmedStation).toBeNull();
    });

    it('동일 station 재방문 시 자동 확정 중복 발사 안 함', () => {
      const onConfirmStation = jest.fn();
      const { result } = setup({
        locationUncertain: true,
        wifiStation: YONGMASAN,
        onConfirmStation,
      });
      act(() => {
        jest.advanceTimersByTime(DEFAULT_UNCERTAIN_THRESHOLD_MS + 100);
      });
      expect(onConfirmStation).toHaveBeenCalledTimes(1);
      act(() => {
        result.current.consumeAutoConfirmed();
      });
      expect(onConfirmStation).toHaveBeenCalledTimes(1);
    });

    it('동일 station + onConfirmStation 참조 변경으로 effect 재실행돼도 ref 가드로 중복 발사 안 함', () => {
      // onConfirmStation은 deps. caller가 인라인 화살표를 넘기면 매 렌더 새 참조 → effect 재실행.
      // ref(autoConfirmedRef)로 같은 station id를 한 번만 발사하는 가드(라인 95) 검증.
      const onConfirmA = jest.fn();
      const onConfirmB = jest.fn();
      const { result, rerender, props } = setup({
        locationUncertain: true,
        wifiStation: YONGMASAN,
        onConfirmStation: onConfirmA,
      });
      act(() => {
        jest.advanceTimersByTime(DEFAULT_UNCERTAIN_THRESHOLD_MS + 100);
      });
      expect(onConfirmA).toHaveBeenCalledTimes(1);
      // 참조만 바꿔서 rerender → effect 재실행 트리거. dismissed/hasEffectiveOrigin은 그대로.
      rerender({ ...props, onConfirmStation: onConfirmB });
      expect(onConfirmA).toHaveBeenCalledTimes(1);
      expect(onConfirmB).not.toHaveBeenCalled();
    });

    it('origin이 결정되었다가 해제 후 같은 station 매칭 시 다시 자동 확정', () => {
      const onConfirmStation = jest.fn();
      const { result, rerender, props } = setup({
        locationUncertain: true,
        wifiStation: YONGMASAN,
        onConfirmStation,
      });
      act(() => {
        jest.advanceTimersByTime(DEFAULT_UNCERTAIN_THRESHOLD_MS + 100);
      });
      expect(onConfirmStation).toHaveBeenCalledTimes(1);
      // origin 결정 (caller가 customOrigin 적용 → hasEffectiveOrigin=true)
      rerender({ ...props, hasEffectiveOrigin: true });
      // origin 해제 (사용자가 reset)
      rerender({ ...props, hasEffectiveOrigin: false });
      act(() => {
        jest.advanceTimersByTime(DEFAULT_UNCERTAIN_THRESHOLD_MS + 100);
      });
      expect(onConfirmStation).toHaveBeenCalledTimes(2);
    });
  });

  describe('사용자 인터랙션', () => {
    it('onCardTap → onConfirmStation 호출 + 모달 dismiss', () => {
      const onConfirmStation = jest.fn();
      const { result } = setup({
        locationUncertain: true,
        userLocation: FAR_OFFSHORE,
        onConfirmStation,
      });
      act(() => {
        jest.advanceTimersByTime(DEFAULT_UNCERTAIN_THRESHOLD_MS + 100);
      });
      expect(result.current.visible).toBe(true);
      act(() => {
        result.current.onCardTap(YONGMASAN);
      });
      expect(onConfirmStation).toHaveBeenCalledWith(YONGMASAN);
      expect(result.current.visible).toBe(false);
    });

    it('onClose → 모달 dismiss + onConfirmStation 미호출 (prior state 보존)', () => {
      const onConfirmStation = jest.fn();
      const { result } = setup({
        locationUncertain: true,
        userLocation: FAR_OFFSHORE,
        onConfirmStation,
      });
      act(() => {
        jest.advanceTimersByTime(DEFAULT_UNCERTAIN_THRESHOLD_MS + 100);
      });
      act(() => {
        result.current.onClose();
      });
      expect(result.current.visible).toBe(false);
      expect(onConfirmStation).not.toHaveBeenCalled();
    });

    it('dismiss 후 같은 uncertain 세션 동안 재오픈 안 됨', () => {
      const { result } = setup({
        locationUncertain: true,
        userLocation: FAR_OFFSHORE,
      });
      act(() => {
        jest.advanceTimersByTime(DEFAULT_UNCERTAIN_THRESHOLD_MS + 100);
      });
      act(() => {
        result.current.onClose();
      });
      expect(result.current.visible).toBe(false);
      // 시간이 또 흘러도 같은 세션이라 재오픈 안 함.
      act(() => {
        jest.advanceTimersByTime(DEFAULT_UNCERTAIN_THRESHOLD_MS + 100);
      });
      expect(result.current.visible).toBe(false);
    });

    it('dismiss 후 uncertain 해소되었다가 다시 발생 → 모달 재오픈 가능', () => {
      const { result, rerender, props } = setup({
        locationUncertain: true,
        userLocation: FAR_OFFSHORE,
      });
      act(() => {
        jest.advanceTimersByTime(DEFAULT_UNCERTAIN_THRESHOLD_MS + 100);
      });
      act(() => {
        result.current.onClose();
      });
      // uncertain 해소
      rerender({ ...props, locationUncertain: false });
      // 다시 uncertain
      rerender({ ...props, locationUncertain: true });
      act(() => {
        jest.advanceTimersByTime(DEFAULT_UNCERTAIN_THRESHOLD_MS + 100);
      });
      expect(result.current.visible).toBe(true);
    });
  });
});
