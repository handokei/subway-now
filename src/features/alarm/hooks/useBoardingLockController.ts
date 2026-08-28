/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { useCallback, useEffect, useMemo } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useBoardingLockStore } from '../store/useBoardingLockStore';
import { useUserIntentStore } from '../store/useUserIntentStore';
import { useNavigationStore } from '../../route/store/useNavigationStore';
import { useLegAdvanceStore } from '../store/useLegAdvanceStore';
import { resolveTripDirection } from '../../route/utils/tripDirection';
import { findStationByNameAndLine } from '../../../shared/utils/stationLookup';
import { allowedLinesFromRoute } from '../../../shared/utils/stationRoute';
import { isValidLineNumber } from '../../../shared/constants/lineApiNames';
import { STATIC_SPEED_THRESHOLD_MPS } from '../../nearest-station/utils/movementGate';
import type { ArrivalInfo, StationArrival } from '../../../shared/types/arrival';
import type { Route } from '../../../shared/utils/stationRoute';
import type { LineNumber, Station } from '../../../shared/types/station';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import {
  FALLBACK_BOARDING_DURATION_MINUTES,
  FREE_TRIP_DESTINATION_SENTINEL,
  isPendingTrainCode,
} from '../../../shared/constants/boardingLock';
import type { AutoLockCandidate } from '../../nearest-station/api/boardingLockSync';
import { useLockSuggestion } from '../api/useLockSuggestion';
import type { LockSuggestionMirror } from '../utils/backendSsotMirror';
import { recordConsensusMismatch } from '../utils/consensusMismatchMetrics';

export interface UseBoardingLockControllerInputs {
  destinationId: string | null;
  destinationName: string | null;
  route: Route;
  arrival: StationArrival | null;
  currentStation: Station | null;
  /**
   * 정적 ETA(분). createLock 시 expectedDurationMs 계산에 사용된다.
   * null이면 fallback 30분 — 잘못된 Lock이라도 자동 만료(× 1.5)가 작동한다.
   */
  expectedDurationMinutes: number | null;
  /**
   * #1014 acceptance gate: iOS CMMotionActivity stationary 신호.
   * true이면 사용자가 원점 대기 중 — hydrate 허용.
   * undefined는 미측정(게이트에서 speedMps로 fallback).
   */
  motionStationary?: boolean | undefined;
  /**
   * #1014 acceptance gate: GPS 속도(m/s).
   * STATIC_SPEED_THRESHOLD_MPS(0.5) 미만이면 정적으로 판단 — hydrate 허용.
   * null은 미측정(게이트에서 motionStationary로 fallback).
   */
  speedMps?: number | null;
}

export interface UseBoardingLockControllerResult {
  lock: BoardingLock | null;
  /**
   * #1534 (S1, T9b, ADR-016) — backend가 추론한 lock 제안 (read-only). UI는 본 값으로
   * "출발역 확인 중..." indicator를 trip 활성 직후 5~30s 동안 노출하거나, 추론 완료 시 lock
   * badge + station name 노출 분기에 사용. null이면 추론 미정착(또는 9-AND gate fallback 중).
   */
  lockSuggestion: LockSuggestionMirror | null;
  /**
   * route 진행 방향으로 필터된 도착 list. 방향 미상이면 up+down 합집합.
   * hydrateLockFromCandidate Gate 1(#1014)의 방향 일치 검증에 쓰이므로 방향 엄격성을 유지한다.
   */
  directionalArrivals: ArrivalInfo[];
  /**
   * BoardingTrainList(사용자 직접 선택) 전용 도착 list — #1326.
   * directionalArrivals가 비어도(방향 필터가 populated side를 거름) 반대 방향 열차가 있으면 합쳐 노출한다.
   * 양쪽 모두 비어야 빈 목록. 빈 list "선택할 열차 없음" 회귀를 막되 Gate 1 엄격성은 건드리지 않는다.
   */
  boardingListArrivals: ArrivalInfo[];
  /** 사용자가 도착 list에서 열차 탭 시 호출. lock 생성을 위한 컨텍스트가 부족하면 no-op. */
  createLockFromTrain: (train: ArrivalInfo) => void;
  /**
   * candidate(trainCode/line/subwayId)로 lock을 hydrate.
   *
   * #2352 — 구 #915/#916 backend `/boarding-lock/sync` 응답 autoLockCandidate 채널은 삭제됐다
   * ("무탭 오토락 전량 삭제" 결정, #2342). 현재 유일한 호출자는 `useTransferAutoDetect`(#924)의
   * device-side 단일 후보 환승 자동 detect — planned route 없이 환승역에서 다른 노선 임박 열차가
   * 정확히 1개 감지될 때만 발동하는 별개 기능이다.
   *
   * idempotent: 이미 같은 trainCode + boardingLine으로 활성 lock이 있으면 no-op.
   * lock 생성을 위한 컨텍스트(destinationId / currentStation / line valid) 부족 시 no-op.
   */
  hydrateLockFromCandidate: (candidate: AutoLockCandidate) => void;
  /** 명시 하차. lock 없는 상태에서 호출돼도 안전. */
  releaseLock: () => void;
}

/**
 * #915 — backend candidate.line(string)이 LineNumber valid 값인지 narrow.
 * 미정합이면 hydrate skip — 호출자는 graceful로 lock 없는 상태 유지.
 *
 * #2278 (PR #2287 리뷰 P2-1) — 하드코딩 배열(구 `VALID_LINES`) 대신 shared
 * `isValidLineNumber`(LINE_API_NAMES 데이터 주도)로 위임. `useBoardingPromptResponder`의
 * 동등 검증과 단일 SSoT로 통합 — 신규 노선 추가 시 두 곳을 따로 갱신할 필요가 없다.
 */
function asLineNumber(raw: string): LineNumber | null {
  return isValidLineNumber(raw) ? raw : null;
}

/**
 * 도착 list 필터 술어 — #897 (Seam A). arrivalSeconds 음수(이미 지나간 열차)만 제외하고 임박(0초)은
 * 유지한다. 0초 행이 useArrivalCountdown tick으로 사라지면 사용자가 다음 차를 같은 차로 오인하는 회귀가
 * 있어 음수만 차단. 음수 train은 createLockFromTrain에서도 의미가 없어 #666 가드를 갈음한다.
 * directionalArrivals / boardingListArrivals 두 파생값이 같은 정책을 공유하는 SSOT.
 */
const isReachable = (train: ArrivalInfo): boolean => train.arrivalSeconds >= 0;

/**
 * #2407 — lock이 이미 확정된(pending 아닌) trainCode로 존재하면 lockSuggestion 채택을 skip.
 * pending fallback lock(trainCode 미확정)은 upgrade 대상이라 skip하지 않는다.
 */
function shouldSkipExistingLock(lock: BoardingLock | null): boolean {
  return lock !== null && !isPendingTrainCode(lock.trainCode);
}

/**
 * #2407 — pending fallback lock upgrade는 같은 leg(boardingLine 일치)일 때만 허용한다.
 * 다른 leg의 suggestion이 fallback lock을 clobber하지 않도록 방어.
 */
function isPendingUpgradeLineMismatch(lock: BoardingLock | null, boardingLine: LineNumber): boolean {
  return lock !== null && isPendingTrainCode(lock.trainCode) && boardingLine !== lock.boardingLine;
}

/**
 * #2278 (PR #2287 리뷰 P1-1) — legAdvance stamp(사용자 명시 하차 응답)가 살아있는 동안 stale/
 * 불일치 lockSuggestion으로 재-hydrate해 그 stamp를 무력화하지 않도록 판정한다:
 *   (a) suggestion.decidedAt < stamp.stampedAt — 사용자가 하차를 확인한 시점 *이전에* backend가
 *       결정한 stale suggestion. 그 사이의 최신 상황을 반영하지 못했으므로 신뢰 X.
 *   (b) suggestion.boardingLine !== stamp.nextLine — 사용자가 확인한 다음 leg와 다른 노선을
 *       제안 — stale mirror(이전 leg) 재생성 회귀(#2278 RCA)를 여기서 직접 차단.
 * stamp가 없으면(legAdvanceLine=null) conflict 없음 — 기존 동작 그대로.
 */
function isLegAdvanceConflict(
  legAdvanceLine: LineNumber | null,
  legAdvanceStampedAt: number | null,
  decidedAt: number,
  boardingLine: LineNumber,
): boolean {
  if (legAdvanceLine === null) return false;
  const isStale = legAdvanceStampedAt !== null && decidedAt < legAdvanceStampedAt;
  const disagrees = boardingLine !== legAdvanceLine;
  return isStale || disagrees;
}

/**
 * BoardingLock 제어 hook (#584 PR B).
 *
 * 책임:
 *  - 마운트 시 storage에서 lock 복원
 *  - destination 변경 시 stale lock 자동 release (다른 trip의 lock이 남는 것 차단)
 *  - AppState 'active' 진입 시 만료 검사
 *  - route 진행 방향으로 도착 list 필터링 — UI에 전달
 *  - 열차 탭 → BoardingLock 생성 (current station + line + 정적 ETA × 60_000 ms)
 *
 * 이번 PR 범위: UI 진입점 wiring. Fusion/scheduler 통합은 PR C/D.
 */
export function useBoardingLockController({
  destinationId,
  destinationName,
  route,
  arrival,
  currentStation,
  expectedDurationMinutes,
  motionStationary,
  speedMps,
}: UseBoardingLockControllerInputs): UseBoardingLockControllerResult {
  const lock = useBoardingLockStore((s) => s.lock);
  const loadLock = useBoardingLockStore((s) => s.loadLock);
  const createLock = useBoardingLockStore((s) => s.createLock);
  const releaseLock = useBoardingLockStore((s) => s.releaseLock);
  const checkExpiry = useBoardingLockStore((s) => s.checkExpiry);

  // #1534 (S1, T9b, ADR-016) — backend lockSuggestion 1순위 reader.
  // null이면 기존 9-AND gate fallback (`hydrateLockFromCandidate`)이 그대로 동작.
  const { suggestion: lockSuggestion } = useLockSuggestion();

  // #2278 — 사용자 하차 응답 stamp. lock 해제 직후 route 진행도가 아직 못 따라온 gap을
  // 로컬에서 즉시 메운다 (getApproachLine 우선순위: lock > legAdvance > route > fallback).
  // #2278 (PR #2287 리뷰 P1-1) — 아래 lockSuggestion 자동 hydrate effect가 이 stamp를
  // 무력화하지 않도록 하는 staleness 가드에도 재사용.
  const legAdvanceLine = useLegAdvanceStore((s) => s.nextLine);
  const legAdvanceStampedAt = useLegAdvanceStore((s) => s.stampedAt);

  // 마운트 시 storage hydrate.
  useEffect(() => {
    void loadLock();
  }, [loadLock]);

  // destination 변경 → stale lock release. 같은 destination이면 그대로 유지(앱 재시작 등).
  // #978: free-trip sentinel lock은 destinationId=null인 동안 그대로 유지하고, 사용자가 실제
  // destination을 설정하는 순간(sentinel !== realId) invalidate. destinationId=null + sentinel lock
  // 조합은 "여전히 free trip 진행 중"으로 본다.
  useEffect(() => {
    if (!lock) return;
    if (lock.destinationId === destinationId) return;
    if (destinationId === null && lock.destinationId === FREE_TRIP_DESTINATION_SENTINEL) return;
    void releaseLock();
  }, [lock, destinationId, releaseLock]);

  // AppState active 진입 시 만료 검사 + 마운트 직후 1회.
  useEffect(() => {
    void checkExpiry();
    const handler = (state: AppStateStatus): void => {
      if (state === 'active') void checkExpiry();
    };
    const sub = AppState.addEventListener('change', handler);
    return () => sub.remove();
  }, [checkExpiry]);

  // #1534 (S1, T9b, ADR-016) — backend lockSuggestion 1순위 채택.
  //
  // lock이 이미 존재하면 no-op (`hydrateLockFromCandidate`와 동일 idempotent 정책 — 사용자 명시
  // 탭 lock 보호 + auto-lock도 한 번 잡히면 변경 X). lockSuggestion이 null이면 9-AND gate
  // fallback이 `hydrateLockFromCandidate`로 동작 (consumer onAutoLockCandidate 경로).
  //
  // 9-AND gate 우회 정책:
  //   - directionalArrivals 매칭 필수 X — backend가 이미 arvlcd-confirmed-train evidence로 합의
  //     했으므로 device-side arrival list cross-check를 한 번 더 강제할 필요 없음.
  //   - motion gate(stationary/speedMps) 우회 — backend가 SSOT 권위 결정. device GPS race로
  //     일시 이동/정지 신호가 잘못 잡혀도 backend가 evidence 합의로 발사한 suggestion을 신뢰.
  //
  // 안전 가드:
  //   - allowedLines 검증 유지 (trip route 외 line trainCode reject — 환승역 fusion 오류 보호).
  //   - currentStation 부재 시 boardingStationId fallback이 불가하므로 stationId가 stations.json과
  //     매칭되지 않으면 graceful skip (다음 cycle 재시도). lockSuggestion.stationId는 backend가
  //     waypoint 기반으로 산출했으므로 정상 케이스 대부분 매칭.
  //   - destinationId 없으면 free-trip sentinel으로 hydrate.
  //   - #2278 (PR #2287 리뷰 P1-1) — legAdvance stamp(사용자 명시 하차 응답)가 살아있는 동안
  //     stale/불일치 lockSuggestion으로 재-hydrate해 그 stamp를 무력화하지 않는다:
  //       (a) suggestion.decidedAt < stamp.stampedAt — 사용자가 하차를 확인한 시점 *이전에*
  //           backend가 결정한 stale suggestion. 그 사이의 최신 상황을 반영하지 못했으므로 신뢰 X.
  //       (b) suggestion.boardingLine !== stamp.nextLine — 사용자가 확인한 다음 leg와 다른 노선을
  //           제안 — stale mirror(이전 leg) 재생성 회귀(#2278 RCA)를 여기서 직접 차단.
  //     stamp가 없으면(nextLine=null) 가드 미개입 — 기존 동작 그대로.
  useEffect(() => {
    if (!lockSuggestion) return;
    // #2407 — pending lock(#2407 fallback lock, trainCode 미확정)은 lockSuggestion(backend
    // arvlcd-confirmed evidence, arrival/realtimePosition 기반)이 도착하면 async로 실 trainCode를
    // 확정해야 한다("기존 메커니즘 재사용, 신규 감지 신설 금지" — 이 effect가 이미 하는 backend
    // suggestion → createLock 채택 로직을 pending 케이스까지 확장). 이미 trainCode가 확정된
    // 일반 lock은 기존대로 완전 no-op(사용자 명시 탭 lock 보호 정책 불변).
    if (shouldSkipExistingLock(lock)) return;
    // #2330 (consensus-D, 설계 SSoT #2323 (3)) — confidence='consensus'는 lock 승격 금지.
    // legConsensus는 UI 표시(배지/하이라이트)/floor 힌트 전용 forward라 high/medium/low(9-AND
    // gate 기반 evidence)와 달리 자동 hydrate 대상이 아니다. "오토락 부활" 오해를 구조적으로 차단.
    if (lockSuggestion.confidence === 'consensus') return;
    const boardingLine = asLineNumber(lockSuggestion.lineId);
    if (!boardingLine) return;
    if (isPendingUpgradeLineMismatch(lock, boardingLine)) return;
    if (isLegAdvanceConflict(legAdvanceLine, legAdvanceStampedAt, lockSuggestion.decidedAt, boardingLine)) {
      return;
    }
    const allowed = allowedLinesFromRoute(route);
    if (allowed && !allowed.has(boardingLine)) return;
    // boardingStationId 산출: lockSuggestion.stationId가 stations.json id이면 그대로,
    // station name이면 (lookup, line) 매칭 — 백엔드는 stationName 그대로 forward 케이스가
    // 많아 양쪽 모두 지원해야 한다.
    const stationByName = findStationByNameAndLine(lockSuggestion.stationId, boardingLine);
    const boardingStationId =
      stationByName?.id ?? currentStation?.id ?? lockSuggestion.stationId;
    if (!boardingStationId) return;
    const isSentinel = !destinationId;
    const effectiveDestinationId = destinationId ?? FREE_TRIP_DESTINATION_SENTINEL;
    const durationMin = expectedDurationMinutes ?? FALLBACK_BOARDING_DURATION_MINUTES;
    const now = Date.now();
    createLock({
      destinationId: effectiveDestinationId,
      trainCode: lockSuggestion.trainCode,
      boardingStationId,
      boardingLine,
      boardedAt: now,
      expectedDurationMs: durationMin * 60_000,
      // initialEtaSeconds는 lockSuggestion에 없음 — 자동 lock 지연 칩은 사용자 명시 탭 lock에만
      // 노출되는 게 의도 (`hydrateLockFromCandidate`와 동일 정책).
      ...(isSentinel
        ? {
            hydratedFromSentinel: {
              destinationId: FREE_TRIP_DESTINATION_SENTINEL,
              sentinelAt: now,
            },
          }
        : {}),
      // #2290 P1 — lockSuggestion은 backend(#1534)가 arvlcd-confirmed-train evidence로 이미
      // 합의한 뒤 device에 통보한 결과다. device-side 9-AND gate(directionalArrivals 매칭 /
      // motion gate)를 의도적으로 우회하는 이유(위 196-200줄)와 동일 — backend가 이미 "탑승
      // evidence"를 확인했으므로 생성 시점 자체가 evidence다.
    }, true).catch(() => {
      // store action rejection은 graceful — 다음 polling cycle에서 자연 재시도.
    });
  }, [
    lockSuggestion,
    lock,
    route,
    currentStation,
    destinationId,
    expectedDurationMinutes,
    createLock,
    legAdvanceLine,
    legAdvanceStampedAt,
  ]);

  const direction = useMemo(() => {
    if (!route || !destinationName || !currentStation) return null;
    return resolveTripDirection(route, destinationName, currentStation.id);
  }, [route, destinationName, currentStation]);

  // #1449 (ADR-015 §9 frontend) — trip route에 포함된 노선 집합. lock 채택 시 line filter SSOT.
  // trip 비활성/route null이면 undefined — 두 진입점은 undefined를 "필터 미적용"으로 해석한다
  // (free-trip / hydrate 경로에서 route가 없는 상태도 기존처럼 허용).
  // backend(#1439 E6) gate와 같은 규칙을 device 측에도 적용해, trip route 외 line의 traincode가
  // BoardingLock store로 흘러드는 회귀를 차단한다.
  const allowedLines = useMemo(() => allowedLinesFromRoute(route), [route]);

  const directionalArrivals = useMemo<ArrivalInfo[]>(() => {
    if (!arrival) return [];
    if (direction === 'up') return arrival.up.filter(isReachable);
    if (direction === 'down') return arrival.down.filter(isReachable);
    return [...arrival.up, ...arrival.down].filter(isReachable);
  }, [arrival, direction]);

  // #1326: BoardingTrainList 전용 — 방향 필터 결과가 비면 빈 목록 대신 양방향 합집합으로 폴백.
  //
  // directionalArrivals는 hydrateLockFromCandidate Gate 1(#1014)의 false-positive 방어용이라 방향을
  // 엄격히 유지해야 한다. 하지만 사용자가 직접 탭하는 BoardingTrainList에서는 resolveTripDirection이
  // (환승역/환상선/index 기반 한계로) 잘못된 방향을 골라 그 쪽 arrival이 비면 "선택할 열차 없음"이 뜨는
  // 회귀가 있었다. 도착 열차가 실제로 존재하면 빈 목록을 피하는 게 우선이므로, 방향 필터 결과가 비면
  // 반대 방향까지 합쳐 노출한다. 양쪽 모두 비면 그대로 빈 목록(진짜 도착 없음 → 컴포넌트 empty-state).
  const boardingListArrivals = useMemo<ArrivalInfo[]>(() => {
    if (directionalArrivals.length > 0) return directionalArrivals;
    if (!arrival) return [];
    return [...arrival.up, ...arrival.down].filter(isReachable);
  }, [directionalArrivals, arrival]);

  const createLockFromTrain = useCallback(
    (train: ArrivalInfo) => {
      if (!destinationId || !currentStation) return;
      // #1449 (ADR-015 §9 frontend) — trip route 외 line traincode reject.
      // 환승역(왕십리/청량리 등)에서 사용자가 옆 노선 열차를 잘못 탭하거나, fusion이 옆 노선의
      // train arrival을 directionalArrivals에 섞어 노출한 경우 lock 채택을 차단한다.
      // allowedLines === undefined는 trip 비활성 → 필터 미적용(free-trip 등 기존 UX 유지).
      if (allowedLines && !allowedLines.has(train.line)) return;
      // #2330 (consensus-D, 설계 SSoT #2323 (3)) — 명시 탭이 항상 우선. backend consensus
      // engine이 confirmed(confidence='consensus')한 제안과 다른 열차를 탭하면 mismatch telemetry
      // 기록 — lock 채택 자체는 아래 기존 흐름 그대로(탭이 SSoT, consensus는 표시 전용이라 차단하지 않음).
      if (
        lockSuggestion?.confidence === 'consensus' &&
        lockSuggestion.trainCode !== train.trainCode
      ) {
        recordConsensusMismatch(lockSuggestion.trainCode, train.trainCode);
      }
      // #1923 — 사용자 명시 의향 stamp. BoardingTrainList 직접 탭은 lock 활성과 동급 의향 표명.
      // ADR-014 §X "사용자 명시 의향 trip = lock 활성과 동급 정확도 보장 의무" 정합.
      // setInfoModeEnabled는 memory + storage atomic — graceful 실패(다음 cycle에서 자연 재시도).
      // lock 활성 trip은 backend가 boardingLock 분기로 처리하므로 본 stamp는 graceful surplus,
      // 단 lock이 실패/만료해 lockless 전환되면 즉시 lockless intermediate gate 활성화 보장.
      void useUserIntentStore.getState().setInfoModeEnabled(true);
      // #2371 (Part of #2306) — BoardingTrainList 직접 탭(user-tap)도 boardingPrompt 응답과
      // 동급 명시 의향 표명이므로 navigationActive도 함께 켠다(#2306 RCA — 화면 잠금 시 BG GPS
      // 미시작 → leg 알림 전멸). hydrateLockFromCandidate(무탭 fusion auto-lock 경로)는 의도적으로
      // 건드리지 않는다 — 사용자 명시 탭이 아닌 candidate 채택까지 BG GPS를 켜면 #1973
      // "명시 trigger 없이 자동 BG 금지" 원칙 위반.
      useNavigationStore.getState().startNavigation();
      const durationMin = expectedDurationMinutes ?? FALLBACK_BOARDING_DURATION_MINUTES;
      // #663: boardingLine은 사용자가 실제로 탭한 train의 line을 사용. currentStation.line은 fusion
      // 추정이라 환승역에서 옆 노선으로 잘못 잠긴 상태일 수 있다 (#662). train.line은 어댑터가 subwayId로
      // 결정해 row마다 정확. fusion이 잘못돼 있어도 lock만은 정답을 유지 — backend sync(#622) 정확도 보장.
      // #707: boardingStationId도 같은 이유로 정정. 환승역에서 fusion이 옆 노선 stop id로 잠긴 상태면
      // backend가 그 id로 reschedule 계산해 잘못된 leg 알람을 보낼 수 있다. 같은 역명에서 train.line으로
      // 정확 매칭되는 stop id를 사용. 매칭 실패(데이터 누락 가상 케이스)는 currentStation.id로 안전 폴백.
      const correctedStation = findStationByNameAndLine(currentStation.name, train.line);
      const boardingStationId = correctedStation?.id ?? currentStation.id;
      void createLock({
        destinationId,
        trainCode: train.trainCode,
        boardingStationId,
        boardingLine: train.line,
        boardedAt: Date.now(),
        expectedDurationMs: durationMin * 60_000,
        // #897 Seam A: 탑승 시점 ETA 스냅샷. 동일 trainCode가 유지되는 동안 새 폴링의 arrivalSeconds가
        // 이 값보다 크게 늘면 그 차이가 지연(분). BoardingTrainList가 "+N분 지연" 칩으로 노출.
        initialEtaSeconds: train.arrivalSeconds,
      // #2290 P1 — user-tap은 "미래 열차 선택"일 뿐 탑승 확정 evidence가 아니므로 evidence=false.
      // `hasConsumedOriginWait`가 위 initialEtaSeconds 경과 여부로 별도 판정한다.
      }, false, 'user-tap').then(() => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }).catch(() => {
        // store action rejection은 graceful — 다음 polling cycle에서 자연 재시도.
      });
    },
    [destinationId, currentStation, expectedDurationMinutes, createLock, allowedLines, lockSuggestion],
  );

  const release = useCallback(() => {
    void releaseLock();
  }, [releaseLock]);

  // candidate(현재는 useTransferAutoDetect의 device-side 단일 후보 detect, #924)를 받아 client
  // BoardingLock store hydrate. #2352 — 구 backend #915/#916 autoLockCandidate 채널은 삭제됨.
  // hydrate 정책: lock이 이미 존재하면 항상 no-op.
  //  - 사용자가 BoardingTrainList에서 명시 탭한 lock을 candidate(다른 trainCode 가능)가
  //    silently overwrite하지 않게 보호 (#915 self code-review).
  //  - destination 변경 시 controller의 stale-lock release effect가 lock=null로 만든 후에야 hydrate.
  //  - 자동 lock도 한 번 잡히면 변경 X.
  // #1014 RC2 acceptance gate — 두 조건 모두 통과해야 hydrate:
  //  1) candidate.trainCode가 directionalArrivals(현재 역 + 방향 필터)에 있는지 확인
  //     → origin을 이미 지난 열차(arrival list 없음)는 자동 차단.
  //     → 방향 불일치 열차도 동시에 차단 (directionalArrivals가 direction 필터 적용됨).
  //  2) 사용자가 origin에서 정적 대기 중인지 확인 — motionStationary 우선, speedMps fallback.
  //     → 이미 열차에 탑승해 이동 중인 상태에서 candidate가 지연 발생하는 false positive를 차단.
  const hydrateLockFromCandidate = useCallback(
    (candidate: AutoLockCandidate) => {
      if (!currentStation) return;
      const boardingLine = asLineNumber(candidate.line);
      if (!boardingLine) return;
      if (lock) return;
      // #1449 (ADR-015 §9 frontend) — trip route 외 line autoLockCandidate reject.
      // backend autoLock(#916) 9-AND gate가 device-side trip context를 완전히 모르므로,
      // device가 trip route allowedLines 검증을 한 번 더 강제한다.
      // allowedLines === undefined는 trip 비활성 → 필터 미적용 (free-trip sentinel 경로 유지).
      if (allowedLines && !allowedLines.has(boardingLine)) return;

      // #1014 Gate 1: trainCode가 현재 directionalArrivals에 있는지 확인.
      // directionalArrivals는 arrival + direction 필터로 이미 방향 일치 검증을 포함한다.
      const trainInArrivals = directionalArrivals.some(
        (t) => t.trainCode === candidate.trainCode,
      );
      if (!trainInArrivals) return;

      // #1014 Gate 2: 사용자 원점 dwell 확인.
      // motionStationary=true → 정적 확정 → 통과.
      // motionStationary=false → 이동 가능성 있음. speedMps로 교차 검증:
      //   speedMps >= STATIC_SPEED_THRESHOLD_MPS이면 이동 확정 → 차단.
      //   speedMps null(미측정) 또는 정적이면 → 통과.
      //   (motionStationary=false는 앱 init 직후 초기값일 수 있어 단독 차단하지 않는다)
      // motionStationary 미측정(undefined)이면 speedMps로 단독 판단:
      //   speedMps >= STATIC_SPEED_THRESHOLD_MPS → 차단. 미측정/정적 → 통과.
      // 두 신호 모두 없거나 불확실하면 보수적으로 통과 — false negative보다 false positive 방지 우선.
      //
      // #2154 — backend transfer-swap 발급 경로 전량 삭제(무탭 환승 auto-lock 사슬 근절)에 맞춰
      // `from:'transfer-swap'` Gate 2 우회 분기도 함께 제거. backend가 더 이상 이 라벨을 발급하지
      // 않으므로 candidate.from은 항상 undefined — motionStationary/speedMps 판정만 남는다.
      if (motionStationary === true) {
        // stationary 확인됨 → Gate 2 통과
      } else if (speedMps != null && speedMps >= STATIC_SPEED_THRESHOLD_MPS) {
        return; // GPS speed로 이동 중 확인 → no-op
      }

      // #978 (PR #955 follow-up): destinationId 없으면 free-trip sentinel으로 hydrate.
      // 사용자가 나중에 실제 destination을 설정하면 위의 destination 변경 effect가
      // (sentinel !== realId) → 자동 release하므로 cross-talk 차단.
      const isSentinel = !destinationId;
      const effectiveDestinationId = destinationId ?? FREE_TRIP_DESTINATION_SENTINEL;
      const durationMin = expectedDurationMinutes ?? FALLBACK_BOARDING_DURATION_MINUTES;
      // boardingStationId는 createLockFromTrain과 동일하게 (역명, candidate.line) 매칭 정정.
      const correctedStation = findStationByNameAndLine(currentStation.name, boardingLine);
      const boardingStationId = correctedStation?.id ?? currentStation.id;
      const now = Date.now();
      createLock({
        destinationId: effectiveDestinationId,
        trainCode: candidate.trainCode,
        boardingStationId,
        boardingLine,
        boardedAt: now,
        expectedDurationMs: durationMin * 60_000,
        // initialEtaSeconds는 candidate에 없음 — Seam A 지연 칩은 cron이 채워둔 lock 메타로 노출되지 않으며,
        // 사용자가 명시 탭한 lock에서만 노출되는 게 의도(자동 lock은 정확도가 보장 안 됨).
        ...(isSentinel
          ? {
              hydratedFromSentinel: {
                destinationId: FREE_TRIP_DESTINATION_SENTINEL,
                sentinelAt: now,
              },
            }
          : {}),
      // #2290 P1 / #2154 — transfer-swap 라벨 삭제 후 이 경로(#915/#916 원거리 autoLock candidate)는
      // 항상 Gate 2가 motionStationary(=아직 원점에 정적 대기 중)를 확인해야 통과하는 경로라
      // "아직 미탑승" 가능성이 오히려 정상 케이스다. 탑승 확정 evidence로 뭉뚱그리지 않는다 —
      // evidence=false, initialEtaSeconds도 없으므로 `hasConsumedOriginWait`가 보수적으로 false를
      // 유지(대기 표시 유지).
      }, false).catch(() => {
        // store action rejection은 graceful — loadLock race / storage 일시 실패는 다음 sync에서 자연 재시도.
      });
    },
    [destinationId, currentStation, expectedDurationMinutes, lock, createLock, directionalArrivals, motionStationary, speedMps, allowedLines],
  );

  return {
    lock,
    lockSuggestion,
    directionalArrivals,
    boardingListArrivals,
    createLockFromTrain,
    hydrateLockFromCandidate,
    releaseLock: release,
  };
}
