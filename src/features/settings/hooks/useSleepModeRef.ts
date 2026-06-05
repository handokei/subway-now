import { useRef, type MutableRefObject } from 'react';
import { useAppStore } from '../../../store/useAppStore';

/**
 * sleepMode를 ref로 노출 — 호출 시점 값을 캡처하되 effect deps에 sleepMode를 제외하기 위한 패턴(#632).
 * 토글 시점에 effect 재실행 없이 다음 callback 호출 때 새 값이 반영된다.
 */
export function useSleepModeRef(): MutableRefObject<boolean> {
  const sleepMode = useAppStore((s) => s.sleepMode);
  const ref = useRef(sleepMode);
  ref.current = sleepMode;
  return ref;
}
