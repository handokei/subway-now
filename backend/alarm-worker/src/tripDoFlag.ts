/**
 * TripDO shadow write Feature Flag (Phase 1, ADR-031 / 이슈 #2264, Epic #2260).
 *
 * ADR-031은 글로벌 cron O(N) 스캔을 per-trip Durable Object + self-alarm 이벤트 구동으로
 * 재설계한다. Phase 1은 `TripDO` scaffold만 배포하고 cron은 여전히 authoritative — DO는
 * shadow(no-op 기본)로 병존한다.
 *
 * 본 모듈은 `archFlag.ts`(#1982 ADR-022 Phase 0)와 동일한 KV read/write 어댑터 패턴을
 * 재사용한다. flag가 'off'(default)인 동안 `POST /trips`의 DO dual-write 경로는 완전히
 * no-op — 기존 cron/KV 동작 100% 유지(Phase 1-3 dormant).
 *
 * Rollback 정책: `on` → `off` KV write 만으로 즉시 되돌린다(배포 없음).
 */

/** 신규 TripDO shadow write 활성 KV 키. 값은 `on` 또는 `off` 만 유효. */
export const TRIP_DO_FLAG_KV_KEY = 'arch:trip-do-shadow-v1';

/** 두 가지 값만 허용 — enum literal union. 다른 값은 default(`off`) 로 정규화된다. */
export type TripDoFlagValue = 'on' | 'off';

/** Default 값 — 미설정 KV / 오타 / 파싱 실패 모두 이 값으로 fallback. */
export const TRIP_DO_FLAG_DEFAULT: TripDoFlagValue = 'off';

/** 유효 값 판정 — set / get 양쪽 공용. */
export function isTripDoFlagValue(raw: unknown): raw is TripDoFlagValue {
  return raw === 'on' || raw === 'off';
}

/**
 * KV로부터 현재 flag 값을 조회. 값 부재 / 오타 / KV 미바인딩 견해에서 이견을 없애기 위해
 * 다음 순서로 정규화한다:
 *  1. `kv` 인자가 없으면 default 반환 (개발 환경 호환).
 *  2. KV `get` 결과가 null이면 default (미설정 시 dormant).
 *  3. 유효 문자열('on' / 'off')이면 그 값을 반환.
 *  4. 그 외 오타/타입 이상 값은 default로 fallback (KV를 조작한 운영자 실수 방어).
 */
export async function getTripDoFlag(
  kv: KVNamespace | undefined,
): Promise<TripDoFlagValue> {
  if (!kv) return TRIP_DO_FLAG_DEFAULT;
  const raw = await kv.get(TRIP_DO_FLAG_KV_KEY);
  if (raw === null) return TRIP_DO_FLAG_DEFAULT;
  return isTripDoFlagValue(raw) ? raw : TRIP_DO_FLAG_DEFAULT;
}

/**
 * 관리자용 flag 설정. 유효하지 않은 값은 write 없이 throw — 잘못된 KV 상태 진입 차단.
 *
 * TTL 없음: rollback 시 즉시 반영되어야 하므로 영구 저장.
 */
export async function setTripDoFlag(
  kv: KVNamespace,
  value: TripDoFlagValue,
): Promise<void> {
  if (!isTripDoFlagValue(value)) {
    throw new Error(`tripDoFlag: invalid value ${String(value)}`);
  }
  await kv.put(TRIP_DO_FLAG_KV_KEY, value);
}
