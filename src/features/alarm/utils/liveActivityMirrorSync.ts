/**
 * #2610 (b) — mirror-sourced Live Activity 갱신 코어. 순수 추출 + 공유 가드 3종.
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
 * #2610 (code review) — 이 함수를 "mirror 소비자 공용 코어"로 삼아 3개 가드를 여기 배치, 향후
 * 소비자도 자동 적용받는다:
 *   1. LA dismiss sentinel(#926) — 사용자가 방금 LA를 dismiss했으면 mirror 갱신도 부활시키지 않는다
 *      (BG 경로와 대칭 — `refreshLiveActivityFromBackgroundContext`도 동일 sentinel을 본다).
 *   2. `shouldSkipDeviceLiveActivityWrite`(#2481) — backend-authority 모드에서 이미 backend가 이
 *      trip의 LA push 채널을 쥐고 있으면 device 쓰기를 스킵.
 *   3. GPS writer recency arbitration(`liveActivityGpsWriteArbitration.ts`) — mirror 경로는
 *      ETA/alarmEvent를 계산하지 않아 항상 null로 넘기므로, GPS writer(`updateStationNotification`)가
 *      최근에 쓴 ETA/알람 배지를 blank로 덮어쓰지 않도록 최근 GPS 쓰기가 있으면 이번 tick을 양보한다.
 *
 * BG 경로(`refreshLiveActivityFromBackgroundContext`)는 이미 자신의 호출부에서 1/2번을 별도로
 * 판정하므로(gps-bg 분기도 같은 가드를 받아야 하기 때문), 여기서 다시 판정해도 같은 storage 상태를
 * 보는 한 결과는 동일 — 중복이지만 회귀 없음(#2589/#2605/#2608 반영분 그대로, 기존 30개 테스트
 * 무수정 green으로 증명).
 *
 * 동작 보존:
 *   - update-only 가드 — 활성 LA가 없으면 no-op. native `update()`가 내부적으로 `start()`로
 *     fall-through해 사용자가 본 적 없는 새 LA를 생성하는 위험을 차단(#2589 code review 3번).
 *   - backend mirror는 GPS distance를 싣지 않는다 — backend가 이미 "이 역에 있다"고 advance
 *     확정한 상태이므로 0m(도착)로 표시한다.
 *
 * 반환값(#2610 code review 4번) — 실제로 `updateLiveActivity`를 호출했으면 true, 어느 가드에서든
 * skip했으면 false. FG 소비처가 이 값으로만 dedup ref를 갱신해, no-op tick은 다음 tick에 재시도한다.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LiveActivity from 'live-activity';
import type { Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import { createLogger } from '../../../shared/utils/logger';
import { ACTIVE_TRIP_KEY } from '../../../shared/constants/storageKeys';
import { buildLiveActivityData } from './stationNotification';
import { isLaDismissed } from './laDismissSentinel';
import { shouldSkipDeviceLiveActivityWrite } from './liveActivityPushChannel';
import { isDeviceGpsLiveActivityWriteRecent } from './liveActivityGpsWriteArbitration';

const logger = createLogger('LiveActivityMirrorSync');

/**
 * mirror가 resolve한 station으로 Live Activity를 갱신한다.
 *
 * BG 컨텍스트와 동일하게 ETA/alarm은 계산하지 않는다 — silent push/backend push가 알람을 별도로
 * 발사하고, ETA는 backend LA push가 권위. 이 함수는 station/route 변동만 빠르게 반영한다.
 *
 * @returns 실제 `updateLiveActivity` 호출 여부.
 */
export async function updateLiveActivityFromMirrorStation(
  mirrorStation: Station,
  destination: Station,
  route: Route,
): Promise<boolean> {
  if (await isLaDismissed()) {
    logger.info('LA dismiss sentinel active — skip mirror-sourced refresh');
    return false;
  }
  const tripToken = await AsyncStorage.getItem(ACTIVE_TRIP_KEY);
  if (shouldSkipDeviceLiveActivityWrite(tripToken)) {
    logger.info('backend-authority active trip — skip mirror-sourced LA write');
    return false;
  }
  if (isDeviceGpsLiveActivityWriteRecent()) {
    logger.info(
      'GPS writer wrote recently — mirror writer yields this tick (avoid ETA/alarm badge blank)',
    );
    return false;
  }
  if (!LiveActivity.hasActiveLiveActivity()) {
    logger.info(
      `la-refresh source=backend-ssot but no active LA — skip (update-only, no create): ${mirrorStation.name}`,
    );
    return false;
  }
  const data = buildLiveActivityData(mirrorStation, 0, destination, route, null, false, null);
  await LiveActivity.updateLiveActivity(data);
  logger.info(`la-refresh source=backend-ssot: ${mirrorStation.name} → ${destination.name}`);
  return true;
}
