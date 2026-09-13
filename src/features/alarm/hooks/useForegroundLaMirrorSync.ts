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
 * `useBackendSsotMirrorPoll`(5s 간격, freshness ≤180s 판정 내장)이 반환하는 mirror가 가리키는
 * station으로 전진할 때만 Live Activity를 갱신한다. station 결정(`resolveBackendSsotMirrorStation`)과
 * 갱신 코어(`updateLiveActivityFromMirrorStation` — update-only 가드 → buildLiveActivityData →
 * updateLiveActivity)는 BG LA refresh와 동일 함수를 공유 — 판정/동작 drift 없음.
 *
 * additive — destination 없거나 mirror가 없거나(부재/stale/거부) 활성 LA가 없으면 아무 것도 하지
 * 않는다(update-only 가드는 공유 함수 내부).
 */
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import type { LineNumber, Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import { createLogger } from '../../../shared/utils/logger';
import { useBackendSsotMirrorPoll } from './useBackendSsotMirrorPoll';
import { resolveBackendSsotMirrorStation } from '../utils/backendSsotMirror';
import { updateLiveActivityFromMirrorStation } from '../utils/liveActivityMirrorSync';

const logger = createLogger('useForegroundLaMirrorSync');

export function useForegroundLaMirrorSync(
  destination: Station | null,
  route: Route,
  lockLine?: LineNumber,
): void {
  const mirror = useBackendSsotMirrorPoll();
  // 직전에 LA에 적용한 mirror station id — 동일 역 재수신 시 중복 updateLiveActivity 호출 방지.
  const lastAppliedStationIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    if (!destination) {
      lastAppliedStationIdRef.current = null;
      return;
    }
    if (!mirror) return;

    const mirrorStation = resolveBackendSsotMirrorStation(mirror, lockLine);
    if (!mirrorStation) return;
    if (lastAppliedStationIdRef.current === mirrorStation.id) return;

    lastAppliedStationIdRef.current = mirrorStation.id;
    void updateLiveActivityFromMirrorStation(mirrorStation, destination, route).catch((e) => {
      logger.warn('FG mirror LA sync 실패', e);
    });
  }, [mirror, destination, route, lockLine]);
}
