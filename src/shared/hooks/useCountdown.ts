import { useEffect, useState } from 'react';

export type Countdown = { mm: string; ss: string; totalSec: number; done: boolean };

function calc(arrivalAtMs: number | null): Countdown {
  // #3132 — null = 시간 모름. 호출자는 mm:ss 대신 위치 문구를 보여준다 (0초로 접지 않음).
  const diff = arrivalAtMs === null ? 0 : Math.max(0, Math.floor((arrivalAtMs - Date.now()) / 1000));
  const mm = String(Math.floor(diff / 60)).padStart(2, '0');
  const ss = String(diff % 60).padStart(2, '0');
  return { mm, ss, totalSec: diff, done: diff <= 0 };
}

export function useCountdown(arrivalAtMs: number | null): Countdown {
  const [state, setState] = useState<Countdown>(() => calc(arrivalAtMs));

  useEffect(() => {
    setState(calc(arrivalAtMs));
    if (arrivalAtMs === null) return undefined;
    const id = setInterval(() => setState(calc(arrivalAtMs)), 1000);
    return () => clearInterval(id);
  }, [arrivalAtMs]);

  return state;
}
