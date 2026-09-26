import type { StationArrival } from '../api/arrivalApi';
import type { StaticEtaOptions } from '../../../shared/utils/stationRoute';

/**
 * 출발역 arrival 응답에서 `calculateStaticETA`의 `arrivalAtOrigin` 옵션 값을 추출한다.
 *
 * 정책 (#784):
 * - mock 데이터는 skip — receivedAtMs=0이라 어차피 stale 판정되지만 명시적으로도 제외해 의도 명확화
 * - up/down 양 방향 첫 차 중 가장 빨리 오는 열차 선택 — 사용자가 둘 중 더 빠른 차를 탈 것이라는 가정
 * - `receivedAtMs <= 0` 또는 `arrivalSeconds < 0`은 비정상 row로 skip
 * - 후보가 없으면 undefined → 호출처는 `DEFAULT_WAIT_MINUTES` graceful fallback
 *
 * **책임 분리**: 본 helper는 비정상 row sanitize 전담 — 60s freshness 판정은 호출처
 * (`resolveWaitMinutes` in `stationRoute.ts`)가 처리한다. raw `receivedAtMs`를 그대로 넘겨야
 * freshness 게이트가 일관 적용된다.
 *
 * useArrivalCountdown(1Hz tick) 대신 useArrivalInfo raw row 직접 사용 — 옵션 B 채택 사유:
 * countdown은 receivedAtMs를 원본으로 유지하면서 arrivalSeconds만 차감해 60s 후 항상 stale 판정.
 * ETA는 분 단위 정수라 1Hz tick 미반영해도 표시값 변화 없음(receivedAtMs 신선도가 유일한 기준).
 */
export function pickArrivalAtOrigin(
  arrival: StationArrival | null,
): StaticEtaOptions['arrivalAtOrigin'] {
  if (!arrival || arrival.isMock) return undefined;
  let best: { arrivalSeconds: number; receivedAtMs: number } | undefined;
  for (const list of [arrival.up, arrival.down]) {
    const first = list[0];
    if (!first) continue;
    if (first.receivedAtMs <= 0) continue;
    if (first.arrivalSeconds < 0) continue;
    if (!best || first.arrivalSeconds < best.arrivalSeconds) {
      best = { arrivalSeconds: first.arrivalSeconds, receivedAtMs: first.receivedAtMs };
    }
  }
  return best;
}
