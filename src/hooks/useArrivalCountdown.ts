import { useEffect, useRef, useState } from 'react';
import type { ArrivalInfo, StationArrival } from '../api/arrivalApi';

const COUNTDOWN_INTERVAL_MS = 1_000;

function tickItems(items: ArrivalInfo[]): ArrivalInfo[] {
  return items.map((item) => {
    const seconds = Math.max(0, item.arrivalSeconds - 1);
    return {
      ...item,
      arrivalSeconds: seconds,
      arrivalMinutes: Math.floor(seconds / 60),
    };
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

  // Countdown every second for non-mock data
  const isMock = arrival?.isMock === true;
  const hasArrival = arrival != null;
  useEffect(() => {
    if (!hasArrival || isMock) return;

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
  }, [hasArrival, isMock]);

  return display;
}
