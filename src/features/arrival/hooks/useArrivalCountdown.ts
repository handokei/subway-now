import { useEffect, useRef, useState } from 'react';
import type { ArrivalInfo, StationArrival } from '../api/arrivalApi';

const COUNTDOWN_INTERVAL_MS = 1_000;

function tickItems(items: ArrivalInfo[]): ArrivalInfo[] {
  return items.map((item) => {
    // #3132 — 시간 모름(null)은 감산하지 않는다. 0으로 접으면 다시 00:00이 된다.
    if (item.arrivalSeconds === null) return item;
    return { ...item, arrivalSeconds: Math.max(0, item.arrivalSeconds - 1) };
  });
}

export function useArrivalCountdown(arrival: StationArrival | null): StationArrival | null {
  const [display, setDisplay] = useState<StationArrival | null>(arrival);
  const arrivalRef = useRef(arrival);

  // Sync when new API data arrives
  useEffect(() => {
    arrivalRef.current = arrival;
    setDisplay(arrival);
  }, [arrival]);

  // 실시간 응답뿐 아니라 schedule fallback도 1초 카운트다운 진행 (이슈 #468).
  // schedule은 isMock=true지만 wall-clock anchor 기반이라 폴링마다 연속 감소한다.
  // 하드코딩 MOCK_ARRIVALS(source 없음)는 데모용 정적값이므로 종전대로 tick 제외.
  const isCountable = arrival != null && (arrival.isMock !== true || arrival.source === 'schedule');
  useEffect(() => {
    if (!isCountable) return;

    const id = setInterval(() => {
      const current = arrivalRef.current!;
      const ticked: StationArrival = {
        ...current,
        up: tickItems(current.up),
        down: tickItems(current.down),
      };
      arrivalRef.current = ticked;
      setDisplay(ticked);
    }, COUNTDOWN_INTERVAL_MS);

    return () => clearInterval(id);
  }, [isCountable]);

  return display;
}
