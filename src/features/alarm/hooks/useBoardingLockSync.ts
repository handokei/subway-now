/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: alarm hook이 nearest-station feature의 API client
 * `syncBoardingLock`을 직접 호출한다. positionUpload와 동형(BG task가 nearest-station API
 * 호출)이라 file-level disable 패턴을 따른다. ADR Phase 5 (#890).
 */
/**
 * Seam E (#901) — BoardingLock 정정 신호 송신 훅.
 *
 * 사용자의 좋은 GPS fix(accuracy ≤ GOOD_FIX_ACCURACY_MAX_M)로 확정된 현재역을 backend에 통보해
 * cron의 stale lock currentWaypoint를 사용자 위치와 정렬한다. silent push 누락 회귀(#622) 흡수.
 *
 * #2709 — lock 신원(trainCode/boardingLine) → backend 전달의 **유일** 경로. 과거 `POST /trips`의
 * `boardingLockMeta`(#622)가 route ↔ lock 불일치 시 통째로 드롭되고, 이 경로는 GPS 정확도 게이트로
 * 막혀 있어 두 경로가 각자 다른 이유로 lock을 누락했다(2026-09-18 라이드 13분 미도달 실측). 이제
 * 이 훅이 유일 경로이며, station 관측과 lock 신원을 필드 단위로 분리 게이트한다:
 *   - station 관측(observedStationName + accuracy)은 여전히 GOOD_FIX_ACCURACY_MAX_M(또는 WiFi
 *     SSID) 게이트를 통과해야만 "신뢰 가능한 현재 위치"로 전송된다 — 틀린 역 관측이 backend
 *     advance를 오염시키는 것을 막는 기존 안전장치는 그대로 유지.
 *   - lock 신원(trainCode + boardingLine)은 GPS 상태와 무관하게 전달돼야 한다(ADR-010/ADR-039).
 *     좋은 fix가 없으면 lock의 boarding station(생성 시점 스냅샷, GPS 무관 ground truth)을
 *     observedStationName fallback으로 사용한다 — `routeToWaypoints`가 boarding station 자체를
 *     waypoint로 만들지 않으므로 이 값은 절대 남은 waypoint와 매칭돼 backend advance(hop shift)를
 *     오염시키지 않는다(`computeLockSyncAdvance`는 station 이름이 waypoints 안에 있을 때만 shift).
 *
 * 트리거:
 *   1) currentStationName 변경(또는 GPS 신뢰 불가 시 lock 존재) → debounce SYNC_DEBOUNCE_MS 후 발사
 *   2) `forceTriggerKey` 변경 — trip 등록 직후 / 지하→지상 경계(Seam G) 등 호출자 선택 트리거
 *      (key는 식별용 문자열; 호출자가 동일 key를 재전달하면 재발사 안 함)
 *
 * 두 트리거 모두 실패(네트워크/5xx) 시, payload에 실린 lock 신원이 있으면 backoff 재시도한다 —
 * lock 신원은 backend ADR-038 Phase 2(#2560) 승격 경로의 유일한 입력이라 한 번 도달 실패로
 * 다음 station 변경까지 무기한 대기하면 안 된다.
 *
 * APNs token / trip token 모두 없는 상태(트립 미시작)는 자연 no-op. 송신 결과(정정 자체,
 * currentWaypoint)는 무시 — backend의 정정 결과는 cron 사이클이 client에 silent push로 별도 전달한다.
 */

import { useEffect, useRef, type MutableRefObject } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { APNS_TOKEN_KEY, ACTIVE_TRIP_KEY } from '../../../shared/constants/storageKeys';
import { syncBoardingLock } from '../../nearest-station/api/boardingLockSync';
import { getStationById } from '../../../shared/utils/stationRoute';
import {
  isPendingTrainCode,
  LOCK_ONLY_SYNC_ACCURACY_METERS,
  LOCK_SYNC_RETRY_BACKOFF_MS,
  LOCK_SYNC_RETRY_MAX_ATTEMPTS,
} from '../../../shared/constants/boardingLock';
import { isScheduleFallbackTrainCode } from '../utils/scheduleFallback';
import { logLockSyncDelivery } from '../utils/alarmLog';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('useBoardingLockSync');

/** sync 발사 직전 debounce — 사용자가 짧게 역 사이를 GPS jitter로 왕복해도 1회로 묶는다. */
export const SYNC_DEBOUNCE_MS = 5000;

/** 좋은 fix 임계 — Seam E 정정은 GPS-확신 신호만 받는다. positionUpload의 ≥ 50m drop과 정합. */
export const GOOD_FIX_ACCURACY_MAX_M = 50;

export interface UseBoardingLockSyncOptions {
  /** 클라가 좋은 fix로 확정한 현재역명. null이면 lock 신원 fallback anchor로만 발사(있을 때). */
  currentStationName: string | null;
  /** 직전 fix accuracy meters. null/임계 초과면 station 관측은 신뢰 불가(lock 신원은 영향 없음). */
  accuracyMeters: number | null;
  /**
   * 트립 활성 여부 — 호출자가 trip + lock 활성 게이트를 결정해 전달한다.
   * false면 본 훅은 sync를 발사하지 않는다 (lock 없는 fix에 backend가 trip_not_found로 응답할 뿐이라
   * 트래픽만 발생). 게이트는 호출자 책임 — alarm 슬라이스가 lock 존재로 판단.
   */
  tripActive: boolean;
  /**
   * 명시 트리거 키 — 값이 바뀔 때마다 1회 즉시 sync 발사 (debounce 우회).
   *   - 트립 등록 직후: 새 trip token을 key로 전달
   *   - 지하→지상 경계: barometer 신호 timestamp 또는 sequence 번호 전달
   * 같은 key 재전달은 no-op (재발사 방지). null → effect skip.
   */
  forceTriggerKey?: string | null;
  /** Seam G subsurface 신호 (옵션) — backend 로그에 진단 라벨로 첨부. */
  subsurface?: boolean;
  /**
   * #1286 — 현재역이 WiFi SSID 매칭으로 확정됐는지 (fusion confidence==='wifi-ssid').
   * true면 `accuracyMeters > GOOD_FIX_ACCURACY_MAX_M` 게이트를 우회한다 — WiFi SSID는 GPS 정확도와
   * 무관하게 역을 확정하므로(지하 GPS dead zone에서 accuracy>50m가 정상), ≤50m fix가 없어도 sync한다.
   * 일반 GPS 유도 역(false/미전달)에는 ≤50m 게이트를 그대로 유지 — 부정확한 fix로 잘못된 정정 차단.
   * accuracy=null(관측 자체 부재)은 WiFi 여부와 무관하게 여전히 no-op (payload accuracy 필드 요구).
   */
  stationFromWifi?: boolean;
  /**
   * D4 (#1210) — 현재 활성 boarding lock의 trainCode. 있으면 sync payload에 동봉돼
   * backend가 환승 leg trainCode 변경을 즉시 인식하고 `consecutiveEtaMissing` 자동 종료를 차단한다.
   * null이면 payload에 trainCode 미포함 (구버전 backend / lock 없는 trip 호환).
   *
   * #2709 — 이 필드가 채워지면(schedule-fallback/pending sentinel 제외) GPS 상태와 무관하게
   * 발사를 유발한다 — 좋은 fix가 없으면 `boardingLockBoardingStationId` fallback anchor를 쓴다.
   */
  boardingLockTrainCode?: string | null;
  /**
   * D4 (#1210) — 현재 활성 boarding lock의 노선. trainCode와 함께 sync payload에 동봉된다.
   * trainCode 없이 단독 전송은 backend에서 무시 (trainCode가 동일성 판정의 primary key).
   */
  boardingLockLine?: string | null;
  /**
   * #2709 — 현재 활성 boarding lock의 탑승역 id (`BoardingLock.boardingStationId`). 신뢰 가능한
   * GPS 관측이 없을 때 이 id로 station name을 조회해 observedStationName fallback으로 사용한다 —
   * GPS와 무관한 ground truth(lock 생성 시점 스냅샷)이며, 아직 소비되지 않은 waypoint와 절대
   * 겹치지 않아(routeToWaypoints가 boarding station 자체는 waypoint에 포함하지 않음) backend
   * advance 로직을 오염시키지 않는다.
   */
  boardingLockBoardingStationId?: string | null;
  /**
   * #2709 — 현재 활성 boarding lock의 탑승 시각(`BoardingLock.boardedAt`, epoch ms). 전달 성공 시
   * 이 값으로부터 경과 초를 계산해 `logLockSyncDelivery`의 `delaySeconds`로 적재한다 — "lock 생성 →
   * backend 반영" 지연 실측(#2709 요구사항 7).
   */
  boardingLockBoardedAt?: number | null;
}

/**
 * `clearTimeout(null)`이 런타임에 안전한 no-op이라는 사실에 기대는 대신 명시적으로 가드한다 —
 * 호출부 3곳(clearLockRetry / dispatchSync 성공·실패 분기)이 각자 null 분기를 중복 방어하면
 * 테스트가 그 3곳 전부에서 "timer가 null인 경우"를 각각 재현해야 하는 부담이 생긴다. 이 한
 * 함수로 모으면 어느 호출부에서든 null/non-null 두 경우 중 하나씩만 자연히 나와도 전체 분기가
 * 커버된다.
 */
function clearPendingTimer(timer: ReturnType<typeof setTimeout> | null): void {
  if (timer !== null) clearTimeout(timer);
}

/** lock 신원이 backend로 전달할 가치가 있는 상태인지 — pending/schedule-fallback sentinel 제외. */
function isUsableLockIdentity(trainCode: string | null | undefined, line: string | null | undefined): boolean {
  if (!trainCode || !line) return false;
  return !isPendingTrainCode(trainCode) && !isScheduleFallbackTrainCode(trainCode);
}

interface ObservedAnchor {
  observedStationName: string;
  accuracy: number;
  /**
   * lock 신원을 payload에 동봉할 수 있으면 그 값(trainCode/boardingLine/boardedAt), 아니면
   * 전부 null. 호출부가 원본 props로 재차 유효성을 되짚지 않도록 이 함수가 유일하게 판단한다
   * (호출부 4곳에서 중복 삼항식을 두면 "includeLockIdentity가 true인데 trainCode가 null일 수
   * 있는가"라는 도달 불가능한 방어 분기가 매 호출부에 생겨 테스트로 커버할 수 없는 dead branch가
   * 늘어난다).
   */
  lockIdentity: { trainCode: string; boardingLine: string; boardedAt: number | null } | null;
}

/**
 * 이번 사이클에 보낼 observedStationName/accuracy를 결정한다.
 *   1) 신뢰 가능한 GPS 관측(≤50m 또는 WiFi SSID)이 있으면 그것을 그대로 사용 — lock 신원도 함께
 *      실을 수 있으면 싣는다.
 *   2) 없으면 lock 신원이 usable할 때만 boarding station(GPS 무관) fallback으로 anchor를 만든다.
 *   3) 둘 다 없으면 이번 사이클엔 보낼 것이 없다(null).
 */
function resolveObservedAnchor(input: {
  currentStationName: string | null;
  accuracyMeters: number | null;
  stationFromWifi?: boolean;
  boardingLockTrainCode?: string | null;
  boardingLockLine?: string | null;
  boardingLockBoardingStationId?: string | null;
  boardingLockBoardedAt?: number | null;
}): ObservedAnchor | null {
  const hasGoodStationFix =
    input.currentStationName != null &&
    input.accuracyMeters != null &&
    (input.stationFromWifi === true || input.accuracyMeters <= GOOD_FIX_ACCURACY_MAX_M);
  const hasUsableLockIdentity = isUsableLockIdentity(input.boardingLockTrainCode, input.boardingLockLine);
  // hasUsableLockIdentity가 true면 isUsableLockIdentity 정의상 둘 다 non-empty string.
  const lockIdentity = hasUsableLockIdentity
    ? {
        trainCode: input.boardingLockTrainCode as string,
        boardingLine: input.boardingLockLine as string,
        boardedAt: input.boardingLockBoardedAt ?? null,
      }
    : null;

  if (hasGoodStationFix) {
    return {
      observedStationName: input.currentStationName as string,
      accuracy: input.accuracyMeters as number,
      lockIdentity,
    };
  }
  if (lockIdentity && input.boardingLockBoardingStationId) {
    const boardingStation = getStationById(input.boardingLockBoardingStationId);
    if (boardingStation) {
      return {
        observedStationName: boardingStation.name,
        accuracy: LOCK_ONLY_SYNC_ACCURACY_METERS,
        lockIdentity,
      };
    }
    // lock은 usable하지만 boarding station lookup 실패 — 시도 자체가 불가능(stations.json drift 등).
    logLockSyncDelivery({ outcome: 'blocked' });
  }
  return null;
}

/**
 * Effect-only 훅 — 외부 상태를 mutate하지 않고 backend POST만 발사한다 (return 없음).
 * 정정 결과는 cron sync silent push로 client에 별도 전달.
 */
export function useBoardingLockSync({
  currentStationName,
  accuracyMeters,
  tripActive,
  forceTriggerKey,
  subsurface,
  stationFromWifi,
  boardingLockTrainCode,
  boardingLockLine,
  boardingLockBoardingStationId,
  boardingLockBoardedAt,
}: UseBoardingLockSyncOptions): void {
  // 이미 보낸 observedStationName을 기억해 debounce 안의 중복 발사를 방지.
  const lastSentStationRef = useRef<string | null>(null);
  // D4 (#1210) — 이미 보낸 trainCode를 기억해 환승 leg에서 trainCode가 바뀐 trip은 같은 역에서도
  // 1회 재발사하도록 한다. station 단독 dedup만 두면 환승 직후 사용자가 환승역에 계속 머무는 동안
  // backend가 새 trainCode를 영영 못 받는 회귀가 생긴다 (D4 evidence consecutiveEtaMissing 자동 종료).
  const lastSentTrainCodeRef = useRef<string | null>(null);
  // forceTriggerKey 이전 값 — 같은 key 재전달 시 no-op 판정용.
  const lastForceKeyRef = useRef<string | null>(null);
  // #2709 — lock 신원(trainCode|boardingLine) 실패 재시도 상태. 두 트리거(station-change/
  // force-trigger)가 공유 — 어느 쪽이 실패해도 동일 backoff 큐로 재시도한다.
  const lockRetryRef = useRef<{
    sig: string | null;
    timer: ReturnType<typeof setTimeout> | null;
    attempt: number;
  }>({ sig: null, timer: null, attempt: 0 });
  // #2709 — retry 콜백(지연 실행)이 항상 최신 props를 읽도록 하는 ref.
  const latestRef = useRef({
    currentStationName,
    accuracyMeters,
    subsurface,
    stationFromWifi,
    boardingLockTrainCode,
    boardingLockLine,
    boardingLockBoardingStationId,
    boardingLockBoardedAt,
  });
  useEffect(() => {
    latestRef.current = {
      currentStationName,
      accuracyMeters,
      subsurface,
      stationFromWifi,
      boardingLockTrainCode,
      boardingLockLine,
      boardingLockBoardingStationId,
      boardingLockBoardedAt,
    };
  });

  const clearLockRetry = (): void => {
    // clearTimeout(null)은 표준적으로 안전한 no-op — timer 존재 여부를 분기할 필요가 없다.
    clearPendingTimer(lockRetryRef.current.timer);
    lockRetryRef.current = { sig: null, timer: null, attempt: 0 };
  };

  // tripActive false → true 전환 시 lastSent ref들을 리셋. 새 trip의 첫 currentStationName이
  // 이전 trip의 마지막 station과 같아도 첫 sync가 발사되도록 보장 (#915 self code-review C4).
  useEffect(() => {
    if (!tripActive) {
      lastSentStationRef.current = null;
      lastSentTrainCodeRef.current = null;
      lastForceKeyRef.current = null;
      clearLockRetry();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripActive]);

  // 1) currentStationName 변경(또는 GPS 신뢰 불가 상태에서 lock 신원 fallback) debounce 트리거.
  // D4: trainCode 변경(환승 leg)도 동일 트리거로 다뤄 같은 역에서도 새 lock으로 1회 재발사.
  useEffect(() => {
    if (!tripActive) return;
    const anchor = resolveObservedAnchor({
      currentStationName,
      accuracyMeters,
      stationFromWifi,
      boardingLockTrainCode,
      boardingLockLine,
      boardingLockBoardingStationId,
      boardingLockBoardedAt,
    });
    if (!anchor) return;
    const trainCodeForFire = anchor.lockIdentity?.trainCode ?? null;
    const stationUnchanged = lastSentStationRef.current === anchor.observedStationName;
    const trainCodeUnchanged = lastSentTrainCodeRef.current === trainCodeForFire;
    if (stationUnchanged && trainCodeUnchanged) return;

    const timer = setTimeout(() => {
      // race: force-trigger 경로가 같은 station+trainCode를 이미 발사했을 수 있음. setTimeout
      // 내부에서 한 번 더 체크해 중복 발사 차단.
      if (
        lastSentStationRef.current === anchor.observedStationName &&
        lastSentTrainCodeRef.current === trainCodeForFire
      ) {
        return;
      }
      lastSentStationRef.current = anchor.observedStationName;
      lastSentTrainCodeRef.current = trainCodeForFire;
      void dispatchSync(
        {
          observedStationName: anchor.observedStationName,
          accuracy: anchor.accuracy,
          subsurface,
          trainCode: anchor.lockIdentity?.trainCode ?? null,
          boardingLine: anchor.lockIdentity?.boardingLine ?? null,
          boardedAt: anchor.lockIdentity?.boardedAt ?? null,
          reason: 'station-change',
        },
        latestRef,
        lockRetryRef,
      );
    }, SYNC_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [
    tripActive,
    currentStationName,
    accuracyMeters,
    subsurface,
    stationFromWifi,
    boardingLockTrainCode,
    boardingLockLine,
    boardingLockBoardingStationId,
    boardingLockBoardedAt,
  ]);

  // 2) 명시 트리거 (forceTriggerKey) — debounce 우회.
  useEffect(() => {
    if (!tripActive) return;
    if (!forceTriggerKey) return;
    if (lastForceKeyRef.current === forceTriggerKey) return;
    const anchor = resolveObservedAnchor({
      currentStationName,
      accuracyMeters,
      stationFromWifi,
      boardingLockTrainCode,
      boardingLockLine,
      boardingLockBoardingStationId,
      boardingLockBoardedAt,
    });
    if (!anchor) return;
    const trainCodeForFire = anchor.lockIdentity?.trainCode ?? null;

    lastForceKeyRef.current = forceTriggerKey;
    // lastSent ref들을 즉시 동기로 set — effect 1의 debounce timer가 같은 station/trainCode로
    // 추가 발사하지 않도록 차단. fire 실패해도 force 트리거는 forceTriggerKey 변경으로만 재시도되므로
    // false-positive 무발사는 발생하지 않음(단, lock 신원이 있으면 아래 dispatchSync가 별도 backoff).
    lastSentStationRef.current = anchor.observedStationName;
    lastSentTrainCodeRef.current = trainCodeForFire;
    void dispatchSync(
      {
        observedStationName: anchor.observedStationName,
        accuracy: anchor.accuracy,
        subsurface,
        trainCode: anchor.lockIdentity?.trainCode ?? null,
        boardingLine: anchor.lockIdentity?.boardingLine ?? null,
        boardedAt: anchor.lockIdentity?.boardedAt ?? null,
        reason: 'force-trigger',
      },
      latestRef,
      lockRetryRef,
    );
  }, [
    tripActive,
    forceTriggerKey,
    currentStationName,
    accuracyMeters,
    subsurface,
    stationFromWifi,
    boardingLockTrainCode,
    boardingLockLine,
    boardingLockBoardingStationId,
    boardingLockBoardedAt,
  ]);
}

interface DispatchSyncInput {
  observedStationName: string;
  accuracy: number;
  subsurface?: boolean;
  /** null이면 payload에 trainCode/boardingLine 미포함(순수 station 관측만). */
  trainCode: string | null;
  boardingLine: string | null;
  /** lock.boardedAt — 전달 성공 시 지연(초) 계측용. trainCode가 null이면 무시. */
  boardedAt: number | null;
  reason: 'station-change' | 'force-trigger';
}

type LatestSyncInputsRef = MutableRefObject<{
  currentStationName: string | null;
  accuracyMeters: number | null;
  subsurface?: boolean;
  stationFromWifi?: boolean;
  boardingLockTrainCode?: string | null;
  boardingLockLine?: string | null;
  boardingLockBoardingStationId?: string | null;
  boardingLockBoardedAt?: number | null;
}>;

type LockRetryRef = MutableRefObject<{
  sig: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  attempt: number;
}>;

/**
 * fireSync 발사 + lock 신원이 실려 있으면 계측(attempt/success)과 실패 시 backoff 재시도를 담당.
 * #2709 — lock 신원은 backend ADR-038 Phase 2(#2560) 승격 경로의 유일한 입력이므로, 한 번의
 * 네트워크 실패로 다음 station 변경까지 무기한 대기하면 안 된다.
 */
async function dispatchSync(
  input: DispatchSyncInput,
  latestRef: LatestSyncInputsRef,
  retryRef: LockRetryRef,
): Promise<void> {
  const hasLockIdentity = input.trainCode != null && input.boardingLine != null;
  const sig = hasLockIdentity ? `${input.trainCode}|${input.boardingLine}` : null;
  if (hasLockIdentity) {
    logLockSyncDelivery({ outcome: 'attempt' });
  }

  const res = await fireSync(input);

  if (!hasLockIdentity || sig === null) return; // station-only 발사 — lock 재시도 대상 아님.

  if (res?.ok) {
    if (retryRef.current.sig === sig) {
      // clearTimeout(null)은 안전한 no-op — timer 존재 여부를 분기할 필요가 없다.
      clearPendingTimer(retryRef.current.timer);
      retryRef.current = { sig: null, timer: null, attempt: 0 };
    }
    logLockSyncDelivery({
      outcome: 'success',
      ...(input.boardedAt != null
        ? { delaySeconds: Math.max(0, Math.round((Date.now() - input.boardedAt) / 1000)) }
        : {}),
    });
    return;
  }

  // 실패 — backoff 재시도. 다른 sig(lock이 이미 바뀜)에 대한 대기가 있었다면 갈아탄다.
  const attempt = retryRef.current.sig === sig ? retryRef.current.attempt : 0;
  if (attempt >= LOCK_SYNC_RETRY_MAX_ATTEMPTS) {
    logger.info(`lock-identity sync: 재시도 상한(${LOCK_SYNC_RETRY_MAX_ATTEMPTS}) 도달 — 중단`, sig);
    return;
  }
  // 다른(stale) sig의 대기 타이머가 남아 있었다면 정리 — clearTimeout(null)은 안전한 no-op.
  clearPendingTimer(retryRef.current.timer);
  const delay = LOCK_SYNC_RETRY_BACKOFF_MS[attempt];
  const timer = setTimeout(() => {
    retryRef.current.timer = null;
    void retryLockIdentity(sig, latestRef, retryRef);
  }, delay);
  retryRef.current = { sig, timer, attempt: attempt + 1 };
}

/**
 * backoff 만료 시 최신 props로 lock 신원 재시도. station 관측은 그 시점의 최신값을 다시
 * 평가한다 — 재시도 사이 GPS가 회복됐으면 신뢰 가능한 실제 station으로 승격돼 나간다.
 */
async function retryLockIdentity(
  sig: string,
  latestRef: LatestSyncInputsRef,
  retryRef: LockRetryRef,
): Promise<void> {
  const latest = latestRef.current;
  if (!isUsableLockIdentity(latest.boardingLockTrainCode, latest.boardingLockLine)) return;
  const currentSig = `${latest.boardingLockTrainCode}|${latest.boardingLockLine}`;
  if (currentSig !== sig) return; // lock이 이미 다른 값으로 바뀜 — 새 effect run이 처리.

  const anchor = resolveObservedAnchor(latest);
  if (!anchor) return; // 여전히 anchor 없음 — blocked는 resolveObservedAnchor가 이미 적재.
  /* istanbul ignore next -- 이 함수 진입 시점에 isUsableLockIdentity(latest.*)가 이미 true를
   * 반환했다(상단 가드) — resolveObservedAnchor는 동일 입력에 동일 판정을 재사용해 lockIdentity를
   * 계산하므로, anchor가 non-null인 이 지점에서 anchor.lockIdentity가 null일 수 있는 경로가
   * 현재 코드에 없다. 향후 resolveObservedAnchor 판정 로직이 분기될 경우를 대비한 방어적 가드. */
  if (!anchor.lockIdentity) return;

  await dispatchSync(
    {
      observedStationName: anchor.observedStationName,
      accuracy: anchor.accuracy,
      subsurface: latest.subsurface,
      trainCode: anchor.lockIdentity.trainCode,
      boardingLine: anchor.lockIdentity.boardingLine,
      boardedAt: anchor.lockIdentity.boardedAt,
      reason: 'station-change',
    },
    latestRef,
    retryRef,
  );
}

/**
 * AsyncStorage에서 token을 읽어 syncBoardingLock 호출. token/trip 부재는 graceful no-op(null 반환).
 * 정정 자체(currentWaypoint)는 cron silent push 경로가 별도로 client store를 mutate한다.
 * #2352 — 구 autoLockCandidate(#916) 무탭 hydrate forward 로직은 삭제됐다.
 */
async function fireSync(
  input: DispatchSyncInput,
): Promise<Awaited<ReturnType<typeof syncBoardingLock>> | null> {
  const token = await AsyncStorage.getItem(APNS_TOKEN_KEY);
  const activeTrip = await AsyncStorage.getItem(ACTIVE_TRIP_KEY);
  if (!token || !activeTrip) {
    logger.info('skip — apns or trip token missing', { reason: input.reason });
    return null;
  }
  const payload = {
    token,
    observedStationName: input.observedStationName,
    observedAtMs: Date.now(),
    accuracy: input.accuracy,
    ...(input.subsurface !== undefined ? { subsurface: input.subsurface } : {}),
    ...(input.trainCode ? { trainCode: input.trainCode } : {}),
    ...(input.boardingLine ? { boardingLine: input.boardingLine } : {}),
  };
  const res = await syncBoardingLock(payload);
  logger.info('boarding-lock sync sent', {
    reason: input.reason,
    trainCode: input.trainCode ?? null,
    advanced: res.advanced ?? false,
    currentWaypoint: res.currentWaypoint ?? null,
    ok: res.ok,
  });
  return res;
}
