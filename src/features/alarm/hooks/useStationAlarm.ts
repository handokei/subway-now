/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { getFirstLeg, isStationOnRoute, isSameStationName } from '../../../shared/utils/stationRoute';
import type { Route } from '../../../shared/utils/stationRoute';
import type { Station } from '../../../shared/types/station';
import { alarmKey, evaluateAlarmPhase, type AlarmEvent } from '../utils/stationAlarm';
import { resolveAlarmDirection } from '../utils/alarmDirection';
import { distanceMetersBetween, estimateEtaSeconds } from '../../../shared/utils/stationEta';
import { resolveNextTarget } from '../utils/stationPipeline';
import { sendAlarmNotification, sendStationPassedNotification } from '../utils/stationNotification';
import { isImminentByArrivalCode } from '../../arrival/utils/imminentArrivalSignal';
import { findFgArvlCdFireSignal } from '../utils/fgArvlCdFastPath';
import type { StationArrival } from '../../../shared/types/arrival';
import { getStoredTripTrainCode } from '../../route/utils/tripTrainCode';
import { useArrivalInfo } from '../../arrival/hooks/useArrivalInfo';
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
  logRefMismatch,
  logSuppressedDedupAlarm,
  logSuppressedDedupStation,
  logSuppressedDismissSilence,
  logSuppressedMovement,
  logSuppressedPhaseGate,
  logSuppressedSleepFirstTransfer,
  logSuppressedStationPassedWarmup,
} from '../utils/alarmLog';
import { evaluateDismissSilence } from '../utils/dismissSilenceGate';
import { getBoardingLock } from '../utils/boardingLockStorage';
import { shouldSuppressBySleepRule } from '../utils/shouldSuppressBySleepRule';
import { evaluateMovement, MOVEMENT_TO_ALARM_LOG_REASON } from '../../nearest-station/utils/movementGate';
import type { PositionStability } from '../../nearest-station/utils/positionStaticDetector';
import { useSettingsStore } from '../../settings/store/useSettingsStore';
import { useAlarmEventStore } from '../store/useAlarmEventStore';
import { createLogger } from '../../../shared/utils/logger';
import { isAccuracyAcceptable } from '../../nearest-station/utils/locationGates';
import type { FusionConfidence, FusionSource } from '../../../shared/types/fusion';
import { resolveNotificationSource, type NotificationSource } from '../utils/notificationSource';

const logger = createLogger('StationAlarm');

// #1010 — station-passed hydration warmup. lock hydrate 완료 후 이 기간 동안 station-passed 차단.
// 하이드레이션 직후 firedAlarms가 복원되기 전 GPS 신호와 동기화되는 과도 구간 false alarm 방지.
const STATION_PASSED_HYDRATE_WARMUP_MS = 30_000;

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

/**
 * #917 follow-up — station-passed 알림 dedup → resolve → send → setLast → log 시퀀스 추출.
 * GPS station-passed effect와 FG arvlCd fast-path effect가 동일한 5단 시퀀스를 반복하던 것
 * (Sonar cpd 27/25 line 블록)을 단일 함수로 통합. source 라벨만 다르고 dedup 키는
 * lastNotifiedStationId 단일 출처 — 어느 effect가 먼저 발사해도 다른 쪽이 자동 dedup.
 *
 * cancelled 콜백을 받는 이유: 호출부가 IIFE 내부에서 effect cleanup을 관찰해야 함.
 * await 경계마다 재확인하지 않으면 stale fire 가능.
 */
async function dispatchStationPassed(params: {
  source: 'fg' | 'fg-arvlcd';
  candidateStation: Station;
  capturedRoute: Route;
  capturedDestinationId: string;
  capturedDestinationName: string;
  notificationSource: NotificationSource | undefined;
  isCancelled: () => boolean;
  errorLogPrefix: string;
}): Promise<void> {
  const {
    source,
    candidateStation,
    capturedRoute,
    capturedDestinationId,
    capturedDestinationName,
    notificationSource,
    isCancelled,
    errorLogPrefix,
  } = params;
  try {
    const lastId = await getLastNotifiedStationId(capturedDestinationId);
    if (isCancelled()) return;
    if (candidateStation.id === lastId) {
      logSuppressedDedupStation(source, candidateStation);
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
    if (isCancelled()) return;
    await setLastNotifiedStationId(capturedDestinationId, candidateStation.id);
    logFiredStationPassed(source, candidateStation);
  } catch (e) {
    logger.error(errorLogPrefix, e);
  }
}

/**
 * #917 follow-up — silence 게이트 통과 후 dispatchStationPassed 호출. GPS path(`fg`)와 FG arvlCd
 * fast-path(`fg-arvlcd`)가 같은 silence→dispatch 시퀀스를 반복하던 Sonar cpd 25 line 블록을 통합.
 * silenced=true면 log + return; 아니면 dispatch. 두 path 모두 호출 직전에 movement gate를
 * 자체적으로 처리(GPS path는 effect 진입 시점에 미리, FG path는 본 helper 호출 직전에) 한 뒤
 * 본 함수를 호출한다.
 */
async function runSilenceGateAndDispatch(params: {
  source: 'fg' | 'fg-arvlcd';
  candidateStation: Station;
  capturedRoute: Route;
  capturedDestinationId: string;
  capturedDestinationName: string;
  notificationSource: NotificationSource | undefined;
  isCancelled: () => boolean;
  errorLogPrefix: string;
  dismissSilence: import('../utils/dismissSilenceStorage').DismissSilenceState | null;
  userLocation: { lat: number; lng: number } | null;
  clearDismissSilenceAction: () => Promise<void>;
}): Promise<void> {
  const silenceGate = applySilenceGate(
    params.dismissSilence,
    Date.now(),
    params.userLocation,
    params.clearDismissSilenceAction,
  );
  if (silenceGate.silenced) {
    logSuppressedDismissSilence({
      source: params.source,
      stationName: params.candidateStation.name,
      kind: 'station-passed',
    });
    return;
  }
  await dispatchStationPassed({
    source: params.source,
    candidateStation: params.candidateStation,
    capturedRoute: params.capturedRoute,
    capturedDestinationId: params.capturedDestinationId,
    capturedDestinationName: params.capturedDestinationName,
    notificationSource: params.notificationSource,
    isCancelled: params.isCancelled,
    errorLogPrefix: params.errorLogPrefix,
  });
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
   * #1013 — undefined는 warmup 상태(fg-hydrate 직후 ~30s). speed=null + positionStability=unknown과
   * 동시 발생 시 evaluateMovement가 'motion-warmup'으로 차단.
   */
  motionStationary?: boolean | undefined;
  /**
   * #917 A2 follow-up — FG fast path arvlCd∈{0,1} 매역 알림 입력.
   *
   * 호출자(HomeScreen 등)가 현재 폴링 중인 `useArrivalInfo` 결과를 그대로 전달한다.
   * 폴링 station은 nearestStation(또는 origin)이 일반적이며, 매역 fast-path effect는
   * 그 arrival.up/down row 중 lock.trainCode 일치 + arvlCd∈{0,1}을 트리거 신호로 본다.
   *
   * 미전달이면 fast-path 효과는 no-op — 기존 ETA/API imminent path와 backend cron 1차 source만 동작.
   */
  currentStationArrival?: StationArrival | null;
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
  currentStationArrival,
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
  // #1010: station-passed hydration warmup — 하이드레이션 완료 시각(ms). null이면 미완료.
  // warmup window 동안 station-passed effect가 즉시 차단된다.
  const stationPassedHydratedAtRef = useRef<number | null>(null);
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
  const sleepMode = useSettingsStore((s) => s.sleepMode);
  const allowSpeaker = useSettingsStore((s) => s.allowSpeaker);
  const setAlarmEvent = useAlarmEventStore((s) => s.setAlarmEvent);
  // #746 — dismiss silence 게이트 평가용 in-memory state. clear는 만료 시점에
  // store action을 통해 호출(storage도 함께 정리). 게이트 자체는 pure 함수.
  const dismissSilence = useAlarmEventStore((s) => s.dismissSilence);
  const clearDismissSilenceAction = useAlarmEventStore((s) => s.clearDismissSilence);
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
    stationPassedHydratedAtRef.current = null;
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
      // #1010: station-passed warmup 시작 — 하이드레이션 완료 시각 기록.
      stationPassedHydratedAtRef.current = Date.now();
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
    // getFirstLeg는 route 타입과 무관하게 첫 leg endName을 반환 — direct/transfer/multi-transfer
    // 모두 첫 hop과 일치 (transferName 또는 collapsed destination).
    const isFirstHop = isSameStationName(getFirstLeg(activeRoute, activeDestination.name).endName, rawEvent.stationName);
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
    // #580 M4: mismatch 발생 시 stamp — 같은 destinationId에서 반복되면 hydration race 정황.
    if (firedAlarmsRefDestIdRef.current !== destination.id) {
      logRefMismatch(destination.id, firedAlarmsRefDestIdRef.current);
      return;
    }

    // 알람 경로는 표시 경로보다 엄격한 정확도 게이트(MAX_ACCURACY_M=200m)를 적용한다.
    // useNearestStation은 지하 구간에서 정확도 1500m까지 표시용으로 수용하므로,
    // 그대로 알람을 울리면 잘못된 역에서 false alarm이 발생한다.
    // Phase 알람은 ETA 거리 계산이 필요해 GPS 게이트가 통과한 경우에만 평가한다.
    if (!isAccuracyAcceptable(accuracyMeters)) {
      logSuppressedPhaseGate('gate-phase-accuracy', destination.name);
      return;
    }

    // #670/#672: 첫 trigger suppress — fg-hydrate 직후 stale state 발사 차단.
    if (!skipWarmupGuard && isFirstAlarmEvalRef.current) {
      isFirstAlarmEvalRef.current = false;
      logSuppressedPhaseGate('gate-phase-warmup', destination.name);
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
    // #903 (Seam G) — 기압계 강등 시 evaluateAlarmPhase가 early/transfer 알람을 보류.
    // arrivalConfidence는 useFusedNearestStation이 'gps-only-underground'로 강등한 값을 그대로 흘려보냄.
    const degraded = arrivalConfidence === 'gps-only-underground';
    const rawEvent = evaluateAlarmPhase(
      {
        route,
        destinationName: destination.name,
        etaSeconds,
        currentLine: nearestStation?.line ?? null,
        degradedConfidence: degraded,
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
    // #903 — degraded 평가는 arrivalConfidence에서 파생. 지하 진입으로 'gps-only'→
    // 'gps-only-underground' 단독 전환 시(다른 deps 정적) 본 effect 재실행되어 차단 정책 즉시 반영.
    arrivalConfidence,
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
    // #580 M4: mismatch stamp.
    if (firedAlarmsRefDestIdRef.current !== destination.id) {
      logRefMismatch(destination.id, firedAlarmsRefDestIdRef.current);
      return;
    }
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
    // #903 — 위 ETA effect와 동일 사유. degraded 단독 전환에 본 API-신호 effect도 즉시 반응.
    arrivalConfidence,
  ]);

  // Station-passed 알림 효과: 경로상 역 변경 시 dedup된 per-station 알림.
  // dedup은 AsyncStorage(lastNotifiedStationId)를 단일 출처로 사용 — Foreground/Background
  // 양쪽에서 동일하게 적용된다.
  // #1010: firedHydrated 가드 + 30s warmup — lock hydrate 직후 GPS가 stabilize되기 전
  // false alarm이 발사되는 회귀를 차단한다.
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

    // #1010: firedAlarms 복원 완료 전에는 발사 보류.
    if (!firedHydrated) return;
    // #1010: hydration 완료 후 30s warmup window 동안 발사 보류.
    if (!skipWarmupGuard) {
      const hydratedAt = stationPassedHydratedAtRef.current;
      if (hydratedAt !== null && Date.now() - hydratedAt < STATION_PASSED_HYDRATE_WARMUP_MS) {
        logSuppressedStationPassedWarmup(nearestStation?.name);
        return;
      }
    }

    if (!accuracyOk && !arrivalConfirmed) return;

    // cancellation: 효과 cleanup이 cancelled를 true로 만들어 stale IIFE를 중단시킨다.
    // A→B→A 빠른 변동 시 이전 IIFE들이 cancelled로 차단되고 최신 candidate만 알림을 보낸다.
    if (nearestStation && isStationOnRoute(nearestStation, route)) {
      const candidateStation = nearestStation;
      const capturedRoute = route;
      const capturedDestinationId = destination.id;
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

      // #746 — dismiss silence 게이트 + dispatch는 helper로 통합 (Sonar cpd 회피).
      // userLocation 없이도 시간 조건만 평가 가능 — null 좌표 그대로 전달.
      void runSilenceGateAndDispatch({
        source: 'fg',
        candidateStation,
        capturedRoute,
        capturedDestinationId,
        capturedDestinationName,
        notificationSource,
        isCancelled: () => cancelled,
        errorLogPrefix: '역 통과 알림 실패:',
        dismissSilence,
        userLocation,
        clearDismissSilenceAction,
      });
    }

    return () => {
      cancelled = true;
    };
  }, [
    route,
    destination?.id,
    destination?.name,
    nearestStation?.id,
    firedHydrated,
    accuracyOk,
    arrivalConfirmed,
    movementSuppressionReason,
    dismissSilence,
    clearDismissSilenceAction,
    userLocation?.lat,
    userLocation?.lng,
  ]);

  // #917 A2 follow-up — FG fast path: lock.trainCode가 currentStationArrival의 row에
  // arvlCd∈{0,1}으로 첫 관찰되면 nearestStation에 대한 매역(station-passed) 알림 즉시 발사.
  //
  // 백엔드 cron(10~30s 사이클) 대비 우위: 클라는 useArrivalInfo 1주기(보통 30s) 안에 같은 신호를
  // 이미 가지고 있으므로 BG silent push 도달 지연 없이 발사 가능. 지하/지상 무관 SSOT가 GPS 아닌
  // Seoul `realtimeArrivalList`.
  //
  // 가드 (AND, 하나라도 false면 no-op):
  //   1. firedHydrated — destination별 firedAlarms 복원 완료 후
  //   2. route + destination + nearestStation 존재 (nearest 없으면 fire 대상 station 결정 불가)
  //   3. firedAlarmsRef destinationId 일치 (#699 race 가드)
  //   4. nearestStation이 route 상에 있음 (off-route 신호 무시)
  //   5. lock 존재 + lock.trainCode == row.trainCode + arvlCd∈{0,1} (findFgArvlCdFireSignal — #640 회귀 가드)
  //   6. dismiss silence 미적용
  //   7. movement gate(speed/accuracy/static) 통과
  //   8. lastNotifiedStationId 미일치 (GPS station-passed와 dedup 공유 — 한 station에 한 알람)
  //
  // dedup 정책: lastNotifiedStationId 단일 출처. 기존 station-passed effect와 같은 키를 사용해
  // GPS 경로/Fast path 어느 쪽이 먼저 발사해도 다른 쪽은 자동 dedup. 이슈가 명시한
  // `(trainCode, station, arvlCd)` granularity는 station-level dedup의 superset이라 충족된다.
  useEffect(() => {
    if (!firedHydrated) return;
    if (!route || !destination) return;
    if (!nearestStation) return;
    // #580 M4: mismatch stamp.
    if (firedAlarmsRefDestIdRef.current !== destination.id) {
      logRefMismatch(destination.id, firedAlarmsRefDestIdRef.current);
      return;
    }
    if (!currentStationArrival) return;
    if (!isStationOnRoute(nearestStation, route)) return;

    const candidateStation = nearestStation;
    const capturedRoute = route;
    const capturedDestinationId = destination.id;
    const capturedDestinationName = destination.name;

    let cancelled = false;
    void (async () => {
      const lock = await getBoardingLock();
      if (cancelled) return;
      // #640 회귀 가드 — lock 부재 시 lockless trip의 임의 train arvlCd로 fire 절대 금지.
      // findFgArvlCdFireSignal 내부 가드와 중복이지만 명시 — 가드 본질이 본 PR의 핵심.
      if (!lock) return;
      const signal = findFgArvlCdFireSignal(currentStationArrival, lock);
      if (!signal) return;

      // #727/#728/#733 — 정적 misfire 가드. arvlCd 신호가 강해도 정적 사용자(speed=0) 발사는
      // 잘못된 trainCode lock 케이스 (fusion이 통과 열차를 momentary adopt)에서 위험.
      // movement gate는 silence gate보다 먼저 평가 — 정적 사용자면 silence 만료 부수효과도 불필요.
      if (movementSuppressionReason) {
        logSuppressedMovement({
          source: 'fg-arvlcd',
          stationName: candidateStation.name,
          kind: 'station-passed',
          reason: movementSuppressionReason,
        });
        return;
      }

      // #746 silence gate + dispatch는 helper로 통합 (Sonar cpd 회피).
      // lastNotifiedStationId 공유 dedup. cancelled 재확인 — getBoardingLock 후 effect cleanup 가능.
      await runSilenceGateAndDispatch({
        source: 'fg-arvlcd',
        candidateStation,
        capturedRoute,
        capturedDestinationId,
        capturedDestinationName,
        notificationSource,
        isCancelled: () => cancelled,
        errorLogPrefix: 'FG arvlCd fast-path 알림 실패:',
        dismissSilence,
        userLocation,
        clearDismissSilenceAction,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [
    firedHydrated,
    route,
    destination?.id,
    destination?.name,
    nearestStation?.id,
    nearestStation?.name,
    nearestStation?.line,
    currentStationArrival,
    movementSuppressionReason,
    dismissSilence,
    clearDismissSilenceAction,
    userLocation?.lat,
    userLocation?.lng,
    notificationSource,
  ]);
}
