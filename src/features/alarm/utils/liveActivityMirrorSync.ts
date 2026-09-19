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
 *   2. (#2659에서 제거) `shouldSkipDeviceLiveActivityWrite`(#2481) backend-authority 스킵 —
 *      그 게이트는 GPS-sourced 쓰기 전용으로 좁혔다. 근거는 함수 본문 주석 참조.
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
import * as LiveActivity from 'live-activity';
import type { Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import { createLogger } from '../../../shared/utils/logger';
import { buildLiveActivityData } from './stationNotification';
import { isLaDismissed } from './laDismissSentinel';
import { isDeviceGpsLiveActivityWriteRecent } from './liveActivityGpsWriteArbitration';
import { logLiveActivityUpdated } from './alarmLog';

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
  // #2659 — backend-authority 게이트(`shouldSkipDeviceLiveActivityWrite`, #2481)는 **GPS-sourced**
  // 쓰기 전용이다. 그 게이트의 근거는 "device GPS 추정치로 backend의 정확한 N정거장을 덮어쓰지
  // 마라"인데, 이 경로가 쓰는 값은 GPS 추정치가 아니라 **backend 자신의 SSoT mirror**라 애초에
  // 권위 충돌이 없다. 그런데 게이트가 소스를 구분하지 않아, LA push 세션이 등록된 순간부터
  // mirror 경로까지 함께 막혀 LA의 writer가 backend LA push 하나만 남았다 —
  // 2026-09-16 라이드에서 그 단일 채널이 0건(`laPushDelivery=0/0`)이 되자 LA가 탑승역
  // ("용마산 / 탑승하셨나요?")에 13분간 얼어붙었다. mirror는 HTTP(`POST /position` 응답, #2261)로
  // 지하에서도 갱신되므로, 이 경로를 열어두면 "알림은 늦어도 화면은 맞다"가 성립한다.
  // 게이트는 GPS 경로(`updateStationNotification` / `refreshLiveActivityFromBackgroundContext`의
  // BG_LAST_STATION 분기)에 그대로 남아 있다.
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
  // #2659 (code review P1-1) — ActivityKit update는 content-state **전체 교체**라, 이 경로가
  // 쓰면 backend LA push가 직전에 실은 ETA/알람 배지가 null로 덮인다. device는 backend LA push
  // 도달을 관측할 수단이 없어(JS를 깨우지 않는다) GPS writer용 arbitration 같은 recency 가드를
  // 대칭으로 만들 수 없다 — 그래서 이 경로의 노출 범위를 **역 전이당 1회**로 묶는 것이 현재
  // 가능한 최선의 경계다: BG 트리거(`refreshLiveActivityOnMirrorAdvance`)는 mirror 역/노선이
  // 바뀔 때만 발화하고, FG 훅(`useForegroundLaMirrorSync`)은 dedup 키로 같은 조합 재적용을 막는다.
  // 그 1회조차 "역이 방금 바뀐 시점"이라 backend가 실었던 ETA는 이미 이전 역 기준이다. 정상
  // 상황이면 곧바로 다음 backend push/GPS write가 ETA를 복원하고, 정상이 아니면(=이 fix가
  // 겨냥한 지하 push 공백) 애초에 지킬 ETA가 존재하지 않는다.
  const data = buildLiveActivityData(mirrorStation, 0, destination, route, null, false, null);
  await LiveActivity.updateLiveActivity(data);
  // #2686 — LA 갱신 횟수 계측(측정 목적, 정책 변경 없음).
  logLiveActivityUpdated();
  logger.info(`la-refresh source=backend-ssot: ${mirrorStation.name} → ${destination.name}`);
  return true;
}
