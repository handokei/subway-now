/* eslint-disable import/no-restricted-paths --
 * 취침모드(settings 슬라이스) 여부를 읽어 소리/중요도를 정한다. 단방향 read 1곳뿐이라 이 파일에만
 * 옵트인한다(ADR Phase 5 orchestration 컨벤션).
 */
/**
 * #3007 A — "아직 탑승 전이신가요? 안내를 종료할까요?" 종료 제안 (OS 예약 로컬 알림).
 *
 * 문제(10/20 실측): 18:40:11에 목적지를 설정하고 탑승 lock이 끝내 붙지 않은 lockless trip이 앱 kill 뒤
 * 06:17까지 좀비로 살아 있었다. 앱이 죽어 있으면 JS 타이머도, LA 갱신도, silent push도 없다 — 앱이
 * 살아 있지 않아도 **OS가 표시**하는 DATE 예약만이 이 공백을 건널 수 있다.
 *
 * 설계 결정(문서화):
 *  - 트리거: trip 시작(setDestination switch → TRIP_STARTED_AT stamp)으로부터 `PAUSE_AUTO_END_MS`(15분).
 *    새 매직 넘버를 만들지 않고 "정지 15분 → 종료 제안"과 같은 상수를 재사용한다.
 *  - 이것은 **제안**이지 자동 종료가 아니다. 종료는 [종료] 버튼 탭(명시 의향)에서만 일어난다.
 *    본문 탭($default)은 trip을 건드리지 않는다(ADR-014).
 *  - 카테고리: 등록된 `ALARM_CATEGORY`([확인]/[trip 종료])를 재사용한다. 신규 카테고리는 앱 부팅 등록·
 *    응답 분기·i18n 버튼을 전부 추가해야 하는데 얻는 것이 없다. 단 ALARM_CATEGORY는 지금까지 **로컬 예약에
 *    쓴 적이 없다**(backend push 전용) — 구분은 `data.kind === 'trip-end-offer'`로 하고 응답 handler가
 *    그 kind일 때만 종료 사유를 `'user-end-offer'`로 분리 기록한다.
 *  - #2822(유령 알림) 아님: title/body/sound/category/data.kind를 모두 가져 인지 가능하다.
 *  - #2155(OS 예약은 도착역 1건 최후 안전망) 대비 두 번째 OS 예약 부류다 — 고정 id 1건, alarm.wav 없음,
 *    위치 재검증이 필요 없는 시간 제안이라 조기 발사 위험 축이 해당하지 않는다.
 *  - 고정 id `trip-end-offer`: safety-net(`alarm-<token>-`)·prescheduled·legacy(`alarm:`/`bl:`/`tba:`)
 *    prefix 어느 것과도 겹치지 않아 기존 prefix cancel/sweep에 휘말리지 않는다. tripToken 없이도 취소된다
 *    (`cancelTripBoundOsQueue`는 tripToken이 없으면 early return하므로 취소가 tripToken에 의존하면 안 된다).
 *  - `killAllAlarms`(도착 알람 해제)의 `cancelAllScheduledNotificationsAsync`는 이 제안도 지운다 — 수용:
 *    그 시점은 도착 직전이라 도착 자동 종료가 담당한다.
 *  - 취침모드 ON: 소리 없음 + iOS passive(ADR-023 무음). 예약 시점의 모드로 고정된다(추정: 취침 토글은
 *    trip 시작 전후 드물게 바뀐다).
 *  - 앱 kill 상태에서 [종료] 액션이 JS에 도달하는지는 **미검증**(추정, U1) — 도달하지 않으면 사용자는 앱을
 *    열어야 한다(그래도 제안은 표시된다).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import i18next from 'i18next';
import { Platform } from 'react-native';
import { PAUSE_AUTO_END_MS } from '../../../shared/constants/realtime';
import { ACTIVE_TRIP_KEY } from '../../../shared/constants/storageKeys';
import { addDomainBreadcrumb } from '../../../shared/infra/monitoring/breadcrumb';
import { createLogger } from '../../../shared/utils/logger';
import { useSettingsStore } from '../../settings/store/useSettingsStore';
import type { LockReleaseReason } from '../store/useBoardingLockStore';
import { ALARM_CATEGORY } from './notificationCategory';
import { getTripStartedAt } from './tripStartStorage';

const log = createLogger('tripEndOffer');

/** OS 예약 고정 식별자 — 어떤 prefix sweep(`alarm-`/`alarm:`/`bl:`/`tba:`/presched)과도 겹치지 않는다. */
export const TRIP_END_OFFER_ID = 'trip-end-offer';
/** 알림 `data.kind` — 응답 handler가 이 제안을 일반 ALARM_CATEGORY 알림과 구분하는 키. */
export const TRIP_END_OFFER_KIND = 'trip-end-offer';

/** trip 시작(또는 재arm 기준 시각)으로부터 제안까지의 지연. */
const TRIP_END_OFFER_DELAY_MS = PAUSE_AUTO_END_MS;

/**
 * lock이 풀려도 **trip이 계속 이어지는** 사유 — 이 사유일 때만 제안을 재arm한다(A-2).
 * trip 종료/전환 계열(`TripEndReason` 전부, 'trip-cleanup', 'destination-change', 'auto-release-destination',
 * 'silent-push-fg-immediate')은 포함하지 않는다: 그 release는 trip 종료 cleanup의 일부이거나 곧 종료가 온다.
 */
const REARM_ON_RELEASE_REASONS: ReadonlyArray<LockReleaseReason> = [
  'user',
  'transfer',
  'vanish',
  'expired',
  'train-code-mismatch',
  'auto-release-transfer',
];

/**
 * `fromMs + 15분`에 종료 제안을 예약한다. 고정 id라 재호출은 기존 예약을 덮어쓴다.
 * 발사 시각이 이미 과거면 예약하지 않는다. 실패는 삼킨다 — 제안 하나로 trip 시작 흐름이 깨지면 안 된다.
 */
export async function scheduleTripEndOffer(fromMs: number): Promise<void> {
  const fireMs = fromMs + TRIP_END_OFFER_DELAY_MS;
  if (fireMs <= Date.now()) return;
  try {
    const tripToken = await AsyncStorage.getItem(ACTIVE_TRIP_KEY).catch(() => null);
    const silent = useSettingsStore.getState().sleepMode;
    await Notifications.scheduleNotificationAsync({
      identifier: TRIP_END_OFFER_ID,
      content: {
        title: i18next.t('notifications.tripEndOfferTitle'),
        body: i18next.t('notifications.tripEndOfferBody'),
        categoryIdentifier: ALARM_CATEGORY,
        data: { kind: TRIP_END_OFFER_KIND, ...(tripToken ? { tripToken } : {}) },
        ...(silent ? {} : { sound: 'default' }),
        ...(Platform.OS === 'ios' && { interruptionLevel: silent ? 'passive' : 'active' }),
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(fireMs) },
    });
    addDomainBreadcrumb('trip', 'end-offer-scheduled', { fireAt: fireMs });
  } catch (e) {
    log.warn('trip-end-offer 예약 실패 (graceful)', e);
  }
}

/** 예약된 제안과 이미 표시된 제안을 모두 제거한다. tripToken에 의존하지 않는다. */
export async function cancelTripEndOffer(): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(TRIP_END_OFFER_ID);
  } catch (e) {
    log.warn('trip-end-offer cancel 실패', e);
  }
  try {
    await Notifications.dismissNotificationAsync(TRIP_END_OFFER_ID);
  } catch (e) {
    log.warn('trip-end-offer dismiss 실패', e);
  }
}

/**
 * A-2 — lock이 trip 종료 없이 풀렸을 때(환승 release 등) 지금부터 15분 뒤로 제안을 다시 건다.
 * trip이 이미 없으면(tripStartedAt null) 재arm하지 않는다.
 */
export async function rearmTripEndOfferOnRelease(reason: LockReleaseReason): Promise<void> {
  if (!REARM_ON_RELEASE_REASONS.includes(reason)) return;
  if ((await getTripStartedAt()) === null) return;
  await scheduleTripEndOffer(Date.now());
}
