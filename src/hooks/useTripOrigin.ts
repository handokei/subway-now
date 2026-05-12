import { useEffect, useRef } from 'react';
import type { Station } from '../types/station';

/**
 * destination이 설정/변경되는 순간의 origin을 캡처해 trip 동안 고정한다.
 *
 * useFusedNearestStation의 routeContext.origin에 매 폴링마다 흔들리는 effectiveOrigin을
 * 직접 넘기면 useRouteProgress의 arc useMemo deps가 흔들려 진행도 state가 0으로 리셋된다
 * (`useRouteProgress.ts`의 useEffect([arc])). 트립 단위로 안정된 origin이 필요.
 *
 * 캡처 규칙:
 * - destination null → tripOrigin null
 * - destination 변경(또는 첫 set) → 그 시점의 effectiveOrigin으로 캡처
 * - 첫 캡처 시 effectiveOrigin이 아직 null이면 다음 effect에서 lazily 캡처
 * - destination이 같은 동안 effectiveOrigin이 바뀌어도 tripOrigin은 유지
 *
 * setter 패턴 사용 — state 반환형보다 이 hook에서 적합한 이유:
 * routeContext가 useFusedNearestStation 호출 시점에 필요하고 tripOrigin은 그 호출 결과(effectiveOrigin)에
 * 의존하는 cycle 구조라, 호출 측이 이미 useState로 tripOrigin을 보관해야 한다. state 반환형으로 가면
 * routeContext용 별도 useState+useEffect sync가 또 필요해 오히려 코드가 늘어난다. setter를 받아
 * 호출 측 useState를 그대로 갱신하는 게 가장 단순하다.
 */
export function useTripOrigin(
  destination: Station | null,
  effectiveOrigin: Station | null,
  setTripOrigin: (origin: Station | null) => void,
): void {
  const tripDestIdRef = useRef<string | null>(null);
  const tripOriginRef = useRef<Station | null>(null);

  useEffect(() => {
    const destId = destination?.id ?? null;
    if (destId !== tripDestIdRef.current) {
      tripDestIdRef.current = destId;
      const next = destination ? effectiveOrigin : null;
      tripOriginRef.current = next;
      setTripOrigin(next);
      return;
    }
    if (destination && !tripOriginRef.current && effectiveOrigin) {
      tripOriginRef.current = effectiveOrigin;
      setTripOrigin(effectiveOrigin);
    }
  }, [destination, effectiveOrigin, setTripOrigin]);
}
