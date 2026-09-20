/* eslint-disable import/no-restricted-paths --
 * #2768 (게이트 전수감사 C, ⑤) — 자동 종료 발동을 alarmLog로 stamp한다. cross-feature 적재는
 * computeBoardableWaitsForRoute.ts/useV1MismatchDetector.ts 등과 같은 기존 패턴 — 다른 feature
 * 슬라이스가 alarm feature의 alarmLog(관측 전용 ring buffer)에 직접 적재하는 것은 이미 여러
 * 곳에서 옵트인된 공용 관측 채널이다.
 */
import { useEffect, useRef, useState } from 'react';
import type { FusionSource } from '../../../shared/types/fusion';
import { logArrivalAutoClearFired } from '../../alarm/utils/alarmLog';

const ARRIVAL_THRESHOLD_KM = 0.5;
const CLEAR_DELAY_MS = 2000;

export interface UseArrivalAutoClearParams {
  currentStationName: string | undefined;
  distanceKm: number | undefined;
  /**
   * #2716 — distanceKm의 출처. `backend-ssot` tier는 mirror가 사용자 위치를 모르는 상태에서
   * distanceKm=0을 placeholder로 보고한다(실측 아님). 이 값이 'backend-ssot'이면 distanceKm
   * 임계값 비교를 신뢰하지 않고 destinationArrivalConfirmed로 대체한다.
   */
  distanceSource: FusionSource | undefined;
  /**
   * #2741 — true면 distanceKm이 실측이 아니라 placeholder(관례적으로 0)다. `wifi-ssid`는
   * GPS 있음(실측)/없음(placeholder) 두 경우 모두 같은 distanceSource 값을 쓰므로
   * distanceSource만으로는 두 경우를 구분할 수 없다 — caller
   * (NearestStationResult.distanceIsPlaceholder)가 계산해 전달한다. `backend-ssot`는 항상
   * placeholder이지만 #2716이 이미 distanceSource==='backend-ssot' 분기로 처리하므로 그
   * producer는 이 필드를 세팅하지 않는다.
   */
  distanceIsPlaceholder: boolean | undefined;
  /**
   * #2716 — distanceSource==='backend-ssot' 또는 distanceIsPlaceholder===true일 때 요구하는
   * 대체 확증. 새 신호를 만들지 않고 기존 열차 피드 arvlCd(useDestinationAutoClear.
   * pickDestinationArvlCd와 동일 신호)가 ARRIVAL_CODE.ARRIVED인지 여부를 caller가 계산해 전달한다.
   */
  destinationArrivalConfirmed: boolean;
  destinationName: string | undefined;
  onClear: () => void;
}

// #551: 도착 자동 해제 race.
// 이전 구조는 effect cleanup에서 무조건 clearTimeout을 호출해, deps(distanceKm 등)가 바뀔 때마다
// 2초 타이머가 지워지고 본문 재진입 시 arrivedBanner=true 가드로 새 타이머가 안 잡혀 영구 잔존했다.
// 타이머는 일단 set되면 unmount 전까지 살아남도록 분리한다.
export function useArrivalAutoClear({
  currentStationName,
  distanceKm,
  distanceSource,
  distanceIsPlaceholder,
  destinationArrivalConfirmed,
  destinationName,
  onClear,
}: UseArrivalAutoClearParams): { arrivedBanner: boolean } {
  const [arrivedBanner, setArrivedBanner] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firedForRef = useRef<string | null>(null);
  const onClearRef = useRef(onClear);

  useEffect(() => {
    onClearRef.current = onClear;
  }, [onClear]);

  useEffect(() => {
    if (destinationName == null) {
      firedForRef.current = null;
    }
  }, [destinationName]);

  useEffect(() => {
    if (arrivedBanner) return;
    // #2716 — 'backend-ssot' tier는 사용자 위치를 모르는 mirror라 distanceKm=0을 placeholder로
    // 보고한다(실측 0m가 아니다). 이 값을 임계값 비교에 그대로 쓰면 역명 일치만으로 항상
    // 통과해버려 2차 거리 가드가 무력화된다 — 이 경우 대신 목적지 arvlCd 확증
    // (destinationArrivalConfirmed, 기존 열차 피드 신호 재사용)을 요구한다.
    // #2741 — 'wifi-ssid'는 GPS 있음(실측)/없음(placeholder) 두 경우 모두 같은 source 값을
    // 쓰므로 distanceSource만으로 분기할 수 없다. caller가 계산한 distanceIsPlaceholder로
    // placeholder 케이스만 골라 동일한 대체 확증 경로를 태운다.
    const distanceGatePasses =
      distanceSource === 'backend-ssot' || distanceIsPlaceholder
        ? destinationArrivalConfirmed
        : distanceKm != null && distanceKm <= ARRIVAL_THRESHOLD_KM;
    if (
      currentStationName != null &&
      destinationName != null &&
      currentStationName === destinationName &&
      distanceGatePasses &&
      firedForRef.current !== destinationName
    ) {
      firedForRef.current = destinationName;
      setArrivedBanner(true);
      // #2768 — 자동 종료 발동 시점 stamp (측정 목적, 정책 변경 없음).
      logArrivalAutoClearFired(destinationName);
      timeoutRef.current = setTimeout(() => {
        onClearRef.current();
        setArrivedBanner(false);
        timeoutRef.current = null;
      }, CLEAR_DELAY_MS);
    }
  }, [
    arrivedBanner,
    currentStationName,
    distanceKm,
    distanceSource,
    distanceIsPlaceholder,
    destinationArrivalConfirmed,
    destinationName,
  ]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  return { arrivedBanner };
}
