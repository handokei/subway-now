import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

export function usePolling(
  callback: () => void,
  intervalMs: number,
  options?: { onResume?: () => void },
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const onResumeRef = useRef(options?.onResume);
  onResumeRef.current = options?.onResume;

  useEffect(() => {
    const intervalRef = { current: setInterval(() => callbackRef.current(), intervalMs) };

    const subscription = AppState.addEventListener('change', (state) => {
      clearInterval(intervalRef.current);
      if (state === 'active') {
        onResumeRef.current?.();
        callbackRef.current();
        intervalRef.current = setInterval(() => callbackRef.current(), intervalMs);
      }
    });

    return () => {
      clearInterval(intervalRef.current);
      subscription.remove();
    };
  }, [intervalMs]);
}
