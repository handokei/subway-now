/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 본 파일은 alarm 슬라이스에 있지만 route(direction)/settings(sleepMode)
 * /shared(constants, lookups)를 함께 조합하는 막차 알람 orchestrator. 후속 PR에서 orchestration
 * 슬라이스로 추출할 때 disable 제거 예정.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import i18next from 'i18next';
import type { Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import {
  LAST_TRAIN_ALARM_THRESHOLD_MINUTES,
  LAST_TRAIN_CHANNEL_ID,
  LAST_TRAIN_FIRED_KEY_PREFIX,
  LAST_TRAIN_NOTIFICATION_ID,
  LAST_TRAIN_PAST_GRACE_MINUTES,
} from '../../../shared/constants/lastTrainAlarm';
import { getStationDisplayName } from '../../../shared/utils/stationDisplay';
import { createLogger } from '../../../shared/utils/logger';
import { addDomainBreadcrumb } from '../../../shared/infra/monitoring/breadcrumb';
import { resolveTripDirection } from '../../route/utils/tripDirection';
// #2284 (P1 wire matrix gap) — 즉시 발사(trigger:null) fired-only 독립 버퍼 집계 stamp.
import { logLastTrainAlarmFired } from './alarmLog';
import {
  classifyDayTypeKst,
  getLastTrainTime,
  isLineCovered,
  minutesUntilLastTrain,
  todayKstKey,
  type DayType,
  type Direction,
} from './lastTrainSchedule';

const logger = createLogger('LastTrainAlarm');

/**
 * #474 — 막차 임박 알람 평가 결과.
 *
 * - `should-fire`: 임계값 안. 호출자가 알림 발화 + idempotency stamp.
 * - `skip:*`: 평가 단계 중 조기 종료. 호출자는 추가 액션 없이 다음 사이클로 진행.
 */
export type LastTrainEvaluationOutcome =
  | { kind: 'should-fire'; lineCovered: true; minutesRemaining: number; lastTrainTime: string; dayType: DayType; direction: Direction }
  | { kind: 'skip-sleep-off' }
  | { kind: 'skip-no-trip' }
  | { kind: 'skip-uncovered-line' }
  | { kind: 'skip-direction-unknown' }
  | { kind: 'skip-no-day-type' }
  | { kind: 'skip-no-data' }
  | { kind: 'skip-out-of-window'; minutesRemaining: number };

export interface LastTrainEvaluationInput {
  sleepMode: boolean;
  /** Origin = 현재 탑승 가능 역. lockless trip이면 fused current station. */
  origin: Station | null;
  /** 사용자가 설정한 목적지. 방향 산출에 사용. */
  destination: Station | null;
  /** stationRoute가 빌드한 route. 환승 1+회면 첫 leg 기준으로 방향 산출. */
  route: Route | null | undefined;
  now: Date;
  threshold?: number;
}

/**
 * 막차 임박 알람 발화 여부를 순수 함수로 결정. 부수효과 없음.
 *
 * 우선순위:
 *  1) sleepMode OFF → skip-sleep-off
 *  2) origin/destination 부재 → skip-no-trip (방향 산출 불가능)
 *  3) origin.line이 lastTrains.json에서 uncovered → skip-uncovered-line (graceful)
 *  4) direction null → skip-direction-unknown
 *  5) dayType null (Intl 회귀) → skip-no-day-type
 *  6) 막차 시각 데이터 부재 → skip-no-data
 *  7) 남은 시간 > threshold 또는 음수(이미 지남) → skip-out-of-window
 *  8) 그 외 → should-fire
 */
export function evaluateLastTrainAlarm(input: LastTrainEvaluationInput): LastTrainEvaluationOutcome {
  if (!input.sleepMode) return { kind: 'skip-sleep-off' };
  if (!input.origin || !input.destination || !input.route) return { kind: 'skip-no-trip' };
  if (!isLineCovered(input.origin.line)) return { kind: 'skip-uncovered-line' };
  const direction = resolveTripDirection(input.route, input.destination.name, input.origin.id);
  if (direction === null) return { kind: 'skip-direction-unknown' };
  const dayType = classifyDayTypeKst(input.now);
  if (dayType === null) return { kind: 'skip-no-day-type' };
  const lastTrainTime = getLastTrainTime({
    stationsJsonId: input.origin.id,
    dayType,
    direction,
  });
  if (lastTrainTime === null) return { kind: 'skip-no-data' };
  const minutesRemaining = minutesUntilLastTrain({ lastTrainTime, now: input.now });
  if (minutesRemaining === null) return { kind: 'skip-no-data' };
  const threshold = input.threshold ?? LAST_TRAIN_ALARM_THRESHOLD_MINUTES;
  if (minutesRemaining > threshold) return { kind: 'skip-out-of-window', minutesRemaining };
  if (minutesRemaining < -LAST_TRAIN_PAST_GRACE_MINUTES) return { kind: 'skip-out-of-window', minutesRemaining };
  return {
    kind: 'should-fire',
    lineCovered: true,
    minutesRemaining,
    lastTrainTime,
    dayType,
    direction,
  };
}

/** dedup key 형식: prefix:stationId:YYYYMMDD-KST. */
export function buildFiredKey(stationsJsonId: string, dayKey: string): string {
  return `${LAST_TRAIN_FIRED_KEY_PREFIX}:${stationsJsonId}:${dayKey}`;
}

/**
 * Android 채널 등록. 막차 알람은 취침 깨우기 위한 채널이므로 진동 활성 + DEFAULT importance.
 * silent push station-passed처럼 잠을 깨우면 안 되는 채널과 의도적으로 분리한다.
 */
export async function ensureLastTrainChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.deleteNotificationChannelAsync(LAST_TRAIN_CHANNEL_ID).catch(() => {});
  await Notifications.setNotificationChannelAsync(LAST_TRAIN_CHANNEL_ID, {
    name: i18next.t('notifications.channelLastTrain'),
    importance: Notifications.AndroidImportance.HIGH,
    enableVibrate: true,
    vibrationPattern: [0, 500, 250, 500],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
}

export interface FireLastTrainAlarmInput {
  origin: Station;
  destination: Station;
  minutesRemaining: number;
  lastTrainTime: string;
}

/** expo-notifications로 막차 N분 전 안내 1회 발화. */
export async function fireLastTrainAlarm(input: FireLastTrainAlarmInput): Promise<void> {
  await ensureLastTrainChannel();
  const originName = getStationDisplayName(input.origin);
  const destinationName = getStationDisplayName(input.destination);
  // 음수면 "막차가 방금 지났습니다" 안내, 양수면 "N분 남음".
  const minutesForText = Math.max(input.minutesRemaining, 0);
  const title = i18next.t('alarms.lastTrainTitle', {
    minutes: minutesForText,
  });
  const body = i18next.t('alarms.lastTrainBody', {
    origin: originName,
    destination: destinationName,
    time: input.lastTrainTime,
  });
  try {
    await Notifications.dismissNotificationAsync(LAST_TRAIN_NOTIFICATION_ID);
  } catch {
    // 기존 알림 없어도 무시
  }
  await Notifications.scheduleNotificationAsync({
    identifier: LAST_TRAIN_NOTIFICATION_ID,
    content: {
      title,
      body,
      sound: false,
      ...(Platform.OS === 'android' && {
        channelId: LAST_TRAIN_CHANNEL_ID,
        priority: Notifications.AndroidNotificationPriority.HIGH,
      }),
      ...(Platform.OS === 'ios' && { interruptionLevel: 'timeSensitive' as const }),
    },
    trigger: null,
  });
  logger.info('막차 알람 발화', originName, '→', destinationName, body);
  addDomainBreadcrumb('alarm', 'last-train-fire', {
    origin: input.origin.name,
    destination: input.destination.name,
    minutesRemaining: input.minutesRemaining,
    lastTrainTime: input.lastTrainTime,
  });
  // #2284 (P1) — trigger:null 즉시 발사 확정. fired-only 독립 버퍼 집계용 stamp.
  logLastTrainAlarmFired({ stationName: input.origin.name });
}

export interface RunLastTrainAlarmCycleInput extends LastTrainEvaluationInput {
  /** AsyncStorage 게이트 주입. 테스트가 in-memory store로 대체할 수 있도록 분리. */
  storage?: { getItem(key: string): Promise<string | null>; setItem(key: string, v: string): Promise<void> };
  /** fireLastTrainAlarm 주입 — 알림 발화 모킹용. */
  fire?: (input: FireLastTrainAlarmInput) => Promise<void>;
}

/**
 * 1 polling cycle 진입점. evaluate → 게이트 통과 시 idempotency 체크 → 미발화면 fire + stamp.
 * 반환: 실제로 발화했는지(true/false). 발화 outcome 정보는 logger/breadcrumb 자체 stamp.
 */
export async function runLastTrainAlarmCycle(input: RunLastTrainAlarmCycleInput): Promise<boolean> {
  const outcome = evaluateLastTrainAlarm(input);
  if (outcome.kind !== 'should-fire') return false;
  // outcome.kind === 'should-fire'면 evaluate가 origin/destination이 둘 다 not-null임을 게이트로 보증.
  // TS narrow를 위해 비-null assertion 대신 변수에 재바인딩.
  const origin = input.origin as NonNullable<typeof input.origin>;
  const destination = input.destination as NonNullable<typeof input.destination>;
  const storage = input.storage ?? AsyncStorage;
  const dayKey = todayKstKey(input.now);
  if (dayKey === '') return false; // Intl 회귀 시 dedup 키 보장 불가 → 안전 skip.
  const firedKey = buildFiredKey(origin.id, dayKey);
  const alreadyFired = await storage.getItem(firedKey);
  if (alreadyFired) return false;
  const fire = input.fire ?? fireLastTrainAlarm;
  await fire({
    origin,
    destination,
    minutesRemaining: outcome.minutesRemaining,
    lastTrainTime: outcome.lastTrainTime,
  });
  await storage.setItem(firedKey, String(input.now.getTime()));
  return true;
}
