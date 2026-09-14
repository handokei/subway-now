/**
 * `apns-collapse-id` 공유 빌더 (#2610 코드리뷰 P1).
 *
 * 배경: 5개 alert 채널(station-notif/boarding-prompt/sleep-alarm/prepare-alarm/fallback-alert)이
 * 각자 `${prefix}${tripToken.slice(0, 16)}(-${station})` 패턴을 중복 구현했다. APNs
 * `apns-collapse-id` 헤더는 UTF-8 64바이트 한도가 있는데(#2086), station을 접미사로 붙이는
 * 4개 빌더(sleep-alarm/prepare-alarm/fallback-alert 및 향후 추가분)는 station 자체가 긴
 * 한글 역명일 때(예: `남한산성입구(성남법원.검찰청)`) 한도를 넘길 수 있음이 코드리뷰에서
 * 실측됐다 — 기존 구현은 `slice(0, 16)`로 tripToken만 방어하고 station은 무방비였다.
 *
 * 본 모듈은 station suffix를 **UTF-8 바이트 단위로, 문자 경계를 보존하며** 안전 절단하는
 * 단일 빌더로 5개 채널을 통합한다. prefix + tripToken(16자 축약)는 항상 ASCII/hex라 고정
 * 폭이 짧고(최대 33바이트, `boarding-prompt-` 기준), station suffix 쪽만 남는 예산만큼
 * 절단해도 collapse 유니크성(같은 trip·station 조합만 같은 id)은 유지된다.
 */

/** APNs `apns-collapse-id` 헤더 한도 (#2086). */
export const APNS_COLLAPSE_ID_MAX_BYTES = 64;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * `value`를 UTF-8 `maxBytes` 이하로 안전하게 절단한다. 코드 포인트(`for...of`) 단위로
 * 순회해 멀티바이트 문자(한글 3바이트, 서러게이트 페어 포함 이모지 등) 중간에서 잘리지
 * 않도록 보장한다 — 문자 하나를 통째로 포함할 수 없으면 그 문자부터는 버린다.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value;
  let bytes = 0;
  let result = '';
  for (const char of value) {
    const charBytes = utf8ByteLength(char);
    if (bytes + charBytes > maxBytes) break;
    result += char;
    bytes += charBytes;
  }
  return result;
}

/**
 * `${prefix}${tripToken.slice(0, 16)}(-${station})` 형태의 collapse id를 만들고
 * `APNS_COLLAPSE_ID_MAX_BYTES` 이하로 절단한다. `tripToken.slice(0, 16)`은 기존 5개 빌더와
 * 동일한 축약 규칙(#2086/#2130) — ASCII/hex 전제라 바이트=문자수, 별도 UTF-8 처리 불필요.
 * 절단이 실제로 필요한 경우는 station suffix가 긴 한글 역명일 때뿐이다(prefix+tripToken
 * 고정 폭이 항상 예산 안에 들어오므로).
 */
function buildCollapseId(prefix: string, tripToken: string, station?: string): string {
  const base = `${prefix}${tripToken.slice(0, 16)}`;
  const full = station === undefined ? base : `${base}-${station}`;
  return truncateUtf8(full, APNS_COLLAPSE_ID_MAX_BYTES);
}

/**
 * #2063 (ADR-023 개정) — 매역 알림(station-notif) apns-collapse-id prefix.
 * 같은 trip 의 매역 알림은 알림센터에서 최신 것으로 교체(스택 방지).
 */
export const STATION_NOTIF_COLLAPSE_ID_PREFIX = 'station-';

/** #2063 — 매역 알림 apns-collapse-id 빌더. */
export function stationNotifCollapseId(tripToken: string): string {
  return buildCollapseId(STATION_NOTIF_COLLAPSE_ID_PREFIX, tripToken);
}

/**
 * #2130 (Part B-be-2) — boarding-prompt(반복 발사, A4) apns-collapse-id prefix.
 * 새 열차의 prompt가 이전 무응답 배너를 알림센터에서 최신으로 교체(스택 금지).
 */
export const BOARDING_PROMPT_COLLAPSE_ID_PREFIX = 'boarding-prompt-';

/** #2130 — boarding-prompt apns-collapse-id 빌더. */
export function boardingPromptCollapseId(tripToken: string): string {
  return buildCollapseId(BOARDING_PROMPT_COLLAPSE_ID_PREFIX, tripToken);
}

/** #2066 (Phase 2-backend) — 취침 알람(sleep-alarm) apns-collapse-id prefix. */
export const SLEEP_ALARM_COLLAPSE_ID_PREFIX = 'alarm-';

/** #2066 — 취침 알람 apns-collapse-id 빌더. trip·station 조합 단위로 collapse. */
export function sleepAlarmCollapseId(tripToken: string, targetStation: string): string {
  return buildCollapseId(SLEEP_ALARM_COLLAPSE_ID_PREFIX, tripToken, targetStation);
}

/** #2510 — 준비 알람(prepare-alarm) apns-collapse-id prefix. */
export const PREPARE_ALARM_COLLAPSE_ID_PREFIX = 'prepare-';

/** #2510 — 준비 알람 apns-collapse-id 빌더. trip·station 조합 단위로 collapse. */
export function prepareAlarmCollapseId(tripToken: string, targetStation: string): string {
  return buildCollapseId(PREPARE_ALARM_COLLAPSE_ID_PREFIX, tripToken, targetStation);
}

/**
 * #2610 (RCA-A) — fallback alert apns-collapse-id prefix.
 * silent → alert fallback은 원본 alert 없이 새로 뜨는 독립 알림이라 collapseId가 없었다.
 * lockless intermediate cron이 같은 station을 반복 등록하면(leg-2 매 cycle) fallback도
 * 반복 발사돼 알림센터에 이중·삼중 적층한다(2026-09-14 06:48:37 4건 정체 관측).
 * station-notif(prefix `station-`)와 다른 네임스페이스를 써서 서로 다른 알림 종류가
 * 우발적으로 서로를 교체해버리는 충돌을 피한다.
 */
export const FALLBACK_ALERT_COLLAPSE_ID_PREFIX = 'fallback-alert-';

/**
 * fallback alert collapseId 빌더. `identity`는 trip 신원 토큰(`entry.tripToken`)이 정상
 * 경로이고, 이를 확인할 수 없는 구 entry(#2522 이전 putPending)는 호출부가 device token
 * (`entry.token`)으로 대체해 전달한다 — 유니크성은 유지되고, 해당 legacy entry는 KV
 * TTL(120s) 내 자연 소멸이라 영향 범위가 제한적이다.
 */
export function fallbackAlertCollapseId(identity: string, stationName: string): string {
  return buildCollapseId(FALLBACK_ALERT_COLLAPSE_ID_PREFIX, identity, stationName);
}
