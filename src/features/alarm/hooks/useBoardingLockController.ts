/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useBoardingLockStore } from '../store/useBoardingLockStore';
import { resolveTripDirection } from '../../route/utils/tripDirection';
import { findStationByNameAndLine } from '../../../shared/utils/stationLookup';
import { allowedLinesFromRoute } from '../../../shared/utils/stationRoute';
import { STATIC_SPEED_THRESHOLD_MPS } from '../../nearest-station/utils/movementGate';
import type { ArrivalInfo, StationArrival } from '../../../shared/types/arrival';
import type { Route } from '../../../shared/utils/stationRoute';
import type { LineNumber, Station } from '../../../shared/types/station';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import {
  FALLBACK_BOARDING_DURATION_MINUTES,
  FREE_TRIP_DESTINATION_SENTINEL,
} from '../../../shared/constants/boardingLock';
import type { AutoLockCandidate } from '../../nearest-station/api/boardingLockSync';
import { useLockSuggestion } from '../api/useLockSuggestion';
import type { LockSuggestionMirror } from '../utils/backendSsotMirror';
import { pickAutoTrainCodeFromArrivals } from '../utils/boardingPromptAutoLock';
import { logBoardingPromptAutoLock } from '../utils/alarmLog';
import { ARRIVAL_CODE } from '../../../shared/constants/arrivalCodes';

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
   * #915/#916 — backend `/boarding-lock/sync` 응답의 autoLockCandidate로 lock을 hydrate.
   * destination-only baseline UX에서 사용자가 명시 탭하지 않아도 backend cron이 trainCode를
   * 결정하면 client store에 반영해 lock UX 활성화한다.
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
 */
const VALID_LINES: ReadonlyArray<LineNumber> = [
  '1', '2', '3', '4', '5', '6', '7', '8', '9', 'airport', 'gyeongui', 'bundang', 'sinbundang',
];
function asLineNumber(raw: string): LineNumber | null {
  return (VALID_LINES as ReadonlyArray<string>).includes(raw) ? (raw as LineNumber) : null;
}

/**
 * 도착 list 필터 술어 — #897 (Seam A). arrivalSeconds 음수(이미 지나간 열차)만 제외하고 임박(0초)은
 * 유지한다. 0초 행이 useArrivalCountdown tick으로 사라지면 사용자가 다음 차를 같은 차로 오인하는 회귀가
 * 있어 음수만 차단. 음수 train은 createLockFromTrain에서도 의미가 없어 #666 가드를 갈음한다.
 * directionalArrivals / boardingListArrivals 두 파생값이 같은 정책을 공유하는 SSOT.
 */
const isReachable = (train: ArrivalInfo): boolean => train.arrivalSeconds >= 0;

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
  useEffect(() => {
    if (!lockSuggestion) return;
    if (lock) return;
    const boardingLine = asLineNumber(lockSuggestion.lineId);
    if (!boardingLine) return;
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
    }).catch(() => {
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
      });
    },
    [destinationId, currentStation, expectedDurationMinutes, createLock, allowedLines],
  );

  const release = useCallback(() => {
    void releaseLock();
  }, [releaseLock]);

  // #915/#916 — backend autoLockCandidate를 받아 client BoardingLock store hydrate.
  // hydrate 정책: lock이 이미 존재하면 항상 no-op.
  //  - 사용자가 BoardingTrainList에서 명시 탭한 lock을 backend cron candidate(다른 trainCode 가능)가
  //    silently overwrite하지 않게 보호 (#915 self code-review).
  //  - destination 변경 시 controller의 stale-lock release effect가 lock=null로 만든 후에야 hydrate.
  //  - 자동 lock도 한 번 잡히면 변경 X (Seam F swap은 backend cron이 trip.boardingLock을 갱신하고
  //    silent push로 client store가 hydrate되는 별 경로).
  // #1014 RC2 acceptance gate — 두 조건 모두 통과해야 hydrate:
  //  1) candidate.trainCode가 directionalArrivals(현재 역 + 방향 필터)에 있는지 확인
  //     → origin을 이미 지난 열차(arrival list 없음)는 자동 차단.
  //     → 방향 불일치 열차도 동시에 차단 (directionalArrivals가 direction 필터 적용됨).
  //  2) 사용자가 origin에서 정적 대기 중인지 확인 — motionStationary 우선, speedMps fallback.
  //     → 이미 열차에 탑승해 이동 중인 상태에서 backend가 autoLockCandidate를 지연 응답하는
  //        false positive를 차단.
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
      // W1 (#1271, Epic #1204 그룹 2): backend가 `from:'transfer-swap'` hint를 첨부했으면
      // Gate 2를 우회한다. swap hint는 backend가 (기존 lock + 새 trainCode + trainCode 변경)
      // 3 조건을 모두 통과한 신뢰 evidence — 사용자가 이미 이동 중(새 leg 탑승)인 게 정상이라
      // motion 차단을 적용하면 환승 lock 회복이 영구 차단된다(피드백 7, 22:53 transfer skip).
      // Gate 1(directionalArrivals 매칭)은 유지해 false positive 방어.
      // ADR-014 첫 줄: lock 활성/lockless 동급 정확도 보장.
      if (candidate.from === 'transfer-swap') {
        // transfer swap evidence 신뢰 → Gate 2 우회
      } else if (motionStationary === true) {
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
      }).catch(() => {
        // store action rejection은 graceful — loadLock race / storage 일시 실패는 다음 sync에서 자연 재시도.
      });
    },
    [destinationId, currentStation, expectedDurationMinutes, lock, createLock, directionalArrivals, motionStationary, speedMps, allowedLines],
  );

  // #1640 — Origin leg device-side auto-lock.
  //
  // 환승 leg는 `useTransferTrainList.ts:152-161`에서 이미 device-side로 arvlCd 우선순위 자동 lock을
  // 시도한다. 하지만 origin leg(첫 lock 부재 상태)는 backend boardingPrompt push → useBoardingPromptResponder
  // 응답 chain에 100% 종속이라, backend 9-AND gate fail(지하/lockless 환경)이면 device가 자체로 lock 시도조차
  // 못 했다 — 7일 누적 push 0건 / autoLock 0건 / lockless 알림 0건 회귀의 root cause.
  //
  // 본 effect는 origin leg에서 동일 device-side trigger를 복원한다. 정책은 `useTransferTrainList` D5
  // (#1211)와 같은 패턴:
  //   - lock 부재 + arrival 가용 + currentStation 확정 시
  //   - `pickAutoTrainCodeFromArrivals(directionalArrivals)` 단일 후보 산출 가능 시
  //   - allowedLines 검증 통과 시
  //   - createLock 즉시 호출 (사용자 액션 0)
  // ambiguity / empty 시 skip → 자연스럽게 BoardingTrainList (HomeScreen.tsx:1099 분기) fallback UX로 도달.
  //
  // backend push 응답 chain(C 경로)은 그대로 유지 — 본 effect가 먼저 성공하면 store lock 활성으로
  // 뒤늦은 backend push 응답의 createLock도 `if (lock) return` idempotent로 자연 skip.
  //
  // 정합성 가드:
  //   1) `lock != null` → skip (사용자 명시 탭/lockSuggestion/hydrateLockFromCandidate 우선 보호).
  //   2) `!currentStation || !route` → skip (lock 컨텍스트 부재).
  //   3) `directionalArrivals.length === 0` → skip (다음 polling cycle 재시도).
  //   4) `pickAutoTrainCodeFromArrivals` ambiguity/empty → skip + idempotency ref 미설정 (다음 cycle 재시도).
  //   5) **arvlCd 강 evidence 요구** — 선정된 train의 arvlCd가 ENTERING(0) / ARRIVED(1) / DEPARTED(2) 중
  //      하나여야 자동 lock 진행. `pickAutoTrainCodeFromArrivals`의 마지막 fallback(arrivals[0] 첫 후보)은
  //      device-side origin auto-lock에서 거부 — backend push 응답 path는 "사용자가 boarded 응답" 신호로
  //      그 후보를 신뢰하지만, device-side trigger는 사용자 신호 없이 발사하므로 강 evidence가 필수.
  //      false positive(엉뚱한 열차 lock) ≤ ambiguity 차단 (CLAUDE.md 룰 + ADR-014 첫 줄).
  //   6) `allowedLines` 검증 — trip route 외 line train 자동 lock 차단 (환승역 fusion 오류 보호).
  //   7) Idempotency: 같은 `${destinationId}|${currentStation.id}` 조합에서 최대 1회 lock 시도. 사용자가
  //      release 후 같은 origin에서 다시 lock 시도하려면 effect의 success 분기에서 ref가 set되므로
  //      자연 차단. trip 전환(destination 변경)으로 stale lock release되면 새 key → 자동 재시도 허용.
  //
  // CLAUDE.md 룰 정렬:
  //   - lockless 토글 OFF도 자동 lock 진행 (정보용 라벨, ADR-014 "사용자 명시 의향 trip 동급" 룰).
  //   - GPS 결정 권한 X — 본 effect는 arrival API + arvlCd 우선순위만 사용.
  //   - 시간 적분 fire 권한 X — fire가 아니라 lock 부착만.
  const lastOriginAutoLockKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (lock) return;
    if (!route) return;
    if (!currentStation) return;
    if (directionalArrivals.length === 0) return;
    const originKey = `${destinationId ?? FREE_TRIP_DESTINATION_SENTINEL}|${currentStation.id}`;
    if (lastOriginAutoLockKeyRef.current === originKey) return;
    const chosen = pickAutoTrainCodeFromArrivals(directionalArrivals);
    if (!chosen) return;
    // 강 evidence 게이트: arvlCd가 ENTERING/ARRIVED/DEPARTED 중 하나일 때만 진행.
    // `pickAutoTrainCodeFromArrivals`는 receivedAt 정렬 첫 후보로 fallback하지만, 본 effect는
    // 사용자 신호 없이 device-side 자체 발사이므로 fallback path를 거부한다 (false positive 차단).
    if (
      chosen.arrivalCode !== ARRIVAL_CODE.ENTERING &&
      chosen.arrivalCode !== ARRIVAL_CODE.ARRIVED &&
      chosen.arrivalCode !== ARRIVAL_CODE.DEPARTED
    ) {
      return;
    }
    // allowedLines 검증 — useBoardingPromptResponder.tryAutoLock과 createLockFromTrain의 정책을 그대로 반영.
    if (allowedLines && !allowedLines.has(chosen.line)) return;
    // idempotency ref는 시도 직전에 set — store action이 race/storage 실패해도 다음 cycle 재시도하지 않도록.
    // graceful 실패는 ref reset 없이 그대로 두고, 사용자 release 시 자연 재진입(다른 key로) 시점에 재시도된다.
    lastOriginAutoLockKeyRef.current = originKey;
    const durationMin = expectedDurationMinutes ?? FALLBACK_BOARDING_DURATION_MINUTES;
    const correctedStation = findStationByNameAndLine(currentStation.name, chosen.line);
    const boardingStationId = correctedStation?.id ?? currentStation.id;
    const isSentinel = !destinationId;
    const effectiveDestinationId = destinationId ?? FREE_TRIP_DESTINATION_SENTINEL;
    const now = Date.now();
    createLock({
      destinationId: effectiveDestinationId,
      trainCode: chosen.trainCode,
      boardingStationId,
      boardingLine: chosen.line,
      boardedAt: now,
      expectedDurationMs: durationMin * 60_000,
      // #897 Seam A: 자동 lock도 탑승 시점 ETA 스냅샷 보존 — origin leg device-side 채택은 사용자 명시 탭과
      // 동급으로 신뢰(arvlCd 우선순위 단일 후보 + arrival API 가용)하므로 지연 칩이 backend SSoT hydrate와
      // 다르게 활성화돼야 자연스럽다.
      initialEtaSeconds: chosen.arrivalSeconds,
      ...(isSentinel
        ? {
            hydratedFromSentinel: {
              destinationId: FREE_TRIP_DESTINATION_SENTINEL,
              sentinelAt: now,
            },
          }
        : {}),
    })
      .then(() => {
        // V/X 측정 — `source='boarding-prompt'` 재사용해 DebugModal/autoLock outcome 분포에서 한 화면에서 가시화.
        // backend push 응답 path(useBoardingPromptResponder)와 같은 reason 라벨을 쓰되, alarm log entry에는
        // stationName=`${line}·${originStation}` 포맷으로 stamped — countBoardingPromptAutoLockOutcomes 결과에
        // 가산되어 1주 production 측정에서 device-side origin 시도 가시화.
        logBoardingPromptAutoLock({
          reason: 'autolock-success',
          originStation: currentStation.name,
          line: chosen.line,
        });
      })
      .catch(() => {
        // store action rejection은 graceful — 이미 ref가 set돼 있어 즉시 재시도 폭주는 차단.
        // 사용자 명시 탭 / backend push 응답 path가 fallback으로 남아 있다.
        logBoardingPromptAutoLock({
          reason: 'autolock-lock-failed',
          originStation: currentStation.name,
          line: chosen.line,
        });
      });
  }, [
    lock,
    route,
    currentStation,
    directionalArrivals,
    destinationId,
    expectedDurationMinutes,
    allowedLines,
    createLock,
  ]);

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
