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
import { detectTransfer } from '../utils/transferDetect';
import { findActiveTransferContext } from '../utils/findActiveTransferContext';
import { isExpressStop } from '../utils/expressLookup';
import { lineToSubwayId } from '../../../shared/constants/lineApiNames';
import type { OtherLineArrival } from '../utils/transferDetect';
import type { AutoLockCandidate } from '../../nearest-station/api/boardingLockSync';
import type { ArrivalInfo, StationArrival } from '../../../shared/types/arrival';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { LineNumber, NearestStationsResult, Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';

export interface UseTransferAutoDetectInputs {
  /** 환승역 신호 + 후보 산출에 필요한 현재 fusion 결과. */
  readonly nearestStations: NearestStationsResult | null;
  /** 현재 정차 중 여부 — `false`(walking)일 때만 detect 활성. */
  readonly motionStationary: boolean;
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

  const otherLineArrivals = useMemo<OtherLineArrival[]>(
    () => collectOtherLineArrivals(arrival, boardingLine),
    [arrival, boardingLine],
  );

  // planned route의 transfer waypoint면 기존 useTransferTrainList가 책임지므로 detect skip.
  const onPlannedTransfer = useMemo(
    () => findActiveTransferContext(boardingLock, route, destinationName, currentStation) !== null,
    [boardingLock, route, destinationName, currentStation],
  );

  const detection = useMemo(() => {
    if (onPlannedTransfer) return { detected: false, candidateLines: [] as LineNumber[] };
    return detectTransfer({
      nearestStations,
      motionWalking: !motionStationary,
      otherLineArrivals,
    });
  }, [onPlannedTransfer, nearestStations, motionStationary, otherLineArrivals]);

  const candidateLines = detection.candidateLines;

  // 모달 visible은 user dismiss를 존중해야 하므로 별도 state. detect 결과만으로 derive하면
  // 같은 환승역에서 사용자가 닫아도 다음 polling에서 다시 열린다.
  const [modalVisible, setModalVisible] = useState(false);
  const dismissedAtStationRef = useRef<string | null>(null);
  const lastAutoLockedKeyRef = useRef<string | null>(null);

  const stationKey = currentStation?.id ?? null;

  // 사용자가 환승역을 벗어나면 dismiss flag 리셋 — 다음 환승에서 다시 모달 열림 허용.
  useEffect(() => {
    if (dismissedAtStationRef.current && dismissedAtStationRef.current !== stationKey) {
      dismissedAtStationRef.current = null;
    }
    if (lastAutoLockedKeyRef.current && !stationKey) {
      lastAutoLockedKeyRef.current = null;
    }
  }, [stationKey]);

  // detect 결과 적용 — 단일 후보면 자동 lock, 다중 후보면 모달 open.
  useEffect(() => {
    if (!detection.detected || candidateLines.length === 0 || !currentStation) {
      if (candidateLines.length === 0 && modalVisible) setModalVisible(false);
      return;
    }
    if (candidateLines.length === 1) {
      const [line] = candidateLines;
      const candidate = buildAutoLockCandidate(line, arrival, destinationName);
      /* istanbul ignore next -- candidateLines가 detectTransfer로 산출되었으면 arrival에 해당 line의
         imminent 도착이 반드시 존재 → pickImminentTrainCode는 항상 trainCode를 반환. 방어 코드. */
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
  }, [detection.detected, candidateLines, currentStation, arrival, destinationName, onAutoLock, modalVisible, stationKey]);

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
      const candidate = buildAutoLockCandidate(line, arrival, destinationName);
      if (!candidate) return;
      const key = `${currentStation.id}|${candidate.trainCode}|${candidate.line}`;
      lastAutoLockedKeyRef.current = key;
      onAutoLock(candidate);
      setModalVisible(false);
      dismissedAtStationRef.current = stationKey;
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
 * arrival.up / down을 평탄화한 뒤 `boardingLine`을 제외하고 OtherLineArrival 배열로 변환.
 * 같은 line의 up/down이 모두 있어도 detectTransfer가 dedup하므로 추가 처리 불필요.
 */
function collectOtherLineArrivals(
  arrival: StationArrival | null,
  boardingLine: LineNumber | null,
): OtherLineArrival[] {
  if (!arrival) return [];
  const all: ArrivalInfo[] = [...arrival.up, ...arrival.down];
  const out: OtherLineArrival[] = [];
  for (const t of all) {
    if (boardingLine !== null && t.line === boardingLine) continue;
    out.push({ line: t.line, arrivalSeconds: t.arrivalSeconds, arrivalCode: t.arrivalCode });
  }
  return out;
}

/**
 * candidate line의 첫(=가장 임박) trainCode를 사용해 AutoLockCandidate 구성.
 * subwayId 매핑 누락 시 null — 호출자가 hydrate skip(이미 line valid 가드 있음).
 *
 * #971: destinationName이 주어지면 trainType이 destination에 정차하는 후보를 우선 선택.
 * 일반정차역만 가능한 destination에서 급행/특급이 통과하는 lock 사고를 회피한다.
 */
function buildAutoLockCandidate(
  line: LineNumber,
  arrival: StationArrival | null,
  destinationName: string | null,
): AutoLockCandidate | null {
  const subwayId = lineToSubwayId(line);
  /* istanbul ignore next -- 모든 LineNumber는 LINE_TO_SUBWAY_ID에 등록되어 있어 null 분기는
     valid LineNumber 입력 하에서 도달 불가. 타입 보강용 방어. */
  if (!subwayId) return null;
  const trainCode = pickImminentTrainCode(arrival, line, destinationName);
  if (!trainCode) return null;
  return { trainCode, line, subwayId };
}

/**
 * 같은 line의 후보 중 가장 임박한 trainCode 반환.
 *
 * #971: destinationName이 있으면 destination 정차 가능한 trainType을 1차 후보군으로,
 * 그 군이 비면 전체에서 fallback. destinationName=null은 기존 동작(전체에서 imminent).
 *
 * `isExpressStop`은 normal에 대해 항상 true, 데이터 미보유 line/type에 대해 보수적으로 true →
 * 미지의 노선/타입을 사용자에게 무리하게 막지 않는다. 일반정차역 only인 destination에서
 * 정확한 express 정차역 데이터가 있는 경우(예: 1·9호선 급행)에만 express 후보를 제외한다.
 */
function pickImminentTrainCode(
  arrival: StationArrival | null,
  line: LineNumber,
  destinationName: string | null,
): string | null {
  if (!arrival) return null;
  const all: ArrivalInfo[] = [...arrival.up, ...arrival.down];
  let preferred: ArrivalInfo | null = null;
  let fallback: ArrivalInfo | null = null;
  for (const t of all) {
    if (t.line !== line) continue;
    /* istanbul ignore next -- detectTransfer는 음수 arrivalSeconds를 후보에서 제외한 뒤 line을
       반환하므로, 그 line의 음수 train이 있더라도 양수 train이 이미 적어도 하나 존재. 양수만
       best로 선택되어 음수 분기는 도달하지 않는다. 방어 코드. */
    if (t.arrivalSeconds < 0) continue;
    if (!fallback || t.arrivalSeconds < fallback.arrivalSeconds) fallback = t;
    // destination 미설정 → 모든 후보가 preferred와 동등 → fallback만으로 판정.
    if (destinationName === null) continue;
    if (!isExpressStop(destinationName, line, t.trainType)) continue;
    if (!preferred || t.arrivalSeconds < preferred.arrivalSeconds) preferred = t;
  }
  return (preferred ?? fallback)?.trainCode ?? null;
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
