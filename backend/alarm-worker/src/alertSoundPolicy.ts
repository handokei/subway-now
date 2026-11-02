/**
 * #2510 재오픈 (2026-11-02) — 역 단위 alert의 모드 × 종류 → {발사 여부, sound, interruption-level} 정책 표.
 *
 * 용어(2026-10-21 사용자 확정): **알람** = 취침모드 환승 전·하차 전 소리 알람(alarm.wav, time-sensitive).
 * **알림** = 일반 notification. 알람은 취침 전용이다(ADR-024 첫 줄).
 *
 * 사고 이력: 일반모드에서 alarm.wav가 울리는 회귀(#2158 -> #2510 -> 2026-11-02 트립 186)는 발사 지점마다
 * sound를 직접 적으면서 반복됐다. 이제 backend에서 alarm.wav 리터럴은 이 파일의 `ALARM_SOUND` 한 곳뿐이고,
 * 모든 역 단위 alert는 `sendStationAlert`를 거쳐 이 표로 sound/level이 정해진다
 * (`alarmSoundLiteralGuard.test.ts`가 리터럴 매치 수와 export 목록을 강제한다).
 *
 * 타입 강제:
 * - 취침 행은 알람 또는 off, 일반 행은 알림 또는 off만 — 일반 행에 알람 sound를 넣으면 `satisfies`에서 컴파일 에러.
 * - `Record<StationAlertKind, ...>` — 종류가 늘면 두 모드 행을 모두 채워야 컴파일된다.
 * - 1역 전 push와 도착 push는 content 타입이 서로 다르다(`OneStopContent` / `ArrivalContent`) — #3237처럼
 *   도착 문구 builder가 1역 전 push에 재사용되면 컴파일 에러.
 */
import { sendAlertPush, type SendAlertPushOptions, type SendPushResult } from './apns';
import type { Trip, Waypoint } from './types';

export type TripMode = 'sleep' | 'normal';
export type StationAlertKind = 'one-stop' | 'arrival-transfer' | 'arrival-destination' | 'arrival-intermediate';

const ALARM_SOUND = 'alarm.wav';
type AlarmSound = typeof ALARM_SOUND;
/** null = aps.sound 생략(무소리 배너). */
type NotificationSound = 'default' | null;

interface Off {
  readonly fires: false;
}
interface AlarmOn {
  readonly fires: true;
  readonly sound: AlarmSound;
  readonly interruptionLevel: 'time-sensitive';
}
interface NotifOn {
  readonly fires: true;
  readonly sound: NotificationSound;
  readonly interruptionLevel: 'active' | 'time-sensitive';
}

type PolicyTable = {
  readonly sleep: Readonly<Record<StationAlertKind, Off | AlarmOn>>;
  readonly normal: Readonly<Record<StationAlertKind, Off | NotifOn>>;
};

const ALARM: AlarmOn = { fires: true, sound: ALARM_SOUND, interruptionLevel: 'time-sensitive' };

/**
 * 일반(비취침) 모드 환승·하차 도착 알림. 두 행이 이 상수 하나를 공유하므로 전환은 이 한 줄이다.
 * 현재 = S(무음 배너 + active): ADR-024 "알림 = 무소리 배너", #2510 이전 동작, #2363 "gentle".
 * 사용자가 기본음을 원하면 D로 한 줄 전환: `{ fires: true, sound: 'default', interruptionLevel: 'active' }`
 * (그 경우 ADR-024:30 스펙표 소리 행 개정이 같은 PR에 필요하다 — ADR-014 §6).
 */
const NORMAL_ARRIVAL_ALERT: NotifOn = { fires: true, sound: null, interruptionLevel: 'active' };

export const STATION_ALERT_POLICY = {
  sleep: {
    'one-stop': ALARM,
    'arrival-transfer': ALARM, // ADR-048:29 — 취침 환승·하차 도착은 loud
    'arrival-destination': ALARM,
    'arrival-intermediate': { fires: false }, // 취침 매역 mute
  },
  normal: {
    'one-stop': { fires: false }, // 2026-11-02 사용자 결정 — #2510 철회(일반모드 1정거장 전 알람 없음)
    'arrival-transfer': NORMAL_ARRIVAL_ALERT,
    'arrival-destination': NORMAL_ARRIVAL_ALERT,
    'arrival-intermediate': { fires: true, sound: null, interruptionLevel: 'active' },
  },
} as const satisfies PolicyTable;

type BrandedAlertContent<K extends 'one-stop' | 'arrival'> = {
  readonly title: string;
  readonly body: string;
  /** 타입 전용 brand — wire에 실리지 않는다(런타임 값 없음). */
  readonly __content: K;
};
/** 1정거장 전 push 문구(`sleepAlarmContent`). */
export type OneStopContent = BrandedAlertContent<'one-stop'>;
/** 환승·하차·매역 도착 push 문구(`buildStationNotifContent`). */
export type ArrivalContent = BrandedAlertContent<'arrival'>;
type ContentFor<K extends StationAlertKind> = K extends 'one-stop' ? OneStopContent : ArrivalContent;

type ArrivalAlertKind = Exclude<StationAlertKind, 'one-stop'>;
const KIND_BY_TIMING: {
  readonly 'one-stop': Readonly<Record<Waypoint['kind'], 'one-stop'>>;
  readonly arrival: Readonly<Record<Waypoint['kind'], ArrivalAlertKind>>;
} = {
  'one-stop': { intermediate: 'one-stop', transfer: 'one-stop', destination: 'one-stop' },
  arrival: {
    intermediate: 'arrival-intermediate',
    transfer: 'arrival-transfer',
    destination: 'arrival-destination',
  },
};

export function tripMode(trip: Pick<Trip, 'sleepModeEnabled'>): TripMode {
  return trip.sleepModeEnabled === true ? 'sleep' : 'normal';
}

export function stationAlertKind(target: Waypoint['kind'], timing: 'one-stop'): 'one-stop';
export function stationAlertKind(target: Waypoint['kind'], timing: 'arrival'): ArrivalAlertKind;
export function stationAlertKind(target: Waypoint['kind'], timing: 'one-stop' | 'arrival'): StationAlertKind {
  return KIND_BY_TIMING[timing][target];
}

export function resolveStationAlert(
  trip: Pick<Trip, 'sleepModeEnabled'>,
  kind: StationAlertKind,
): Off | AlarmOn | NotifOn {
  return STATION_ALERT_POLICY[tripMode(trip)][kind];
}

/**
 * 역 단위 alert 발사의 유일한 진입점. sound/interruption-level은 정책 표에서만 붙는다.
 * off 행은 발사하지 않는다 — 호출부가 `resolveStationAlert(...).fires`로 먼저 걸러야 하며, 걸러지지 않은 채
 * 도달하면 프로그래밍 오류이므로 조용히 삼키지 않고 throw한다.
 */
export async function sendStationAlert<K extends StationAlertKind>(
  trip: Pick<Trip, 'sleepModeEnabled'>,
  kind: K,
  content: ContentFor<K>,
  options: Omit<SendAlertPushOptions, 'title' | 'body' | 'sound' | 'interruptionLevel'>,
): Promise<SendPushResult> {
  const policy = resolveStationAlert(trip, kind);
  if (!policy.fires) throw new Error(`sendStationAlert: policy-off (${tripMode(trip)} x ${kind})`);
  return sendAlertPush({
    ...options,
    title: content.title,
    body: content.body,
    sound: policy.sound,
    interruptionLevel: policy.interruptionLevel,
  });
}
