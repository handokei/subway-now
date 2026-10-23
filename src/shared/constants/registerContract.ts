/**
 * `POST /trips` 등록 계약 — backend와 device가 공유하는 응답 상수 (#3006, ADR-029 취지).
 *
 * backend가 KV 쓰기 장애(쿼터 소진 등)로 등록하지 못했을 때 503 본문 `error` 값이다.
 * device는 이 값으로 "재시도하면 복구되는 일시 장애"를 식별한다(문자열 리터럴 중복 금지).
 */
export const REGISTER_KV_UNAVAILABLE_ERROR = 'kv_unavailable';
