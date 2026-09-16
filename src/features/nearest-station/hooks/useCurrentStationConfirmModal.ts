/**
 * F4 1탭 현재역 확정 모달 트리거 hook (#914, Epic #912).
 *
 * `useStationCandidates`(F2/F3 narrow)로 후보를 산출하고, 자동 추정이 길어지면(locationUncertain
 * 지속) 모달을 띄울지 결정한다.
 *
 *  - origin이 이미 결정돼 있으면(`hasEffectiveOrigin=true`) 모달 차단 — 사용자 흐름 방해 없음.
 *  - locationUncertain이 `uncertainThresholdMs`(기본 8s) 이상 지속되면 후보 산출 후 트리거.
 *  - `isAutoConfirmed`(wifi 단일 매칭, GPS 단일 후보 등)면 모달 없이 즉시 `onConfirmStation`
 *    호출 + `autoConfirmedStation` 노출 → caller가 toast 표시.
 *  - 후보 2~3개면 `visible=true` → 모달 1탭 확정.
 *  - 후보 0개면 모달은 띄우지만 검색 fallback UI(`onSearchFallback`)로 안내.
 *  - 사용자 close = 상태 보존(아무 부수효과 없음, dismiss = 검색은 호출자 정책).
 *
 * 본 hook은 모달 visibility 결정 + 후보 산출만 담당. customOrigin 적용/검색 모달 오픈은
 * HomeScreen이 callback으로 받아 wire 한다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStationCandidates } from './useStationCandidates';
import type { Station } from '../../../shared/types/station';

/** locationUncertain이 이 시간 이상 지속되면 트리거. cold start 직후 깜빡임을 흡수. */
export const DEFAULT_UNCERTAIN_THRESHOLD_MS = 8_000;

export interface UseCurrentStationConfirmModalInputs {
  /** `useFusedNearestStation().locationUncertain`. */
  readonly locationUncertain: boolean;
  /** GPS 좌표. F4 candidates 산출 입력. */
  readonly userLocation: { readonly lat: number; readonly lng: number } | null;
  /** F2 wifi SSID 매칭 결과. 미가용이면 null. */
  readonly wifiStation: Station | null;
  /** origin이 이미 결정돼 있으면 모달 차단 — UX 방해 회피. */
  readonly hasEffectiveOrigin: boolean;
  /**
   * #1541 — trip(목적지)이 활성 상태이면 F4 자동 확정/모달 모두 비활성.
   *
   * trip 중에는 effectiveOrigin이 lock(boardingLock) 또는 customOrigin(사용자 명시 의향)으로
   * 이미 묶여 있는 게 정상이며, GPS pause(BG 진입/지하 dead zone)로 `result?.station`이
   * 일시적으로 null이 되어 hasEffectiveOrigin이 false로 떨어지더라도 F4가 다른 station을
   * customOrigin으로 설정하면 trip-locked origin을 영구 덮어쓰는 stuck 회귀가 발생한다
   * (2026-06-19 트립 2 "고터 11분 stuck").
   *
   * trip 활성 중에는 origin 정정을 사용자 수동 탭(BoardingTrainList / OriginPicker) 또는
   * 강 SSOT consensus(useDestinationStore.clearCustomOriginForSsotOverride)로만 허용한다.
   */
  readonly tripActive?: boolean;
  /** 사용자 1탭 또는 자동 확정 시 호출 (customOrigin 적용). */
  readonly onConfirmStation: (station: Station) => void;
  /** uncertain 지속 임계값(ms). 기본 8000. */
  readonly uncertainThresholdMs?: number;
}

export interface UseCurrentStationConfirmModalResult {
  /** 모달 표시 여부. */
  readonly visible: boolean;
  /** UI에 뿌릴 후보. */
  readonly candidates: readonly Station[];
  /** 강조 표시 후보. */
  readonly topPick: Station | null;
  /** 카드 탭 핸들러 (caller가 modal 추가 close 처리 불필요 — 내부에서 close 처리). */
  readonly onCardTap: (station: Station) => void;
  /** 모달 X close 핸들러. 상태 보존(아무 부수효과 없음). */
  readonly onClose: () => void;
  /** 자동 확정된 station — 1회성 신호. caller가 toast 표시 후 `consumeAutoConfirmed` 호출. */
  readonly autoConfirmedStation: Station | null;
  /** autoConfirmedStation 신호 소비 — toast가 사라진 뒤 호출. */
  readonly consumeAutoConfirmed: () => void;
}

export function useCurrentStationConfirmModal(
  inputs: UseCurrentStationConfirmModalInputs,
): UseCurrentStationConfirmModalResult {
  const {
    locationUncertain,
    userLocation,
    wifiStation,
    hasEffectiveOrigin,
    tripActive = false,
    onConfirmStation,
    uncertainThresholdMs = DEFAULT_UNCERTAIN_THRESHOLD_MS,
  } = inputs;

  const { candidates, topPick, isAutoConfirmed } = useStationCandidates({
    userLocation,
    wifiStation,
  });

  const [uncertainSustained, setUncertainSustained] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [autoConfirmedStation, setAutoConfirmedStation] = useState<Station | null>(null);
  const autoConfirmedRef = useRef<string | null>(null);

  // locationUncertain false 또는 origin 결정되면 sustained 타이머 reset + 사용자 dismiss 해제.
  // 같은 uncertain 세션을 한 번 닫으면 origin이 바뀌거나 uncertain이 해소될 때까지 다시 안 뜬다.
  useEffect(() => {
    if (!locationUncertain || hasEffectiveOrigin) {
      setUncertainSustained(false);
      setDismissed(false);
      return;
    }
    const handle = setTimeout(() => setUncertainSustained(true), uncertainThresholdMs);
    return () => clearTimeout(handle);
  }, [locationUncertain, hasEffectiveOrigin, uncertainThresholdMs]);

  // 자동 확정: visible 조건 충족 + isAutoConfirmed이면 모달 없이 즉시 적용. 같은 station 재진입은 1회만.
  // #1541 — trip 활성 중에는 자동 확정 비활성. trip-locked origin을 덮어쓰는 stuck 회귀 차단.
  useEffect(() => {
    if (!uncertainSustained || dismissed || hasEffectiveOrigin || tripActive) return;
    if (!isAutoConfirmed || topPick === null) return;
    if (autoConfirmedRef.current === topPick.id) return;
    autoConfirmedRef.current = topPick.id;
    setAutoConfirmedStation(topPick);
    onConfirmStation(topPick);
  }, [uncertainSustained, dismissed, hasEffectiveOrigin, tripActive, isAutoConfirmed, topPick, onConfirmStation]);

  // 자동 확정 ref reset — origin이 변경(또는 해제)되면 다음 uncertain 세션에서 다시 자동 확정 가능.
  useEffect(() => {
    if (!hasEffectiveOrigin) return;
    autoConfirmedRef.current = null;
  }, [hasEffectiveOrigin]);

  const onCardTap = useCallback(
    (station: Station) => {
      setDismissed(true);
      onConfirmStation(station);
    },
    [onConfirmStation],
  );

  const onClose = useCallback(() => {
    setDismissed(true);
  }, []);

  const consumeAutoConfirmed = useCallback(() => {
    setAutoConfirmedStation(null);
  }, []);

  // #1541 — trip 활성 중에는 modal도 차단(자동 확정과 일관). trip 중 origin 정정은
  // 수동 탭 또는 강 SSOT consensus 경유.
  const visible = useMemo(
    () =>
      uncertainSustained &&
      !dismissed &&
      !hasEffectiveOrigin &&
      !tripActive &&
      !isAutoConfirmed,
    [uncertainSustained, dismissed, hasEffectiveOrigin, tripActive, isAutoConfirmed],
  );

  return {
    visible,
    candidates,
    topPick,
    onCardTap,
    onClose,
    autoConfirmedStation,
    consumeAutoConfirmed,
  };
}
