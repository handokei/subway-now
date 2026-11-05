/**
 * #2122 (FG 보조 발사) — 로컬 notification identifier 빌더.
 *
 * backend `stationNotifCollapseId`(backend/alarm-worker/src/scheduled.ts, #2063/#2086)와
 * **문자열 단위로 동일한 규칙**을 device에서 재현한다. 뒤늦게 도착하는 backend alert push의
 * `apns-collapse-id`가 이 로컬 알림과 같은 identifier면, iOS가 알림센터에서 이 로컬 알림을
 * remote로 교체한다(같은 trip 내 station-notif는 collapse-id가 trip 단위 — station 무관).
 *
 * device token(64 hex)을 통째로 넣으면 apns-collapse-id 64B 한도를 초과할 수 있어(#2086과
 * 동일 사유) `slice(0, 16)`로 축약한다. backend와 축약 길이(16)가 다르면 문자열이 어긋나
 * collapse가 성립하지 않으므로 **절대 변경 금지** — 변경 시 backend 규칙과 함께 조정해야 한다.
 */
export const STATION_NOTIF_COLLAPSE_ID_PREFIX = 'station-';

export function buildStationNotifCollapseId(deviceToken: string): string {
  return `${STATION_NOTIF_COLLAPSE_ID_PREFIX}${deviceToken.slice(0, 16)}`;
}
