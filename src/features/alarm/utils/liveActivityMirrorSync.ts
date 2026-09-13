/**
 * #2610 (b) — mirror-sourced Live Activity 갱신 코어. 순수 추출.
 *
 * `refreshLiveActivityFromBackgroundContext`(BG silent push 경로, #2589)가 backend SSoT mirror로
 * currentStation을 결정한 뒤 실행하던 4단계(mirror station 결정 → hasActiveLiveActivity 가드 →
 * buildLiveActivityData → updateLiveActivity) 중 뒤 3단계를 이 파일로 추출한다. mirror station 결정
 * 자체는 이미 `resolveBackendSsotMirrorStation`(backendSsotMirror.ts)이 FG cascade picker와 BG LA
 * refresh 양쪽의 공유 진입점이라 그대로 caller가 호출한다 — 이 함수는 "이미 결정된 mirror station"을
 * 입력으로 받는다.
 *
 * #2610 — FG(`useForegroundLaMirrorSync`, silent push와 독립적인 `useBackendSsotMirrorPoll` 폴링
 * 경로)도 동일 함수를 호출해, silent push가 FG에서 0건이어도(#2610 RCA 1번, 이 PR 범위 밖) LA가
 * backend mirror를 따라 전진한다.
 *
 * 동작 100% 보존(#2589/#2605/#2608 반영분과 동일):
 *   - update-only 가드 — 활성 LA가 없으면 no-op. native `update()`가 내부적으로 `start()`로
 *     fall-through해 사용자가 본 적 없는 새 LA를 생성하는 위험을 차단(#2589 code review 3번).
 *   - backend mirror는 GPS distance를 싣지 않는다 — backend가 이미 "이 역에 있다"고 advance
 *     확정한 상태이므로 0m(도착)로 표시한다.
 */
import * as LiveActivity from 'live-activity';
import type { Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import { createLogger } from '../../../shared/utils/logger';
import { buildLiveActivityData } from './stationNotification';

const logger = createLogger('LiveActivityMirrorSync');

/**
 * mirror가 resolve한 station으로 Live Activity를 갱신한다. 활성 LA가 없으면 no-op.
 *
 * BG 컨텍스트와 동일하게 ETA/alarm은 계산하지 않는다 — silent push/backend push가 알람을 별도로
 * 발사하고, ETA는 backend LA push가 권위. 이 함수는 station/route 변동만 빠르게 반영한다.
 */
export async function updateLiveActivityFromMirrorStation(
  mirrorStation: Station,
  destination: Station,
  route: Route,
): Promise<void> {
  if (!LiveActivity.hasActiveLiveActivity()) {
    logger.info(
      `la-refresh source=backend-ssot but no active LA — skip (update-only, no create): ${mirrorStation.name}`,
    );
    return;
  }
  const data = buildLiveActivityData(mirrorStation, 0, destination, route, null, false, null);
  await LiveActivity.updateLiveActivity(data);
  logger.info(`la-refresh source=backend-ssot: ${mirrorStation.name} → ${destination.name}`);
}
