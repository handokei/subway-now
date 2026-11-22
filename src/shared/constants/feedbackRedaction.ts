/**
 * #3366 — 버그 신고 진단 첨부의 스크럽 패턴 (device 클라이언트 + backend `/feedback` 공용 SSoT).
 *
 * 좌표 영속 저장 금지(`docs/requirements/12-cross-cutting.md:26`) 2중 방어선: 클라이언트가 보내기 전에,
 * 서버가 저장 직전에 같은 패턴으로 지운다. backend는 `tsconfig.json` include로 직접 import한다.
 *
 * 위경도는 **문맥 조건**이 필수다 — 실기기 덤프 6개 검사에서 문맥 없는 `3[3-9]\.\d{2,}` 패턴은
 * `arc=33.53`·`acc=339.39`·`age=33.375` 등 오탐 96건, 문맥 있는 패턴은 실좌표 6건·오탐 0.
 *  - 접두 문맥: `lat=` / `lng=` / `pos=` 바로 뒤의 한국 범위 수치(쉼표 쌍 `pos=lat,lng` 포함)
 *  - 쌍 문맥: `<위도>,<경도>` 한국 범위 수치 쌍(소수 2자리 이상, 앞자리 숫자·소수점 없음)
 */

const LAT_INT = '3[3-9]';
const LNG_INT = '1(?:2[4-9]|3[0-2])';

export const REDACTED_COORDINATE = '[redacted]';
export const REDACTED_TOKEN = '[token]';

/** 모든 패턴은 `g` 플래그 — `String.replace`로 일괄 치환. */
export const COORDINATE_REDACTION_PATTERNS: readonly RegExp[] = [
  new RegExp(
    `(?<=\\b(?:lat|lng|pos)=)(?:${LAT_INT}|${LNG_INT})\\.\\d+(?:,\\s*(?:${LAT_INT}|${LNG_INT})\\.\\d+)?`,
    'g',
  ),
  new RegExp(`(?<![\\d.])${LAT_INT}\\.\\d{2,},\\s*${LNG_INT}\\.\\d{2,}(?!\\d)`, 'g'),
];

/** 40자 이상 hex 연속 문자열(trip/APNs token) — ADR-006 "전체 token 비적재". */
export const TOKEN_HEX_PATTERN = /[0-9a-fA-F]{40,}/g;
