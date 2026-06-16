/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * #1385 — boardingPrompt displayed wire-up.
 *
 * #1021에서 추가된 `logBoardingPromptFired`가 production 호출자가 없어 DebugModal
 * "Boarding Prompt" 카운터와 acceptance dashboard(displayed 의존)가 영원히 0/null로
 * 표시되던 dead-wire 버그를 잡는다.
 *
 *   1) FG에서 notification 수신 시 `addNotificationReceivedListener` 콜백 → categoryIdentifier가
 *      BOARDING_PROMPT_CATEGORY면 `logBoardingPromptFired` 호출 + dedup set 등록.
 *   2) BG cold-start로 FG receive를 못 잡은 케이스는 `useBoardingPromptResponder`의 response
 *      listener에서 dedup set 체크 후 보완 적재 (이 파일이 export하는 helper 사용).
 *
 * dedup key는 `notification.request.identifier`. set은 모듈 스코프 in-memory — 앱 재시작 시
 * reset되지만 fired entry는 영구 alarm log AsyncStorage에 적재되므로 누적 손실 없음.
 */

import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { BOARDING_PROMPT_CATEGORY } from '../utils/notificationCategory';
import { logBoardingPromptFired } from '../utils/alarmLog';
import { extractBoardingPromptPayload } from './useBoardingPromptResponder';
import { createLogger } from '../../../shared/utils/logger';

const log = createLogger('boardingPromptDisplayLogger');

/**
 * 모듈 스코프 dedup set. `useBoardingPromptDisplayLogger` (FG receive) 와
 * `useBoardingPromptResponder` (response — cold-start 보완) 가 공유한다.
 * 같은 notification.request.identifier로 fired가 이미 적재됐는지 확인 후 1건만 적재.
 */
const displayedIdentifiers = new Set<string>();

/**
 * 같은 notification에 대해 displayed 적재가 이미 이루어졌는지 확인.
 * `useBoardingPromptResponder`가 cold-start 보완 시 이 helper로 dedup 체크.
 */
export function wasBoardingPromptDisplayed(identifier: string): boolean {
  return displayedIdentifiers.has(identifier);
}

/**
 * displayed 적재가 완료됐음을 dedup set에 기록.
 * `useBoardingPromptResponder`가 cold-start fired를 추가 적재한 직후 호출.
 */
export function markBoardingPromptDisplayed(identifier: string): void {
  displayedIdentifiers.add(identifier);
}

/** 테스트 격리용 — dedup set을 비운다. production 코드에서는 호출하지 않는다. */
export function __resetBoardingPromptDisplayedDedup(): void {
  displayedIdentifiers.clear();
}

/**
 * FG receive listener — BOARDING_PROMPT category notification 수신 시 displayed 적재.
 *
 * app/_layout.tsx에서 useBoardingPromptResponder 옆에 같이 호출한다. deps 없음.
 */
export function useBoardingPromptDisplayLogger(): void {
  useEffect(() => {
    const sub = Notifications.addNotificationReceivedListener((notification) => {
      try {
        const request = notification.request;
        const content = request.content;
        // iOS에서만 categoryIdentifier가 채워진다 (Android는 무시). BOARDING_PROMPT 외 카테고리는 skip.
        if (content.categoryIdentifier !== BOARDING_PROMPT_CATEGORY) return;
        // payload schema 검증 — 형식이 다른 push가 같은 category를 재사용해도 displayed 오적재 차단.
        const payload = extractBoardingPromptPayload(content.data);
        if (!payload) return;
        const identifier = request.identifier;
        if (typeof identifier !== 'string' || identifier.length === 0) return;
        if (displayedIdentifiers.has(identifier)) return;
        displayedIdentifiers.add(identifier);
        logBoardingPromptFired({
          originStation: payload.originStation,
          line: payload.line,
        });
      } catch (err) {
        // listener 콜백은 절대 throw 금지 — 오작동 시 silent log만.
        log.warn('boarding-prompt displayed 적재 실패', err as Error);
      }
    });
    return () => sub.remove();
  }, []);
}
