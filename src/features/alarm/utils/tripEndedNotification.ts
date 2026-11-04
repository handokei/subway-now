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
import { ACTIVE_TRIP_KEY, TRIP_CORR_ID_KEY } from '../../../shared/constants/storageKeys';
import type { Station } from '../../../shared/types/station';
import { getStationDisplayName } from '../../../shared/utils/stationDisplay';
import { TRIP_ENDED_CATEGORY } from './notificationCategory';
import { createLogger } from '../../../shared/utils/logger';
import { addDomainBreadcrumb } from '../../../shared/infra/monitoring/breadcrumb';
import { useSettingsStore } from '../../settings/store/useSettingsStore';
import { appendAlarmLog } from './alarmLog';
import { getCurrentTripCorrIdSync } from '../../observability/utils/tripCorrId';
import { claimTripEnd, resolveTripEndIdentity } from './tripEndClaim';
import { getTripStartedAt } from './tripStartStorage';
import { getBoardingLock } from './boardingLockStorage';
import { useBoardingLockStore } from '../store/useBoardingLockStore';

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
  /**
   * 경로 진입 시점에 `captureTripEndIdentity()`로 잡아 둔 종료 identity(dedupe 키). 생략하면 알림 시점에
   * 조회한다(폴백). 종료 경로마다 cleanup 타이밍이 달라 알림 시점 조회는 키가 갈라지므로(#3005 PR-B)
   * 자동 종료 경로는 진입 직후 캡처해 넘긴다. `null` = 캡처 시점에도 trip을 알 수 없음.
   */
  identity?: string | null;
}

/**
 * 종료 1건의 dedupe 키. corrId는 `runTripBoundCleanups`가 지우므로 **cleanup 전에** 불러야 한다
 * (cleanup 뒤 호출은 startedAt → 분 단위 폴백으로 내려간다).
 */
async function resolveEndClaimKey(captured: string | null | undefined): Promise<string> {
  const identity = captured === undefined ? await resolveTripEndIdentity() : captured;
  return identity ?? `min:${Math.floor(Date.now() / MINUTE_MS)}`;
}

/** 종료 경로 진입 시점에 캡처한 trip 신원. cleanup이 아래 값들을 지우기 전의 스냅샷이다. */
export interface TripEndSnapshot {
  /** dedupe/claim 키 — corrId 1순위 -> `start:<startedAt>` -> null(캡처 시점에도 trip을 알 수 없음). */
  identity: string | null;
  /** 진입 시점의 corrId 메모리 캐시(PR-A `expected.corrId`와 같은 출처). */
  corrId: string | null;
  /** 진입 시점의 ACTIVE_TRIP_KEY(backend trip token). */
  activeTripToken: string | null;
}

/**
 * 종료 경로 **진입 직후** trip 신원을 캡처한다(#3005 PR-B identity + PR-A expected 신원).
 * identity는 corrId 1순위 -> `start:<startedAt>` -> null. corrId 메모리 캐시가 cold launch로 아직 비어 있으면
 * storage를 직접 읽어 hydrate 완료를 기다린다 — `getCurrentTripCorrId()`는 캐시를 덮어써 cleanup이 지운 corrId를
 * 되살릴 수 있어 쓰지 않는다. 읽기는 호출 즉시(동기 구간에서) 시작되므로 뒤이은 cleanup이 지우기 전의 값을 잡는다.
 */
export async function captureTripEndSnapshot(): Promise<TripEndSnapshot> {
  const cached = getCurrentTripCorrIdSync();
  const [stored, startedAt, activeTripToken] = await Promise.all([
    cached ? Promise.resolve(null) : AsyncStorage.getItem(TRIP_CORR_ID_KEY).catch(() => null),
    cached ? Promise.resolve(null) : getTripStartedAt().catch(() => null),
    AsyncStorage.getItem(ACTIVE_TRIP_KEY).catch(() => null),
  ]);
  const corrId = cached ?? null;
  const identity =
    cached ?? stored ?? (startedAt === null ? null : `start:${startedAt}`);
  return { identity, corrId, activeTripToken };
}

/** identity만 필요한 호출부용(`clearAndNotifyTripEnded` 등). */
export async function captureTripEndIdentity(): Promise<string | null> {
  const { identity } = await captureTripEndSnapshot();
  return identity;
}

/**
 * 지금 lock 있는 trip인가 — 메모리 우선, 없으면 storage(cold launch에서 lock store가 아직 재수화 전일 수 있다).
 * lock-only-alerts(10-21): lock 없는 trip의 종료는 알림을 내지 않는다. cleanup이 lock을 지우기 **전에** 불러야 한다.
 */
export async function hasBoardingLock(): Promise<boolean> {
  if (useBoardingLockStore.getState().lock !== null) return true;
  return (await getBoardingLock()) !== null;
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
  const { destination, reason, identity } = input;
  // 어떤 단계(claim 키 조회 / 문구 조립 / 예약)가 throw해도 호출부(종료 cleanup 흐름)로 새지 않는다.
  try {
    if (!claimTripEnd(await resolveEndClaimKey(identity))) return;
    const stationName = destination ? getStationDisplayName(destination) : null;
    const { title: titleKey, body: bodyKey } = TRIP_ENDED_TEXT_KEYS[reason];
    // #3223 후속 — 도착 종료 + 목적지명이 있으면 "{역} 도착 · 안내 종료" / "목적지에 도착해 경로 안내를 마쳤어요"
    // (backend `buildTripEndedAlertContent`와 같은 문장). 그 외 사유·역명 없음은 기존 문구 유지.
    const arrivedNamed = reason === 'arrived' && stationName;
    const bodyText = i18next.t(arrivedNamed ? 'route.tripEndedArrivedBody' : bodyKey);
    const body = stationName && !arrivedNamed ? `${stationName} · ${bodyText}` : bodyText;
    const title = arrivedNamed
      ? i18next.t('route.tripEndedArrivedNamedTitle', { name: stationName })
      : i18next.t(titleKey);
    const silent = useSettingsStore.getState().sleepMode;
    const tripToken = await AsyncStorage.getItem(ACTIVE_TRIP_KEY).catch(() => null);
    await Notifications.scheduleNotificationAsync({
      identifier: TRIP_ENDED_NOTIFICATION_ID,
      content: {
        title,
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

/**
 * 자동 해제 호출부(HomeScreen 도착 / 목적지 자동 해제)용: identity와 lock 유무를 **clear 이전에** 캡처하고, clear를
 * 동기로 실행한 뒤 캡처한 identity로 알린다. clear가 corrId를 지워도 다른 종료 경로와 같은 키를 쓴다.
 * lock 없는 trip(역 탭·목적지 설정만)은 알림을 내지 않는다(lock-only-alerts, 2026-10-21 — lockless의 종료 안내는
 * 시한 종료 1회뿐이다). 종료(clear) 자체는 lock과 무관하게 항상 수행한다.
 */
export function clearAndNotifyTripEnded(clear: () => void, input: NotifyTripEndedInput): void {
  const captured = captureTripEndIdentity();
  const lockTrip = hasBoardingLock();
  clear();
  void Promise.all([captured, lockTrip]).then(([identity, hasLock]) =>
    hasLock ? notifyTripEnded({ ...input, identity }) : undefined,
  );
}
