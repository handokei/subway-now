/**
 * #2675 — **자동 trip 종료를 사용자에게 알린다.**
 *
 * 사용자 보고(2026-09-17): "FG 진입하니 알아서 도착 후 종료돼 있음 — 도착했다는 안내도, 종료한다는
 * 알림도 없이 조용히 사라짐." 이건 정상이 아니다. 앱이 스스로 여정을 끝냈으면 그 사실이 사용자에게
 * 보여야 한다.
 *
 * 왜 지금까지 조용했나: trip 종료 알림(`TRIP_ENDED_CATEGORY`)은 **backend가 trip을 끝냈을 때**
 * 보내는 push에만 붙어 있었다. device가 스스로 끝내는 경로(도착 자동 해제 / self-end / backstop)는
 * 종료 후 backend trip을 지우기까지 하므로 backend가 알림을 보낼 주체 자체가 사라진다. 실측 덤프의
 * `receivedByKind: ... tripEnd=0`이 그 결과다. i18n 문구(`route.tripEndedArrivedTitle` /
 * `tripEndedTitle` / `tripEndedBody`)는 이미 있었지만 **소비하는 코드가 없었다**(orphan 문자열).
 *
 * 이 모듈은 그 공백만 메운다 — 종료 판정 로직은 건드리지 않는다.
 *
 * 사용자가 **직접** "안내 종료"를 누른 경우에는 부르지 않는다(본인이 한 행동을 다시 알리는 것은
 * 노이즈). 호출부는 자동 종료 경로만이다.
 */
import * as Notifications from 'expo-notifications';
import i18next from 'i18next';
import type { Station } from '../../../shared/types/station';
import { getStationDisplayName } from '../../../shared/utils/stationDisplay';
import { TRIP_ENDED_CATEGORY } from './notificationCategory';
import { createLogger } from '../../../shared/utils/logger';
import { addDomainBreadcrumb } from '../../../shared/infra/monitoring/breadcrumb';

const log = createLogger('tripEndedNotification');

/** 알림 식별자 — 같은 종료 이벤트가 여러 경로에서 겹쳐도 트레이에 1건만 남도록 고정 id. */
export const TRIP_ENDED_NOTIFICATION_ID = 'trip-ended';

/**
 * 자동 종료 사유. 문구 분기에만 쓰인다(하드코딩 분기 대신 데이터 주도 — 사유가 늘어도
 * 호출부만 값을 추가하면 된다).
 *
 * - `arrived`  : 목적지 도착으로 종료(도착 자동 해제 / self-end).
 * - `backstop` : 도착 확증 없이 안전망으로 종료(장시간 잔존 / 일시정지 만료 등).
 */
export type TripEndedReason = 'arrived' | 'backstop';

export interface NotifyTripEndedInput {
  /** 종료 시점의 목적지. 문구에 역명을 싣는다. null이면 역명 없이 종료 문구만. */
  destination: Station | null;
  reason: TripEndedReason;
}

/**
 * 자동 종료 1건을 로컬 알림으로 표시한다.
 *
 * 로컬 알림인 이유: 이 시점엔 backend trip이 이미 지워졌거나 곧 지워지므로 push를 기대할 수 없고,
 * 앱이 백그라운드/종료 상태일 수도 있어 화면 내 배너/토스트만으로는 사용자에게 도달하지 못한다.
 *
 * 실패는 swallow — 알림 하나 때문에 종료 cleanup 흐름이 깨지면 안 된다.
 */
export async function notifyTripEnded(input: NotifyTripEndedInput): Promise<void> {
  const { destination, reason } = input;
  const stationName = destination ? getStationDisplayName(destination) : null;
  const title =
    reason === 'arrived'
      ? i18next.t('route.tripEndedArrivedTitle')
      : i18next.t('route.tripEndedTitle');
  const body = stationName
    ? `${stationName} · ${i18next.t('route.tripEndedBody')}`
    : i18next.t('route.tripEndedBody');
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: TRIP_ENDED_NOTIFICATION_ID,
      content: {
        title,
        body,
        // [다음 여정 시작] 버튼. 이미 등록된 category를 재사용한다(#1798 P2).
        categoryIdentifier: TRIP_ENDED_CATEGORY,
        // 도착/종료는 소리 없이 조용히 — 다만 **보이기는 해야** 한다는 것이 이 모듈의 요구사항.
        sound: undefined,
      },
      trigger: null,
    });
    log.info(`trip-ended 알림 표시: reason=${reason} station=${stationName ?? '-'}`);
    addDomainBreadcrumb('trip', 'end-notified', { reason, station: stationName ?? '' });
  } catch (e) {
    log.warn('trip-ended 알림 표시 실패 (graceful)', e);
  }
}
