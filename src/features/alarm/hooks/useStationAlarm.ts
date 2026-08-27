/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  getFirstLeg,
  getRouteRemainingSeconds,
  isStationOnRoute,
  isSameStationName,
  isStationWithinHopWindow,
  arcIndexOf,
  LOCKLESS_HOP_WINDOW_DEFAULT,
  computeHopWindowSize,
} from '../../../shared/utils/stationRoute';
import type { Route } from '../../../shared/utils/stationRoute';
import type { Station } from '../../../shared/types/station';
import { alarmKey, parseAlarmKey, evaluateAlarmPhase, type AlarmEvent } from '../utils/stationAlarm';
import { resolveAlarmDirection } from '../utils/alarmDirection';
import { distanceMetersBetween, estimateTransitEtaSeconds } from '../../../shared/utils/stationEta';
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
import { getTripStartedAt } from '../utils/tripStartStorage';
import {
  logFiredAlarm,
  logFiredStationPassed,
  logFiredAlarmsHydrate,
  logFiredAlarmsTripBoundaryReset,
  logHydrationTransition,
  logRefMismatch,
  logSuppressedChannelAgnosticDedup,
  logSuppressedCrossCategoryDedup,
  logSuppressedCrossCategoryRecent,
  logSuppressedFireAlarmOnce,
  logSuppressedPhaseToPhaseDedup,
  logSuppressedDedupAlarm,
  logSuppressedDedupStation,
  logSuppressedDismissSilence,
  logSuppressedHopWindow,
  logSuppressedHopWindowNoSource,
  logSuppressedPassedEventOnLockOrigin,
  logSuppressedMovement,
  logSuppressedPhaseGate,
  logSuppressedSleepFirstTransfer,
  logSuppressedSsotFireGate,
  logSuppressedStationPassedWarmup,
  logSuppressedLocklessNoUserIntent,
  type HydrationPhase,
} from '../utils/alarmLog';
import { fireAlarmOnce } from '../utils/fireAlarmOnce';
import { evaluateSsotFireGate } from '../utils/ssotFireGate';
import {
  isAnyChannelRecentlyFired,
  isStationRecentlyFired,
  isPhaseToPhaseCrossStationRecentlyFired,
  isTripScopedCrossCategoryRecentlyFired,
  markStationFired,
} from '../utils/crossCategoryStationDedup';
import { evaluateDismissSilence } from '../utils/dismissSilenceGate';
import { getBoardingLock } from '../utils/boardingLockStorage';
import { resolveCurrentLine } from '../utils/resolveCurrentLine';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { LineNumber } from '../../../shared/types/station';
import { shouldSuppressBySleepRule } from '../utils/shouldSuppressBySleepRule';
import { evaluateMovement, MOVEMENT_TO_ALARM_LOG_REASON } from '../../nearest-station/utils/movementGate';
import type { PositionStability } from '../../nearest-station/utils/positionStaticDetector';
import { useSettingsStore } from '../../settings/store/useSettingsStore';
import { useAlarmEventStore } from '../store/useAlarmEventStore';
// #2387 — 명시 탭 의향(infoModeEnabled) 환승 계승. lock=null을 "미탭" proxy로 쓰던 게이트가
// 환승 후 lock release 시 명시 탭 의향까지 함께 억제하던 회귀를 막는다.
import { useUserIntentStore } from '../store/useUserIntentStore';
import { createLogger } from '../../../shared/utils/logger';
import { isAccuracyAcceptable } from '../../nearest-station/utils/locationGates';
import type { FusionConfidence, FusionSource } from '../../../shared/types/fusion';
import { isStrongFusionSource } from '../../../shared/constants/fusionSourceStrength';
import { isSimpleArchEnabled } from '../../../shared/config/archFlag';
import {
  fireFgAuxStationPassedNotification,
  fireLocalAlarmNotification,
  type StationPassedTargetKind,
} from '../utils/stationNotification';
import { markLocalStationFired } from '../utils/recentLocalStationFires';
import { resolveNotificationSource } from '../utils/notificationSource';
import { isMinimalAlarmEnabled } from '../../../shared/constants/debugFlags';

const logger = createLogger('StationAlarm');

/**
 * #1984 (Phase 1-4, ADR-022 B3) — client 채널 통합 fire path.
 *
 * flag OFF (default, `EXPO_PUBLIC_SIMPLE_ARRIVAL_ARCH !== 'true'`): 기존 fire 흐름 유지
 * (Phase ETA + API imminent 두 useEffect가 각각 `fireAndLog` 직접 호출). backward-compat 보장.
 *
 * flag ON (`EXPO_PUBLIC_SIMPLE_ARRIVAL_ARCH === 'true'` — dogfood 빌드): 두 useEffect가
 * `fireAlarmOnce` unified ledger를 통과한 뒤에만 `fireAndLog` 호출. ledger key =
 * `${stationName}|${line}|${kind}|${phase}` — 같은 초 동시 dispatch race 차단.
 *
 * 회귀 evidence (2026-07-01 08:32:09 성수 fg fired station-passed 2건, #1980 코멘트 케이스 1).
 *
 * #2002 — 임시 module-scope `let simpleArchEnabled` + `__setSimpleArchEnabledForTests` 삭제.
 * Phase 0 real helper `isSimpleArchEnabled()` (`src/shared/config/archFlag.ts`) 로 교체 —
 * env `EXPO_PUBLIC_SIMPLE_ARRIVAL_ARCH === 'true'` 또는 caller 가 remote flag 전달 시 활성.
 * fire 시점에 매번 조회 — 매 시점 최신 flag 반영 (테스트에서 env 조작만으로 flag 전환 가능).
 */

// #1010/#1316/#1645 — 하이드레이션 warmup. lock hydrate 완료 후 이 기간 동안 알람 발사를 차단한다.
// 하이드레이션 직후 firedAlarms가 복원되기 전 GPS/ETA 신호와 동기화되는 과도 구간 false alarm 방지.
// station-passed effect(#1010)와 phase 알람 effect(#1316) 양쪽이 같은 window를 공유한다.
//
// #1645 — 30s → 10s 단축. 사용자 trip evidence 6/22 13:38~41 (상왕십리/신당/동대문역사문화공원
// 첫 3 station 알림 누락) — destination 변경/cold start 직후 30s window가 지하철 station 간격(1~2분)
// 보다 길어 V4 acceptance(매역 silent 알림) 일관 위반. 단축 + 다른 가드(firedAlarmsRefDestIdRef #699,
// cross-category dedup #1515, hydrationPhase H5, SSoT Gate A) 이중 보호로 false fire 회귀 방지.
const HYDRATE_WARMUP_MS = 10_000;

/**
 * #1010/#1316 — 하이드레이션 완료(hydratedAt) 후 HYDRATE_WARMUP_MS 시간 window 안인지 판정.
 * hydratedAt=null(미완료)이면 false — 발사 보류는 호출부의 hydrationPhase!=='ready' 가드가 담당하므로
 * 여기선 window 시작 전을 window 밖으로 본다. phase/station-passed 두 effect가 동일 판정을 공유한다.
 */
function isWithinHydrateWarmup(hydratedAt: number | null, now: number): boolean {
  return hydratedAt !== null && now - hydratedAt < HYDRATE_WARMUP_MS;
}

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
 * #1816 — lockless trip + 사용자 명시 의향 없음 시 station-passed 억제 로그 헬퍼.
 * fg / fg-subsurface 두 경로에서 동일한 4행 블록이 반복되어 SonarCloud CPD 해소.
 * lock=null = boardingPrompt 미응답 + BoardingTrainList 미탭.
 */
function logSuppressedStationPassedLockless(stationName: string): void {
  logSuppressedLocklessNoUserIntent({
    source: 'fg',
    stationName,
    kind: 'station-passed',
  });
}

/**
 * #2387 — lockless trip + 사용자 명시 의향(infoModeEnabled) 부재 판정 공통 헬퍼.
 * lock=null AND !infoModeEnabled = boardingPrompt 미응답 + BoardingTrainList 미탭.
 * infoModeEnabled=true면 명시 탭 의향이 환승으로 lock release된 후에도 계승돼 device 알람
 * 권위를 유지한다(lock 재생성 아님 — CLAUDE.md "명시 탭=lock 동급" 정합). fireAndLog phase(:837)와
 * station-passed 두 경로(:1427/:1673) 3곳에서 동일 조건식이 반복돼 SonarCloud CPD 해소.
 */
function isLocklessNoUserIntent(lock: BoardingLock | null): boolean {
  return !lock && !useUserIntentStore.getState().infoModeEnabled;
}

/**
 * #2387 — station-passed 경로(GPS IIFE :1427 / subsurface IIFE :1673) 공통 lockless-no-user-intent
 * 억제 블록. `isLocklessNoUserIntent` 참고. true 반환 시 호출자는 즉시 return.
 */
function suppressIfLocklessStationPassed(lock: BoardingLock | null, candidateStation: Station): boolean {
  if (isLocklessNoUserIntent(lock)) {
    logSuppressedStationPassedLockless(candidateStation.name);
    return true;
  }
  return false;
}

/** #2362 — 매역 알림 본문에 배선할 "남은 정거장 수 + 다음 대상(환승역|도착역)". */
interface StationPassedTarget {
  count: number;
  targetKind: StationPassedTargetKind;
  targetName: string;
}

/**
 * #2362 — route(direct/transfer/multi-transfer)가 이미 들고 있는 남은 정거장 수 필드
 * (`stops`/`stopsToTransfer`/`stopsFromTransfer`/`stopsAfterLastTransfer`)에서 다음 hop
 * 대상(환승역 또는 최종 도착역)과 count를 그대로 읽어온다. 이 필드들은 매 폴링 주기마다
 * `updateRouteFromPosition`(stationRoute.ts)이 현재 위치 기준 정수 hop count로 갱신한
 * SSoT — Live Activity route subtext(`buildLiveActivityData`)도 동일 필드를 읽는다.
 * 별도 GPS 좌표 기반 추정이나 station id lookup을 추가하지 않는다.
 *
 * transfers 배열은 인덱스 하드코딩 없이 순회 — candidate가 아직 도달하지 않은 첫 leg의
 * fromLine과 일치하면 그 leg의 환승역이 대상. 어느 leg에도 걸리지 않으면(마지막 환승 이후)
 * 최종 destination이 대상.
 */
function deriveStationPassedTarget(
  route: NonNullable<Route>,
  destination: Station,
  candidateStation: Station,
): StationPassedTarget {
  if (route.type === 'direct') {
    return { count: route.stops, targetKind: 'destination', targetName: destination.name };
  }
  if (route.type === 'transfer') {
    if (candidateStation.line === route.fromLine) {
      return {
        count: route.stopsToTransfer,
        targetKind: 'transfer',
        targetName: route.transferName,
      };
    }
    return {
      count: route.stopsFromTransfer,
      targetKind: 'destination',
      targetName: destination.name,
    };
  }
  for (const segment of route.transfers) {
    if (candidateStation.line !== segment.fromLine) continue;
    return {
      count: segment.stopsToTransfer,
      targetKind: 'transfer',
      targetName: segment.transferName,
    };
  }
  return {
    count: route.stopsAfterLastTransfer,
    targetKind: 'destination',
    targetName: destination.name,
  };
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
  capturedDestinationId: string;
  isCancelled: () => boolean;
  errorLogPrefix: string;
  /** #2122 — FG 보조 발사 조건(AppState active && lock 활성) 판정용. 호출부가 항상 lock 활성 trip만
   *  진입시키므로 실질적으로 non-null이지만, 타입은 방어적으로 nullable을 유지한다. */
  lock: import('../../../shared/types/boardingLock').BoardingLock | null;
  /** #2362 — count/target 도출용. 호출부의 effect가 이미 `!route || !destination` 가드를
   *  통과했으므로 non-null이지만, 방어적으로 nullable 유지. */
  route: Route;
  destination: Station | null;
}): Promise<void> {
  const {
    source,
    candidateStation,
    capturedDestinationId,
    isCancelled,
    errorLogPrefix,
    lock,
    route,
    destination,
  } = params;
  try {
    const lastId = await getLastNotifiedStationId(capturedDestinationId);
    if (isCancelled()) return;
    if (candidateStation.id === lastId) {
      logSuppressedDedupStation(source, candidateStation);
      return;
    }
    // #1515 — cross-category station-level dedup. destination/transfer가 같은 station에 직전 fire됐다면
    // station-passed 발사 차단. 같은 station 30s 내 카테고리 합산 1건 보장(2026-06-19 성수 회귀).
    // 본 가드는 lastNotifiedStationId(같은 카테고리) dedup 다음에 위치 — destination phase fire가
    // 별도 dedup 출처를 쓰는 회귀를 cross-cut으로 차단한다.
    if (
      isStationRecentlyFired(
        capturedDestinationId,
        candidateStation.name,
        'station-passed',
        Date.now(),
      )
    ) {
      logSuppressedCrossCategoryDedup({
        source,
        stationName: candidateStation.name,
        kind: 'station-passed',
      });
      return;
    }
    // #1643 — trip-scoped cross-category + cross-station 즉시 cascade(5s 윈도우). 같은 trip에 직전
    // 5s 안에 **다른 station에서 phase 알람** fire가 있었다면 station-passed 차단. 어대 "곧 성수 도착"
    // 직후 어대 station-passed 발사 같은 회귀 차단. same-category(SP→SP) cross-station은 통과 —
    // 정상 trip 폴링 진행 보존.
    if (
      isTripScopedCrossCategoryRecentlyFired(
        capturedDestinationId,
        candidateStation.name,
        'station-passed',
        Date.now(),
      )
    ) {
      logSuppressedCrossCategoryRecent({
        source,
        stationName: candidateStation.name,
        kind: 'station-passed',
      });
      return;
    }
    // #2064 (Phase 1-device) — 매역 알림은 backend visible push 단일 채널로 전환. FG station-passed
    // 감지는 이제 사용자 노출 알림을 발사하지 않고 cross-category dedup 윈도우 + lastNotifiedStationId
    // bookkeeping만 수행한다(다른 카테고리 알람/게이트가 여전히 이 상태를 읽는다).
    // category='station-passed' → 후속 destination/transfer 발사 차단.
    // #2122 — 예외: FG 한정 보조 발사. backend APNs 전달 지연(실측 35~51s) 우회를 위해
    // AppState==='active' && lock 활성일 때만 로컬 배너를 추가로 띄운다(바로 아래 블록).
    // 봉인 자체는 유지 — BG/취침/transfer/destination 경로는 여전히 사용자 노출 알림을 발사하지 않는다.
    markStationFired(
      capturedDestinationId,
      candidateStation.name,
      'station-passed',
      Date.now(),
    );
    // #2064 — markStationFired부터 여기까지는 await 없는 순수 동기 구간이라 cancelled는 위
    // isCancelled() 체크(getLastNotifiedStationId await 직후) 이후 바뀔 수 없다. 별도 재확인 불필요
    // — await setLastNotifiedStationId 진입 시점에만 다시 확인하면 충분.
    await setLastNotifiedStationId(capturedDestinationId, candidateStation.id);
    // #2122 (FG 보조 발사) — 위 모든 게이트(dedup/cross-category/hop-window/movement/silence/SSoT
    // 등, 여기 도달했다는 것 자체가 전부 통과했다는 뜻)를 통과한 뒤에만, FG 한정으로 로컬
    // station-passed 배너를 추가 발사한다. BG(AppState !=='active')는 이 블록에 도달해도 스킵 —
    // #2064 봉인이 BG에는 그대로 유지된다.
    // #2362 — count/target(환승역|도착역) 배선. route/destination은 호출부 effect가 이미
    // `!route || !destination` 가드로 non-null을 보장한 뒤에만 여기 도달한다.
    if (AppState.currentState === 'active' && lock && route && destination) {
      try {
        const target = deriveStationPassedTarget(route, destination, candidateStation);
        await fireFgAuxStationPassedNotification(
          candidateStation.name,
          target.count,
          target.targetKind,
          target.targetName,
        );
        logFiredStationPassed(source, candidateStation.name);
      } catch (e) {
        logger.error('FG 보조 발사 실패:', e);
      }
    }
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
  capturedDestinationId: string;
  isCancelled: () => boolean;
  errorLogPrefix: string;
  dismissSilence: import('../utils/dismissSilenceStorage').DismissSilenceState | null;
  userLocation: { lat: number; lng: number } | null;
  clearDismissSilenceAction: () => Promise<void>;
  /** #1816 — lock 활성 trip만 진입. gate-passed-event-on-lock-origin에서 boardingStationId 비교. */
  lock: import('../../../shared/types/boardingLock').BoardingLock | null;
  /** #2362 — dispatchStationPassed로 그대로 전달 → count/target 도출. */
  route: Route;
  destination: Station | null;
}): Promise<void> {
  // #1599 — boardingLock active 시 candidate가 lock origin(= boardingStationId)이면 station-passed 차단.
  // 2026-06-20 용마산 evidence: lock 활성 1초 후 lock origin 자체에 station-passed fire (X1).
  // #1596(autoLock multi-signal consensus) 머지 전까지 band-aid — origin은 "출발역"이라 station-passed
  // 첫 대상이 될 수 없다 (다음 역이 첫 hop). 모든 다른 게이트보다 위 — 가장 강한 사용자 의향 가드.
  if (params.candidateStation.id === params.lock?.boardingStationId) {
    logSuppressedPassedEventOnLockOrigin({
      source: params.source,
      stationName: params.candidateStation.name,
    });
    return;
  }
  // #1816 — #1236 sleep 룰 게이트(station-passed 첫 hop lockless 차단)가 이 경로에 도달하려면
  // lock=null + currentHopIndex=0이 필요하다. #1816 broad guard가 먼저 차단해 이 함수는
  // lock 활성 trip만 진입하므로 sleep-station-passed 분기는 도달 불가 — 제거.
  // (lock 활성 + candidate=boardingStation은 위 gate-passed-event-on-lock-origin이 먼저 차단)
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
    capturedDestinationId: params.capturedDestinationId,
    isCancelled: params.isCancelled,
    errorLogPrefix: params.errorLogPrefix,
    lock: params.lock,
    route: params.route,
    destination: params.destination,
  });
}

/**
 * #1572 (T9, ADR-017) — station-passed fire path SSoT 게이트 평가 + blocked 시 alarmLog 적재.
 *
 * 3 fire path(A=GPS station-passed / B=FG-arvlcd fast-path / C=subsurface verdict)가 같은
 * 5-line SSoT gate 시퀀스(evaluateSsotFireGate → cancelled 재확인 → ssotGate.blocked 분기 →
 * logSuppressedSsotFireGate)를 반복해 SonarCloud CPD가 dup 검출. 본 helper로 통합한다.
 *
 * 호출 규약:
 *   - 입력: candidateStation (id+name) / source / isCancelled callback.
 *   - kind는 'station-passed'로 고정 (3 path 모두 station-passed 카테고리). alarmId 형식도 동일.
 *   - 반환 true: 차단됨 → caller가 즉시 return. cancelled=true도 true로 묶어 caller의 cancelled 분기 단순화.
 *   - 반환 false: 통과 → caller가 다음 단계(dispatch 등) 진행.
 *
 * Path D (`fireAndLog` 내부)는 sync `firedAlarmsRef.current.delete(key)` cleanup이 끼어 있어
 * 본 helper를 사용하지 않는다 (Sonar dup 블록 대상에서 제외됨).
 */
async function evaluateSsotFireGateAndLogIfBlocked(params: {
  candidateStation: Station;
  source: 'fg' | 'fg-arvlcd';
  isCancelled: () => boolean;
}): Promise<boolean> {
  const { candidateStation, source, isCancelled } = params;
  const ssotGate = await evaluateSsotFireGate({
    alarmId: `station-passed:${candidateStation.name}`,
    stationId: candidateStation.id,
    type: 'station-passed',
  });
  if (isCancelled()) return true;
  if (ssotGate.blocked) {
    logSuppressedSsotFireGate({
      source,
      reason: ssotGate.reason as 'gate-alarm-already-decided' | 'gate-station-already-passed',
      stationName: candidateStation.name,
      kind: 'station-passed',
    });
    return true;
  }
  return false;
}

/**
 * #1208 (Epic #1204 D2) — firedAlarms set 기반 fallback hop 추정.
 *
 * 우선 SSOT(estimator.index / lock 진행 시간)이 모두 부재할 때 사용.
 * firedAlarms key 형식 `${phaseId}:${stationName}`을 파싱해 arcStations 위 인덱스 중 max를 찾고 +1.
 * key parse 실패/match 미존재 시 -1 → 호출자가 graceful skip.
 *
 * 주의: 본 fallback은 false negative risk가 있음(예: imminent만 fire되고 station-passed dedup이 비어 있으면
 * 0 반환) — graceful 동작이지 SSOT가 아님. alarmLog reason='gate-hop-window-no-source'를 함께 남겨 분석 가능.
 */
function inferHopIndexFromFiredAlarms(
  firedAlarms: ReadonlySet<string>,
  arcStations: readonly Station[],
): number {
  let maxIdx = -1;
  for (const key of firedAlarms) {
    const parsed = parseAlarmKey(key);
    /* istanbul ignore next — alarmKey()가 항상 `${phaseId}:${stationName}[#occ]` 형식이라 parsed=null은 도달 불가, 잘못된 key 데이터 방어용 */
    if (!parsed) continue;
    const idx = arcStations.findIndex((s) => isSameStationName(s.name, parsed.stationName));
    if (idx > maxIdx) maxIdx = idx;
  }
  if (maxIdx === -1) return -1;
  return Math.min(maxIdx + 1, arcStations.length - 1);
}

// #2373 — computeHopWindowSize는 src/shared/utils/stationRoute.ts로 추출됐다(BG 채널 재사용).
// FG는 위 import에서 shared 버전을 그대로 사용 — 동작 동일, 회귀 없음.

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
  /**
   * #1208 (Epic #1204 D2) — D1 estimator가 추정한 현재 hop index.
   * station-passed 게이트의 1순위 SSOT. null이면 lock 활성 또는 firedAlarms 기반 fallback 시도.
   * 미전달이면 기존 동작 유지(graceful, 게이트 미적용).
   */
  currentHopIndex?: number | null;
  /**
   * #1208 — 현재 trip의 arc station 배열. hop window 게이트와 firedAlarms 기반 fallback hop 계산에 사용.
   * 빈 배열/미전달이면 게이트 미적용(graceful).
   */
  arcStations?: readonly Station[];
  /**
   * #1290/#1298 — useFusedNearestStation.subsurfaceStationDetected 패스스루.
   * true이면 지하(subsurface=true) + barometer-stop/motion-stationary/arvlcd-arrived ≥2 합의 +
   * 역 근접 게이트를 모두 통과한 상태. GPS/arrival 게이트와 독립적으로 station-passed 발사 트리거.
   * 미전달/false면 기존 동작 유지(graceful fallback).
   */
  subsurfaceStationDetected?: boolean;
  /**
   * #1401 — useFusedNearestStation.trainProgressing 패스스루. 직전 tick 대비 fusion result가
   * arc 위에서 advance(idx 증가)했음을 의미. true면 evaluateMovement가 device 모션/GPS speed
   * 정적 신호 가드(motion-stationary / static-speed / static-position) 우회 — 지상/지하 미발사
   * 회귀(역삼 13:37) 차단. 미전달/false면 기존 동작 유지.
   */
  trainProgressing?: boolean;
  /**
   * #1817 — useFusedNearestStation.estimatorIsTimeIntegration 패스스루.
   * true이면 현재 fusion station이 lockless-route-hop / default-hop / reanchored-hop 시간 적분으로
   * 산출된 것 — GPS station(실관측)과 mismatch될 수 있다.
   * destination early / transfer early fire는 fusion station 기반 ETA 계산이므로,
   * 시간 적분 활성 시 GPS 실측과 다른 역을 목표로 발사할 위험이 있다.
   * true면 phase ETA effect를 차단. 미전달/false면 기존 동작 유지.
   *
   * Day 1 evidence: 13:49:38 fu=마장 gp=왕십리 mismatch → 마장 destination early false fire (1m 36s).
   */
  estimatorIsTimeIntegration?: boolean;
  /**
   * #1922 (M1+M3) — useFusedNearestStation.estimatorStrategy 패스스루.
   *
   * station-passed gate(`isStationWithinHopWindow`)의 동적 windowSize 계산 입력.
   * route.type이 transfer/multi-transfer + strategy가 live-position이 아닐 때 환승 leg 진입 직후
   * stuck된 effectiveHopIndex와 candidate idx 사이에 transfer point가 끼어 있으면 windowSize를
   * 동적으로 확장해 dump line 169~244의 61회 suppress 회귀를 차단한다.
   *
   * M3 신뢰도 게이트: strategy === 'live-position'은 실측 신호이므로 격차가 크면 abnormal jump(=
   * GPS jitter / wrong train) 신호라 windowSize 확장 X. 시간 적분 strategy일 때만 확장 허용.
   *
   * 미전달/null이면 기본 windowSize(LOCKLESS_HOP_WINDOW_DEFAULT=1) 유지 → backward-compat.
   */
  currentHopStrategy?: import('../../route/utils/stationProgressEstimator').StationProgressStrategy | null;
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
  currentHopIndex = null,
  arcStations,
  subsurfaceStationDetected = false,
  trainProgressing = false,
  estimatorIsTimeIntegration = false,
  currentHopStrategy = null,
}: UseStationAlarmInputs): void {
  // #2204 — 직전 GPS 샘플의 speedMps. evaluateMovement의 단일샘플 속도 plausibility 가드 입력.
  // useEffect([speedMps])에서 렌더 완료 후 갱신되므로 runMovementGate 호출 시점엔 항상 "직전" 값.
  const prevSpeedMpsRef = useRef<number | null>(null);
  useEffect(() => {
    prevSpeedMpsRef.current = speedMps ?? null;
  }, [speedMps]);

  // #1405 — 동일 5-arg evaluateMovement 호출 helper. Phase ETA / API imminent / movementSuppressionReason
  // 3곳에서 같은 인자로 호출돼 SonarCloud CPD가 dup 검출. helper로 추출해 회피.
  // 매 render에 새 클로저지만, callback 내부에서만 호출되므로 reference 안정성 불필요.
  const runMovementGate = (): ReturnType<typeof evaluateMovement> =>
    evaluateMovement(
      {
        speedMps: speedMps ?? undefined,
        accuracyM: accuracyMeters ?? undefined,
      },
      undefined,
      positionStability,
      motionStationary,
      trainProgressing,
      prevSpeedMpsRef.current,
    );

  const firedAlarmsRef = useRef<Set<string>>(new Set());
  // #1806 — gate-hop-window-no-source 60s dedup. lockless trip + firedAlarms 빈 상태에서 매 5s
  // FG cycle마다 suppression이 적재돼 V9(100/h/trip) 위반(실측 1157/h). 같은 reason은 60s 1회만
  // 적재해 감시 신호는 보존하되 spam을 차단한다.
  // fg / fg-arvlcd path는 독립적인 ref를 가져 서로 dedup하지 않는다 (경로별 독립 감시).
  const lastHopWindowNoSourceFgTsRef = useRef<number>(0);
  const lastHopWindowNoSourceFgArvlcdTsRef = useRef<number>(0);
  // #699: firedAlarmsRef의 내용이 어느 destinationId에 속하는지 추적.
  // destination 변경 직후엔 hydrate effect가 hydrationPhase를 'pre-hydrate'로 리셋하지만,
  // 같은 render cycle의 ETA/API effect는 React state 전파 전이라 hydrationPhase='ready'(stale)
  // 클로저로 진입한다. ref id가 현재 destinationId와 다르면 stale state — phase 평가를 보류해
  // 옛 ref로 새 destination에 잘못된 알람을 발사하는 race를 차단한다.
  const firedAlarmsRefDestIdRef = useRef<string | null>(null);
  // #1893 (RC-17) — firedAlarmsRef 내용이 어느 trip(tripStartedAt epoch ms)에 속하는지 추적.
  // 같은 destinationId로 trip 재시작 시(destinationId 변경 없음) 기존 destination hydrate
  // effect는 재실행되지 않아 in-memory Set이 이전 trip의 fired key를 보존하던 회귀(2026-06-26
  // T4 dump에 T3 fired 2건 carry-over). destination polling cycle(`destinationArrival` 30s)에서
  // tripStartedAt 변동을 감지해 명시적 reset + alarmLog 적재한다. backend trip-ended cleanup이
  // storage(FIRED_ALARMS_KEY)를 비우는 시점과 1:1 매칭.
  const firedAlarmsRefTripStartedAtRef = useRef<number | null>(null);
  // #1010/#1316: 하이드레이션 완료 시각(ms). null이면 미완료.
  // warmup window(HYDRATE_WARMUP_MS) 동안 station-passed effect(#1010)와 phase 알람 effect(#1316)가
  // 즉시 차단된다. #1316 — phase 알람은 기존 isFirstAlarmEvalRef 단발 suppress(첫 eval만 차단)였으나,
  // 2번째 eval(~1초 후)이 GPS/ETA 안정화 전 destination/transfer early를 발사 → 조기 발사가 firedAlarms
  // 슬롯을 점유해 실제 도착 발사가 dedup되는 회귀(08:24:31 성수)가 있었다. station-passed와 동일한
  // 시간 window로 통일한다.
  const hydratedAtRef = useRef<number | null>(null);
  // firedAlarms hydration: BG가 AsyncStorage(FIRED_ALARMS_KEY)에 쓴 dedup 상태를
  // destination별로 격리해 복원한다(#462).
  //
  // #1012 (H5) — 명시적 state machine:
  //   'pre-hydrate'    : 초기/destination 전환 직후. 모든 phase 평가 보류.
  //   'hydrating'      : effect entry. drain 대기 중. 보류.
  //   'storage-synced' : awaitInitialScheduledAlarmDrain 완료. getFiredAlarms 직전. 보류.
  //   'ready'          : firedAlarmsRef + refDestId 셋업 완료. phase 평가 허용.
  // hydration race(lock hydrate / storage sync / fired ref 사이) 차단을 위해 각 transition을
  // 명시화 + alarmLog로 측정 — DebugModal Gates 섹션에서 자동 카운트.
  const [hydrationPhase, setHydrationPhase] = useState<HydrationPhase>('pre-hydrate');
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
  // Epic #1204 N8 — phase 알람의 currentLine 입력에 lock.boardingLine을 우선 반영하기 위한
  // 동기 mirror. getBoardingLock은 비동기이므로 trackedTrainCode와 같은 주기(destinationId /
  // destinationArrival 갱신)로 sync 한다. lock 부재면 null → resolveCurrentLine이
  // nearestStation.line으로 자연 fallback.
  const [currentLockLine, setCurrentLockLine] = useState<LineNumber | null>(null);
  const sleepMode = useSettingsStore((s) => s.sleepMode);
  const setAlarmEvent = useAlarmEventStore((s) => s.setAlarmEvent);
  // #746 — dismiss silence 게이트 평가용 in-memory state. clear는 만료 시점에
  // store action을 통해 호출(storage도 함께 정리). 게이트 자체는 pure 함수.
  const dismissSilence = useAlarmEventStore((s) => s.dismissSilence);
  const clearDismissSilenceAction = useAlarmEventStore((s) => s.clearDismissSilence);
  const sleepModeRef = useRef(sleepMode);

  useEffect(() => {
    sleepModeRef.current = sleepMode;
  }, [sleepMode]);

  // #396: 트립 trainCode lock-in 상태를 destination 도착정보 갱신마다 재로드.
  // lock-in은 첫 valid arrival 캡처 시점에 일어나므로, arrival이 들어올 때마다 확인하면
  // lock 직후 곧바로 API 신호 평가에 반영된다. destinationId가 없으면 null.
  useEffect(() => {
    if (!destinationId) {
      setTrackedTrainCode(null);
      setCurrentLockLine(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const code = await getStoredTripTrainCode(destinationId);
      if (!cancelled) setTrackedTrainCode(code);
    })();
    // N8 — lock.boardingLine 동기 mirror. trackedTrainCode와 동일 주기로 refresh되어
    // phase 알람 effect가 GPS jitter와 무관하게 lock 노선을 currentLine으로 사용한다.
    void (async () => {
      const lock: BoardingLock | null = await getBoardingLock();
      if (!cancelled) setCurrentLockLine(lock?.boardingLine ?? null);
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
    hydratedAtRef.current = null;
    // #1012 (H5) — Phase 1: pre-hydrate 리셋. destination 전환마다 state machine 재시작.
    setHydrationPhase('pre-hydrate');
    logHydrationTransition('pre-hydrate', destinationId);
    // #1012 (H5) — Phase 2: hydrating. effect entry 직후 sync 표기 — drain await 진입 전.
    setHydrationPhase('hydrating');
    logHydrationTransition('hydrating', destinationId);
    void (async () => {
      // 사전 예약 알람의 첫 drain이 완료된 후 read해야 cold start 직후
      // BG-fired 알람이 dedup set에 반영된 상태로 hydrate된다.
      await awaitInitialScheduledAlarmDrain();
      if (cancelled) return;
      // #1012 (H5) — Phase 3: storage-synced. drain 완료 + getFiredAlarms 직전.
      setHydrationPhase('storage-synced');
      logHydrationTransition('storage-synced', destinationId);
      const stored = await getFiredAlarms(destinationId);
      if (cancelled) return;
      firedAlarmsRef.current = stored;
      firedAlarmsRefDestIdRef.current = destinationId;
      // #1893 (RC-17) — hydration 시점의 tripStartedAt을 ref에 stamp. 이후 destinationArrival
      // polling effect(아래)가 storage tripStartedAt과 비교해 같은 destinationId 재시작을 감지한다.
      firedAlarmsRefTripStartedAtRef.current = await getTripStartedAt();
      // #580: hydration 시점 진단 — 같은 destinationId에서 size가 다시 0으로 떨어지면 storage race.
      logFiredAlarmsHydrate(destinationId, stored.size);
      // #1010/#1316: warmup 시작 — 하이드레이션 완료 시각 기록. station-passed/phase 알람 effect 공용.
      hydratedAtRef.current = Date.now();
      // #1012 (H5) — Phase 4: ready. ref 셋업 + warmup 시각 기록 완료 후 phase 평가 허용.
      setHydrationPhase('ready');
      logHydrationTransition('ready', destinationId);
    })();
    return () => {
      cancelled = true;
    };
  }, [destinationId]);

  // #1893 (RC-17) — trip 경계 detection + firedAlarmsRef in-memory Set reset.
  //
  // 같은 destinationId로 trip을 재시작한 경우(=목적지는 그대로 두고 새 출발) 위 hydration effect가
  // 재실행되지 않아 React `firedAlarmsRef.current`는 이전 trip의 fired key를 보존한다. backend가
  // trip-ended 시 storage(FIRED_ALARMS_KEY)는 비워지지만 in-memory ref와 storage가 unsync → 다음
  // fire가 dedup으로 차단되거나 DebugModal dump가 cross-trip carry-over로 오염 (2026-06-26 T4
  // dump L75-76에 T3 시각 fired 2건 carry-over evidence).
  //
  // destination polling cycle(`destinationArrival` 30s)에 hook해 storage tripStartedAt을 read,
  // ref에 stamp한 epoch와 다르면 in-memory Set을 명시적으로 비우고 alarmLog 1건 적재. 동일 trip 안
  // (epoch 동일)에서는 no-op — 정상 fire 흐름에 영향 0. destinationId 변경 분기는 위 hydration effect
  // 가 hydrate 시점에 tripStartedAt도 함께 stamp하므로 중복 reset 발생 X.
  useEffect(() => {
    if (!destinationId) return;
    let cancelled = false;
    void (async () => {
      const currentTripStartedAt = await getTripStartedAt();
      if (cancelled) return;
      // hydration effect가 ref에 stamp한 시점과 비교. ref가 null이면 hydration 미완료 — skip.
      const prevTripStartedAt = firedAlarmsRefTripStartedAtRef.current;
      if (prevTripStartedAt === null) return;
      // 같은 trip(epoch 동일) 또는 trip 종료(currentTripStartedAt === null) → 후자는 hydration effect의
      // destinationId=null 분기가 자연 처리. epoch가 다를 때만 새 trip 시작 → reset.
      if (currentTripStartedAt === null) return;
      if (currentTripStartedAt === prevTripStartedAt) return;
      firedAlarmsRef.current = new Set();
      firedAlarmsRefTripStartedAtRef.current = currentTripStartedAt;
      logFiredAlarmsTripBoundaryReset({
        source: 'fg',
        destinationId,
        previousTripStartedAt: prevTripStartedAt,
        nextTripStartedAt: currentTripStartedAt,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [destinationId, destinationArrival]);

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
    // #1816 (paradigm shift Phase 1 보강) — lockless trip + 사용자 명시 의향 없음 시 ETA/imminent phase 발사 차단.
    // #2387: lockless+무의향 억제 — isLocklessNoUserIntent 참고. 이 상태에서 transfer/destination
    // phase 알람(ETA 기반 early/imminent + API imminent)을 fire하면 paradigm shift 위반.
    // firedAlarmsRef.current.delete(key): 진입부 add를 복구해 storage net-zero 유지 (sleep/cross-category 차단과 동일 패턴).
    if (isLocklessNoUserIntent(lock)) {
      firedAlarmsRef.current.delete(key);
      logSuppressedLocklessNoUserIntent({
        source: 'fg-evaluated',
        stationName: rawEvent.stationName,
        kind: rawEvent.type,
        phaseId: rawEvent.phaseId,
      });
      return;
    }
    // Sleep rule 단일 gate (ADR-023). transfer/station-passed 첫 hop만 suppress. destination은 항상 fire.
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
    // #1515 — cross-category station-level dedup. 같은 station에 직전 station-passed가 fire됐다면
    // destination/transfer phase 알람 후속 발사 차단. category 인자로 phase 알람끼리 진행
    // (early→imminent)은 차단하지 않음 — firedAlarms(phase 카테고리 내 dedup)이 단독 작동.
    if (
      isStationRecentlyFired(activeDestination.id, rawEvent.stationName, rawEvent.type, Date.now())
    ) {
      // firedAlarmsRef.add(key)는 진입부에서 이미 수행 — phase 카테고리 dedup은 유지(다음 사이클에
      // 같은 phase 재평가 막음). cross-category 차단도 sleep 차단과 동일하게 firedAlarms ref만
      // 갱신했으므로 storage 영속화 skip(net-zero).
      firedAlarmsRef.current.delete(key);
      logSuppressedCrossCategoryDedup({
        source: 'fg',
        stationName: rawEvent.stationName,
        kind: rawEvent.type,
        phaseId: rawEvent.phaseId,
      });
      return;
    }
    // #1643 — trip-scoped cross-category + cross-station 즉시 cascade(5s 윈도우). 같은 trip에 직전
    // 5s 안에 **다른 station에서 station-passed** fire가 있었다면 phase 알람 차단. 2026-06-20 12:31
    // 어대 "군자 도착"(SP) → "곧 성수 도착"(D imminent) 회귀 차단. 같은 station 진행(early→imminent)은
    // 통과 — firedAlarms set이 그 dedup을 담당.
    // firedAlarmsRef는 sleep/CC dedup와 동일 패턴 (storage 영속화 skip — net-zero).
    if (
      isTripScopedCrossCategoryRecentlyFired(
        activeDestination.id,
        rawEvent.stationName,
        rawEvent.type,
        Date.now(),
      )
    ) {
      firedAlarmsRef.current.delete(key);
      logSuppressedCrossCategoryRecent({
        source: 'fg',
        stationName: rawEvent.stationName,
        kind: rawEvent.type,
        phaseId: rawEvent.phaseId,
      });
      return;
    }
    // #1656 — phase↔phase cross-station 즉시 cascade(3s 윈도우). 같은 trip에 직전 3s 안에 **다른
    // station에서 phase(transfer/destination) fire**가 있었다면 차단. leg 전환 race에서 옛 leg +
    // 새 leg phase가 동시 fire되는 회귀 차단:
    //   - 2026-06-20 12:32 어대: "곧 건대"(transfer imminent) + "성수 도착"(destination)
    //   - 2026-06-19 15:37 BG: "곧 이수"(destination imminent) + "다음 역 사당"(transfer)
    // firedAlarmsRef.current.delete(key) — 나중 발사가 차단되므로 진입부 add를 복구.
    if (
      isPhaseToPhaseCrossStationRecentlyFired(
        activeDestination.id,
        rawEvent.stationName,
        rawEvent.type,
        Date.now(),
      )
    ) {
      firedAlarmsRef.current.delete(key);
      logSuppressedPhaseToPhaseDedup({
        source: 'fg',
        stationName: rawEvent.stationName,
        kind: rawEvent.type,
        phaseId: rawEvent.phaseId,
      });
      return;
    }
    // #1901/#1900 (RC-7/RC-10a) — channel-agnostic 8분 backstop. 위 cross-category gates는
    // window가 짧거나(30s/5s/3s) phase↔SP 같은 cross-category 조합만 cover한다. silent state push +
    // LA dirty update가 같은 station + 같은 kind를 8분 차로 cross-channel 발사하는 회귀(2026-06-26
    // trip-3 동대문역사문화공원 12:17:58/12:26:12)는 윈도우 밖. 본 게이트는 station+kind level fire
    // 자체를 8분 안에 단 1회만 통과시킨다 — channel(silent/FG/LA) 무관 backstop. 다른 kind는
    // cross-category gate(30s)가 별도 차단. 같은 kind 안의 phase 진행(early→imminent)은 본 gate
    // 가 차단할 수 있지만, 회귀 evidence는 정확히 같은 kind 중복이라 acceptance와 정합.
    if (
      isAnyChannelRecentlyFired(
        activeDestination.id,
        rawEvent.stationName,
        rawEvent.type,
        Date.now(),
        rawEvent.phaseId,
      )
    ) {
      firedAlarmsRef.current.delete(key);
      logSuppressedChannelAgnosticDedup({
        source: 'fg',
        stationName: rawEvent.stationName,
        kind: rawEvent.type,
        phaseId: rawEvent.phaseId,
      });
      return;
    }
    // #1572 (T9) — backend SSoT 권위 게이트 (Path D fireAndLog phase ETA / imminent).
    // AlarmEvent.type은 'transfer' | 'destination'만 (station-passed는 별도 effect).
    // Gate A(alarmId 매칭)만 적용 — transfer/destination은 환승역에서 같은 station이 여러 hop을
    // cover하므로 단순 stationId 매칭은 false positive 위험. type 인자 미명시 → Gate B 자연 비활성.
    const ssotGate = await evaluateSsotFireGate({
      alarmId: `${rawEvent.type}:${rawEvent.stationName}`,
      stationId: rawEvent.stationName,
      type: rawEvent.type,
    });
    if (ssotGate.blocked) {
      // race 차단 reservation 진입 전이라 markStationFired 호출하지 않음.
      // phase 카테고리 dedup ref(firedAlarmsRef)는 진입부에서 add됐는데 SSoT 차단 시 다른 카테고리에
      // 영향 안 주려면 ref만 갱신(storage 영속화 skip — 다른 sleep/cross-category 차단과 동일 패턴).
      firedAlarmsRef.current.delete(key);
      logSuppressedSsotFireGate({
        source: 'fg',
        reason: ssotGate.reason as 'gate-alarm-already-decided' | 'gate-station-already-passed',
        stationName: rawEvent.stationName,
        kind: rawEvent.type,
        phaseId: rawEvent.phaseId,
      });
      return;
    }
    // race 차단 reservation — send 전에 윈도우 갱신해 await 동안 다른 effect가 같은 station을 발사
    // 못하게 한다. category=phase type → 후속 station-passed 차단. #1901 — phaseId도 stamp해
    // channel-agnostic 8분 backstop이 정상 phase 진행(early→imminent)을 통과시킬 수 있도록 한다.
    markStationFired(
      activeDestination.id,
      rawEvent.stationName,
      rawEvent.type,
      Date.now(),
      rawEvent.phaseId,
    );
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
    // #2067 (Phase 2-device, D1) — sendAlarmNotification 제거. 알람 배너는 원격 visible push가
    // 담당(Phase 2-backend). FG는 이제 dedup ledger 기록 + in-app store stamp만 수행한다.
    logFiredAlarm('fg', event, trigger);
    // #2395 (ADR-035 Phase1① — #2067 봉인 해제) — EXPO_PUBLIC_MINIMAL_ALARM ON이면 FG도
    // BG(stationPipeline #2379)와 동일하게 device 로컬 배너를 즉시 발사한다. markLocalStationFired
    // 동반 필수 — 뒤늦게 도착하는 backend transfer/destination push(APNs 지연 실측 35~51s)를
    // setupNotificationHandler의 isRecentLocalAuxFireDuplicate가 (station, kind) 매칭으로 억제해
    // 이중배너를 막는다(#2122와 동일 방어 패턴).
    if (isMinimalAlarmEnabled()) {
      const notificationSource = fusionSource
        ? resolveNotificationSource(fusionSource, locationUncertain)
        : undefined;
      await fireLocalAlarmNotification(event, notificationSource);
      await markLocalStationFired(rawEvent.stationName, rawEvent.type);
    }
  }

  /**
   * #1984 (Phase 1-4, ADR-022 B3) — client 채널 통합 fire ledger gate.
   *
   * flag OFF (default): 바로 `fireAndLog` 호출 — 기존 흐름 그대로.
   * flag ON: `fireAlarmOnce` ledger를 sync entry-guard로 통과한 뒤에만
   * `fireAndLog` 호출. 같은 (stationName, line, kind, phase) 조합이 30s 안에 이미 fire됐으면
   * skip + `logSuppressedFireAlarmOnce` 적재. Phase ETA + API imminent 두 useEffect가 같은
   * 초에 dispatch 시도한 회귀(2026-07-01 08:32:09 성수 fg fired station-passed 2건)를 차단.
   *
   * currentLine = lock.boardingLine 우선(currentLockLine) → nearestStation.line fallback.
   * `resolveCurrentLine` SSOT와 동일 규약.
   *
   * #2002 — fire 시점에 `isSimpleArchEnabled()` 호출 (env `EXPO_PUBLIC_SIMPLE_ARRIVAL_ARCH`
   * 값 기반). remote flag 반영이 필요한 caller 는 후속 PR 에서 arg 로 전달 예정.
   */
  async function fireViaUnifiedGate(
    rawEvent: AlarmEvent,
    trigger: 'api' | 'eta',
    activeRoute: NonNullable<Route>,
    activeDestination: Station,
  ): Promise<void> {
    if (!isSimpleArchEnabled()) {
      await fireAndLog(rawEvent, trigger, activeRoute, activeDestination);
      return;
    }
    const line = resolveCurrentLine(currentLockLine, nearestStation);
    const result = await fireAlarmOnce(
      {
        stationName: rawEvent.stationName,
        line,
        kind: rawEvent.type,
        phase: rawEvent.phaseId,
      },
      () => fireAndLog(rawEvent, trigger, activeRoute, activeDestination),
    );
    if (result.deduped) {
      logSuppressedFireAlarmOnce({
        source: 'fg',
        stationName: rawEvent.stationName,
        kind: rawEvent.type,
        phaseId: rawEvent.phaseId,
      });
    }
  }

  // Phase 알람 효과: ETA 기반 phase 평가 + firedAlarms 갱신.
  // hydrationPhase!=='ready'인 동안에는 보류 — BG가 이미 발화한 phase를 빈 ref로 재발화하는 것을 막는다.
  // station-passed와 분리: 하이드레이션 완료로 인한 effect 재실행이 station-passed 중복 발사를
  // 일으키지 않도록 한다(station-passed는 자체 lastNotifiedStationId dedup만 사용).
  useEffect(() => {
    if (hydrationPhase !== 'ready') return;

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

    // #670/#672/#1316: 하이드레이션 직후 warmup window 동안 발사 보류 — stale firedAlarms·
    // nearestStation과 새 GPS/ETA 좌표가 동기화되기 전 조기 발사 차단. station-passed effect(#1010)와
    // 동일한 HYDRATE_WARMUP_MS 시간 window를 공유한다.
    // #1316 — 기존엔 isFirstAlarmEvalRef로 첫 eval 1회만 suppress했으나, 2번째 eval(~1초 후)이 GPS/ETA
    // 안정화 전 destination/transfer early를 발사 → 그 조기 발사가 firedAlarms 슬롯을 점유해 실제 도착
    // 발사가 dedup으로 억제되는 회귀(08:24:31 성수)가 있었다. 시간 window로 전환해 해소.
    if (!skipWarmupGuard && isWithinHydrateWarmup(hydratedAtRef.current, Date.now())) {
      logSuppressedPhaseGate('gate-phase-warmup', destination.name);
      return;
    }

    // #1817 — 시간 적분 estimator(lockless-route-hop / default-hop / reanchored-hop) 활성 시
    // fusion station이 GPS 실관측 station과 다를 수 있다. destination/transfer early는
    // fusion station 기반 ETA 계산을 사용하므로, GPS station과 mismatch인 상황에서 조기 fire를
    // 차단한다. Day 1 evidence: fu=마장 gp=왕십리 → 왕십리 대기 중 마장 destination early false fire.
    // 실관측(boarding-lock / backend-ssot / position-train / wifi-ssid / fused)
    // 기반 advance만 phase fire 허용 — #1813과 동일 원칙의 phase alarm 확장.
    //
    // #2204 (ADR-026 ①잔여 적대적 검증 HOLE) — estimator 전략(#1817)만 보는 게이트는 fusion
    // source가 route-progress/gps(추정, GPS 좌표 기반)인데 estimator strategy는 시간 적분이
    // 아닌 조합을 놓친다. `fusionSource`(호출자가 전달한 이번 cycle의 실제 판정 source) 기준으로
    // 게이팅 — source가 명시 전달되면 그 강/약 판정이 estimator 전략보다 우선(SSOT). route-progress
    // 화이트리스트 제거: route-progress는 이제 약(추정) source로 분류돼 phase fire 차단 대상.
    // fusionSource 미전달(레거시 호출자/테스트)이면 estimatorIsTimeIntegration으로 graceful fallback.
    const phaseGateBlockedByWeakSource =
      fusionSource !== undefined ? !isStrongFusionSource(fusionSource) : estimatorIsTimeIntegration;
    if (phaseGateBlockedByWeakSource) {
      logSuppressedPhaseGate('gate-phase-time-integration', destination.name);
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
      // #2279 — route는 이 effect 상단(!route return)에서 이미 non-null 보장.
      // haversine 직선거리÷순간속도의 정거장수-무관 과대추정을 실측 hop 시간 합으로 clamp.
      etaSeconds = estimateTransitEtaSeconds(distM, speedMps, getRouteRemainingSeconds(route));
    }

    const suppressed: AlarmEvent[] = [];
    // #903 (Seam G) — 기압계 강등 시 evaluateAlarmPhase가 early/transfer 알람을 보류.
    // arrivalConfidence는 useFusedNearestStation이 'gps-only-underground'로 강등한 값을 그대로 흘려보냄.
    //
    // #1398 — detection-fused는 verdict ≥2 신호 합의 + 근접 게이트가 결합된 라벨.
    //   gps-only-underground 상태에서 verdict가 결합되면 detection-fused로 승격되어 degraded=false →
    //   early/transfer 알람 게이트 자동 해제. 의도된 cascade 결합 효과(verdict가 알람 발사에 실제 기여).
    //   false positive 방어는 subsurfaceStationDetected의 ≥2 합의 + 근접 조건이 담당.
    const degraded = arrivalConfidence === 'gps-only-underground';
    const rawEvent = evaluateAlarmPhase(
      {
        route,
        destinationName: destination.name,
        etaSeconds,
        // Epic #1204 N8 — lock.boardingLine 우선, nearestStation.line fallback.
        // 5호선 답십리 lock 진행 중 fusion이 2호선 상왕십리를 momentary adopt해도
        // currentLine='5'로 유지되어 다른 leg의 hop fire를 차단한다.
        currentLine: resolveCurrentLine(currentLockLine, nearestStation),
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
    // #1984: flag ON 시 unified fire ledger(fireAlarmOnce)가 sync entry-guard로
    // 같은 (station+line+kind+phase) 조합의 동일 초 재발사를 차단한 뒤에만 fireAndLog로 진행.
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
      // #1401 — trainProgressing 추가. fusion arc advance가 확인되면 device 모션/GPS speed 정적
      // 신호 가드를 우회해 미발사 회귀(역삼 13:37) 차단.
      // #1405 — runMovementGate helper로 동일 5-arg evaluateMovement 호출 추출(SonarCloud CPD).
      const movement = runMovementGate();
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
      void fireViaUnifiedGate(rawEvent, 'eta', route, destination);
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
    hydrationPhase,
    setAlarmEvent,
    nearestStation?.id,
    nearestStation?.line,
    // Epic #1204 N8 — lock.boardingLine 변경 시(환승 leg 교체 등) currentLine 재평가.
    currentLockLine,
    positionStability,
    motionStationary,
    trainProgressing,
    skipWarmupGuard,
    dismissSilence,
    clearDismissSilenceAction,
    // #903 — degraded 평가는 arrivalConfidence에서 파생. 지하 진입으로 'gps-only'→
    // 'gps-only-underground' 단독 전환 시(다른 deps 정적) 본 effect 재실행되어 차단 정책 즉시 반영.
    arrivalConfidence,
    // #1817 — 시간 적분 → 실관측 전환 시(estimatorIsTimeIntegration false→true→false) 즉시 재평가.
    estimatorIsTimeIntegration,
    // #2204 — fusionSource 전환(약→강/강→약) 시 즉시 재평가.
    fusionSource,
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
    if (hydrationPhase !== 'ready') return;
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
    // #1401 — trainProgressing 추가. fusion arc advance 시 device 정적 신호 우회.
    // #1405 — runMovementGate helper로 동일 5-arg evaluateMovement 호출 추출.
    const movement = runMovementGate();
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
    // #1984: flag ON 시 unified fire ledger가 Phase ETA effect와의 동일 초
    // 재발사 race를 sync entry-guard로 차단.
    void fireViaUnifiedGate(rawEvent, 'api', route, destination);
  }, [
    hydrationPhase,
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
    trainProgressing,
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
  // #1010: hydrationPhase 가드 + 30s warmup — lock hydrate 직후 GPS가 stabilize되기 전
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
  // #1401 — trainProgressing 추가. fusion arc advance 시 정적 가드 우회.
  // #1405 — runMovementGate helper로 동일 5-arg evaluateMovement 호출 추출.
  const movementSuppressionReason = useMemo(() => {
    const m = runMovementGate();
    return m.reliable ? null : MOVEMENT_TO_ALARM_LOG_REASON[m.reason];
  }, [speedMps, accuracyMeters, positionStability, motionStationary, trainProgressing]);

  useEffect(() => {
    let cancelled = false;
    if (!route || !destination) return;

    // #1010: firedAlarms 복원 완료 전에는 발사 보류.
    if (hydrationPhase !== 'ready') return;
    // #1010: hydration 완료 후 30s warmup window 동안 발사 보류.
    if (!skipWarmupGuard && isWithinHydrateWarmup(hydratedAtRef.current, Date.now())) {
      logSuppressedStationPassedWarmup(nearestStation?.name);
      return;
    }

    if (!accuracyOk && !arrivalConfirmed) return;

    // cancellation: 효과 cleanup이 cancelled를 true로 만들어 stale IIFE를 중단시킨다.
    // A→B→A 빠른 변동 시 이전 IIFE들이 cancelled로 차단되고 최신 candidate만 알림을 보낸다.
    if (nearestStation && isStationOnRoute(nearestStation, route)) {
      const candidateStation = nearestStation;
      const capturedDestinationId = destination.id;

      // #1208 (Epic #1204 D2) — trip 진행도 hop window 게이트.
      // isStationOnRoute는 candidate가 route 노선 위에 있는지만 검사 → 이미 지나간 hop이나
      // 미래 hop에서도 통과(사가정 22:11:56 / 성수 13:28:35 회귀). hop window로 추가 가드.
      // SSOT 우선순위:
      //   1. currentHopIndex prop (D1 estimator 또는 lock 활성 시 interp 결과 — 호출자가 결정)
      //   2. firedAlarms set 기반 fallback (graceful, false negative risk)
      //   3. 둘 다 부재 + arcStations 없음 → 게이트 미적용 (gate-hop-window-no-source)
      if (arcStations && arcStations.length > 0) {
        const effectiveHopIndex =
          currentHopIndex ?? inferHopIndexFromFiredAlarms(firedAlarmsRef.current, arcStations);
        if (effectiveHopIndex < 0) {
          // #1806 — 60s dedup: 같은 reason을 매 5s cycle마다 적재하면 V9 위반(실측 1157/h).
          // 감시 신호는 보존하되 60s 이내 중복은 skip한다.
          const now = Date.now();
          if (now - lastHopWindowNoSourceFgTsRef.current >= 60_000) {
            lastHopWindowNoSourceFgTsRef.current = now;
            logSuppressedHopWindowNoSource({ source: 'fg', stationName: candidateStation.name });
          }
        } else {
          // #1922 (M1+M3) — transfer leg에서 estimator stuck 시 windowSize 동적 확장.
          const candidateIndex = arcIndexOf(arcStations, candidateStation);
          const windowSize = computeHopWindowSize(
            arcStations,
            route,
            effectiveHopIndex,
            candidateIndex,
            currentHopStrategy,
          );
          if (isStationWithinHopWindow(candidateStation, arcStations, effectiveHopIndex, windowSize)) {
            // hop window 통과 — lockless origin hop 차단은 IIFE 내부의 broad !lock 가드가 담당.
            // #1630 — effectiveHopIndex AND 조건 제거. lockless mode는 estimator(시간 적분)가
            // idx를 임의 진행 — 출발역에 머물러도 idx>=1 정상 산출(2026-06-22 08:34:18 용마산
            // evidence: estimator idx=1, 사용자는 출발 직후 = X1 위반). lock 활성 trip은
            // boardingStationId 기준 origin 검사를 IIFE lock 가드가 처리.
          } else {
            logSuppressedHopWindow({
              source: 'fg',
              stationName: candidateStation.name,
              currentHopIndex: effectiveHopIndex,
              candidateIndex,
            });
            return;
          }
        }
      }

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
      // #1236 — sleep 룰 게이트는 helper 내부에서 처리. lock은 IIFE에서 async fetch.
      void (async () => {
        const lock = await getBoardingLock();
        if (cancelled) return;
        // #1816 (paradigm shift Phase 1 보강) — lockless trip + 사용자 명시 의향 없음 시 station-passed 차단.
        // #2387: lockless+무의향 억제 — isLocklessNoUserIntent 참고. paradigm shift 정합.
        // #1514 — origin hop lockless 차단(용마산 evidence)은 본 broad guard의 subset이 되어 하나로 통합.
        if (suppressIfLocklessStationPassed(lock, candidateStation)) return;
        // #1572 (T9) — backend SSoT 권위 게이트 (Path A). mirror.alarmEvents에 같은 alarmId가
        // 이미 있거나(Gate A) mirror.passedStations/alarmEvents에 같은 stationId가 station-passed로
        // 이미 결정됐으면(Gate B) fire 차단. mirror 부재/stale은 graceful no-block.
        // #1572 — 3 path 공통 helper로 통합 (SonarCloud CPD 회피).
        if (
          await evaluateSsotFireGateAndLogIfBlocked({
            candidateStation,
            source: 'fg',
            isCancelled: () => cancelled,
          })
        ) {
          return;
        }
        await runSilenceGateAndDispatch({
          source: 'fg',
          candidateStation,
          capturedDestinationId,
          isCancelled: () => cancelled,
          errorLogPrefix: '역 통과 알림 실패:',
          dismissSilence,
          userLocation,
          clearDismissSilenceAction,
          lock,
          route,
          destination,
        });
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
    hydrationPhase,
    accuracyOk,
    arrivalConfirmed,
    movementSuppressionReason,
    dismissSilence,
    clearDismissSilenceAction,
    userLocation?.lat,
    userLocation?.lng,
    currentHopIndex,
    arcStations,
    // #1922 (M1+M3) — strategy 변동 시 windowSize 재계산.
    currentHopStrategy,
  ]);

  // #917 A2 follow-up — FG fast path: lock.trainCode가 currentStationArrival의 row에
  // arvlCd∈{0,1}으로 첫 관찰되면 nearestStation에 대한 매역(station-passed) 알림 즉시 발사.
  //
  // 백엔드 cron(10~30s 사이클) 대비 우위: 클라는 useArrivalInfo 1주기(보통 30s) 안에 같은 신호를
  // 이미 가지고 있으므로 BG silent push 도달 지연 없이 발사 가능. 지하/지상 무관 SSOT가 GPS 아닌
  // Seoul `realtimeArrivalList`.
  //
  // 가드 (AND, 하나라도 false면 no-op):
  //   1. hydrationPhase==='ready' — destination별 firedAlarms 복원 완료 후
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
    if (hydrationPhase !== 'ready') return;
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
    const capturedDestinationId = destination.id;

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
      // #2364 (ADR-033 A5) — subsurfaceStationDetected=true는 useFusedNearestStation이 이미
      // subsurface(지하 진입 확정) + ≥2 신호 합의(barometer-stop/motion-stationary/arvlcd-arrived) +
      // 역 근접 게이트를 통과시킨 상태. 지하 GPS 사멸로 speed/positionStability가 불명(motion-warmup/
      // static-position 등)일 뿐인데 정적 misfire 가드가 이미 간접 확인된 이동을 오억제하는 회귀
      // 차단 — trainProgressing(#1401)과 동일한 취지의 우회. false positive 방어(통과 열차
      // momentary adopt)는 lock.trainCode 일치(findFgArvlCdFireSignal)가 1차로 이미 담당하고,
      // subsurfaceStationDetected 자체도 근접 게이트를 포함해 GPS 좌표 기반 지하 추정과는 무관하다.
      if (movementSuppressionReason && !subsurfaceStationDetected) {
        logSuppressedMovement({
          source: 'fg-arvlcd',
          stationName: candidateStation.name,
          kind: 'station-passed',
          reason: movementSuppressionReason,
        });
        return;
      }

      // #1266 (Epic #1204 D2 follow-up) — fast-path에도 hop window 게이트 적용.
      // 2026-06-12 22:31 회귀: GPS station-passed effect는 D2(#1208) 게이트로 차단됐으나
      // fg-arvlcd fast-path는 같은 게이트가 없어 fusion이 미래 arc station에 jitter landing
      // + Seoul API row의 lock.trainCode 일치 + arvlCd∈{0,1}일 때 미래 hop fire 가능.
      // SSOT 우선순위는 GPS path와 동일 — currentHopIndex prop → firedAlarms fallback → no-source.
      if (arcStations && arcStations.length > 0) {
        const effectiveHopIndex =
          currentHopIndex ?? inferHopIndexFromFiredAlarms(firedAlarmsRef.current, arcStations);
        if (effectiveHopIndex < 0) {
          // #1806 — 60s dedup: 같은 reason을 매 cycle마다 적재하면 V9 위반. fg와 독립 ref로
          // fg-arvlcd 경로를 별도 감시한다.
          const now = Date.now();
          if (now - lastHopWindowNoSourceFgArvlcdTsRef.current >= 60_000) {
            lastHopWindowNoSourceFgArvlcdTsRef.current = now;
            logSuppressedHopWindowNoSource({
              source: 'fg-arvlcd',
              stationName: candidateStation.name,
            });
          }
        } else {
          // #1922 (M1+M3) — fg-arvlcd 경로도 동일하게 transfer leg windowSize 동적 확장 적용.
          const candidateIndex = arcIndexOf(arcStations, candidateStation);
          const windowSize = computeHopWindowSize(
            arcStations,
            route,
            effectiveHopIndex,
            candidateIndex,
            currentHopStrategy,
          );
          if (!isStationWithinHopWindow(candidateStation, arcStations, effectiveHopIndex, windowSize)) {
            logSuppressedHopWindow({
              source: 'fg-arvlcd',
              stationName: candidateStation.name,
              currentHopIndex: effectiveHopIndex,
              candidateIndex,
            });
            return;
          }
        }
      }

      // #1572 (T9) — backend SSoT 권위 게이트 (Path B fast-path). FG-arvlcd가 backend가 이미
      // 결정한 alarmId/stationId를 재발사하는 회귀 차단. hop window 통과 직후, dispatch 전에 평가.
      // #1572 — 3 path 공통 helper로 통합 (SonarCloud CPD 회피).
      if (
        await evaluateSsotFireGateAndLogIfBlocked({
          candidateStation,
          source: 'fg-arvlcd',
          isCancelled: () => cancelled,
        })
      ) {
        return;
      }

      // #746 silence gate + dispatch는 helper로 통합 (Sonar cpd 회피).
      // lastNotifiedStationId 공유 dedup. cancelled 재확인 — getBoardingLock 후 effect cleanup 가능.
      // #1236 — sleep 룰 게이트 context. lock은 위에서 이미 fetch.
      await runSilenceGateAndDispatch({
        source: 'fg-arvlcd',
        candidateStation,
        capturedDestinationId,
        isCancelled: () => cancelled,
        errorLogPrefix: 'FG arvlCd fast-path 알림 실패:',
        dismissSilence,
        userLocation,
        clearDismissSilenceAction,
        lock,
        route,
        destination,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [
    hydrationPhase,
    route,
    destination?.id,
    destination?.name,
    nearestStation?.id,
    nearestStation?.name,
    nearestStation?.line,
    currentStationArrival,
    movementSuppressionReason,
    // #2364 — subsurfaceStationDetected 변화 시 movement gate 우회 여부 재평가.
    subsurfaceStationDetected,
    dismissSilence,
    clearDismissSilenceAction,
    userLocation?.lat,
    userLocation?.lng,
    // #1236 — currentHopIndex 변화가 sleep 룰 게이트 isFirstHop 판정에 영향.
    currentHopIndex,
    // #1266 — fast-path hop window 게이트 입력. arcStations 변화 시(환승 후 leg 전환 등) 재평가.
    arcStations,
    // #1922 (M1+M3) — fg-arvlcd 경로 동적 windowSize 재계산.
    currentHopStrategy,
  ]);

  // #1290/#1298 — subsurface verdict 기반 station-passed 발사.
  // subsurfaceStationDetected=true: 지하(subsurface=true) + ≥2 신호 합의(barometer-stop/
  // motion-stationary/arvlcd-arrived) + 역 근접 게이트를 useFusedNearestStation이 이미 통과시킨 상태.
  // GPS 거리/정확도 게이트가 이미 fusion 레이어에서 무효화된 신호이므로 여기서 재적용하지 않는다.
  // dedup: lastNotifiedStationId 단일 출처 — GPS/FG-arvlcd/subsurface 세 경로 중 첫 발사 이후 나머지 자동 dedup.
  useEffect(() => {
    if (!subsurfaceStationDetected) return;
    if (hydrationPhase !== 'ready') return;
    if (!route || !destination) return;
    if (!nearestStation) return;
    if (firedAlarmsRefDestIdRef.current !== destination.id) {
      logRefMismatch(destination.id, firedAlarmsRefDestIdRef.current);
      return;
    }
    if (!isStationOnRoute(nearestStation, route)) return;

    const candidateStation = nearestStation;
    const capturedDestinationId = destination.id;

    let cancelled = false;
    void (async () => {
      const lock = await getBoardingLock();
      if (cancelled) return;
      // #1816 (paradigm shift Phase 1 보강) — lockless trip + 사용자 명시 의향 없음 시 subsurface station-passed 차단.
      // #2387: lockless+무의향 억제 — isLocklessNoUserIntent 참고. paradigm shift 정합.
      if (suppressIfLocklessStationPassed(lock, candidateStation)) return;
      // #1572 (T9) — backend SSoT 권위 게이트 (Path C subsurface verdict). subsurface fusion이
      // backend가 이미 결정한 alarmId/stationId를 재발사하는 회귀 차단. dispatch helper 진입 직전 평가.
      // #1572 — 3 path 공통 helper로 통합 (SonarCloud CPD 회피).
      if (
        await evaluateSsotFireGateAndLogIfBlocked({
          candidateStation,
          source: 'fg',
          isCancelled: () => cancelled,
        })
      ) {
        return;
      }
      await runSilenceGateAndDispatch({
        source: 'fg',
        candidateStation,
        capturedDestinationId,
        isCancelled: () => cancelled,
        errorLogPrefix: 'subsurface station-passed 알림 실패:',
        dismissSilence,
        userLocation,
        clearDismissSilenceAction,
        lock,
        route,
        destination,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [
    subsurfaceStationDetected,
    hydrationPhase,
    route,
    destination?.id,
    destination?.name,
    nearestStation?.id,
    dismissSilence,
    clearDismissSilenceAction,
    userLocation?.lat,
    userLocation?.lng,
    currentHopIndex,
  ]);
}
