/**
 * Admin kill switch — 즉시 게이트 차단 인프라 (#1967 Ff-1).
 *
 * 2026-06-28 Wave 1-4 audit (Ff-1): lockless intermediate 게이트(`scheduled.ts` —
 * `trip.infoModeEnabled && waypoint.kind === 'intermediate'`)가 kill switch 없이
 * 머지됐다. device 측 false alarm 회귀가 감지돼도 backend deploy(10~30분) 없이는
 * 즉시 차단 수단이 없었다.
 *
 * `archFlag.ts`(#1982 ADR-022 Phase 0)와 동일한 KV read/write 어댑터 패턴을 재사용한다.
 * 다른 점은 kill switch가 여러 게이트를 다룰 잠재력이 있어 `key` 파라미터로 KV 키를
 * 선택하는 데이터 주도 방식을 취한다는 것 — 새 게이트를 추가할 때 `KILL_SWITCH_KV_KEYS`에
 * 한 줄만 추가하면 되고, admin endpoint / read / write 로직은 변경할 필요가 없다.
 *
 * 현재 유효한 key는 `lockless_intermediate` 하나뿐(#1967 스코프 = Ff-1). Ff-2(device 4-signal
 * consensus 게이트)는 ADR-024 재설계로 소멸해 여기 포함하지 않는다.
 *
 * Rollback 정책: `true` → `false` KV write 만으로 즉시 되돌린다(배포 없음).
 */

import { assertCronCacheTtl, CRON_READ_CACHE_TTL_SEC } from './kvConsistency';

/** 유효한 kill switch key — 새 게이트 추가 시 이 union + 아래 map에 한 줄 추가. */
export type KillSwitchKey = 'lockless_intermediate';

/** key → KV 키 매핑. 데이터 주도 — key 추가 시 read/write 로직 변경 불필요. */
const KILL_SWITCH_KV_KEYS: Record<KillSwitchKey, string> = {
  lockless_intermediate: 'kill-switch:lockless-intermediate',
};

/** 유효한 key 판정 — admin endpoint 입력 검증에 사용. */
export function isKillSwitchKey(raw: unknown): raw is KillSwitchKey {
  return typeof raw === 'string' && raw in KILL_SWITCH_KV_KEYS;
}

/** 두 가지 값만 허용. 그 외 값은 default(`false`, dormant)로 정규화된다. */
export type KillSwitchValue = 'true' | 'false';

/** Default 값 — 미설정 KV / 오타 / 파싱 실패 모두 이 값으로 fallback(게이트 정상 동작). */
export const KILL_SWITCH_DEFAULT: KillSwitchValue = 'false';

/** 유효 값 판정 — get/set 양쪽 공용. */
export function isKillSwitchValue(raw: unknown): raw is KillSwitchValue {
  return raw === 'true' || raw === 'false';
}

/**
 * KV로부터 현재 kill switch 값을 조회. cron read 경로 전용 — `assertCronCacheTtl` +
 * `CRON_READ_CACHE_TTL_SEC`(30s) 컨벤션을 따른다(`kvConsistency.ts`, #1402/#1423).
 *
 *  1. `kv` 인자가 없으면 default 반환 (개발 환경 호환).
 *  2. KV `get` 결과가 null이면 default (미설정 시 dormant — 기존 게이트 동작 100% 유지).
 *  3. 유효 문자열('true'/'false')이면 그 값을 반환.
 *  4. 그 외 오타/타입 이상 값은 default로 fallback (운영자 실수 방어).
 */
export async function getKillSwitch(
  kv: KVNamespace | undefined,
  key: KillSwitchKey,
): Promise<KillSwitchValue> {
  if (!kv) return KILL_SWITCH_DEFAULT;
  assertCronCacheTtl(CRON_READ_CACHE_TTL_SEC);
  const raw = await kv.get(KILL_SWITCH_KV_KEYS[key], { cacheTtl: CRON_READ_CACHE_TTL_SEC });
  if (raw === null) return KILL_SWITCH_DEFAULT;
  return isKillSwitchValue(raw) ? raw : KILL_SWITCH_DEFAULT;
}

/**
 * 관리자용 kill switch 설정. 유효하지 않은 값은 write 없이 throw — 잘못된 KV 상태 진입 차단.
 *
 * TTL 없음: 회귀 감지 시 즉시 반영되어야 하므로 영구 저장.
 */
export async function setKillSwitch(
  kv: KVNamespace,
  key: KillSwitchKey,
  value: KillSwitchValue,
): Promise<void> {
  if (!isKillSwitchValue(value)) {
    throw new Error(`killSwitch: invalid value ${String(value)}`);
  }
  await kv.put(KILL_SWITCH_KV_KEYS[key], value);
}
