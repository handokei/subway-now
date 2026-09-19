/**
 * 2026-08-07 오전 실탑승 dump (corrId=tmsi34imn) — rotation storm → `/trips` 429 →
 * chain_complete=0 replay fixture (Issue #2193, Part of #2192 ADR-025).
 *
 * evidence 출처:
 *   - 실기기 덤프 "Backend Calls" 섹션(07:25:59~07:38:56 KST): 같은 deviceToken으로 `/trips`
 *     재-POST가 반복되다 07:37:35 / 07:37:42 / 07:37:54 / 07:38:55(x2) `status=429` 관측 +
 *     07:30:15 / 07:36:05 `err="Aborted" 5001~5099ms`.
 *   - D1 `trip_metrics`: 같은 corrId 트립에서 `trip_token_hash`가 b00dd879 → c0d5091d →
 *     84a1932c 순으로 3회 바뀜(로테이션 2회), `end_reason='rotated'` 2건(07:30/07:36),
 *     `silent_push_received=0` / `chain_complete=0`.
 *   - 실 deviceToken(마스킹 전 앞부분): `e25e1158e25ef9b151f1920acea506109321ecbd7deadf2c7fbeed7335b3502c`
 *     (덤프 "Backend Calls"의 `/trips/<token>` DELETE 호출 경로에서 그대로 노출).
 *
 * 메커니즘 재현: `index.ts:567`의 rate-limit 게이트(deviceToken 앞16자 키, 10회/10분)가
 * `index.ts:776`의 route-change rotation보다 먼저 평가된다. rotation은 `trip.token`만 새
 * UUID로 바꾸고 rate-limit 키(deviceToken 자체, incoming.token 원본)는 그대로라 route가
 * 바뀔 때마다 재-POST가 같은 카운터를 소진 — 10번째 이후 재-POST는 429로 죽는다.
 */

export const DEVICE_TOKEN =
  'e25e1158e25ef9b151f1920acea506109321ecbd7deadf2c7fbeed7335b3502c';

export const CORR_ID = 'tmsi34imn';

/**
 * `TRIP_REGISTER_MAX_PER_WINDOW`(10) + 1 — 10번째까지는 허용, 11번째부터 429.
 * (`tripRegisterRateLimit.ts` SSOT 상수를 테스트에서 import해 하드코딩 drift를 막는다 —
 * 이 파일은 evidence 재현용 "요청 횟수"만 명시하고, 실제 cap 값은 테스트가 SSOT에서 읽는다.)
 */
export const ROTATION_STORM_REQUEST_COUNT = 11;

/**
 * route 변경을 재현하는 trip payload — index마다 destination/waypoints signature가 달라
 * `computeRouteSignature`가 매번 다른 값을 반환하도록(환승 재플랜 모사) 한다. index=0(최초
 * 등록)은 existing이 없어 rotation이 발동하지 않고, index>=1부터 매 요청이 새 route로
 * 평가돼 rotation을 유발한다.
 */
export function buildRotationStormTripBody(
  index: number,
  futureExpiresAt: number,
): Record<string, unknown> {
  return {
    token: DEVICE_TOKEN,
    route: { type: 'direct', line: '7', stops: index + 1 },
    destination: `evidence-dst-${index}`,
    waypoints: [
      { stationName: `evidence-station-${index}`, line: '7', kind: 'destination' },
    ],
    expiresAt: futureExpiresAt,
    alarmAtEpochMs: futureExpiresAt - 30 * 60 * 1000,
  };
}
