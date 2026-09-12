/**
 * Arrival API SSOT 아키텍처 Feature Flag (Phase 0, ADR-022 / 이슈 #1982).
 *
 * ADR-022 는 알림 SSOT 를 Seoul TOPIS `realtimeStationArrival` API (`arvlCd`) 로 단일화한다.
 * 전환은 Staged 로 진행: Phase 0(본 인프라) → Phase 1(신규 코드 병존) → Phase 2(dogfood)
 * → Phase 3(default ON) → Phase 4(구 코드 삭제 + flag 제거).
 *
 * 본 모듈은 backend 측 KV 스위치의 read/write 어댑터다. Phase 0 시점에는 신규 아키텍처 코드가
 * 없어 flag 값이 어떤 동작도 바꾸지 않는다(dormant). Phase 1 이후 caller 가 결과 값을 분기
 * 조건으로 사용한다.
 *
 * Rollback 정책: `on` → `off` KV write 만으로 즉시 되돌린다(배포 없음). Phase 4 이후에는
 * git revert.
 */

/** 신규 아키텍처 활성 KV 키. 값은 `on` 또는 `off` 만 유효. */
export const ARCH_FLAG_KV_KEY = 'arch:simple-arrival-v1';

/** 두 가지 값만 허용 — enum literal union. 다른 값은 default(`off`) 로 정규화된다. */
export type ArchFlagValue = 'on' | 'off';

/** Default 값 — 미설정 KV / 오타 / 파싱 실패 모두 이 값으로 fallback. */
export const ARCH_FLAG_DEFAULT: ArchFlagValue = 'off';

/** 유효 값 판정 — set / get 양쪽 공용. */
export function isArchFlagValue(raw: unknown): raw is ArchFlagValue {
  return raw === 'on' || raw === 'off';
}

/**
 * KV 로 부터 현재 flag 값을 조회. 값 부재 / 오타 / KV 미바인딩 견해에서 이견을 없애기 위해
 * 다음 순서로 정규화한다:
 *  1. `kv` 인자가 없으면 default 반환 (개발 환경 호환).
 *  2. KV `get` 결과가 null 이면 default (미설정 시 dormant).
 *  3. 유효 문자열('on' / 'off') 이면 그 값을 반환.
 *  4. 그 외 오타/타입 이상 값은 default 로 fallback (KV 를 조작한 운영자 실수 방어).
 */
export async function getArchFlag(
  kv: KVNamespace | undefined,
): Promise<ArchFlagValue> {
  if (!kv) return ARCH_FLAG_DEFAULT;
  const raw = await kv.get(ARCH_FLAG_KV_KEY);
  if (raw === null) return ARCH_FLAG_DEFAULT;
  return isArchFlagValue(raw) ? raw : ARCH_FLAG_DEFAULT;
}

/**
 * 관리자용 flag 설정. 유효하지 않은 값은 write 없이 throw — 잘못된 KV 상태 진입 차단.
 *
 * TTL 없음: rollback 시 즉시 반영되어야 하므로 영구 저장.
 */
export async function setArchFlag(
  kv: KVNamespace,
  value: ArchFlagValue,
): Promise<void> {
  if (!isArchFlagValue(value)) {
    throw new Error(`archFlag: invalid value ${String(value)}`);
  }
  await kv.put(ARCH_FLAG_KV_KEY, value);
}
