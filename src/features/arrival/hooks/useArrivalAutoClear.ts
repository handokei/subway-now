import { useEffect, useRef, useState } from 'react';

const ARRIVAL_THRESHOLD_KM = 0.5;
const CLEAR_DELAY_MS = 2000;

export interface UseArrivalAutoClearParams {
  currentStationName: string | undefined;
  distanceKm: number | undefined;
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
