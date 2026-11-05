import { useEffect, useRef, useState } from 'react';
import {
  STATIC_WINDOW_MS,
  classifyPositionStability,
  type PositionSample,
  type PositionStability,
} from '../utils/positionStaticDetector';

/** 이력 보존 윈도우 (ms). classify에서 사용하는 STATIC_WINDOW_MS의 배수 — 약간 길게 유지해
 *  classify 직전 prune 후에도 minSamples를 충족하도록 한다. */
const PRUNE_WINDOW_MS = STATIC_WINDOW_MS * 2;

/** 메모리 보호: ref 배열 cap. 일반 GPS 폴링(30s)에서 PRUNE_WINDOW(120s) 4 sample 정도이므로
 *  30은 burst를 흡수하면서도 메모리 폭주를 방지하는 안전망. */
const MAX_BUFFER_SIZE = 30;

/**
 * userLocation 갱신마다 sample을 누적해 정적/이동/판정불가를 노출한다.
 *
 * 입력 `userLocation`이 null이면 sample 추가 없이 이전 stability 유지. (GPS 일시 끊김 시
 * 직전 판정을 보존해 다음 cycle에 잘못된 'unknown'으로 reset되지 않도록.)
 *
 * 반환 결정성: classify 결과가 같으면 setState가 re-render를 트리거하지 않아 효율적.
 */
export function usePositionStability(
  userLocation: { lat: number; lng: number } | null,
): PositionStability {
  const bufferRef = useRef<PositionSample[]>([]);
  const [stability, setStability] = useState<PositionStability>('unknown');

  useEffect(() => {
    if (!userLocation) return;
    const now = Date.now();
    const pruned = bufferRef.current.filter((s) => now - s.ts <= PRUNE_WINDOW_MS);
    pruned.push({ lat: userLocation.lat, lng: userLocation.lng, ts: now });
    bufferRef.current = pruned.slice(-MAX_BUFFER_SIZE);
    setStability(classifyPositionStability(bufferRef.current, now));
  }, [userLocation]);

  return stability;
}
