/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 본 hook은 nearest-station / arrival / alarm / route 신호를
 * 조합해 환승 자동 detect를 수행한다. 본질적으로 cross-feature이라 file-level disable로 옵트인.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * #924 — route 미설정 환승 자동 detect — D1 후속 PR (production wire).
 *
 * pure 알고리즘(`transferDetect.ts`, #937 머지)을 런타임 신호와 묶어 다음을 한다:
 *   1) 다른 노선 ArrivalRow를 모아 `detectTransfer`로 입력 — current `boardingLine`은 제외해
 *      이미 타고 있는 노선이 후보로 잡히지 않게 한다.
 *   2) 단일 후보 → A1 자동 lock (`hydrateLockFromCandidate` 재사용, `useBoardingLockController`)
 *      — destination 미설정이면 lock 컨텍스트 부족으로 hydrate가 no-op이라 호출자 가드 불필요.
 *   3) 다중 후보 → 모달 상태를 노출 — 호출자가 F4 1탭 모달(#914) UI 트리거.
 *
 * 본 hook이 막는 것(no-op 조건):
 *   - 사용자가 이미 planned route의 transfer waypoint에 있다 (=`useTransferTrainList` context 활성).
 *     기존 환승 list flow가 책임지므로 자동 detect는 중복 트리거 금지.
 *   - 현재 boardingLock의 boardingLine으로만 후보가 들어와 있다 (=같은 노선 환승 데이터).
 *
 * #971 (#955 follow-up) — 후보 line의 trainCode 산출 시 destination 정차 여부로 우선순위.
 *   destination이 일반정차만 가능 → 급행/특급 통과로 lock 사고 회피. destination 미설정 시
 *   기존 동작(가장 임박) 유지.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { evaluateTransferSwap, buildAutoLockCandidate } from '../utils/transferSwap';
import { findActiveTransferContext } from '../utils/findActiveTransferContext';
import type { AutoLockCandidate } from '../../nearest-station/api/boardingLockSync';
import type { StationArrival } from '../../../shared/types/arrival';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { LineNumber, NearestStationsResult, Station } from '../../../shared/types/station';
import { normalizeStationName, type Route } from '../../../shared/utils/stationRoute';

export interface UseTransferAutoDetectInputs {
  /** 환승역 신호 + 후보 산출에 필요한 현재 fusion 결과. */
  readonly nearestStations: NearestStationsResult | null;
  /** 현재 정차 중 여부 — `false`/`undefined`(warmup)일 때만 detect 활성. */
  readonly motionStationary: boolean | undefined;
  /** 현재 origin station의 도착 데이터(useArrivalInfo 결과). 다른 노선 후보 추출 입력. */
  readonly arrival: StationArrival | null;
  /** 현재 BoardingLock. 활성이면 boardingLine과 같은 후보는 제외(자기 노선 무한 detect 회피). */
  readonly boardingLock: BoardingLock | null;
  /** planned route. 사용자가 이미 알려진 transfer waypoint면 detect skip. */
  readonly route: Route;
  /** route 도착역 이름. `findActiveTransferContext`의 입력. */
  readonly destinationName: string | null;
  /**
   * 단일 후보 detect 시 호출 — 호출자가 `useBoardingLockController.hydrateLockFromCandidate`로
   * lock 자동 hydrate. destination 미설정 / lock 활성 등으로 hydrate가 no-op이면 graceful.
   */
  readonly onAutoLock: (candidate: AutoLockCandidate) => void;
}

export interface UseTransferAutoDetectResult {
  /** detect된 다른 노선 후보(0/1/N). UI 디버깅 + 테스트 노출용. */
  readonly candidateLines: readonly LineNumber[];
  /** 다중 후보 모달이 열려 있어야 하는 상태. 호출자가 F4 모달 visible로 연결. */
  readonly modalVisible: boolean;
  /** 모달에 표시할 후보 역(=현재 환승역을 각 candidate line으로 매핑). */
  readonly modalCandidates: readonly Station[];
  /** 사용자가 모달에서 line(=station) 선택 시 호출. 해당 line으로 hydrate 후 모달 close. */
  readonly selectLine: (line: LineNumber) => void;
  /** 모달 dismiss(닫기/배경 탭). 같은 환승역에서 재오픈 방지하려면 sticky를 호출자가 결정. */
  readonly dismissModal: () => void;
}

export function useTransferAutoDetect({
  nearestStations,
  motionStationary,
  arrival,
  boardingLock,
  route,
  destinationName,
  onAutoLock,
}: UseTransferAutoDetectInputs): UseTransferAutoDetectResult {
  const currentStation = nearestStations?.primary ?? null;
  const boardingLine = boardingLock?.boardingLine ?? null;

  // planned route의 transfer waypoint면 기존 useTransferTrainList가 책임지므로 detect skip.
  const onPlannedTransfer = useMemo(
    () => findActiveTransferContext(boardingLock, route, destinationName, currentStation) !== null,
    [boardingLock, route, destinationName, currentStation],
  );

  // #1281 — FG/BG 공유 pure 결정 로직. hook은 결과를 모달/idempotency state와 묶기만 한다.
  const detection = useMemo(
    () =>
      evaluateTransferSwap({
        nearestStations,
        motionStationary,
        arrival,
        boardingLine,
        destinationName,
        onPlannedTransfer,
      }),
    [nearestStations, motionStationary, arrival, boardingLine, destinationName, onPlannedTransfer],
  );

  const candidateLines = detection.candidateLines;

  // 모달 visible은 user dismiss를 존중해야 하므로 별도 state. detect 결과만으로 derive하면
  // 같은 환승역에서 사용자가 닫아도 다음 polling에서 다시 열린다.
  const [modalVisible, setModalVisible] = useState(false);
  const dismissedAtStationRef = useRef<string | null>(null);
  const lastAutoLockedKeyRef = useRef<string | null>(null);

  // #1637 — 환승역에서 station.id는 line별로 분리(예: '합정-2' vs '합정-6')되어 있어 dismiss flag
  // 추적에 부적합. fusion이 같은 환승역의 다른 line variant를 primary로 채택하면 id 변경 →
  // dismiss reset → 모달 재오픈 무한 cycle (evidence: 2026-06-22 14:01:55 합정역 스크린샷).
  // station name(normalize)으로 추적해 line 무관하게 dismiss 보존.
  const stationKey = currentStation ? normalizeStationName(currentStation.name) : null;

  // 사용자가 환승역을 벗어나면 dismiss flag 리셋 — 다음 환승에서 다시 모달 열림 허용.
  useEffect(() => {
    if (dismissedAtStationRef.current && dismissedAtStationRef.current !== stationKey) {
      dismissedAtStationRef.current = null;
    }
    if (lastAutoLockedKeyRef.current && !stationKey) {
      lastAutoLockedKeyRef.current = null;
    }
  }, [stationKey]);

  const { candidate } = detection;

  // detect 결과 적용 — 단일 후보면 자동 lock, 다중 후보면 모달 open.
  useEffect(() => {
    if (candidateLines.length === 0 || !currentStation) {
      if (candidateLines.length === 0 && modalVisible) setModalVisible(false);
      return;
    }
    if (candidateLines.length === 1) {
      /* istanbul ignore next -- candidateLines가 detectTransfer로 산출되었으면 arrival에 해당 line의
         imminent 도착이 반드시 존재 → buildAutoLockCandidate는 항상 candidate를 반환. 방어 코드. */
      if (!candidate) return;
      // 같은 환승역 같은 trainCode는 1회만 hydrate 시도 — onAutoLock 자체도 idempotent지만
      // hydrateLockFromCandidate는 ETA 스냅샷이 없어 lock=null 가드만 의존 → 첫 hydrate가 race로
      // 늦어지는 동안 매 polling tick에서 호출되는 churn을 줄인다.
      const key = `${currentStation.id}|${candidate.trainCode}|${candidate.line}`;
      if (lastAutoLockedKeyRef.current === key) return;
      lastAutoLockedKeyRef.current = key;
      onAutoLock(candidate);
      return;
    }
    if (dismissedAtStationRef.current === stationKey) return;
    setModalVisible(true);
  }, [candidateLines, candidate, currentStation, onAutoLock, modalVisible, stationKey]);

  const modalCandidates = useMemo<Station[]>(() => {
    if (!currentStation) return [];
    // 환승역 객체는 line 별로 stations.json에 분리되어 있다. variants에서 매핑.
    return candidateLines
      .map((line) => findStationVariantByLine(nearestStations, line))
      .filter((s): s is Station => s !== null);
  }, [candidateLines, nearestStations, currentStation]);

  const selectLine = useCallback(
    (line: LineNumber) => {
      if (!currentStation) return;
      // #1637 — arrival race로 candidate=null이어도 사용자 선택 의도는 dismiss로 stamp.
      // 그렇지 않으면 buildAutoLockCandidate가 null 반환 시(같은 환승역에서 polling 사이
      // arrival 갱신 race) 모달이 즉시 닫혔다가 다음 cycle에 재오픈된다.
      setModalVisible(false);
      dismissedAtStationRef.current = stationKey;
      const candidate = buildAutoLockCandidate(line, arrival, destinationName);
      if (!candidate) return;
      const key = `${currentStation.id}|${candidate.trainCode}|${candidate.line}`;
      lastAutoLockedKeyRef.current = key;
      onAutoLock(candidate);
    },
    [currentStation, arrival, destinationName, onAutoLock, stationKey],
  );

  const dismissModal = useCallback(() => {
    setModalVisible(false);
    dismissedAtStationRef.current = stationKey;
  }, [stationKey]);

  return { candidateLines, modalVisible, modalCandidates, selectLine, dismissModal };
}

/**
 * nearestStations.variants에서 line 일치하는 station을 찾는다. 없으면 null —
 * primary로 fallback하면 잘못된 line의 station 객체가 들어가 boardingStationId가 어긋난다.
 */
function findStationVariantByLine(
  nearestStations: NearestStationsResult | null,
  line: LineNumber,
): Station | null {
  /* istanbul ignore next -- 호출자(modalCandidates)가 currentStation 존재할 때만 호출하고,
     currentStation은 nearestStations.primary에서 도출되어 nearestStations도 항상 truthy. */
  if (!nearestStations) return null;
  // variants에 없다 = stations.json에 해당 line의 동명 station이 없음. 자동 lock 후보로
  // 부적합하므로 모달 표시도 skip. primary로 fallback하면 잘못된 line의 station 객체가
  // 들어가 boardingStationId가 어긋난다.
  return nearestStations.variants.find((v) => v.line === line) ?? null;
}
