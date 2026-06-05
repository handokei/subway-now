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
  useEffect(() => {
    if (!uncertainSustained || dismissed || hasEffectiveOrigin) return;
    if (!isAutoConfirmed || topPick === null) return;
    if (autoConfirmedRef.current === topPick.id) return;
    autoConfirmedRef.current = topPick.id;
    setAutoConfirmedStation(topPick);
    onConfirmStation(topPick);
  }, [uncertainSustained, dismissed, hasEffectiveOrigin, isAutoConfirmed, topPick, onConfirmStation]);

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

  const visible = useMemo(
    () =>
      uncertainSustained &&
      !dismissed &&
      !hasEffectiveOrigin &&
      !isAutoConfirmed,
    [uncertainSustained, dismissed, hasEffectiveOrigin, isAutoConfirmed],
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
