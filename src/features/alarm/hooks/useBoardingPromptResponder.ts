/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * #819 — "탑승했냐?" 푸시 응답 핸들러.
 *
 * iOS UNNotificationCategory "BOARDING_PROMPT"의 액션 [탑승]/[미탑승] 또는 기본 탭을 받아
 * 분기 처리:
 *
 *   - [탑승] 액션: payload.originStation/line 컨텍스트로 Seoul API 도착 정보를 즉시 fetch →
 *     line + 방향 매칭 후보 → arvlCd 우선순위로 trainCode 자동 선택 → `createLock`.
 *     ambiguity → 자동 lock 안 함 (manual BoardingTrainList fallback).
 *
 *   - [미탑승] 액션 / dismiss: backend `POST /boarding-prompt/dismiss` → 5분 silence.
 *
 * `Notifications.addNotificationResponseReceivedListener`는 단일 listener라 app/_layout의
 * 진동 정지 listener와 겹치지만, expo-notifications는 multi-listener를 허용한다 (FlatList 식).
 */

import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import type { ArrivalInfo, StationArrival } from '../../../shared/types/arrival';
import { dismissBoardingPrompt } from '../../nearest-station/api/positionUpload';
import { useBoardingLockStore } from '../store/useBoardingLockStore';
import { useUserIntentStore } from '../store/useUserIntentStore';
import { pickAutoTrainCodeFromArrivals } from '../utils/boardingPromptAutoLock';
import {
  logBoardingPromptAutoLock,
  logBoardingPromptFired,
  logBoardingPromptResponded,
} from '../utils/alarmLog';
import {
  BOARDING_PROMPT_ACTION_BOARDED,
  BOARDING_PROMPT_ACTION_NOT_BOARDED,
  BOARDING_PROMPT_CATEGORY,
} from '../utils/notificationCategory';
import { findStationByNameAndLine } from '../../../shared/utils/stationLookup';
import { createLogger } from '../../../shared/utils/logger';
import { addDomainBreadcrumb } from '../../../shared/infra/monitoring/breadcrumb';
import {
  markBoardingPromptDisplayed,
  wasBoardingPromptDisplayed,
} from './useBoardingPromptDisplayLogger';

const log = createLogger('boardingPromptResponder');

/**
 * 백엔드 payload는 backend `BoardingPromptPushPayload`와 동일 schema (kind/originStation/line/tripToken).
 * Notification data 위치는 iOS에서 `notification.request.trigger.payload.data` 또는
 * `notification.request.content.data` 양쪽에 등장 — both를 시도해 graceful fallback.
 */
export interface BoardingPromptPayload {
  kind: 'boarding-prompt';
  originStation: string;
  line: string;
  tripToken: string;
  /**
   * #1740 — 목적지 방향 filter. backend가 forward하는 경우 'up' | 'down'.
   * 미지정 시 양방향 모두 후보로 허용 (backward compat).
   */
  destinationDirection?: 'up' | 'down';
}

export function extractBoardingPromptPayload(
  raw: unknown,
): BoardingPromptPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.kind !== 'boarding-prompt') return null;
  if (typeof o.originStation !== 'string' || o.originStation.length === 0) return null;
  if (typeof o.line !== 'string' || o.line.length === 0) return null;
  if (typeof o.tripToken !== 'string' || o.tripToken.length === 0) return null;
  const destinationDirection =
    o.destinationDirection === 'up' || o.destinationDirection === 'down'
      ? (o.destinationDirection as 'up' | 'down')
      : undefined;
  return {
    kind: 'boarding-prompt',
    originStation: o.originStation,
    line: o.line,
    tripToken: o.tripToken,
    destinationDirection,
  };
}

export interface UseBoardingPromptResponderDeps {
  /** Seoul API 도착 fetch — caller가 line + station으로 호출 가능한 함수 주입. */
  fetchArrivalsForStation: (stationName: string) => Promise<StationArrival | null>;
  /** trip의 destinationId — lock 생성 시 필요 (현재 사용자 trip 컨텍스트). */
  destinationId: string | null;
  /** 사용자 trip의 expectedDurationMs — lock expiry 계산. null이면 fallback 30분. */
  expectedDurationMs: number;
  /**
   * #1888 (RC-13) — 사용자가 banner를 직접 탭한 경우($default action) 호출되는 navigation callback.
   *
   * banner 탭은 "list를 보고 싶다"는 사용자 의향 — 자동 lock 성공/실패와 무관하게 home 화면으로
   * navigate해 BoardingTrainList를 노출한다. expo-router의 router.navigate('/') 등 caller가 주입.
   *
   * 미전달이면 navigation 없이 기존 동작(lock 시도 + dismiss 분기) 그대로. listener 호출은 sync 진입점
   * 이라 router를 직접 import하면 테스트가 expo-router를 모킹해야 해서 caller injection 패턴 채택.
   */
  onBannerTap?: () => void;
}

/**
 * 응답 listener wiring + 분기 처리.
 *
 * destinationId가 null이면 lock 생성 불가 — 사용자가 trip을 이미 종료한 후 푸시를 늦게 탭한 케이스.
 * 그 경우 dismiss POST만 발사하고 lock 시도는 silent skip.
 */
export function useBoardingPromptResponder(deps: UseBoardingPromptResponderDeps): void {
  const createLock = useBoardingLockStore((s) => s.createLock);

  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const request = response.notification.request;
      const payload = extractBoardingPromptPayload(request.content.data);
      if (!payload) return;
      // #1385 — BG cold-start fired 보완. FG receive listener가 못 잡은 케이스(killed-app 상태에서
      // prompt 표시 → 사용자가 곧장 응답)에서도 displayed 카운트를 살린다. dedup은
      // notification.request.identifier 기준 — FG receive가 먼저 적재했으면 skip.
      const identifier = request.identifier;
      if (typeof identifier === 'string' && identifier.length > 0) {
        const isBoardingPromptCategory =
          request.content.categoryIdentifier === BOARDING_PROMPT_CATEGORY;
        // categoryIdentifier 미수신 OS(예: Android)에서도 payload schema가 일치하면 fired 적재.
        const shouldLog =
          (isBoardingPromptCategory || request.content.categoryIdentifier == null) &&
          !wasBoardingPromptDisplayed(identifier);
        if (shouldLog) {
          markBoardingPromptDisplayed(identifier);
          logBoardingPromptFired({
            originStation: payload.originStation,
            line: payload.line,
          });
        }
      }
      void handleResponse(response.actionIdentifier, payload, {
        ...deps,
        createLock,
      });
    });
    return () => sub.remove();
  }, [createLock, deps]);
}

interface HandleDeps extends UseBoardingPromptResponderDeps {
  createLock: ReturnType<typeof useBoardingLockStore.getState>['createLock'];
}

/**
 * actionIdentifier 분기 — pure 함수로 export해 테스트에서 직접 호출 가능.
 *
 *   - `BOARDING_PROMPT_ACTION_BOARDED`: 자동 lock 시도
 *   - `BOARDING_PROMPT_ACTION_NOT_BOARDED`: silence POST
 *   - `Notifications.DEFAULT_ACTION_IDENTIFIER` (= '$default'): 사용자가 알림 자체 탭 — 자동 lock 시도 (탭 = 긍정 의도)
 *   - 그 외 (dismiss 등): silence POST
 */
export async function handleResponse(
  actionIdentifier: string,
  payload: BoardingPromptPayload,
  deps: HandleDeps,
): Promise<void> {
  // #1888 (RC-13) — Interactive UI 작동 evidence. 사용자가 액션 버튼을 탭했거나 banner를 직접 탭한
  // 경로(BOARDED / NOT_BOARDED / $default)에서 1회 발사. UNNotificationCategory가 비활성이면 OS가
  // 액션 자체를 노출하지 않으므로 이 breadcrumb의 존재 자체가 "Interactive UI 작동 확인" 신호.
  // 1주 production 측정: fired vs interactive_tap 비율로 사용자 응답률 추적.
  addDomainBreadcrumb('boarding', 'boarding_prompt_interactive_tap', {
    action: actionIdentifier,
    line: payload.line,
  });

  if (
    actionIdentifier === BOARDING_PROMPT_ACTION_BOARDED ||
    actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER
  ) {
    // #1170 — 응답률/탑승률 measurement. autolock 시도 성공/실패와 무관하게 "사용자가 boarded로
    // 응답했다"는 사실 기록. boardedRate = boarded / (boarded+dismissed)는 게이트 정확도 proxy.
    logBoardingPromptResponded({ outcome: 'boarded' });
    // #1923 — 사용자 명시 의향 stamp. tryAutoLock 성공/실패와 무관하게 의향 표명 사실이 backend로
    // forward되어야 lockless intermediate trip에서도 station-passed silent push가 발사된다.
    // ADR-014 §X "사용자 명시 의향 trip = lock 활성과 동급 정확도 보장 의무" 정합.
    // setInfoModeEnabled는 memory + storage atomic — graceful 실패(다음 cycle에서 재시도).
    void useUserIntentStore.getState().setInfoModeEnabled(true);
    await tryAutoLock(payload, deps);
    // #1888 (RC-13) — banner 탭($default) 케이스만 home 화면으로 navigate. 사용자가 list를 보고 싶다는
    // 명시 의향(action button BOARDED는 silent autolock으로 끝, navigation은 surplus).
    // tryAutoLock 성공/실패와 무관하게 호출 — 실패 시 BoardingTrainList의 fallback UI 노출 의도.
    if (
      actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER &&
      deps.onBannerTap !== undefined
    ) {
      deps.onBannerTap();
    }
    return;
  }
  // [미탑승] 또는 dismiss — 5분 silence.
  // #1170 — dismissed 측정. dismiss POST 결과(네트워크 성공/실패)와 무관하게 사용자 인지 기준 적재.
  logBoardingPromptResponded({ outcome: 'dismissed' });
  await dismissBoardingPrompt(payload.tripToken);
}

async function tryAutoLock(
  payload: BoardingPromptPayload,
  deps: HandleDeps,
): Promise<void> {
  const telemetry = { originStation: payload.originStation, line: payload.line };

  if (!deps.destinationId) {
    // trip이 이미 끝남 — lock 시도 안 함, dismiss로 backend silence.
    logBoardingPromptAutoLock({ reason: 'autolock-no-trip', ...telemetry });
    await dismissBoardingPrompt(payload.tripToken);
    return;
  }

  const arrival = await deps.fetchArrivalsForStation(payload.originStation);
  if (!arrival) {
    log.info('arrivals fetch returned null — falling back to manual');
    logBoardingPromptAutoLock({ reason: 'autolock-arrivals-empty', ...telemetry });
    // #1888 (RC-13) — 빈 후보 graceful skip evidence. arrivals null = API fetch 실패 또는 응답 빈 케이스.
    // BoardingTrainList도 동시에 empty state로 진입하므로 사용자는 manual list에서 0건만 본다.
    // 1주 production: empty_skip > 0 발생 시 candidate-generator(arrivals fetch) 추가 보강 신호.
    addDomainBreadcrumb('boarding', 'boarding_prompt_empty_skip', {
      reason: 'arrivals-null',
      ...telemetry,
    });
    return;
  }

  // #1740 — destination 방향 filter. payload.destinationDirection이 있으면 해당 방향만 선택.
  // 없으면 양방향 모두 후보 (backward compat). 이후 line + arrivalSeconds 필터 적용.
  const { destinationDirection } = payload;
  const directionSlice: readonly ArrivalInfo[] =
    destinationDirection === 'up' || destinationDirection === 'down'
      ? arrival[destinationDirection]
      : ([] as ArrivalInfo[]).concat(arrival.up, arrival.down);
  const sameLine = directionSlice.filter(
    (a) => a.line === payload.line && a.arrivalSeconds > 0,
  );
  const chosen = pickAutoTrainCodeFromArrivals(sameLine, destinationDirection);
  if (!chosen) {
    log.info('ambiguity or empty — auto lock skipped');
    // 빈 후보와 ambiguity 구분: sameLine이 1개 이상인데 chosen이 null이면 ambiguity.
    const reason = sameLine.length === 0 ? 'autolock-arrivals-empty' : 'autolock-ambiguity';
    logBoardingPromptAutoLock({ reason, ...telemetry });
    // #1888 (RC-13) — 빈 후보(line + direction 필터 후 0건) graceful skip evidence.
    // ambiguity는 후보가 있으나 자동 선택 불가 — empty와 별 신호이므로 empty case에서만 발사.
    if (sameLine.length === 0) {
      addDomainBreadcrumb('boarding', 'boarding_prompt_empty_skip', {
        reason: 'line-filtered-empty',
        ...telemetry,
      });
    }
    return;
  }

  // boardingStationId — payload.originStation/line으로 정확 매칭. 매칭 실패는 manual fallback.
  const station = findStationByNameAndLine(payload.originStation, chosen.line);
  if (!station) {
    log.info('station lookup failed — auto lock skipped');
    logBoardingPromptAutoLock({ reason: 'autolock-station-lookup', ...telemetry });
    return;
  }

  try {
    await deps.createLock({
      destinationId: deps.destinationId,
      trainCode: chosen.trainCode,
      boardingStationId: station.id,
      boardingLine: chosen.line,
      boardedAt: Date.now(),
      expectedDurationMs: deps.expectedDurationMs,
      // #897 Seam A: auto-lock 시점 ETA 스냅샷. 지연 신호의 기준치.
      initialEtaSeconds: chosen.arrivalSeconds,
    });
    logBoardingPromptAutoLock({ reason: 'autolock-success', ...telemetry });
  } catch (err) {
    // #1167 — lock 실패 시 fallback 경로. createLock는 storage/network 예외 가능.
    // 사용자는 manual BoardingTrainList에서 재선택. 예외는 swallow — autoLock은 best-effort.
    log.warn('createLock failed — falling back to manual', err as Error);
    logBoardingPromptAutoLock({ reason: 'autolock-lock-failed', ...telemetry });
  }
}
