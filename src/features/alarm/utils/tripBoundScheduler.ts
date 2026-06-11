import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ALARM_PHASES, type AlarmPhase, type AlarmPhaseId } from './alarmPhases';
import { alarmKey, resolveAllTargets, type AlarmEvent } from './stationAlarm';
import { buildAlarmContent } from './stationNotification';
import type { AlarmType } from '../../../shared/types/alarm';
import { isSameStationName, type Route } from '../../../shared/utils/stationRoute';
import { HOP_TIME_MS } from '../../../shared/constants/boardingLock';
import { TRIP_BOUND_ROUTE_SIG_KEY } from '../../../shared/constants/storageKeys';
import { createLogger } from '../../../shared/utils/logger';
import { recordScheduledAlarm } from './prescheduledMetrics';

const logger = createLogger('TripBoundScheduler');

/**
 * 새 identifier prefix — boarding-lock(#584)과 #335 reschedule 경로가 사용하는 `bl:` / `alarm:`
 * 와 분리해서 lock 무관 trip-bound 사전 예약만 prefix로 식별/취소한다.
 *
 * #918 (A3): 자동 lock 후에도 네트워크 0 환경에서 silent push가 못 가는 경우를 대비해
 * trip 등록 시점에 OS local notification을 사전 예약하는 일반화된 진입점.
 */
export const TRIP_BOUND_ALARM_PREFIX = 'tba:';

/** iOS interruption level (lock scheduler와 동일 정책 — early=active, imminent=timeSensitive). */
const PHASE_INTERRUPTION: Record<AlarmPhaseId, 'active' | 'timeSensitive'> = {
  early: 'active',
  imminent: 'timeSensitive',
};

/** Android channel id — stationNotification / alarmScheduler / boardingLockScheduler와 동일. */
const ALARM_CHANNEL_ID = 'station-alarm';

/** imminent phase 고정 lead(ms) — 도착 10초 전. early는 입력 `estimatedHopTimesMs[i]`를 그대로 사용. */
const IMMINENT_LEAD_MS = 10_000;

/**
 * #918 A3 PR3 — rolling window 64 cap 회피용 윈도우 크기 (stop 단위).
 *
 * iOS는 앱당 pending local notification 64개 한도. 한 stop당 (early, imminent) 2개씩 예약되므로
 * `TRIPBOUND_WINDOW_SIZE * 2`가 tba: 채널이 OS 큐에서 점유하는 상한이다. 20 stop으로 둔 이유:
 *  - tba: 40개 + bl: 채널 6~8개(현재 windowSize 3 × 2 phase, 다음 leg 진입 시 일시적 중복 포함)
 *    + 시스템(silent push delivery 1~2건) ≈ 50개 — 64 cap 안쪽 안전 마진.
 *  - 평균 trip 길이(서울 1~9호선 30~40 stop) 대비 절반 이상 커버해, 사용자 통과 1회당 top-up 1회로
 *    rolling이 매끄럽게 진행된다 — 너무 작으면(예: 5) top-up이 매역 발생해 storage I/O 부담.
 *  - 64 cap에 너무 가까우면(예: 30) bl: 채널이 lock 전환기에 일시적으로 부풀 때 cap 초과 위험.
 */
export const TRIPBOUND_WINDOW_SIZE = 20;

/**
 * 사전 예약 대상 단일 stop. lock-free — boarding lock 메타에 의존하지 않고,
 * 호출자가 route 어떤 형태(direct/transfer/multi-transfer)든 평탄화해 넘긴다.
 */
export interface TripBoundStop {
  /** 알람 본문/identifier에 들어갈 canonical 역명. resolveAllTargets의 target.name과 동일 규약. */
  stationName: string;
  /** transfer 또는 destination — 본문 문구가 갈린다. */
  alarmType: AlarmType;
}

export interface PrescheduleParams {
  /** trip의 stop 시퀀스(0..N-1). 비어 있으면 schedule 없이 0건 반환. */
  routeStops: ReadonlyArray<TripBoundStop>;
  /**
   * stop별 leg time(ms). `routeStops[i]`에 도달하기까지 직전 지점에서 걸리는 시간.
   * 길이는 routeStops와 같아야 한다.
   *
   * 누적합 = `startTime` 기준 stop i의 예상 도착 시각.
   * 또한 `estimatedHopTimesMs[i]` 자체가 stop i의 early phase lead(ms)로 사용된다 —
   * boardingLockScheduler.computeHopTimings와 동일 의미(`legSeconds/legStops` 평균).
   */
  estimatedHopTimesMs: ReadonlyArray<number>;
  /** 누적의 기준점. trip 등록 시각(ms epoch). */
  startTime: number;
  /**
   * #918 A3 PR3 — rolling window. 예약할 stop 개수 상한. 미지정이면 routeStops 전체.
   * `startTime` 누적은 항상 routeStops[0]부터 시작하므로 windowSize는 "앞에서 N개만 예약"으로
   * 동작한다. 매역 통과 시 `topUpTripBoundWindow`가 다음 N개로 rolling.
   */
  windowSize?: number;
  /**
   * #918 A3 PR3 — top-up 진입점용. 누적은 routeStops[0]부터 진행하되, 실제 OS schedule은
   * `startStopIndex` 이상인 stop에만 호출한다 (그 이전 stop은 이미 cancel됨).
   * 미지정이면 0. 호출자(topUpTripBoundWindow)는 passedIndex+1을 넘긴다.
   *
   * 이 옵션을 두는 이유: top-up도 fire 시각을 같은 startTime + 누적 hop으로 산출해야
   * 초기 preschedule과 정확히 동일한 fire 시각을 보장한다. 그렇지 않으면 매역 통과마다
   * 누적 오차가 쌓여 imminent가 실제 도착 시각과 어긋난다.
   */
  startStopIndex?: number;
}

export interface ScheduledTripBoundAlarm {
  identifier: string;
  event: AlarmEvent;
  fireDate: Date;
}

/**
 * 단일 (stop, phase) OS local notification 1건 예약 primitive.
 *
 * 가드는 일절 갖지 않는다 — 호출자가 fireMs 가드(과거 시각 / trip 도메인 trivial 등)를 결정한
 * 뒤 호출한다. identifier 충돌 회피를 위해 `occurrenceIdx ≥ 1`이면 `:n` suffix가 붙는다
 * (`prescheduleStationAlerts`의 같은-역-중복 등장 로직과 동일 규약).
 *
 * `prescheduleStationAlerts`와 `rescheduleTripBoundAlarm` 양쪽에서 공통 사용 — 한쪽이 누적
 * `startTime` 모델, 다른 쪽이 `arrivalMs` 직접 지정 모델로 다른 도메인이지만 OS 큐 등록 책임은
 * 동일하다. 그 책임만 primitive에 둔다.
 *
 * 실패 시 caller로 throw (alarmScheduler 정책 일치). `recordScheduledAlarm`은 graceful 내부 처리.
 */
async function scheduleStopPhase(params: {
  phase: AlarmPhase;
  stop: TripBoundStop;
  fireMs: number;
  occurrenceIdx: number;
}): Promise<ScheduledTripBoundAlarm> {
  const { phase, stop, fireMs, occurrenceIdx } = params;
  const event: AlarmEvent = {
    phaseId: phase.id,
    type: stop.alarmType,
    stationName: stop.stationName,
  };
  const baseId = tripBoundAlarmIdentifier(event);
  const identifier = occurrenceIdx === 0 ? baseId : `${baseId}:${occurrenceIdx}`;
  const fireDate = new Date(fireMs);
  const { title, body } = buildAlarmContent(event);

  await Notifications.scheduleNotificationAsync({
    identifier,
    content: {
      title,
      body,
      sound: 'alarm.wav',
      ...(Platform.OS === 'android' && {
        channelId: ALARM_CHANNEL_ID,
        priority: Notifications.AndroidNotificationPriority.MAX,
      }),
      ...(Platform.OS === 'ios' && { interruptionLevel: PHASE_INTERRUPTION[phase.id] }),
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: fireDate },
  });

  await recordScheduledAlarm({ identifier, scheduledFireMs: fireMs });
  return { identifier, event, fireDate };
}

/**
 * trip 등록(자동 lock 직후 포함) 시점에 destinationName 까지 모든 stop에 대해
 * (early, imminent) OS local notification을 사전 예약한다. lock 유무와 무관.
 *
 * - 입력 검증: routeStops와 estimatedHopTimesMs의 길이가 다르면 0건. (호출자 contract 위반 — log warn)
 * - 과거 시각(`fireMs <= startTime`) 알람은 skip — 이미 지난 stop은 자동으로 생략.
 * - 어떤 phase도 예약되지 않으면 0건 반환 + warn (정상 trip은 ≥ 1건 나와야 함).
 * - scheduleNotificationAsync throw 시 caller로 그대로 전파 — alarmScheduler.ts 정책과 일치.
 *
 * 반환: 예약된 alarm 메타 배열(identifier/event/fireDate). 호출자가 추적용 큐를 별도로
 *       관리할 수 있다. cancelTripBoundAlarms()는 prefix 매칭만으로 일괄 취소한다.
 */
export async function prescheduleStationAlerts(
  params: PrescheduleParams,
): Promise<ScheduledTripBoundAlarm[]> {
  const { routeStops, estimatedHopTimesMs, startTime, windowSize, startStopIndex = 0 } = params;

  if (routeStops.length !== estimatedHopTimesMs.length) {
    logger.warn(
      `preschedule skip reason=length-mismatch stops=${routeStops.length} hops=${estimatedHopTimesMs.length}`,
    );
    return [];
  }
  if (routeStops.length === 0) {
    return [];
  }

  // window 상한 — 미지정이면 전체. 호출자가 명시한 음수/0이면 0 stop schedule(자연스럽게 no-op).
  // startStopIndex 음수 입력은 0으로 clamp — caller(top-up) bug 흡수.
  const effectiveStartIndex = startStopIndex < 0 ? 0 : startStopIndex;
  const effectiveWindowSize = windowSize === undefined ? routeStops.length : windowSize;
  const scheduleEndIndex = Math.min(
    routeStops.length,
    effectiveStartIndex + Math.max(0, effectiveWindowSize),
  );

  const scheduled: ScheduledTripBoundAlarm[] = [];
  let cumulativeMs = startTime;
  // wall-clock 가드: caller가 stale startTime을 넘겨도 이미 지난 시각으로 OS 큐에 등록되지 않게.
  // (iOS scheduleNotificationAsync는 과거 Date를 즉시 발사 — 잘못 입력 시 매역 알림 burst 회귀.)
  const nowMs = Date.now();
  // 같은 station이 route 안에 중복 등장(순환 노선 등) 시 identifier 충돌로 iOS가 silent overwrite한다.
  // 발생한 identifier를 추적해 두 번째 등장은 phaseId만으로 식별이 부족하므로 phase별 occurrenceIdx
  // suffix로 unique화한다 (cancelTripBoundAlarms는 prefix 매칭이라 영향 없음).
  const phaseStationOccurrence = new Map<string, number>();

  for (let i = 0; i < routeStops.length; i++) {
    const hopMs = estimatedHopTimesMs[i];
    // NaN/Infinity/음수 보호 — caller가 legSeconds/legStops를 legStops=0 가드 없이 계산한 케이스 등.
    if (!Number.isFinite(hopMs) || hopMs < 0) {
      logger.warn(
        `preschedule skip reason=invalid-hop stop=${routeStops[i].stationName} hopMs=${hopMs}`,
      );
      continue;
    }
    cumulativeMs += hopMs;
    const stop = routeStops[i];

    for (const phase of ALARM_PHASES) {
      const leadMs = phase.id === 'early' ? hopMs : IMMINENT_LEAD_MS;
      const fireMs = cumulativeMs - leadMs;
      // startTime 기준 + 실제 wall-clock 기준 두 조건 모두 통과해야 등록.
      if (fireMs <= startTime || fireMs <= nowMs) continue;

      // 같은 station이 route 안에 중복 등장하는 경우, identifier 충돌을 피하기 위해 occurrence 누적은
      // 윈도우 밖 stop에서도 진행해야 한다 (초기 preschedule과 top-up 호출에서 동일 identifier 산출 보장).
      const occKey = `${phase.id}:${stop.stationName}`;
      const occIdx = phaseStationOccurrence.get(occKey) ?? 0;
      phaseStationOccurrence.set(occKey, occIdx + 1);

      // 윈도우 밖 stop은 누적/occurrence 진행만, OS schedule은 skip — fire 시각/identifier 정렬 보존.
      if (i < effectiveStartIndex || i >= scheduleEndIndex) continue;

      // 가드 통과한 (stop, phase)는 primitive에 위임. ledger 적재 + identifier 결정도 primitive 책임.
      // 첫 등장은 base identifier 유지(호환), 두 번째 이상은 occIdx ≥ 1로 :n suffix가 붙는다.
      const scheduledAlarm = await scheduleStopPhase({
        phase,
        stop,
        fireMs,
        occurrenceIdx: occIdx,
      });
      scheduled.push(scheduledAlarm);
    }
  }

  if (scheduled.length === 0) {
    logger.warn(
      `preschedule skip reason=all-past stops=${routeStops.length} startTime=${startTime}`,
    );
  } else {
    logger.info(`prescheduled ${scheduled.length} alarms for ${routeStops.length} stops`);
  }
  return scheduled;
}

/**
 * identifier 형식: `tba:${phaseId}:${stationName}` 또는 같은 (phaseId, stationName) 중복 시
 * `tba:${phaseId}:${stationName}:${n}` (n ≥ 1).
 * alarmScheduler의 `alarm:` prefix와 분리해 trip-bound 사전 예약만 식별/취소한다.
 */
export function tripBoundAlarmIdentifier(
  event: Pick<AlarmEvent, 'phaseId' | 'stationName'>,
): string {
  return `${TRIP_BOUND_ALARM_PREFIX}${alarmKey(event)}`;
}

export interface ParsedTripBoundAlarmIdentifier {
  phaseId: string;
  stationName: string;
  /**
   * #1193 — 같은 stationName이 route에 중복 등장(순환선/회차)할 때, n번째 등장의 알람을 식별하는
   * 0-based 인덱스. base identifier(`tba:early:역명`)는 0, `tba:early:역명:1`은 1, `:2`는 2...
   *
   * `parseTripBoundAlarmIdentifier`가 `:n` suffix를 분리해 stationName에서 떼어 낸다 (이전 PR4까지는
   * stationName에 `:n`이 합쳐진 채 반환되어 reschedule cancel 매칭이 항상 mismatch였다).
   * suffix 형식이 깨진 경우(`:` 뒤가 숫자가 아니거나 음수 등) `:n` 부분도 stationName으로 간주 —
   * 기존 호출자 호환성 유지(`isSameStationName` 매칭은 자연 mismatch로 떨어지므로 안전).
   */
  occurrenceIdx: number;
}

/**
 * `tripBoundAlarmIdentifier()`의 역연산 (#918 A3 PR2 → #1193 확장).
 *
 * 형식:
 *   `tba:<phaseId>:<stationName>` (occurrenceIdx=0, base identifier)
 *   `tba:<phaseId>:<stationName>:<n>` (n ≥ 1, 중복역의 n번째 등장)
 *
 * prefix가 다르거나 phaseId/stationName이 비어 있으면 null.
 * `:n` 의 n이 정수가 아니면 suffix를 stationName 일부로 흡수 (역명에 콜론 포함되는 비정상 케이스도
 * graceful — backwards-compatible: 기존 호출자가 stationName 그대로 매칭하면 자연 mismatch로 처리).
 */
export function parseTripBoundAlarmIdentifier(
  identifier: string,
): ParsedTripBoundAlarmIdentifier | null {
  if (!identifier.startsWith(TRIP_BOUND_ALARM_PREFIX)) return null;
  const rest = identifier.slice(TRIP_BOUND_ALARM_PREFIX.length);
  const firstColon = rest.indexOf(':');
  if (firstColon <= 0) return null;
  const phaseId = rest.slice(0, firstColon);
  const afterPhase = rest.slice(firstColon + 1);
  if (!afterPhase) return null;
  // `:n` suffix 분리 — 마지막 ':' 뒤가 양의 정수면 occurrenceIdx로 채택.
  const lastColon = afterPhase.lastIndexOf(':');
  if (lastColon > 0) {
    const suffix = afterPhase.slice(lastColon + 1);
    // /^\d+$/ — 숫자만. 빈 문자열은 false.
    if (suffix.length > 0 && /^\d+$/.test(suffix)) {
      const occurrenceIdx = Number(suffix);
      // 0은 base identifier에서 절대 suffix로 표기되지 않으므로(`prescheduleStationAlerts` 규약)
      // `:0`이 와도 graceful하게 0으로 해석 (round-trip 안전성).
      return {
        phaseId,
        stationName: afterPhase.slice(0, lastColon),
        occurrenceIdx,
      };
    }
  }
  return { phaseId, stationName: afterPhase, occurrenceIdx: 0 };
}

/**
 * #918 A3 PR2 (#729 흡수) — preschedule 시점의 route signature 영속화 SSOT.
 * useTripBoundAlarmScheduler가 preschedule 성공 직후 1회 write하고, cancel 시 clear한다.
 * scheduledAlarmReceiver가 fire 시점에 *현재* sig와 비교해 stale 알람을 식별한다.
 *
 * 모든 함수는 graceful — storage 실패는 측정 정확도만 영향, 본 흐름 무관.
 */
export async function setRegisteredTripRouteSig(sig: string): Promise<void> {
  try {
    await AsyncStorage.setItem(TRIP_BOUND_ROUTE_SIG_KEY, sig);
  } catch {
    // graceful — 다음 preschedule cycle에서 재시도.
  }
}

export async function getRegisteredTripRouteSig(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(TRIP_BOUND_ROUTE_SIG_KEY);
  } catch {
    return null;
  }
}

export async function clearRegisteredTripRouteSig(): Promise<void> {
  try {
    await AsyncStorage.removeItem(TRIP_BOUND_ROUTE_SIG_KEY);
  } catch {
    // graceful.
  }
}

/**
 * #918 (caller-side helper): `route` + `destinationName`에서 prescheduleStationAlerts에 넘길
 * `routeStops` + `estimatedHopTimesMs`를 만든다.
 *
 * **계약**: routeStops는 *waypoint 단위*(transfer + destination만). 각 hop의 hopMs는 직전
 * waypoint→현 waypoint 전체 leg 시간(`legSeconds * 1000`). preschedule은 cumulative hop으로
 * fire 시각을 계산하므로 destination 알람은 boardedAt + 전체 trip 시간 - 10s에 발사된다.
 * (legSeconds/legStops 평균 X — 그 값은 station-level 시퀀스용이고 본 helper는 waypoint-level.
 *  self code-review에서 평균치 누적 시 imminent가 leg 1/legStops 위치에서 발사되는 회귀 식별.)
 *
 * - legSeconds≤0/NaN/Infinity 가드: HOP_TIME_MS fallback. 사용자에게 노출되는 알람 시각이
 *   NaN으로 OS 큐에 들어가는 회귀를 caller-side에서 차단(scheduler 본체의 `Number.isFinite`
 *   가드와 이중 안전).
 * - route=null 또는 destinationName=null이면 빈 배열 — 호출자(hook)는 cancel만 수행하고 schedule skip.
 */
export function deriveTripBoundStops(
  route: Route,
  destinationName: string | null,
): { routeStops: TripBoundStop[]; estimatedHopTimesMs: number[] } {
  if (!route || !destinationName) {
    return { routeStops: [], estimatedHopTimesMs: [] };
  }
  const targets = resolveAllTargets(route, destinationName);
  const routeStops: TripBoundStop[] = targets.map((t) => ({
    stationName: t.name,
    alarmType: t.alarmType,
  }));
  const estimatedHopTimesMs: number[] = targets.map((t, i) => {
    const legSeconds = legSecondsForHop(route, i, t.name);
    const legMs = legSeconds * 1000;
    if (!Number.isFinite(legMs) || legMs <= 0) return HOP_TIME_MS;
    return legMs;
  });
  return { routeStops, estimatedHopTimesMs };
}

/**
 * hopIndex / target name으로 route의 leg seconds 필드를 선택. boardingLockScheduler.legSecondsAt
 * 와 동일한 매핑(resolveAllTargets와 1:1 정렬). 두 곳을 합치는 SSOT 통합은 별도 PR.
 */
function legSecondsForHop(
  route: NonNullable<Route>,
  hopIndex: number,
  targetName: string,
): number {
  if (route.type === 'direct') return route.travelSeconds;
  if (route.type === 'transfer') {
    if (isSameStationName(route.transferName, targetName)) return route.secondsToTransfer;
    return route.secondsFromTransfer;
  }
  if (hopIndex < route.transfers.length) return route.transfers[hopIndex].secondsToTransfer;
  return route.secondsAfterLastTransfer;
}

export interface TopUpTripBoundWindowParams extends PrescheduleParams {
  /**
   * Fusion 등에서 통과 보고된 stop의 stationName. routeStops에 존재해야 effect 발생.
   * resolveAllTargets canonical name 기준 — caller가 `isSameStationName`으로 매칭해 넘긴다.
   */
  passedStationName: string;
}

export interface TopUpTripBoundWindowResult {
  cancelled: number;
  scheduled: number;
}

/**
 * #918 A3 PR3 — rolling window top-up.
 *
 * Fusion이 새 stop을 통과 보고하면 호출. 통과한 stop과 그 이전 stop의 사전 예약 알람을 cancel하고,
 * `[passedIndex+1, passedIndex+1+windowSize)` 범위에서 큐에 없는 hop을 채워 예약한다.
 *
 * `boardingLockScheduler.advanceHopWindow`와 동일 패턴 — lock-free trip-bound 예약 채널에 적용.
 * iOS 64 pending notification cap을 회피하기 위해 한 번에 큐에 두는 stop 수를 `windowSize` 이하로
 * 유지한다(기본 {@link TRIPBOUND_WINDOW_SIZE}).
 *
 * - `passedStationName`이 routeStops에 없으면 no-op (no-cancel, no-schedule).
 * - 큐가 이미 정확한 윈도우 상태면 cancel 0건 + schedule은 idempotent overwrite로 진행되지만
 *   호출이 빈번하면 OS 부하 — 호출자가 직전 passedStationName을 기억해 중복 호출을 차단해야 한다
 *   (`useTripBoundAlarmScheduler` 책임).
 * - FG resume 시 같은 함수로 진입 가능 — passedStationName이 가장 최근 통과한 stop이면 동작 일관.
 */
export async function topUpTripBoundWindow(
  params: TopUpTripBoundWindowParams,
): Promise<TopUpTripBoundWindowResult> {
  const {
    routeStops,
    estimatedHopTimesMs,
    startTime,
    passedStationName,
    windowSize = TRIPBOUND_WINDOW_SIZE,
  } = params;

  if (routeStops.length === 0) {
    return { cancelled: 0, scheduled: 0 };
  }

  const passedIndex = routeStops.findIndex((s) => s.stationName === passedStationName);
  if (passedIndex === -1) {
    return { cancelled: 0, scheduled: 0 };
  }

  // 새 윈도우 범위 = [nextStartIndex, nextEndIndex).
  const nextStartIndex = passedIndex + 1;
  const nextEndIndex = Math.min(routeStops.length, nextStartIndex + windowSize);

  // 이미 큐에 있는 `tba:` 알람 중 새 윈도우 밖에 해당하는 것만 cancel (#1193).
  // 활성 윈도우는 `${stationName}:${occurrenceIdx}` 단위로 판정해야 정확하다 — 같은 stationName이
  // route 안에 여러 번 등장하는 경우(순환선/회차) 이미 통과한 occurrence(예: A:0)와 윈도우 안의
  // 다음 occurrence(예: A:2)는 분리 식별돼야 stale cancel이 누락되지 않는다.
  const inWindowStationOccurrences = new Set<string>();
  // 누적은 routeStops 전체에 대해 진행 — `prescheduleStationAlerts`와 동일한 occurrence 규약 보존.
  const occurrenceCount = new Map<string, number>();
  for (let i = 0; i < routeStops.length; i++) {
    const name = routeStops[i].stationName;
    const occIdx = occurrenceCount.get(name) ?? 0;
    occurrenceCount.set(name, occIdx + 1);
    if (i >= nextStartIndex && i < nextEndIndex) {
      inWindowStationOccurrences.add(`${name}:${occIdx}`);
    }
  }

  const all = await Notifications.getAllScheduledNotificationsAsync();
  let cancelled = 0;
  for (const req of all) {
    if (!req.identifier.startsWith(TRIP_BOUND_ALARM_PREFIX)) continue;
    const parsed = parseTripBoundAlarmIdentifier(req.identifier);
    if (parsed === null) continue;
    if (!inWindowStationOccurrences.has(`${parsed.stationName}:${parsed.occurrenceIdx}`)) {
      await Notifications.cancelScheduledNotificationAsync(req.identifier);
      cancelled++;
    }
  }

  // 윈도우 안 stop 예약 — idempotent overwrite. 누적 startTime 기반이라 fire 시각은 초기 preschedule과 동일.
  const scheduledAlarms = await prescheduleStationAlerts({
    routeStops,
    estimatedHopTimesMs,
    startTime,
    startStopIndex: nextStartIndex,
    windowSize,
  });

  logger.info(
    `topUp passedIndex=${passedIndex} window=[${nextStartIndex},${nextEndIndex}) cancelled=${cancelled} scheduled=${scheduledAlarms.length}`,
  );
  return { cancelled, scheduled: scheduledAlarms.length };
}

/**
 * #1193 — routeStops에서 `stationName`의 `occurrenceIdx`번째 등장 인덱스를 반환.
 * `isSameStationName`(canonical name 정규화) 기반 비교 — 표기 차이(역/驛/Station 등) 흡수.
 * 등장 횟수가 occurrenceIdx 이하라면 -1.
 */
function findOccurrenceIndex(
  routeStops: ReadonlyArray<TripBoundStop>,
  stationName: string,
  occurrenceIdx: number,
): number {
  let seen = 0;
  for (let i = 0; i < routeStops.length; i++) {
    if (isSameStationName(routeStops[i].stationName, stationName)) {
      if (seen === occurrenceIdx) return i;
      seen++;
    }
  }
  return -1;
}

export interface RescheduleTripBoundAlarmParams {
  /** 정정 대상 stop의 canonical 역명 (silent push payload.nextStation과 동일 비교). */
  stationName: string;
  /** 새 도착 시각 (epoch ms). past-time이면 graceful no-op. */
  newArrivalMs: number;
  /**
   * 현재 trip의 route. 직접/환승/다중환승 어떤 형태든 — `deriveTripBoundStops`로 평탄화한다.
   * null이면 no-op (silent push 도달 시점에 client storage가 클리어된 race).
   */
  route: Route | null;
  /**
   * 현재 destination name. trip-bound stop 시퀀스의 마지막 waypoint.
   * null이면 no-op (race로 destination이 이미 클리어된 경우).
   */
  destinationName: string | null;
  /**
   * 현 시각 (epoch ms). past-time 가드용. 미지정 시 Date.now().
   * (테스트가 결정적 결과를 얻기 위해 주입.)
   */
  now?: number;
  /**
   * #1193 — 같은 stationName이 route에 중복 등장할 때 정정 대상 occurrence(0-based).
   * 누락 시 0 (= 첫 등장)으로 해석 — 중복 없는 trip / 구 backend 호환.
   *
   * `prescheduleStationAlerts`가 `${stationName}` (occurrenceIdx=0) 또는 `${stationName}:${n}` (n≥1)
   * identifier로 예약하므로, cancel 매칭과 재예약 모두 이 인덱스를 따른다.
   */
  occurrenceIdx?: number;
}

export interface RescheduleTripBoundAlarmResult {
  cancelled: number;
  scheduled: number;
}

/**
 * #918 A3 PR4 — `tba:` 채널 단일 hop 정정.
 *
 * Backend가 보낸 reschedule silent push(`channels`에 'tba' 포함)를 받아 사전 예약된
 * 해당 stop의 `tba:` 알람(both phases)을 cancel하고 newArrivalMs 기준으로 재예약한다.
 *
 * `boardingLockScheduler.rescheduleHopForLock`의 lock-free 사촌 — `trainCode` 매칭 대신
 * stationName으로 routeStops에서 hop index를 찾는다.
 *
 *   - past-time 가드: newArrivalMs ≤ now이면 cancel + reschedule 모두 skip
 *     (이미 지난 시각으로 OS에 들어가면 즉시 발사 — 잘못된 burst 차단).
 *   - stationName이 routeStops에 없으면 graceful no-op (정정 신호 폐기).
 *   - route/destinationName이 null이면 graceful no-op.
 *
 * **#1193 (중복역 trip 정정)**:
 *   - 같은 stationName이 route에 중복 등장하는 경우 `occurrenceIdx`로 정정 대상 occurrence를 명시.
 *   - cancel은 `parsed.stationName === canonicalName && parsed.occurrenceIdx === occurrenceIdx`로
 *     1건만 정확히 매칭한다 — 다른 occurrence의 사전 예약은 보존.
 *   - 재예약 시 같은 `occurrenceIdx`로 base ID(`tba:early:역`) 또는 `:n` suffix ID를 생성.
 *
 * **남은 한계**:
 *   - rolling window(`TRIPBOUND_WINDOW_SIZE`) 밖 stop에 대해서도 본 함수는 무조건 OS 큐에
 *     예약을 push한다. 호출자(silentPushTask)는 backend payload에서 윈도우 안 stop에
 *     해당하는 정정 신호만 본 함수로 전달해야 한다 (윈도우 invariant 유지 책임은 caller).
 *
 * OS API(`cancelScheduledNotificationAsync` / `getAllScheduledNotificationsAsync`)와
 * `scheduleStopPhase`(내부 `scheduleNotificationAsync`)는 throw 가능 — 호출자(silentPushTask)가
 * try/catch로 silent push handler crash를 차단한다 (alarmScheduler 정책과 일치).
 */
export async function rescheduleTripBoundAlarm(
  params: RescheduleTripBoundAlarmParams,
): Promise<RescheduleTripBoundAlarmResult> {
  const { stationName, newArrivalMs, route, destinationName } = params;
  const nowMs = params.now ?? Date.now();
  // #1193 — 정정 대상 occurrence(0-based). 미지정 시 첫 등장.
  const occurrenceIdx = params.occurrenceIdx ?? 0;

  if (newArrivalMs <= nowMs) {
    logger.info(
      `reschedule skip: past-time newArrivalMs=${newArrivalMs} now=${nowMs} station=${stationName}`,
    );
    return { cancelled: 0, scheduled: 0 };
  }
  if (!route || !destinationName) {
    logger.info(
      `reschedule skip: route=${route ? 'ok' : 'null'} destination=${destinationName ?? 'null'}`,
    );
    return { cancelled: 0, scheduled: 0 };
  }

  const { routeStops, estimatedHopTimesMs } = deriveTripBoundStops(route, destinationName);
  // #1193 — N번째 occurrence를 routeStops에서 찾는다 (occurrenceIdx=0이면 첫 등장).
  // 같은 stationName이 occurrenceIdx만큼 등장하지 않으면 silent no-op (backend/client 동기화 race).
  const targetIndex = findOccurrenceIndex(routeStops, stationName, occurrenceIdx);
  if (targetIndex === -1) {
    logger.info(
      `reschedule no-op: ${stationName} occurrence=${occurrenceIdx} not found in routeStops`,
    );
    return { cancelled: 0, scheduled: 0 };
  }

  // 기존 `tba:` 알람 중 해당 (stationName, occurrenceIdx)에 정확히 매칭하는 것만 cancel (#1193).
  // 다른 occurrence(예: 같은 역의 :0, :2)는 그대로 보존돼 stale fire 위험 없음.
  const canonicalName = routeStops[targetIndex].stationName;
  const all = await Notifications.getAllScheduledNotificationsAsync();
  let cancelled = 0;
  for (const req of all) {
    if (!req.identifier.startsWith(TRIP_BOUND_ALARM_PREFIX)) continue;
    const parsed = parseTripBoundAlarmIdentifier(req.identifier);
    if (parsed === null) continue;
    if (parsed.stationName === canonicalName && parsed.occurrenceIdx === occurrenceIdx) {
      await Notifications.cancelScheduledNotificationAsync(req.identifier);
      cancelled++;
    }
  }

  // 재예약 — newArrivalMs를 두 phase의 절대 도착 시각으로 직접 사용.
  // prescheduleStationAlerts 누적 모델(startTime + Σhop)을 거치지 않으므로 단일 stop을
  // 위해 startTime을 역산할 필요가 없다 (역산 시 early phase의 fireMs == startTime이 되어
  // 누적 모델의 `fireMs <= startTime` 가드에 정확히 걸려 silent drop되던 회귀 차단).
  //
  // 가드: nowMs 단일 — 정정 push 도착 시점 기준으로 과거 시각만 차단. trip 시작 trivial 가드
  // (cumulative 모델의 startTime 가드)는 본 시나리오와 무관 — newArrivalMs는 stop의 새 도착
  // 시각으로 backend가 보내 준 값이지 trip의 출발 시각이 아니다.
  // hopMs는 deriveTripBoundStops가 HOP_TIME_MS fallback을 보장 — 본 함수에선 별도 가드 없이 사용.
  const hopMs = estimatedHopTimesMs[targetIndex];
  const stop = routeStops[targetIndex];
  let scheduled = 0;
  for (const phase of ALARM_PHASES) {
    const leadMs = phase.id === 'early' ? hopMs : IMMINENT_LEAD_MS;
    const fireMs = newArrivalMs - leadMs;
    if (fireMs <= nowMs) continue;
    await scheduleStopPhase({ phase, stop, fireMs, occurrenceIdx });
    scheduled++;
  }

  logger.info(
    `reschedule done: station=${canonicalName} occurrence=${occurrenceIdx} cancelled=${cancelled} scheduled=${scheduled} newArrivalMs=${newArrivalMs}`,
  );
  return { cancelled, scheduled };
}

/**
 * trip 종료(release / 목적지 도착 / 사용자 취소) 시 호출 — `tba:` prefix를 가진 모든 사전
 * 예약 알람을 OS 큐에서 제거한다. 다른 prefix(alarm:, bl:)는 건드리지 않는다.
 *
 * cancelScheduledNotificationAsync는 idempotent — 이미 발사된 알람도 안전하게 통과한다.
 */
export async function cancelTripBoundAlarms(): Promise<void> {
  const all = await Notifications.getAllScheduledNotificationsAsync();
  let cancelled = 0;
  for (const req of all) {
    if (req.identifier.startsWith(TRIP_BOUND_ALARM_PREFIX)) {
      await Notifications.cancelScheduledNotificationAsync(req.identifier);
      cancelled++;
    }
  }
  if (cancelled > 0) {
    logger.info(`cancelled ${cancelled} trip-bound alarms`);
  }
  // #918 A3 PR2: sig storage도 함께 cleanup — 다음 reconcile 시 stale sig가 남지 않게.
  await clearRegisteredTripRouteSig();
}
