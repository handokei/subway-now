import { useEffect, useRef } from 'react';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import {
  ARRIVAL_PROXIMITY_THRESHOLD_M,
  AUTO_RELEASE_GRACE_MS,
  LEG_TRANSITION_STATIONARY_GATE_MS,
} from '../../../shared/constants/boardingLock';
import { createLogger } from '../../../shared/utils/logger';
import { getTransferLegs } from '../../../shared/utils/transferLegs';
import { logLegTransition } from '../utils/alarmLog';

const logger = createLogger('useBoardingLockAutoRelease');

export interface UseBoardingLockAutoReleaseInputs {
  /** 활성 BoardingLock. null이면 평가하지 않음. */
  lock: BoardingLock | null;
  /** 목적지 id. lock.destinationId와 비교는 store/controller가 이미 수행하므로 본 hook은 매칭 판정용. */
  destinationId: string | null;
  /** Fusion으로 결정된 현재역. */
  currentStation: Station | null;
  /** Fusion 현재역까지 거리(km). useFusedNearestStation의 result.distanceKm. */
  distanceKm: number | null;
  /** Lock 해제 액션. useBoardingLockController.releaseLock 또는 store releaseLock 위임. */
  releaseLock: () => void;
  /**
   * 활성 trip route. null이면 환승 leg 분기는 동작하지 않고 도착 분기만 평가.
   * #899 (Seam C) — 환승 leg 도달 시 lock 자동 release을 위해 추가.
   */
  route?: Route;
  /**
   * #1887 (RC-14 paradigm 4 보강) — iOS CMMotionActivity stationary 신호.
   *
   * **transfer 분기에만** 적용되는 추가 게이트. 사용자 paradigm 4 "이동속도가 빠르지 않다면 판단 후에
   * 자동 하차"의 정확 적용. 환승역 도달 + 거리/grace 조건이 충족돼도 motion stationary가
   * `LEG_TRANSITION_STATIONARY_GATE_MS`(30s) 이상 지속되어야 leg 전환 release 발화.
   *
   * 도착(destination) 분기는 본 게이트 미적용 — 도착 시점에는 사용자가 짐 정리/하차 동작으로 motion이
   * walking 변동 가능. transfer 분기는 환승 도보 전 정차 시간이 명확한 시그널이라 30s 이상 정지
   * 신호를 release 조건에 추가해 paradigm 5 "1정거장 이내 deadline" 정확성 확보.
   *
   * `undefined`(미측정) 시 기존 동작(transfer 분기 release 즉시 평가) — backward-compat.
   */
  motionStationary?: boolean | undefined;
}

/**
 * 도착 자동 release hook (#759).
 *
 * 활성 BoardingLock + 도착 신호 지속 시 lock을 자동 해제한다.
 *
 * 매칭 분기 (#899 Seam C — 환승 분기 추가):
 *  1) 목적지 도달: currentStation.id == destinationId.
 *  2) 환승 leg 도달: route의 어떤 transfer leg의 transferName/fromLine이
 *     lock.boardingLine과 일치하고 그 leg의 transferName이 currentStation.name과 일치.
 *     → 사용자가 새 leg에 탑승하는 사이 stale lock이 남는 회귀(#899) 차단.
 *
 * 트리거 조건:
 *  - lock active
 *  - 위 매칭 분기 중 하나 true
 *  - distance < ARRIVAL_PROXIMITY_THRESHOLD_M
 *  - 위 셋이 AUTO_RELEASE_GRACE_MS 이상 지속
 *
 * 동작:
 *  - 진입 시 첫 ts ref 기록.
 *  - 매 fusion update에서 (a) 조건 지속 + 경과시간 ≥ grace → releaseLock + ref 리셋.
 *    (b) 조건 미충족 → ref 리셋 (다음 진입에서 새로 카운트 시작).
 *  - lock.trainCode 변경(새 trip/leg) 시 ref 리셋 — 이전 trip의 진입 ts가 새 trip에 흘러가지 않음.
 *
 * 환승 trip의 마지막 hop도 동일 처리 — 마지막 hop은 destinationId 매칭, 그 외 hop은
 * transfer leg 매칭으로 발화한다.
 *
 * sleep mode와 무관: release는 알람 발화가 아니라 lock 라이프사이클 정리.
 *
 * useArrivalAutoClear와의 책임 분리:
 *  - useArrivalAutoClear — 도착 banner UX + setDestination(null) (UI 도착 처리)
 *  - 본 hook — lock 자동 release (라이프사이클 정리)
 *  - 임계값/grace가 다른 이유: 자동 release는 lock 해제까지 가는 강한 effect라 300m/45s로 보수적.
 *    UI banner는 500m/2s로 빠른 시각 피드백.
 */
export function useBoardingLockAutoRelease({
  lock,
  destinationId,
  currentStation,
  distanceKm,
  releaseLock,
  route = null,
  motionStationary,
}: UseBoardingLockAutoReleaseInputs): void {
  const firstArrivedAtRef = useRef<number | null>(null);
  const lastTrainCodeRef = useRef<string | null>(null);
  // #1887 (RC-14) — transfer 분기 진입 시점 ts 추적. motion stationary 30s gate에 사용.
  // arrival ts와 별도 ref인 이유: 사용자가 환승역 진입 후 motion stationary가 늦게 latch되는
  // 케이스에서 grace ms와 stationary gate ms가 독립 평가되어 각자 threshold를 채워야 fire.
  const firstStationaryAtRef = useRef<number | null>(null);

  useEffect(() => {
    const trainCode = lock?.trainCode ?? null;
    if (lastTrainCodeRef.current !== trainCode) {
      lastTrainCodeRef.current = trainCode;
      firstArrivedAtRef.current = null;
      firstStationaryAtRef.current = null;
    }

    if (!lock || !destinationId || !currentStation || distanceKm == null) {
      firstArrivedAtRef.current = null;
      firstStationaryAtRef.current = null;
      return;
    }

    const matchKind = matchReleaseTarget(
      currentStation,
      destinationId,
      route,
      lock.boardingLine,
    );
    const proximityOk = distanceKm * 1000 < ARRIVAL_PROXIMITY_THRESHOLD_M;
    if (matchKind === null || !proximityOk) {
      firstArrivedAtRef.current = null;
      firstStationaryAtRef.current = null;
      return;
    }

    const now = Date.now();
    if (firstArrivedAtRef.current === null) {
      firstArrivedAtRef.current = now;
    }

    // #1887 (RC-14) — transfer 분기 motion stationary 30s gate.
    // motionStationary가 false면 ref 리셋 — 다음 stationary=true 진입에서 새로 카운트.
    // motionStationary가 undefined(미측정)면 ref 리셋 — 게이트 미적용 분기로 폴백.
    if (matchKind === 'transfer') {
      if (motionStationary === true) {
        if (firstStationaryAtRef.current === null) firstStationaryAtRef.current = now;
      } else {
        firstStationaryAtRef.current = null;
      }
    }

    const arrivedFor = now - firstArrivedAtRef.current;
    if (arrivedFor < AUTO_RELEASE_GRACE_MS) return;

    // transfer 분기 + motion stationary 측정 시: 30s gate도 동시 충족 필요.
    // 미측정(undefined)이면 기존 동작(grace만으로 release) — backward-compat.
    if (matchKind === 'transfer' && motionStationary !== undefined) {
      const stationaryFor =
        firstStationaryAtRef.current !== null ? now - firstStationaryAtRef.current : 0;
      if (stationaryFor < LEG_TRANSITION_STATIONARY_GATE_MS) return;
    }

    firstArrivedAtRef.current = null;
    firstStationaryAtRef.current = null;
    logger.info(`${matchKind} grace 충족 → lock 자동 release`);
    releaseLock();
    // #1887 (RC-14) — leg 전환 evidence 적재. transfer 분기 release만 leg-transition으로 분류.
    // device-side self-contained evidence — push notification fire는 backend cascade(RC-13/RC-16)
    // 의존이라 본 PR 범위 외. alarmLog로 detect 시점 + 정거장 컨텍스트만 stamp.
    if (matchKind === 'transfer') {
      logLegTransition({
        fromLine: lock.boardingLine,
        transferStationName: currentStation.name,
      });
    }
  }, [lock, destinationId, currentStation, distanceKm, releaseLock, route, motionStationary]);
}

/**
 * 현재역이 release 대상인지 판정한다.
 * - 'destination': trip 최종 도착역 매칭.
 * - 'transfer': route의 transfer leg 중 boardingLine과 일치하는 leg의 환승역 매칭.
 * - null: 매칭 없음.
 *
 * 동명이역 회피: transfer 매칭은 leg.fromLine과 lock.boardingLine이 같아야 한다.
 * 같은 leg에서 destination/transfer가 동시에 매칭될 수는 없다 (destination은 id 매칭).
 */
function matchReleaseTarget(
  currentStation: Station,
  destinationId: string,
  route: Route,
  boardingLine: string,
): 'destination' | 'transfer' | null {
  if (currentStation.id === destinationId) return 'destination';
  const legs = getTransferLegs(route);
  const matched = legs.some(
    (leg) => leg.fromLine === boardingLine && leg.transferName === currentStation.name,
  );
  return matched ? 'transfer' : null;
}
