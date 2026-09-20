import { useEffect, useRef, useState } from 'react';
import type { FusionSource } from '../../../shared/types/fusion';

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
   * #2716 — distanceSource==='backend-ssot'일 때 요구하는 대체 확증. 새 신호를 만들지 않고
   * 기존 열차 피드 arvlCd(useDestinationAutoClear.pickDestinationArvlCd와 동일 신호)가
   * ARRIVAL_CODE.ARRIVED인지 여부를 caller가 계산해 전달한다.
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
    if (
      currentStationName != null &&
      destinationName != null &&
      currentStationName === destinationName &&
      distanceKm != null &&
      distanceKm <= ARRIVAL_THRESHOLD_KM &&
      firedForRef.current !== destinationName
    ) {
      firedForRef.current = destinationName;
      setArrivedBanner(true);
      timeoutRef.current = setTimeout(() => {
        onClearRef.current();
        setArrivedBanner(false);
        timeoutRef.current = null;
      }, CLEAR_DELAY_MS);
    }
  }, [arrivedBanner, currentStationName, distanceKm, destinationName]);

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
