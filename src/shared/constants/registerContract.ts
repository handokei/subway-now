/**
 * `POST /trips` 등록 계약 — backend와 device가 공유하는 응답 상수 (#3006, ADR-029 취지).
 *
 * backend가 KV 쓰기 장애(쿼터 소진 등)로 등록하지 못했을 때 503 본문 `error` 값이다.
 * device는 이 값으로 "재시도하면 복구되는 일시 장애"를 식별한다(문자열 리터럴 중복 금지).
 */
export const REGISTER_KV_UNAVAILABLE_ERROR = 'kv_unavailable';

/**
 * 503 `kv_unavailable` 응답에 `Retry-After` 헤더가 없거나 해석할 수 없을 때 device가 쓰는 기본
 * 억제 시간(초). backend(`index.ts`)가 내려주는 값(60)과 같다 — 헤더가 정상이면 그 값을 쓴다.
 */
export const REGISTER_KV_UNAVAILABLE_DEFAULT_RETRY_AFTER_SECONDS = 60;

/**
 * #3006 PR-2 — register가 503 `kv_unavailable`(degraded)인 동안 device가 재시도하는 주기(ms).
 * 기존 backoff(15/30/60s × 3)가 소진된 뒤에도 서버 복구(00:00 UTC 쿼터 리셋 등)를 감지하기 위한
 * 저빈도 주기다 — 5분이면 KV 쓰기 쿼터를 의미 있게 쓰지 않는다.
 */
export const REGISTER_DEGRADED_RETRY_INTERVAL_MS = 300_000;
