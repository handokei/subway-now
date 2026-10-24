/**
 * #474 — 막차 시간표 알림 공용 상수.
 *
 * 취침모드 활성 시 사용자의 현재역(또는 목적지가 같은 노선이면 출발측)에서
 * 막차까지 남은 시간이 임계값 이하로 떨어졌을 때 알림 1회 발화.
 *
 * 정책:
 *  - 임계값(N분)은 데이터 주도. 신규 임계값 추가 시 본 파일만 갱신.
 *  - storage key는 trip-bound가 아니라 "오늘 이 stationId 1회"라 매일 자정 KST에 reset.
 *  - 노선(13 LineNumber) 누락 케이스는 dataset 자체에서 노출 (코드 분기 X).
 */

/** 막차 N분 전 알림 임계값. 분 단위. */
export const LAST_TRAIN_ALARM_THRESHOLD_MINUTES = 15;

/** 막차 잔여 시간이 음수가 되거나 다음 날로 넘어간 경우 무시할 마진. */
export const LAST_TRAIN_PAST_GRACE_MINUTES = 2;

/** 단일 발화 idempotency 키 prefix. dedup key 형식: `${PREFIX}:${stationId}:${YYYYMMDD-KST}` */
export const LAST_TRAIN_FIRED_KEY_PREFIX = 'subway-now:last-train-fired';

/** Expo notification identifier (dismiss 시 단일 surface 정리). */
export const LAST_TRAIN_NOTIFICATION_ID = 'last-train-alarm';

/** Android notification channel id. */
export const LAST_TRAIN_CHANNEL_ID = 'last-train-alarm';
