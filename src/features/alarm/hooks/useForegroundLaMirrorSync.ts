/**
 * #2610 (b) — LA refresh를 FG mirror 폴링(`useBackendSsotMirrorPoll`, #2606)에 wire.
 *
 * 배경: `refreshLiveActivityFromBackgroundContext`(#2589, LA=mirror 1순위)는 silentPushTask(BG
 * task) 수신 시에만 실행되는데, FG 상태로 진행된 trip에서는 silent push 수신이 0건인 경우가
 * 있다(#2610 RCA 1번 — 원인 규명은 이 PR 범위 밖). 결과적으로 그 경로가 FG에서 한 번도 돌지 않아
 * LA가 backend advance를 따라가지 못하고 정체한다. mirror 자체는 이미 /position 폴링으로 최신 상태를
 * 유지하므로(estimator backend-ssot-override), silent push라는 단일 배달 채널에 기대지 않고 FG에서도
 * mirror를 직접 폴링해 "backend가 갱신 중" 신호로 삼아 LA를 갱신 트리거한다.
 *
 * #2790 — LA에 쓰는 station은 더 이상 mirror가 resolve한 raw station이 아니라, **in-app이 채택한
 * 현재역(`useFusedNearestStation().result.station`, caller가 `currentStation`으로 전달)**을
 * 그대로 따른다. 이전에는 `resolveBackendSsotMirrorStation`으로 mirror를 독립 재해석해 LA에 실었는데,
 * FG cascade(`useFusedNearestStation`)가 같은 mirror를 거부하고 GPS를 채택하는 경우(예: 중곡 mirror
 * vs 용마산 GPS) LA의 station과 `route`(앱이 채택한 현재역 기준)가 서로 다른 소스가 되어 자기모순
 * 문구(예: "중곡 → 뚝섬 / 6정거장 남음"인데 6은 용마산 기준)가 발생했다. LA가 `currentStation`을
 * `route`와 동일 앵커로 받으면 LA == in-app이 구성적으로 보장된다 — mirror 재해석을 제거했으므로
 * cross-line 가드(`evaluateBackendSsotCrossLineGuard`)도 함께 제거한다(currentStation은 이미 그
 * cascade의 가드를 통과한 값이라 재판정이 불필요).
 *
 * mirror 폴링은 여전히 "backend가 갱신 중 → LA refresh를 시도해볼 시점" 트리거로만 남는다(mirror가
 * 없으면 backend가 아직 advance를 보고하지 않은 상태이므로 보수적으로 미갱신).
 *
 * 갱신 코어(`updateLiveActivityFromMirrorStation` — dismiss sentinel/backend-authority/GPS
 * arbitration 가드 → update-only 가드 → buildLiveActivityData → updateLiveActivity)는 BG LA
 * refresh와 동일 함수를 공유 — 판정/동작 drift 없음.
 *
 * #2610 (code review 4번) — dedup ref는 `updateLiveActivityFromMirrorStation`이 실제로
 * `updateLiveActivity`를 호출(applied===true)했을 때만 기록한다. 가드에 걸려 no-op한 tick은 ref를
 * 건드리지 않아, 다음 mirror 갱신에서 같은 station이어도 재시도된다(예: arbitration 창이 지난 뒤).
 *
 * #2610 (code review 5/6번) — `useBackendSsotMirrorPoll`은 destination이 있고 iOS일 때만
 * enable(idle/Android 폴링 제거). dedup 키는 destination.id + route 시그니처 + currentStation.id로
 * 구성해 destination/route/currentStation 전환 시 재적용되도록 한다(예: 경로 재계산으로 목적지까지
 * 남은 정거장 문구가 바뀌는 경우).
 *
 * additive — destination/currentStation이 없거나 mirror가 없거나(부재/stale) 활성 LA가 없으면
 * 아무 것도 하지 않는다(update-only 가드는 공유 함수 내부).
 */
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import type { Station } from '../../../shared/types/station';
import { routeSignature, type Route } from '../../../shared/utils/stationRoute';
import { createLogger } from '../../../shared/utils/logger';
import { useBackendSsotMirrorPoll } from './useBackendSsotMirrorPoll';
import { updateLiveActivityFromMirrorStation } from '../utils/liveActivityMirrorSync';

const logger = createLogger('useForegroundLaMirrorSync');

export function useForegroundLaMirrorSync(
  destination: Station | null,
  route: Route,
  currentStation: Station | null,
): void {
  const isIos = Platform.OS === 'ios';
  const mirror = useBackendSsotMirrorPoll(isIos && destination !== null);
  // 직전에 LA에 성공 적용한 (destination, route, currentStation) 키 — 동일 조합 재수신 시 중복
  // updateLiveActivity 호출 방지. 실패/가드-거부 tick은 이 ref를 갱신하지 않아 다음 tick 재시도.
  const lastAppliedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isIos) return;
    if (!destination || !currentStation) {
      lastAppliedKeyRef.current = null;
      return;
    }
    // mirror는 station 소스가 아니라 "backend가 갱신 중" 트리거로만 쓴다(#2790). mirror가 없으면
    // backend가 아직 advance를 보고하지 않은 상태이므로 보수적으로 미갱신.
    if (!mirror) return;

    const dedupKey = `${destination.id}:${routeSignature(route)}:${currentStation.id}`;
    if (lastAppliedKeyRef.current === dedupKey) return;

    let cancelled = false;
    updateLiveActivityFromMirrorStation(currentStation, destination, route)
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
  }, [isIos, mirror, destination, route, currentStation]);
}
