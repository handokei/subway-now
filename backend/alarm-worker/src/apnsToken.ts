/**
 * APNs device token 포맷 검증 (#2176).
 *
 * 08-06 로테이션 결함 RCA: 코드 어디에도 "APNs 토큰은 64-hex"라는 불변식 검증이 없어
 * `crypto.randomUUID()`로 교체된 `trip.token`이 rotation 이전 상태에서 그대로 APNs로
 * 발사돼도 아무도 감지하지 못했다. 본 유틸은 그 불변식을 단일 지점에서 정의한다.
 *
 * `trips.ts`의 `resolveTripDeviceToken`이 사용하던 로컬 정규식(#2174)을 이 파일로 이전 —
 * push 발사 경로(`apnsHost.ts`)도 동일 정의를 재사용해야 하므로 공용 모듈로 승격한다.
 */
const APNS_DEVICE_TOKEN_HEX64_RE = /^[0-9a-f]{64}$/i;

/** 주어진 문자열이 APNs device token 포맷(64자리 hex)인지 검사한다. */
export function isValidApnsToken(token: string): boolean {
  return APNS_DEVICE_TOKEN_HEX64_RE.test(token);
}
