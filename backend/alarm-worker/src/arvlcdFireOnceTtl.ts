/**
 * arvlCd fire-once TTL helper — ADR-022 Phase 1-1 (#1985).
 *
 * ## 배경
 *
 * ADR-022 (#1980) — Seoul TOPIS `realtimeStationArrival` API (arvlCd) 를 알림 SSOT 로 단일화하는
 * 아키텍처 재설계. Issue #1980 코멘트 "동일 알림 반복 발사 근본 원인" 케이스 2:
 *
 *   13:31:14 silent-push-received 어린이대공원
 *   13:32:14 silent-push-received 어린이대공원   ← 1분 후 또
 *   13:37:14 silent-push-received 어린이대공원   ← 5분 후 또
 *   13:38:14 silent-push-received station-passed imminent 어린이대공원
 *
 * Backend cron 60s 폴링 + arvlCd=1 지속(~30초) — 매 폴링마다 감지 시 push 재발사. 기존
 * `arvlCdFireKey` dedup 은 `arvlCd` 값을 key 에 포함해 0(진입) 과 1(도착) 을 별 entry 로 분리
 * stamp → 같은 train 이 한 station 을 지나가는 동안 최소 2번 fire 가능.
 *
 * ## 정책
 *
 * 같은 (`tripToken`, `stationName`, `cycle`) 조합에서 fire 를 **1회로 강제**. 5분 TTL 로 자연
 * 회수 — TTL 만료 시 다음 관측이 새 cycle 시작 (train 이 물리적으로 같은 station 을 5분 안에
 * 재방문할 수 없음).
 *
 * `cycle` 파라미터는 애초 "미래-확장 slot"으로 설계되어 caller 가 `0` 고정값을 전달했다
 * (arvlCd 0→1→2→5 전체 monotone 시퀀스를 단일 fire 이벤트로 통합 — 어린이대공원 반복 storm
 * 차단, #1985/#2200). #2448 에서 그 확장 slot 을 실제로 활용 — caller(`fireArvlCdStationPush`)
 * 가 `arvlCdFireOnceBucket(arvlCd)`(`scheduled.ts`)로 ENTERING(0)/그 외 2-way bucket 값을
 * 계산해 전달한다. 이 helper 자체는 bucket 의 의미를 모른다 — 여전히 순수 (token, station,
 * cycle) 3-tuple key 저장소일 뿐이며, storm 방지(같은 3-tuple 무제한 재발사 차단)는 그대로다.
 *
 * ## Feature flag
 *
 * 본 helper 자체는 flag 를 알지 않는다 — caller (`fireArvlCdStationPush`) 가 `isSimpleArchEnabled(env)`
 * 로 게이트한다. `isSimpleArchEnabled`는 real `getArchFlag(env.TRIPS)`를 조회한다 (#2201).
 *
 * ## 관측
 *
 * skip 발생 시 caller 가 `writeMetric(env, { eventType: 'suppress', reason: 'fire-once-cycle-already' })`
 * 로 wrangler tail 관측. `arvlCdFireOnceSkipped` stat 카운터도 별도 누적.
 */

import { getArchFlag } from './archFlag';
import type { Env } from './types';

/**
 * 5분 (300s). Train 이 같은 station 을 5분 안에 재방문할 수 없다는 실제 운영 특성 기반.
 * `ARVLCD_FIRE_DEDUP_TTL_SEC` (1시간, per-arvlCd key) 와 별개 정책 — 이 TTL 은 cycle 단위
 * 전체를 커버하며 flag=ON 시에만 적용된다.
 */
export const ARVLCD_FIRE_ONCE_TTL_SEC = 5 * 60;

/**
 * KV key prefix. 형식: `fireOnce:{tripToken}:{stationName}:{arvlCdCycle}`.
 *
 * 주의: `arvlCdFireKey` (`arvlcd-fire:` prefix, per-arvlCd 분리) 와 namespace 격리 —
 * 두 dedup layer 가 동일 KV 에서 서로 오염하지 않는다.
 */
export const ARVLCD_FIRE_ONCE_KEY_PREFIX = 'fireOnce:';

/**
 * Fire-once KV key 빌더.
 *
 * @param token       trip token (per-trip isolation — cross-trip leak 차단).
 * @param stationName waypoint station name (표준 어휘, `stations.json` BLDN_NM).
 * @param cycle       arvlCd cycle bucket (현재는 `0` 고정 slot, 5분 TTL 이 cycle 경계 처리).
 */
export function arvlCdFireOnceKey(
  token: string,
  stationName: string,
  cycle: number,
): string {
  return `${ARVLCD_FIRE_ONCE_KEY_PREFIX}${token}:${stationName}:${cycle}`;
}

/**
 * KV 에 이미 fire-once stamp 가 있는지 확인.
 *
 * @returns true — 이미 fire 됨 (skip 필요). false — 미stamp (fire 진행 가능).
 */
export async function checkArvlCdFireOnce(
  kv: KVNamespace,
  token: string,
  stationName: string,
  cycle: number,
): Promise<boolean> {
  const key = arvlCdFireOnceKey(token, stationName, cycle);
  const existing = await kv.get(key);
  return existing !== null;
}

/**
 * Fire-once stamp 를 5분 TTL 로 write. 성공 fire 직후 caller 가 호출.
 *
 * value 는 stamp 시각 ms — 관측 시 몇 초 전에 stamp 됐는지 tail 에서 즉시 확인.
 */
export async function stampArvlCdFireOnce(
  kv: KVNamespace,
  token: string,
  stationName: string,
  cycle: number,
  now: number,
): Promise<void> {
  const key = arvlCdFireOnceKey(token, stationName, cycle);
  await kv.put(key, String(now), { expirationTtl: ARVLCD_FIRE_ONCE_TTL_SEC });
}

/**
 * ADR-022 Phase 1-1 (#1985) → Phase 1-2 real wire (#2201, ADR-026 Decision 4).
 *
 * `env.TRIPS` KV 의 real `getArchFlag`를 조회 — 'on' 이면 true. 어린이대공원 13:31/13:32/13:37
 * 재발사 (#2200 storm evidence) 는 이 flag가 remote='on' 인데도 항상 `false`를 반환하는
 * 하드코딩 stub 이었던 것이 backend 기여분 근본 원인 — real wire 로 dormant 해제한다.
 *
 * 함수로 노출한 이유: 테스트에서 `vi.spyOn(module, 'isSimpleArchEnabled')` 로 flag=ON 시나리오
 * 검증 가능 유지.
 */
export async function isSimpleArchEnabled(env: Env): Promise<boolean> {
  return (await getArchFlag(env.TRIPS)) === 'on';
}
