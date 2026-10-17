import { useEffect, useRef } from 'react';
import type { Station } from '../../../shared/types/station';

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
 * - #700 hydration: persistedTripOrigin이 있으면 첫 캡처를 그 값으로 갈음한다.
 *   cold restart(앱 강제종료 후 재실행) 시 GPS 첫 fix가 진짜 출발역과 다른 경우
 *   route가 잘못된 origin으로 계산되는 회귀를 막는다.
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
  persistedTripOrigin?: Station | null,
): void {
  const tripDestIdRef = useRef<string | null>(null);
  const tripOriginRef = useRef<Station | null>(null);

  // #700 — 영속화된 origin이 store에서 hydrate되는 시점은 비동기(loadTripOrigin)다.
  // 첫 렌더 시점엔 persistedTripOrigin이 아직 null일 수 있으므로 effect로 처리해
  // hydrate가 완료된 시점에 ref를 시드한다. 단 이미 자체 캡처가 일어났으면(ref(origin)
  // truthy) 시드를 스킵 — 진행 중인 trip의 origin을 stale persisted로 오염시키지 않게.
  // hydration effect를 capture effect보다 먼저 선언해 마운트 시 시드 → 캡처 순서가
  // 보장되도록 했다.
  useEffect(() => {
    if (!destination || !persistedTripOrigin) return;
    if (tripOriginRef.current) return;
    tripDestIdRef.current = destination.id;
    tripOriginRef.current = persistedTripOrigin;
  }, [destination, persistedTripOrigin]);

  useEffect(() => {
    const destId = destination?.id ?? null;
    if (destId !== tripDestIdRef.current) {
      tripDestIdRef.current = destId;
      const next = destination ? effectiveOrigin : null;
      tripOriginRef.current = next;
      // #700 — destination이 truthy로 첫 set되는 순간 effectiveOrigin이 null이면
      // setter(null)을 호출해 영속값까지 클리어해버리는 race가 있다 (loadTripOrigin이
      // 늦게 도착하는 경우). null로의 명시적 클리어(destination null)는 그대로 보낸다.
      if (next !== null || !destination) {
        setTripOrigin(next);
      }
      return;
    }
    if (destination && !tripOriginRef.current && effectiveOrigin) {
      tripOriginRef.current = effectiveOrigin;
      setTripOrigin(effectiveOrigin);
    }
  }, [destination, effectiveOrigin, setTripOrigin]);
}
