import { useEffect, useState } from 'react';

export type Countdown = { mm: string; ss: string; totalSec: number; done: boolean };

function calc(arrivalAtMs: number): Countdown {
  const diff = Math.max(0, Math.floor((arrivalAtMs - Date.now()) / 1000));
  const mm = String(Math.floor(diff / 60)).padStart(2, '0');
  const ss = String(diff % 60).padStart(2, '0');
  return { mm, ss, totalSec: diff, done: diff <= 0 };
}

export function useCountdown(arrivalAtMs: number): Countdown {
  const [state, setState] = useState<Countdown>(() => calc(arrivalAtMs));

  useEffect(() => {
    setState(calc(arrivalAtMs));
    const id = setInterval(() => setState(calc(arrivalAtMs)), 1000);
    return () => clearInterval(id);
  }, [arrivalAtMs]);

  return state;
}
