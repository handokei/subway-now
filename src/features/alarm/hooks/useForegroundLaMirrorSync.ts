/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: mirror-sourced LA sync는 route 슬라이스의 cross-line 가드
 * (`evaluateBackendSsotCrossLineGuard`, approachLine.ts)를 `useFusedNearestStation`/
 * `useTransferTrainList`와 동일하게 소비해야 판정 drift가 없다. 그 두 orchestrator와 동일하게
 * file-level disable로 옵트인 처리.
 */
/**
 * #2610 (b) — LA refresh를 FG mirror 폴링(`useBackendSsotMirrorPoll`, #2606)에 wire.
 *
 * 배경: `refreshLiveActivityFromBackgroundContext`(#2589, LA=mirror 1순위)는 silentPushTask(BG
 * task) 수신 시에만 실행되는데, FG 상태로 진행된 trip에서는 silent push 수신이 0건인 경우가
 * 있다(#2610 RCA 1번 — 원인 규명은 이 PR 범위 밖). 결과적으로 그 경로가 FG에서 한 번도 돌지 않아
 * LA가 backend advance를 따라가지 못하고 정체한다. mirror 자체는 이미 /position 폴링으로 최신 상태를
 * 유지하므로(estimator backend-ssot-override), silent push라는 단일 배달 채널에 기대지 않고 FG에서도
 * mirror를 직접 폴링해 LA를 갱신하면 이 경로와 완전히 독립적으로 acceptance(#2596)를 만족한다.
 *
 * station 결정(`resolveBackendSsotMirrorStation`)과 갱신 코어(`updateLiveActivityFromMirrorStation`
 * — dismiss sentinel/backend-authority/GPS arbitration 가드 → update-only 가드 →
 * buildLiveActivityData → updateLiveActivity)는 BG LA refresh와 동일 함수를 공유 — 판정/동작 drift
 * 없음.
 *
 * #2610 (code review 3번) — cross-line 가드(`evaluateBackendSsotCrossLineGuard`)를 다른 두 mirror
 * 소비자(`useFusedNearestStation`/`useTransferTrainList`)와 동일하게 적용한다. lockLine을
 * `resolveBackendSsotMirrorStation`에 강제해도(성수 7호선 클래스 방어) boardingLock이 없는 구간에서는
 * name-only/currentStationLine fallback이 남아있어, legAdvanceLine 확정값과 어긋나는 station을 한 번
 * 더 거른다. `positionTrainResult`는 이 훅에 배선하지 않는다 — `useTransferTrainList`와 동일하게 GPS를
 * 판정 근거로 쓰지 않는 orchestrator라 항상 null을 넘기고, 그 단계는 자연히 no-op(guard 함수 자체가
 * 그 경우 통과시키도록 설계됨). 가드가 거부하면 보수적으로 미갱신(no-op) — 다음 tick(mirror 갱신) 재시도.
 *
 * #2610 (code review 4번) — dedup ref는 `updateLiveActivityFromMirrorStation`이 실제로
 * `updateLiveActivity`를 호출(applied===true)했을 때만 기록한다. 가드에 걸려 no-op한 tick은 ref를
 * 건드리지 않아, 다음 mirror 갱신에서 같은 station이어도 재시도된다(예: arbitration 창이 지난 뒤).
 *
 * #2610 (code review 5/6번) — `useBackendSsotMirrorPoll`은 destination이 있고 iOS일 때만
 * enable(idle/Android 폴링 제거). dedup 키는 destination.id + route 시그니처 + mirrorStation.id로
 * 구성해 destination/route 전환 시 같은 station이어도 재적용되도록 한다(예: 경로 재계산으로 목적지까지
 * 남은 정거장 문구가 바뀌는 경우).
 *
 * additive — destination 없거나 mirror가 없거나(부재/stale/거부/cross-line 거부) 활성 LA가 없으면
 * 아무 것도 하지 않는다(update-only 가드는 공유 함수 내부).
 */
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { LineNumber, Station } from '../../../shared/types/station';
import { routeSignature, type Route } from '../../../shared/utils/stationRoute';
import { createLogger } from '../../../shared/utils/logger';
import { evaluateBackendSsotCrossLineGuard } from '../../route/utils/approachLine';
import { useBackendSsotMirrorPoll } from './useBackendSsotMirrorPoll';
import { resolveBackendSsotMirrorStation } from '../utils/backendSsotMirror';
import { updateLiveActivityFromMirrorStation } from '../utils/liveActivityMirrorSync';

const logger = createLogger('useForegroundLaMirrorSync');

export function useForegroundLaMirrorSync(
  destination: Station | null,
  route: Route,
  boardingLock: BoardingLock | null,
  legAdvanceLine: LineNumber | null,
): void {
  const isIos = Platform.OS === 'ios';
  const mirror = useBackendSsotMirrorPoll(isIos && destination !== null);
  // 직전에 LA에 성공 적용한 (destination, route, mirror station) 키 — 동일 조합 재수신 시 중복
  // updateLiveActivity 호출 방지. 실패/가드-거부 tick은 이 ref를 갱신하지 않아 다음 tick 재시도.
  const lastAppliedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isIos) return;
    if (!destination) {
      lastAppliedKeyRef.current = null;
      return;
    }
    if (!mirror) return;

    const lockLine = boardingLock ? boardingLock.boardingLine : undefined;
    const mirrorStation = resolveBackendSsotMirrorStation(mirror, lockLine);
    if (!mirrorStation) return;

    // #2610 (code review 3번) — cross-line 가드. positionTrainResult는 배선하지 않음(GPS 미소비
    // orchestrator 컨벤션, useTransferTrainList와 동일).
    if (
      evaluateBackendSsotCrossLineGuard(mirrorStation.line, null, boardingLock, legAdvanceLine)
    ) {
      logger.info(
        `mirror station ${mirrorStation.name} cross-line 거부 — 보수적 미갱신 (legAdvanceLine=${String(legAdvanceLine)})`,
      );
      return;
    }

    const dedupKey = `${destination.id}:${routeSignature(route)}:${mirrorStation.id}`;
    if (lastAppliedKeyRef.current === dedupKey) return;

    let cancelled = false;
    updateLiveActivityFromMirrorStation(mirrorStation, destination, route)
      .then((applied) => {
        if (cancelled) return;
        if (applied) {
          lastAppliedKeyRef.current = dedupKey;
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        logger.warn('FG mirror LA sync 실패', e);
      });
    return () => {
      cancelled = true;
    };
  }, [isIos, mirror, destination, route, boardingLock, legAdvanceLine]);
}
