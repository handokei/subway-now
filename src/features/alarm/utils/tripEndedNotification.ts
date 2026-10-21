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
/* eslint-disable import/no-restricted-paths --
 * 취침모드(settings 슬라이스) 여부와 trip corrId(observability 슬라이스)를 읽는 cross-feature 모듈
 * (`tripEndOffer.ts` 선례). 본질적 orchestrator라 파일 단위로 명시 옵트인한다.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import i18next, { type ParseKeys } from 'i18next';
import { Platform } from 'react-native';
import { ACTIVE_TRIP_KEY } from '../../../shared/constants/storageKeys';
import type { Station } from '../../../shared/types/station';
import { getStationDisplayName } from '../../../shared/utils/stationDisplay';
import { TRIP_ENDED_CATEGORY } from './notificationCategory';
import { createLogger } from '../../../shared/utils/logger';
import { addDomainBreadcrumb } from '../../../shared/infra/monitoring/breadcrumb';
import { getCurrentTripCorrIdSync } from '../../observability/utils/tripCorrId';
import { useSettingsStore } from '../../settings/store/useSettingsStore';
import { appendAlarmLog } from './alarmLog';
import { claimTripEnd } from './tripEndClaim';
import { getTripStartedAt } from './tripStartStorage';

const log = createLogger('tripEndedNotification');

/** 알림 식별자 — 같은 종료 이벤트가 여러 경로에서 겹쳐도 트레이에 1건만 남도록 고정 id. */
export const TRIP_ENDED_NOTIFICATION_ID = 'trip-ended';

/** 알림 `data.kind` — 응답 handler/관측이 자동 종료 통지를 다른 알림과 구분하는 키. */
export const TRIP_ENDED_AUTO_KIND = 'trip-ended-auto';

/**
 * 자동 종료 사유. 문구는 `TRIP_ENDED_TEXT_KEYS` 데이터 맵으로만 결정된다(사유가 늘면 맵에 한 줄 —
 * `Record<TripEndedReason, …>`라 누락은 컴파일 에러).
 *
 * - `arrived`        : 목적지 도착으로 종료(도착 자동 해제 / self-end).
 * - `backstop`       : 도착 확증 없이 안전망으로 종료.
 * - `paused`         : 일시정지 15분 경과 backstop(`runNavigationPauseBackstop`).
 * - `lifecycle`      : 9시간 lifecycle force-end.
 * - `backend-gone`   : backend가 트립 없음(404/410)을 확정해 device가 스스로 종료.
 * - `backend-silent` : backend 침묵으로 종료(Signal 4).
 */
export type TripEndedReason =
  | 'arrived'
  | 'backstop'
  | 'paused'
  | 'lifecycle'
  | 'backend-gone'
  | 'backend-silent';

/** 종료 알림 문구 i18n 키 — 존재하지 않는 키는 컴파일 에러(리소스 타입 기반). */
type TripEndedTextKey = Extract<ParseKeys, `route.tripEnded${string}`>;

/** reason → 제목/본문 i18n 키. 분기문 대신 데이터로 구동한다. */
export const TRIP_ENDED_TEXT_KEYS: Record<
  TripEndedReason,
  { title: TripEndedTextKey; body: TripEndedTextKey }
> = {
  arrived: { title: 'route.tripEndedArrivedTitle', body: 'route.tripEndedBody' },
  backstop: { title: 'route.tripEndedTitle', body: 'route.tripEndedBody' },
  paused: { title: 'route.tripEndedTitle', body: 'route.tripEndedPausedBody' },
  lifecycle: { title: 'route.tripEndedTitle', body: 'route.tripEndedLifecycleBody' },
  'backend-gone': { title: 'route.tripEndedTitle', body: 'route.tripEndedBackendLostBody' },
  'backend-silent': { title: 'route.tripEndedTitle', body: 'route.tripEndedBackendLostBody' },
};

const MINUTE_MS = 60_000;

export interface NotifyTripEndedInput {
  /** 종료 시점의 목적지. 문구에 역명을 싣는다. null이면 역명 없이 종료 문구만. */
  destination: Station | null;
  reason: TripEndedReason;
}

/**
 * 종료 1건의 dedupe 키. corrId는 `runTripBoundCleanups`가 지우므로 **cleanup 전에** 불러야 한다
 * (cleanup 뒤 호출은 startedAt → 분 단위 폴백으로 내려간다).
 */
async function resolveEndClaimKey(): Promise<string> {
  const corrId = getCurrentTripCorrIdSync();
  if (corrId) return corrId;
  const startedAt = await getTripStartedAt().catch(() => null);
  if (startedAt !== null) return `start:${startedAt}`;
  return `min:${Math.floor(Date.now() / MINUTE_MS)}`;
}

/**
 * 자동 종료 1건을 로컬 알림으로 표시한다.
 *
 * 로컬 알림인 이유: 이 시점엔 backend trip이 이미 지워졌거나 곧 지워지므로 push를 기대할 수 없고,
 * 앱이 백그라운드/종료 상태일 수도 있어 화면 내 배너/토스트만으로는 사용자에게 도달하지 못한다.
 *
 * 같은 종료가 여러 경로에서 동시에 감지돼도 1건만 표시한다(`claimTripEnd`).
 * 실패는 swallow — 알림 하나 때문에 종료 cleanup 흐름이 깨지면 안 된다.
 */
export async function notifyTripEnded(input: NotifyTripEndedInput): Promise<void> {
  const { destination, reason } = input;
  // 어떤 단계(claim 키 조회 / 문구 조립 / 예약)가 throw해도 호출부(종료 cleanup 흐름)로 새지 않는다.
  try {
    if (!claimTripEnd(await resolveEndClaimKey())) return;
    const stationName = destination ? getStationDisplayName(destination) : null;
    const { title: titleKey, body: bodyKey } = TRIP_ENDED_TEXT_KEYS[reason];
    const bodyText = i18next.t(bodyKey);
    const body = stationName ? `${stationName} · ${bodyText}` : bodyText;
    const silent = useSettingsStore.getState().sleepMode;
    const tripToken = await AsyncStorage.getItem(ACTIVE_TRIP_KEY).catch(() => null);
    await Notifications.scheduleNotificationAsync({
      identifier: TRIP_ENDED_NOTIFICATION_ID,
      content: {
        title: i18next.t(titleKey),
        body,
        // [다음 여정 시작] 버튼. 이미 등록된 category를 재사용한다(#1798 P2).
        categoryIdentifier: TRIP_ENDED_CATEGORY,
        data: { kind: TRIP_ENDED_AUTO_KIND, reason, ...(tripToken ? { tripToken } : {}) },
        // 소리 없이 조용히 — 다만 **보이기는 해야** 한다. `undefined`가 아니라 명시 false(iOS 기본 동작에
        // 의존하지 않는다). 취침모드면 배너 없이 알림센터에만(passive, `tripEndOffer.ts` 선례).
        sound: false,
        ...(Platform.OS === 'ios' && { interruptionLevel: silent ? 'passive' : 'active' }),
      },
      trigger: null,
    });
    appendAlarmLog({
      ts: Date.now(),
      source: 'trip-end-notice',
      outcome: 'fired',
      reason: 'trip-end-notice',
      stationName: `reason=${reason}`,
    });
    log.info(`trip-ended 알림 표시: reason=${reason} station=${stationName ?? '-'}`);
    addDomainBreadcrumb('trip', 'end-notified', { reason, station: stationName ?? '' });
  } catch (e) {
    log.warn('trip-ended 알림 표시 실패 (graceful)', e);
  }
}
