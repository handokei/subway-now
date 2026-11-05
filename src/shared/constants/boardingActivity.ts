/**
 * #3221 — 탑승여부 Live Activity(여정 LA와 별도 ActivityKit 타입) 상수.
 */

/** push-to-start(서버가 앱 없이 탑승 LA를 시작) 가능한 최소 iOS 버전. */
export const BOARDING_PUSH_TO_START_MIN_IOS = { major: 17, minor: 2 } as const;

/** 앱 foreground에서 탑승 LA를 시작할 수 있는 최소 iOS 버전(AppIntent 버튼이 iOS 17.0+). */
export const BOARDING_FG_START_MIN_IOS = { major: 17, minor: 0 } as const;

/** 노선을 해석하지 못한 프롬프트의 탑승 LA 배지 중립색(iOS system gray). */
export const BOARDING_UNKNOWN_LINE_COLOR_HEX = '#8E8E93';
