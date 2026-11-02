/**
 * #3036 PR-3a — 위치 fix의 출처. 등록 스냅샷(promptGeoContext.originFixSource)으로 backend에 송신된다.
 * 값 문자열은 device/backend 파서 계약이므로 변경 시 backend와 동시에 바꾼다.
 */
export const GPS_FIX_SOURCE = {
  LIVE: 'gps-live',
  LAST_KNOWN: 'gps-last-known',
} as const;

export type GpsFixSource = (typeof GPS_FIX_SOURCE)[keyof typeof GPS_FIX_SOURCE];
