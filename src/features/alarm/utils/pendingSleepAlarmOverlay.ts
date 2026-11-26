/**
 * #3377 — BG/잠금에서 울린 취침 알람의 오버레이(SleepAlarmOverlay) 이벤트를 저장했다가 재생한다.
 *
 * #3219 이후 오버레이 단일 소스는 FG에서 받은 companion뿐이라, 잠금/BG에서 울린 알람은 앱을 열어도 화면이 없었다.
 * 개정(ADR-048 :31 (d), 2026-11-26): BG 수신 이벤트를 **최신 1건**만 `PENDING_SLEEP_ALARM_OVERLAY_KEY`에 `{ event, firedAt }`로
 * 저장하고, 탭(30분 창) 또는 FG 진입(2분 창)에서 1회 재생한 뒤 삭제한다. `ALARM_EVENT_KEY`와 분리 — 그 키는 firedAt 없이 쓰이고 drain-only다.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AlarmEvent } from '../../../shared/types/alarm';
import { DESTINATION_KEY, PENDING_SLEEP_ALARM_OVERLAY_KEY, ROUTE_KEY, SLEEP_MODE_KEY } from '../../../shared/constants/storageKeys';
import { createLogger } from '../../../shared/utils/logger';
import type { Route } from '../../../shared/utils/stationRoute';
import type { Station } from '../../../shared/types/station';
import { buildCompanionAlarmEvent } from './companionAlarmEvent';
import { readStoredRouteLogged } from './readStoredRouteLogged';

const logger = createLogger('PendingSleepAlarmOverlay');

/** 오버레이 이벤트를 재구성하는 데 필요한 companion 필드 — 로컬 알림 `content.data`에도 같은 모양으로 실린다. */
export interface CompanionOverlayFields {
  nextStation: string;
  nextLine: string;
  targetKind: AlarmEvent['type'];
  originStation: string;
  /** 칸(타깃까지 실제 남은 정거장 수). 기본 칸(1역 전)은 생략. */
  band?: number;
}

const OVERLAY_TARGET_KINDS: readonly AlarmEvent['type'][] = ['destination', 'transfer'];

function isTargetKind(value: unknown): value is AlarmEvent['type'] {
  return OVERLAY_TARGET_KINDS.includes(value as AlarmEvent['type']);
}

/** 알림 `content.data`에서 재구성 필드를 꺼낸다. 하나라도 빠지면 null(재구성 불가). */
export function parseCompanionOverlayFields(data: unknown): CompanionOverlayFields | null {
  if (typeof data !== 'object' || data === null) return null;
  const { nextStation, nextLine, targetKind, originStation, band } = data as Record<string, unknown>;
  if (typeof nextStation !== 'string' || typeof nextLine !== 'string' || typeof originStation !== 'string') return null;
  if (!isTargetKind(targetKind)) return null;
  const hasBand = typeof band === 'number' && Number.isInteger(band) && band >= 1;
  return { nextStation, nextLine, targetKind, originStation, ...(hasBand && { band }) };
}

export function parseDestinationName(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Station> | null;
    return parsed && typeof parsed.name === 'string' ? parsed.name : null;
  } catch {
    return null;
  }
}

/**
 * companion 필드 → 오버레이 AlarmEvent. 저장된 route/destination으로 방향·stationId를 채우고, 조회가 실패하면
 * (역명, nextLine)으로 찾은 stationId만 쓴다(방향 생략). stationId를 못 구하면 null — 호출자는 오버레이를 생략한다.
 */
export async function resolveCompanionOverlayEvent(fields: CompanionOverlayFields): Promise<AlarmEvent | null> {
  let route: Route = null;
  let destinationName: string | null = null;
  try {
    const [routeRaw, destRaw] = await Promise.all([AsyncStorage.getItem(ROUTE_KEY), AsyncStorage.getItem(DESTINATION_KEY)]);
    route = readStoredRouteLogged(routeRaw, destRaw);
    destinationName = parseDestinationName(destRaw);
  } catch (e) {
    logger.warn('companion overlay: route/destination 조회 실패 — stationId 없이 표시', e);
  }
  const event = buildCompanionAlarmEvent({ route, destinationName, ...fields });
  if (!event) logger.warn('companion overlay: stationId 조회 실패 — 오버레이 생략', fields.nextStation);
  return event;
}

/** 최신 1건 덮어쓰기. 실패는 삼킨다(알람 소리·안전망 취소·ack를 막지 않는다). */
export async function savePendingSleepAlarmOverlay(event: AlarmEvent, firedAt: number = Date.now()): Promise<void> {
  try {
    await AsyncStorage.setItem(PENDING_SLEEP_ALARM_OVERLAY_KEY, JSON.stringify({ event, firedAt }));
  } catch (e) {
    logger.warn('pending sleep-alarm overlay 저장 실패', e);
  }
}

function isStoredEvent(value: unknown): value is AlarmEvent {
  if (typeof value !== 'object' || value === null) return false;
  const { phaseId, type, stationName, stationId } = value as Record<string, unknown>;
  return typeof phaseId === 'string' && isTargetKind(type) && typeof stationName === 'string' && typeof stationId === 'string';
}

/**
 * 저장 이벤트를 꺼낸다 — 있으면 **어느 경우든 키를 지운다**(재생 1회·stale 잔존 방지). 창(`windowMs`) 안의 이벤트만
 * 돌려주고, 지난 건·형식 불일치(구버전·firedAt 없음)는 null.
 */
export async function takePendingSleepAlarmOverlay({
  windowMs,
  now = Date.now(),
}: {
  windowMs: number;
  now?: number;
}): Promise<AlarmEvent | null> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_SLEEP_ALARM_OVERLAY_KEY);
    if (!raw) return null;
    await AsyncStorage.removeItem(PENDING_SLEEP_ALARM_OVERLAY_KEY);
    const { event, firedAt } = (JSON.parse(raw) ?? {}) as { event?: unknown; firedAt?: unknown };
    if (!isStoredEvent(event) || typeof firedAt !== 'number') return null;
    return now - firedAt <= windowMs ? event : null;
  } catch {
    return null;
  }
}

/**
 * storage의 sleepMode(권위). 메모리 `useSettingsStore.sleepMode`는 콜드 스타트에서 hydrate 전 false라 FG 진입·탭 재생이
 * 그 값으로 판정하면 race로 억제된다(HomeScreen이 loadSleepMode와 loadAlarmEvent를 동시에 시작). `alarmLocalAuthority.readSleepMode`와
 * 같은 판정이나, 그 모듈은 stationNotification 의존 그래프가 커서 store에서 import하지 않고 여기서 직접 읽는다.
 */
export async function isSleepModeStored(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(SLEEP_MODE_KEY);
    return raw ? JSON.parse(raw) === true : false;
  } catch {
    return false;
  }
}
