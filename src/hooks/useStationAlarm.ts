import { useEffect, useMemo, useRef, useState } from 'react';
import { isStationOnRoute, isSameStationName } from '../utils/stationRoute';
import type { Route } from '../utils/stationRoute';
import type { Station } from '../types/station';
import { alarmKey, evaluateAlarmPhase, resolveAllTargets, type AlarmEvent } from '../utils/stationAlarm';
import { resolveAlarmDirection } from '../utils/alarmDirection';
import { distanceMetersBetween, estimateEtaSeconds } from '../utils/stationEta';
import { resolveNextTarget } from '../utils/stationPipeline';
import { sendAlarmNotification, sendStationPassedNotification } from '../utils/stationNotification';
import { isImminentByArrivalCode } from '../utils/imminentArrivalSignal';
import { getStoredTripTrainCode } from '../utils/tripTrainCode';
import { useArrivalInfo } from './useArrivalInfo';
import {
  getLastNotifiedStationId,
  setLastNotifiedStationId,
  getFiredAlarms,
  setFiredAlarms,
} from '../utils/notificationState';
import { awaitInitialScheduledAlarmDrain } from '../utils/scheduledAlarmReceiver';
import {
  logFiredAlarm,
  logFiredAlarmsHydrate,
  logFiredStationPassed,
  logSuppressedDedupAlarm,
  logSuppressedDedupStation,
  logSuppressedDismissSilence,
  logSuppressedMovement,
  logSuppressedSleepFirstTransfer,
} from '../utils/alarmLog';
import { evaluateDismissSilence } from '../utils/dismissSilenceGate';
import { getBoardingLock } from '../utils/boardingLockStorage';
import { shouldSuppressBySleepRule } from '../utils/shouldSuppressBySleepRule';
import { evaluateMovement, MOVEMENT_TO_ALARM_LOG_REASON } from '../utils/movementGate';
import type { PositionStability } from '../utils/positionStaticDetector';
import { useAppStore } from '../store/useAppStore';
import { createLogger } from '../utils/logger';
import { isAccuracyAcceptable } from '../utils/locationGates';
import type { FusionConfidence, FusionSource } from '../utils/pickFusedStation';
import { resolveNotificationSource } from '../utils/notificationSource';

const logger = createLogger('StationAlarm');

/**
 * #746 — dismiss silence 게이트 판정 + 만료 시 store clear 호출.
 * 3개 effect(phase / imminent / station-passed)에서 evaluate→expired 분기를 반복하던 것을 추출.
 * 호출부는 반환값의 silenced만 보고 log + return을 직접 처리한다(콜백 미사용 → 익명 함수
 * 추가 카운팅 방지).
 *
 * - silenced=true: 호출부가 logSuppressedDismissSilence 후 즉시 return.
 * - expired=true:  헬퍼가 clear action을 fire-and-forget으로 호출(실패 무시, 다음 사이클 재시도).
 *
 * SonarCloud S3776(cognitive complexity) 해소 — phase effect의 silence 분기 4개를
 * 단일 호출로 압축. 동시에 S3735(void 연산자)도 Promise chain으로 대체.
 */
function applySilenceGate(
  silence: import('../utils/dismissSilenceStorage').DismissSilenceState | null,
  now: number,
  userLocation: { lat: number; lng: number } | null,
  clearAction: () => Promise<void>,
): { silenced: boolean } {
  const decision = evaluateDismissSilence(silence, now, userLocation);
  if (decision.silenced) return { silenced: true };
  if (decision.expired) {
    // expired → store/storage cleanup. test spy 환경에서 undefined 반환 가능성을
    // Promise.resolve로 정규화하고, 실패는 logger.warn으로 흡수해 익명 catch 핸들러를
    // 만들지 않는다(커버리지 안정).
    Promise.resolve(clearAction()).then(undefined, logClearFailure);
  }
  return { silenced: false };
}

function logClearFailure(e: unknown): void {
  logger.warn('clearDismissSilence 실패 — 다음 사이클 재시도', e);
}

export interface UseStationAlarmInputs {
  route: Route;
  destination: Station | null;
  nearestStation: Station | null;
  userLocation: { lat: number; lng: number } | null;
  speedMps: number | null;
  accuracyMeters: number | null;
  /**
   * useFusedNearestStation의 신뢰도. 'arrival-confirmed'(arvlCd=1 도착 신호)면
   * GPS accuracy 게이트가 막혀도 station-passed 알람을 발화한다 — 지하 깊은 구간
   * (accuracy > 200m) 알람 누락 해소. ETA 기반 phase 알람은 거리 계산이 필요해 GPS 게이트 유지.
   */
  arrivalConfidence?: FusionConfidence;
  /** 사용자 노출 알람 본문에 부착할 데이터 출처 (#327).
   *  useFusedNearestStation의 source를 그대로 전달. 미지정 시 라벨 부착 안 함. */
  fusionSource?: FusionSource;
  /** GPS 게이트 실패 등으로 위치 불확실. true면 source 무시하고 'uncertain' 라벨. */
  locationUncertain?: boolean;
  /**
   * #733 — useFusedNearestStation.positionStability 결과. iOS가 speed=-1(미측정)을 보고하는
   * 정적 케이스에서 evaluateMovement가 'static-position' reason으로 차단할 수 있게 한다.
   * 미전달이면 기존 동작 유지 (speed 신호만 사용).
   */
  positionStability?: PositionStability;
  /**
   * #728 — CMMotionActivity(iOS) motion=stationary 신호. true면 OS 가속도계가 사용자 정적으로 판정.
   * evaluateMovement가 'motion-stationary' reason으로 모든 카테고리(destination/transfer/station-passed)
   * 알람을 차단. 미전달/false면 기존 가드만 동작 (graceful fallback).
   */
  motionStationary?: boolean;
  /**
   * 테스트 전용 — #670/#672 좌표 warmup 가드 비활성화.
   * production 호출자는 미설정으로 둠. 단위 테스트에서 mount 직후 alarm 평가 검증 시 사용.
   */
  skipWarmupGuard?: boolean;
}

export function useStationAlarm({
  route,
  destination,
  nearestStation,
  userLocation,
  speedMps,
  accuracyMeters,
  arrivalConfidence,
  fusionSource,
  locationUncertain = false,
  positionStability,
  motionStationary,
  skipWarmupGuard = false,
}: UseStationAlarmInputs): void {
  const firedAlarmsRef = useRef<Set<string>>(new Set());
  // #699: firedAlarmsRef의 내용이 어느 destinationId에 속하는지 추적.
  // destination 변경 직후엔 hydrate effect가 setFiredHydrated(false)를 호출하지만,
  // 같은 render cycle의 ETA/API effect는 React state 전파 전이라 firedHydrated=true(stale)
  // 클로저로 진입한다. ref id가 현재 destinationId와 다르면 stale state — phase 평가를 보류해
  // 옛 ref로 새 destination에 잘못된 알람을 발사하는 race를 차단한다.
  const firedAlarmsRefDestIdRef = useRef<string | null>(null);
  // #670/#672: ETA 평가 effect의 첫 trigger를 suppress.
  // fg-hydrate 직후 hydrate된 stale firedAlarms·nearestStation과 새 GPS 좌표가 동기화되기 전
  // 즉시 평가 분기로 진입하면 잘못된 phase 알람이 발사됨. 한 cycle 보류로 다음 deps 변경(좌표/
  // hydrate state 갱신) 시 안정된 입력으로 평가.
  const isFirstAlarmEvalRef = useRef(true);
  // firedAlarms hydration: BG가 AsyncStorage(FIRED_ALARMS_KEY)에 쓴 dedup 상태를
  // destination별로 격리해 복원한다(#462). hydrated=false인 동안 phase 평가를 보류해
  // 빈 ref로 false re-fire가 발생하지 않도록 가드한다.
  const [firedHydrated, setFiredHydrated] = useState(false);
  const destinationId = destination?.id ?? null;
  // #396: 목적지 역의 도착정보를 별도로 폴링. arrivalCode가 ENTERING/ARRIVED가 되는 순간
  // imminent 신호로 사용. useArrivalInfo는 모듈 스코프 TtlCache를 공유해 추가 호출 비용이 적다.
  const { arrival: destinationArrival } = useArrivalInfo(
    destination?.name ?? null,
    destination?.line ?? null,
  );
  // 트립에 lock된 사용자 열차 코드. AsyncStorage에서 비동기 로드. lock 실패 상태(null)면
  // API 신호 평가는 보수적으로 false 반환 — 잘못된 train으로 imminent 오발사 방지.
  const [trackedTrainCode, setTrackedTrainCode] = useState<string | null>(null);
  // fusion source → 알람 본문 라벨. 두 effect(phase / station-passed)가 공유.
  const notificationSource = useMemo(
    () => (fusionSource ? resolveNotificationSource(fusionSource, locationUncertain) : undefined),
    [fusionSource, locationUncertain],
  );
  const sleepMode = useAppStore((s) => s.sleepMode);
  const allowSpeaker = useAppStore((s) => s.allowSpeaker);
  const setAlarmEvent = useAppStore((s) => s.setAlarmEvent);
  // #746 — dismiss silence 게이트 평가용 in-memory state. clear는 만료 시점에
  // store action을 통해 호출(storage도 함께 정리). 게이트 자체는 pure 함수.
  const dismissSilence = useAppStore((s) => s.dismissSilence);
  const clearDismissSilenceAction = useAppStore((s) => s.clearDismissSilence);
  const sleepModeRef = useRef(sleepMode);
  const allowSpeakerRef = useRef(allowSpeaker);

  useEffect(() => {
    sleepModeRef.current = sleepMode;
  }, [sleepMode]);

  useEffect(() => {
    allowSpeakerRef.current = allowSpeaker;
  }, [allowSpeaker]);

  // #396: 트립 trainCode lock-in 상태를 destination 도착정보 갱신마다 재로드.
  // lock-in은 첫 valid arrival 캡처 시점에 일어나므로, arrival이 들어올 때마다 확인하면
  // lock 직후 곧바로 API 신호 평가에 반영된다. destinationId가 없으면 null.
  useEffect(() => {
    if (!destinationId) {
      setTrackedTrainCode(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const code = await getStoredTripTrainCode(destinationId);
      if (!cancelled) setTrackedTrainCode(code);
    })();
    return () => {
      cancelled = true;
    };
  }, [destinationId, destinationArrival]);

  // destination별 firedAlarms 하이드레이션 (#462).
  // destination이 바뀌면 storage의 destinationId와 일치하지 않는 entry는 자동 빈 set 반환.
  // → cross-trip stale state가 새 trip의 evaluator를 오염시키지 않는다.
  useEffect(() => {
    let cancelled = false;
    setFiredHydrated(false);
    void (async () => {
      // 사전 예약 알람의 첫 drain이 완료된 후 read해야 cold start 직후
      // BG-fired 알람이 dedup set에 반영된 상태로 hydrate된다.
      await awaitInitialScheduledAlarmDrain();
      const stored = await getFiredAlarms(destinationId);
      if (cancelled) return;
      firedAlarmsRef.current = stored;
      firedAlarmsRefDestIdRef.current = destinationId;
      // #580: hydration 시점 진단 — 같은 destinationId에서 size가 다시 0으로 떨어지면 storage race.
      logFiredAlarmsHydrate(destinationId, stored.size);
      setFiredHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [destinationId]);

  // 알람 발사 + 로깅 헬퍼. ETA effect와 API 신호 effect가 동일 시퀀스를 수행하므로 통합.
  // route/destination은 호출자가 가드 후 non-null로 전달 — 함수 내부 가드 중복 제거.
  //
  // #699: setFiredAlarms를 await — fire-and-forget이면 다음 evaluation(또는 destination
  // 변경에 의한 re-hydrate, BG silent push의 storage read)이 stale state를 보고 같은
  // phase를 재발사함(2분 간격 destination 더블 fire 회귀). sync ref add 직후 storage
  // write 완료까지 기다려 FG/BG 단일 출처 일관성을 보장한다.
  async function fireAndLog(
    rawEvent: AlarmEvent,
    trigger: 'api' | 'eta',
    activeRoute: NonNullable<Route>,
    activeDestination: Station,
  ): Promise<void> {
    // #754 — in-flight dedup. 진입 즉시 firedAlarmsRef에 추가해 await 동안 effect가
    // 재실행돼도 같은 키가 evaluateAlarmPhase에서 dedup된다. 같은 키가 이미 있으면
    // 즉시 return — sync 입구에서 race window를 닫는다 (88회 burst 회귀 차단).
    // sleep-rule suppress 분기에선 아래에서 delete로 복구해 sleep 토글 후 재발사 가능.
    // alarmKey는 phaseId/stationName만 사용하므로 direction 조정 전후로 동일 키.
    const key = alarmKey(rawEvent);
    if (firedAlarmsRef.current.has(key)) return;
    firedAlarmsRef.current.add(key);

    // #750: 공통 sleep 룰 게이트. scheduler가 사전 예약을 skip한 transfer를 FG polling이
    // 우회 발사하던 회귀 차단. sleep으로 suppress된 키는 firedAlarmsRef에서 제거해 sleep OFF
    // 토글 시 다음 evaluation이 정상 발사 경로로 진입할 수 있게 한다.
    // resolveAllTargets는 route가 활성이면 최소 1개 waypoint를 반환한다 — empty 분기 가드 불필요.
    const firstHopName = resolveAllTargets(activeRoute, activeDestination.name)[0].name;
    const isFirstHop = isSameStationName(firstHopName, rawEvent.stationName);
    const lock = await getBoardingLock();
    if (
      shouldSuppressBySleepRule({
        lock,
        event: { type: rawEvent.type, stationName: rawEvent.stationName },
        sleepMode: sleepModeRef.current,
        isFirstHop,
      })
    ) {
      // delete는 ref만 갱신 — setFiredAlarms 호출 없음. 진입부 add도 ref만 갱신했으므로
      // 같은 분기 내 add → delete는 storage 관점에서 net-zero (BG가 읽는 영속 상태 불변).
      firedAlarmsRef.current.delete(key);
      logSuppressedSleepFirstTransfer({
        source: 'fg',
        stationName: rawEvent.stationName,
        phaseId: rawEvent.phaseId,
      });
      return;
    }
    // 좌/우 안내 방향. nearestStation 미정이면 direction 미부착(본문에 좌/우 라인 생략).
    const direction = nearestStation
      ? resolveAlarmDirection(rawEvent, {
          route: activeRoute,
          destinationName: activeDestination.name,
          sourceStationName: nearestStation.name,
        })
      : undefined;
    const event = direction ? { ...rawEvent, direction } : rawEvent;
    // AsyncStorage write 완료까지 await — BG/재하이드레이션 race 차단(#699).
    try {
      await setFiredAlarms(activeDestination.id, firedAlarmsRef.current);
    } catch (e) {
      logger.error('firedAlarms 영속화 실패:', e);
    }
    if (sleepModeRef.current) {
      setAlarmEvent(event);
    }
    try {
      await sendAlarmNotification(
        event,
        sleepModeRef.current,
        allowSpeakerRef.current,
        notificationSource,
      );
    } catch (e) {
      logger.error('알람 알림 실패:', e);
    }
    logFiredAlarm('fg', event, trigger);
  }

  // Phase 알람 효과: ETA 기반 phase 평가 + firedAlarms 갱신.
  // firedHydrated=false인 동안에는 보류 — BG가 이미 발화한 phase를 빈 ref로 재발화하는 것을 막는다.
  // station-passed와 분리: 하이드레이션 완료로 인한 effect 재실행이 station-passed 중복 발사를
  // 일으키지 않도록 한다(station-passed는 자체 lastNotifiedStationId dedup만 사용).
  useEffect(() => {
    if (!firedHydrated) return;

    if (!route || !destination) return;

    // #699: destination 변경 직후 firedAlarmsRef가 옛 destination 내용일 수 있다.
    // hydrate가 완료되어 ref id가 현재 destinationId와 일치할 때까지 평가 보류.
    if (firedAlarmsRefDestIdRef.current !== destination.id) return;

    // 알람 경로는 표시 경로보다 엄격한 정확도 게이트(MAX_ACCURACY_M=200m)를 적용한다.
    // useNearestStation은 지하 구간에서 정확도 1500m까지 표시용으로 수용하므로,
    // 그대로 알람을 울리면 잘못된 역에서 false alarm이 발생한다.
    // Phase 알람은 ETA 거리 계산이 필요해 GPS 게이트가 통과한 경우에만 평가한다.
    if (!isAccuracyAcceptable(accuracyMeters)) return;

    // #670/#672: 첫 trigger suppress — fg-hydrate 직후 stale state 발사 차단.
    if (!skipWarmupGuard && isFirstAlarmEvalRef.current) {
      isFirstAlarmEvalRef.current = false;
      return;
    }

    let etaSeconds: number | null = null;
    if (userLocation) {
      const distM = distanceMetersBetween(
        userLocation.lat,
        userLocation.lng,
        destination.lat,
        destination.lng,
      );
      etaSeconds = estimateEtaSeconds(distM, speedMps);
    }

    const suppressed: AlarmEvent[] = [];
    const rawEvent = evaluateAlarmPhase(
      {
        route,
        destinationName: destination.name,
        etaSeconds,
        currentLine: nearestStation?.line ?? null,
      },
      firedAlarmsRef.current,
      undefined,
      suppressed,
    );
    for (const event of suppressed) logSuppressedDedupAlarm('fg', event);
    // #699: fireAndLog가 setFiredAlarms를 await하므로 promise를 명시적으로 흘려보낸다.
    // #754: in-flight dedup은 fireAndLog 진입부의 sync firedAlarmsRef.current.add(key) 가
    // 보장한다 (await getBoardingLock 전에 set에 들어가므로 같은 키의 동시 호출은 즉시 return).
    if (rawEvent) {
      // #746 — dismiss silence 게이트. 사용자 dismiss 후 5분/200m 이내라면 모든 카테고리 차단.
      // movement/dedup보다 위 — 사용자 명시 정책이 데이터 정확성보다 우선.
      const silenceGate = applySilenceGate(
        dismissSilence,
        Date.now(),
        userLocation,
        clearDismissSilenceAction,
      );
      if (silenceGate.silenced) {
        logSuppressedDismissSilence({
          source: 'fg',
          stationName: rawEvent.stationName,
          kind: rawEvent.type,
          phaseId: rawEvent.phaseId,
        });
        return;
      }
      // #733 — Phase ETA path movement gate. early phase는 etaSeconds 무관, remainingStops<=1만
      // 검사하므로 fusion이 인접역으로 jitter하면 즉시 발사. snapshot 1/2에서 관측된 20:07:48 등
      // 정적 transfer-early 회귀 차단.
      // #728 — motionStationary 추가. speed=0.69 m/s 임계 우회 phantom과 destination/transfer 카테고리 보호.
      const movement = evaluateMovement(
        {
          speedMps: speedMps ?? undefined,
          accuracyM: accuracyMeters ?? undefined,
        },
        undefined,
        positionStability,
        motionStationary,
      );
      if (!movement.reliable && movement.reason) {
        logSuppressedMovement({
          source: 'fg',
          stationName: rawEvent.stationName,
          kind: rawEvent.type,
          phaseId: rawEvent.phaseId,
          reason: MOVEMENT_TO_ALARM_LOG_REASON[movement.reason],
        });
        return;
      }
      void fireAndLog(rawEvent, 'eta', route, destination);
    }
  }, [
    route,
    destination?.id,
    destination?.name,
    destination?.lat,
    destination?.lng,
    userLocation?.lat,
    userLocation?.lng,
    speedMps,
    accuracyMeters,
    firedHydrated,
    setAlarmEvent,
    nearestStation?.id,
    nearestStation?.line,
    positionStability,
    motionStationary,
    skipWarmupGuard,
    dismissSilence,
    clearDismissSilenceAction,
  ]);

  // #396: 도착정보 API 신호로 imminent 발사.
  // lock된 trainCode가 목적지 역에 진입/도착하면 즉시 발사 — speedMps/accuracy 무관.
  // 기존 ETA 기반 effect와 firedAlarms를 공유하므로 한쪽이 먼저 발사하면 다른 쪽은 dedup된다.
  // silent push(#478) 핸들러도 동일 isImminentByArrivalCode를 사용해 BG에서 같은 판정.
  //
  // #727: 정적 misfire 가드 — speedMps/accuracy 무관 정책은 *trackedTrainCode가 잘못 lock된*
  // 케이스에서 잘못된 발사를 막지 못한다 (정적 사용자 근처 통과 열차를 fusion이 momentary
  // adoption → 그 trainCode가 목적지역 도착하면 ENTERED → 알람 발사). evaluateMovement로
  // 정적/저신호 거부.
  useEffect(() => {
    if (!firedHydrated) return;
    if (!route || !destination) return;
    // #699: ETA effect와 동일 guard — destination 전환 race로 stale ref가 imminent를
    // 잘못 발사하는 것을 차단한다.
    if (firedAlarmsRefDestIdRef.current !== destination.id) return;
    if (!isImminentByArrivalCode(destinationArrival, trackedTrainCode)) return;

    const imminentKey = `imminent:${destination.name}`;
    if (firedAlarmsRef.current.has(imminentKey)) return;

    // #746 — dismiss silence 게이트. dismiss 후 5분/200m 이내라면 imminent도 차단.
    const silenceGate = applySilenceGate(
      dismissSilence,
      Date.now(),
      userLocation,
      clearDismissSilenceAction,
    );
    if (silenceGate.silenced) {
      logSuppressedDismissSilence({
        source: 'fg',
        stationName: destination.name,
        kind: 'destination',
        phaseId: 'imminent',
      });
      return;
    }

    // #727 정적 misfire 가드 — useStationAlarm은 timestamp 입력이 없으므로 speed/accuracy만 평가.
    // #733 — speed=null 시 positionStability fallback 사용.
    // #728 — motionStationary 추가. API imminent 경로의 destination 카테고리 보호 (13:53:53 회귀).
    const movement = evaluateMovement(
      {
        speedMps: speedMps ?? undefined,
        accuracyM: accuracyMeters ?? undefined,
      },
      undefined,
      positionStability,
      motionStationary,
    );
    if (!movement.reliable && movement.reason) {
      logSuppressedMovement({
        source: 'fg',
        stationName: destination.name,
        kind: 'destination',
        phaseId: 'imminent',
        reason: MOVEMENT_TO_ALARM_LOG_REASON[movement.reason],
      });
      return;
    }

    const rawEvent: AlarmEvent = { phaseId: 'imminent', type: 'destination', stationName: destination.name };
    // #699: setFiredAlarms 영속화 완료를 await — silent push BG 핸들러가 같은 imminent를
    // 재발사하지 않도록 storage가 sync된 후 다음 cycle 진입.
    void fireAndLog(rawEvent, 'api', route, destination);
  }, [
    firedHydrated,
    route,
    destination?.id,
    destination?.name,
    destinationArrival,
    trackedTrainCode,
    setAlarmEvent,
    nearestStation?.id,
    speedMps,
    accuracyMeters,
    positionStability,
    motionStationary,
    dismissSilence,
    clearDismissSilenceAction,
    userLocation?.lat,
    userLocation?.lng,
  ]);

  // Station-passed 알림 효과: 경로상 역 변경 시 dedup된 per-station 알림.
  // dedup은 AsyncStorage(lastNotifiedStationId)를 단일 출처로 사용 — Foreground/Background
  // 양쪽에서 동일하게 적용된다. firedHydrated에 의존하지 않으므로 하이드레이션 완료가
  // station-passed를 재발사시키지 않는다.
  // #452: deps에 raw accuracyMeters를 두면 GPS 노이즈로 매 fix 재실행 → dedup-suppressed
  // 로그가 cap까지 차서 다른 진단을 밀어낸다. 게이트 통과 여부(boolean)만 dep로 둔다.
  const accuracyOk = isAccuracyAcceptable(accuracyMeters);
  // #584 PR D2: boarding-lock(사용자가 탭한 열차를 실시간 위치 API로 확인)은 arrival-confirmed보다
  // 더 강한 신호 — GPS 정확도 게이트도 같은 등급으로 통과시킨다.
  const arrivalConfirmed =
    arrivalConfidence === 'arrival-confirmed' || arrivalConfidence === 'boarding-lock';
  // #733 — station-passed effect용 movement 차단 사유.
  // 메모이즈된 string|null만 deps에 두어 #452 회귀(accuracyMeters 노이즈로 매 fix 재실행) 회피.
  // 같은 reason 문자열은 Object.is로 동일하게 비교되어 동일 분류 안에선 effect 재실행 안 함.
  // 타입은 MOVEMENT_TO_ALARM_LOG_REASON 추론에 위임 — SSOT가 movementGate.ts (새 reason 추가 시
  // 본 위치 수정 불필요, 컴파일러가 자동 cascade).
  const movementSuppressionReason = useMemo(() => {
    const m = evaluateMovement(
      {
        speedMps: speedMps ?? undefined,
        accuracyM: accuracyMeters ?? undefined,
      },
      undefined,
      positionStability,
      motionStationary,
    );
    return m.reliable ? null : MOVEMENT_TO_ALARM_LOG_REASON[m.reason];
  }, [speedMps, accuracyMeters, positionStability, motionStationary]);

  useEffect(() => {
    let cancelled = false;
    if (!route || !destination) return;

    if (!accuracyOk && !arrivalConfirmed) return;

    // cancellation: 효과 cleanup이 cancelled를 true로 만들어 stale IIFE를 중단시킨다.
    // A→B→A 빠른 변동 시 이전 IIFE들이 cancelled로 차단되고 최신 candidate만 알림을 보낸다.
    if (nearestStation && isStationOnRoute(nearestStation, route)) {
      const candidateStation = nearestStation;
      const capturedRoute = route;
      const capturedDestinationName = destination.name;

      // #733 — station-passed movement gate (S4 fix).
      // 기존엔 accuracyOk/arrivalConfirmed만 검사 → fusion이 인접역으로 jitter하면 매번 발사.
      // snapshot 2의 20:16:52 면목 알람(사용자 정적, backend trip 없음) 같은 회귀 차단.
      // arrivalConfirmed(arrival-confirmed/boarding-lock) 강한 신호 시에는 movement gate skip —
      // 지하 GPS 끊김 등에서 arrival API가 단독 신호일 때 알람 누락을 막기 위한 기존 정책 보존.
      // deps에는 movementSuppressionReason(memoized string|null)만 사용해 #452 회귀 회피.
      if (!arrivalConfirmed && movementSuppressionReason) {
        logSuppressedMovement({
          source: 'fg',
          stationName: candidateStation.name,
          kind: 'station-passed',
          reason: movementSuppressionReason,
        });
        return;
      }

      // #746 — dismiss silence 게이트. station-passed 카테고리도 동일 정책으로 차단.
      // userLocation 없이도 시간 조건만 평가 가능 — null 좌표 그대로 전달.
      const silenceGate = applySilenceGate(
        dismissSilence,
        Date.now(),
        userLocation,
        clearDismissSilenceAction,
      );
      if (silenceGate.silenced) {
        logSuppressedDismissSilence({
          source: 'fg',
          stationName: candidateStation.name,
          kind: 'station-passed',
        });
        return;
      }

      void (async () => {
        try {
          const lastId = await getLastNotifiedStationId();
          if (cancelled) return;
          if (candidateStation.id === lastId) {
            logSuppressedDedupStation('fg', candidateStation);
            return;
          }
          // #796: candidateStation.line을 전달해 multi-transfer 환승역 정확 식별.
          const target = resolveNextTarget(
            capturedRoute,
            capturedDestinationName,
            candidateStation.line,
          );
          // 알림 발송 성공 후에만 storage write — 발송 실패 시 다음 폴링에서 재시도 가능.
          await sendStationPassedNotification(
            candidateStation.name,
            capturedDestinationName,
            target,
            notificationSource,
          );
          if (cancelled) return;
          await setLastNotifiedStationId(candidateStation.id);
          logFiredStationPassed('fg', candidateStation);
        } catch (e) {
          logger.error('역 통과 알림 실패:', e);
        }
      })();
    }

    return () => {
      cancelled = true;
    };
  }, [
    route,
    destination?.id,
    destination?.name,
    nearestStation?.id,
    accuracyOk,
    arrivalConfirmed,
    movementSuppressionReason,
    dismissSilence,
    clearDismissSilenceAction,
    userLocation?.lat,
    userLocation?.lng,
  ]);
}
