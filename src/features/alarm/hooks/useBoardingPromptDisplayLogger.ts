/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * #1385 / #1419 — boardingPrompt displayed wire-up.
 *
 * #1021에서 추가된 `logBoardingPromptFired`가 production 호출자가 없어 DebugModal
 * "Boarding Prompt" 카운터와 acceptance dashboard(displayed 의존)가 영원히 0/null로
 * 표시되던 dead-wire 버그를 잡는다.
 *
 *   1) FG에서 notification 수신 시 `addNotificationReceivedListener` 콜백 → categoryIdentifier가
 *      BOARDING_PROMPT_CATEGORY면 `logBoardingPromptFired` 호출 + dedup set 등록.
 *   2) BG cold-start로 FG receive를 못 잡은 케이스는 `useBoardingPromptResponder`의 response
 *      listener에서 dedup set 체크 후 보완 적재 (이 파일이 export하는 helper 사용).
 *   3) #1419 — BG 수신분은 addNotificationReceivedListener가 replay하지 않는다. AppState 'active'
 *      진입 시 `getPresentedNotificationsAsync` 로 tray를 drain해 미적재 BOARDING_PROMPT를 흡수.
 *      `scheduledAlarmReceiver.drainDeliveredScheduledAlarms`와 동형 패턴. 7일간 displayed=0
 *      회귀의 root cause는 (2)에서 사용자가 응답 안 한 BG 수신분이 모두 누락되던 케이스.
 *
 * displayed dedup key는 `notification.request.identifier`. set은 모듈 스코프 in-memory — 앱
 * 재시작 시 reset되지만 fired entry는 영구 alarm log AsyncStorage에 적재되므로 누적 손실 없음.
 *
 * #2627 — #2398 category-received 진단 계측(`logFgCategoryReceived`)은 (1) FG receive listener
 * 경로에서만 호출한다. (3)의 drain은 presented tray **전체**(도착 알림 등 비프롬프트 알림 포함)를
 * `tryLogDisplayed`에 넣으므로, 거기서 category-received까지 같이 적재하면 mount/AppState active
 * 진입마다 트레이 전체가 재적재돼 "backend 재발사"로 오진된다(2026-09-15 덤프). identifier 기준
 * burst dedup(alarmLog.ts `isBurstDuplicate`, bounded TTL)은 유지 — 같은 identifier가 짧은 창
 * 안에 반복되면 drop하되, 창 밖 재수신(진짜 backend 재발사 가능성)은 다시 적재한다.
 */

import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BOARDING_PROMPT_DISPLAYED_IDS_KEY } from '../../../shared/constants/storageKeys';
import { BOARDING_PROMPT_CATEGORY, DISEMBARK_PROMPT_CATEGORY } from '../utils/notificationCategory';
import { logBoardingPromptFired, logBoardingPromptCategoryReceived } from '../utils/alarmLog';
import { extractBoardingPromptPayload, type BoardingPromptPayload } from './useBoardingPromptResponder';
import { createLogger } from '../../../shared/utils/logger';

const log = createLogger('boardingPromptDisplayLogger');

/**
 * 모듈 스코프 dedup set. `useBoardingPromptDisplayLogger` (FG receive) 와
 * `useBoardingPromptResponder` (response — cold-start 보완) 가 공유한다.
 * 같은 notification.request.identifier로 fired가 이미 적재됐는지 확인 후 1건만 적재.
 */
const displayedIdentifiers = new Set<string>();

/**
 * #2677 — dedup set을 **앱 재시작 너머로** 유지한다.
 *
 * 문제: 이 set은 모듈 스코프 in-memory라 프로세스가 죽으면 비워진다. 그런데
 * `drainPresentedBoardingPrompts`는 mount + AppState 'active'마다 **알림 트레이 전체**를 읽어
 * "아직 적재 안 된" 항목을 displayed로 센다. 즉 사용자가 트레이에서 치우지 않은 옛 프롬프트 1건이
 * 앱을 켤 때마다 새로 센 것으로 집계된다.
 *
 * 실측(2026-09-17 덤프): 사용자는 프롬프트를 **한 번도 못 봤다고 보고**했는데
 * `boardingPrompt(all)=8`, `displayed=8`, `responded=0`. 8건 전부 같은 옛 항목("7·건대입구")이
 * hydrate 4회 × 2(mount+active)로 재계수된 것이었다. 실제로는 그 trip에 프롬프트가 0건이었고,
 * 계측은 정반대를 가리켜 진단을 오도했다(#2627이 `category-received`에서 고친 것과 같은 병,
 * 한 층 아래).
 *
 * identifier는 OS가 알림마다 부여하는 안정 키라 그대로 영속화해 "알림 1건은 평생 1회만 센다"는
 * 원래 계약을 프로세스 경계 너머로 복원한다. 무한 증가를 막기 위해 최근 N개만 유지한다 —
 * 트레이에 남을 수 있는 알림 수보다 충분히 크고, 그보다 오래된 항목은 이미 트레이에서 사라져
 * 재계수 대상이 아니다.
 */
const DISPLAYED_ID_HISTORY_LIMIT = 100;
/** storage hydrate 1회 보장용 — 동시 호출이 중복 read하지 않도록 promise를 공유한다. */
let displayedIdentifiersHydration: Promise<void> | null = null;

async function hydrateDisplayedIdentifiers(): Promise<void> {
  displayedIdentifiersHydration ??= (async () => {
    try {
      const raw = await AsyncStorage.getItem(BOARDING_PROMPT_DISPLAYED_IDS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      for (const id of parsed) {
        if (typeof id === 'string' && id.length > 0) displayedIdentifiers.add(id);
      }
    } catch (err) {
      // graceful — 복원 실패는 "이번 세션엔 in-memory만" 으로 자연 degrade(기존 동작).
      log.warn('displayed dedup 복원 실패', err as Error);
    }
  })();
  return displayedIdentifiersHydration;
}

function persistDisplayedIdentifiers(): void {
  const recent = Array.from(displayedIdentifiers).slice(-DISPLAYED_ID_HISTORY_LIMIT);
  void AsyncStorage.setItem(BOARDING_PROMPT_DISPLAYED_IDS_KEY, JSON.stringify(recent)).catch(
    (err: unknown) => {
      log.warn('displayed dedup 영속화 실패', err as Error);
    },
  );
}

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
  persistDisplayedIdentifiers();
}

/** 테스트 격리용 — dedup set을 비운다. production 코드에서는 호출하지 않는다. */
export function __resetBoardingPromptDisplayedDedup(): void {
  displayedIdentifiers.clear();
  displayedIdentifiersHydration = null;
}

/**
 * #2627 — notification.request.identifier가 dedup 키로 쓸 수 있는 유효한 문자열인지 판정.
 * `tryLogDisplayed`(displayed dedup)와 `logFgCategoryReceived`(category-received burst dedup)
 * 양쪽이 동일한 판정을 복제하던 것을 단일 가드로 통합.
 */
function isValidNotificationIdentifier(identifier: unknown): identifier is string {
  return typeof identifier === 'string' && identifier.length > 0;
}

/**
 * #2627 — notification 1건당 payload를 1회만 추출해 caller(FG listener / drain)가 공유한다.
 * `logFgCategoryReceived`와 `tryLogDisplayed`가 각자 `extractBoardingPromptPayload`를 호출하던
 * 것을 caller 레벨로 끌어올려 같은 notification.request.content.data 파싱이 두 번 실행되지
 * 않게 한다. request 접근 자체가 throw할 수 있는 케이스도 여기서 흡수한다.
 */
function safeExtractPayload(notification: Notifications.Notification): BoardingPromptPayload | null {
  try {
    return extractBoardingPromptPayload(notification.request.content.data);
  } catch (err) {
    log.warn('boarding-prompt payload 추출 실패', err as Error);
    return null;
  }
}

/**
 * #2398 진단 계측: FG `addNotificationReceivedListener` 콜백 경로에서만 호출한다. 수신한
 * categoryIdentifier 실제 값(null 포함) + payload 매칭 여부를 device 덤프로 가시화한다.
 * #2627 — drain 경로에서는 절대 호출하지 않는다 (트레이 전체 재적재로 인한 계측 오염 방지).
 * identifier 기준 burst dedup은 `logBoardingPromptCategoryReceived`(alarmLog.ts)가
 * bounded TTL(`isBurstDuplicate`)로 수행 — 여기서는 영구 dedup set을 두지 않는다.
 *
 * `payload`는 같은 콜백에서 이미 추출한 값을 전달받아 재추출하지 않는다.
 */
function logFgCategoryReceived(
  notification: Notifications.Notification,
  payload: BoardingPromptPayload | null,
): void {
  try {
    const request = notification.request;
    const content = request.content;
    const identifier = request.identifier;
    logBoardingPromptCategoryReceived({
      categoryIdentifier: content.categoryIdentifier ?? null,
      payloadMatched: payload !== null,
      identifier: isValidNotificationIdentifier(identifier) ? identifier : undefined,
    });
  } catch (err) {
    // listener 콜백은 절대 throw 금지 — 오작동 시 silent log만.
    log.warn('boarding-prompt category-received 계측 실패', err as Error);
  }
}

/**
 * notification 1건에 대해 displayed 적재(+dedup). FG receive listener와 BG drain 양쪽이 공유.
 *
 * categoryIdentifier가 null인 케이스(Android 등)는 FG receive에서는 skip 하지만 drain에서는
 * payload schema가 일치하면 적재한다. drain은 명시적으로 BOARDING_PROMPT만 필터링하므로
 * 호출 전 caller가 category를 검증한다.
 *
 * `payload`를 caller가 이미 추출했으면 전달받아 재추출을 피한다 (FG receive listener가
 * `logFgCategoryReceived`에서 이미 추출한 값을 재사용).
 */
function tryLogDisplayed(
  notification: Notifications.Notification,
  payload: BoardingPromptPayload | null,
): void {
  try {
    const request = notification.request;
    const content = request.content;
    // #2282 — hop-end 는 DISEMBARK_PROMPT_CATEGORY로 분리 발사되므로 두 category 모두 displayed 적재.
    if (
      content.categoryIdentifier !== BOARDING_PROMPT_CATEGORY &&
      content.categoryIdentifier !== DISEMBARK_PROMPT_CATEGORY
    )
      return;
    if (!payload) return;
    const identifier = request.identifier;
    if (!isValidNotificationIdentifier(identifier)) return;
    if (displayedIdentifiers.has(identifier)) return;
    displayedIdentifiers.add(identifier);
    // #2677 — 이 알림을 셌다는 사실을 앱 재시작 너머로 남긴다(같은 알림 재계수 차단).
    persistDisplayedIdentifiers();
    logBoardingPromptFired({
      originStation: payload.originStation,
      line: payload.line,
    });
  } catch (err) {
    // listener/drain 콜백은 절대 throw 금지 — 오작동 시 silent log만.
    log.warn('boarding-prompt displayed 적재 실패', err as Error);
  }
}

/**
 * #1419 — BG 발사 drain. presented tray에서 BOARDING_PROMPT_CATEGORY notification을 읽어
 * 미적재 분만 displayed로 누적한다. AppState 'active' 진입 시점 + 마운트 시점에 호출한다.
 *
 * `scheduledAlarmReceiver.drainDeliveredScheduledAlarms`와 동형 — addNotificationReceivedListener는
 * BG 수신분을 replay하지 않으므로 displayed 카운터가 0으로 굳는 회귀를 해결한다.
 */
async function drainPresentedBoardingPrompts(): Promise<void> {
  // #2677 — 트레이를 읽기 **전에** 이전 세션의 dedup 기록을 복원한다. 복원 전에 세면 같은 알림이
  // 앱 재시작마다 새로 센 것으로 집계된다(실측: 프롬프트 0건인 trip에서 displayed=8).
  await hydrateDisplayedIdentifiers();
  let presented: Notifications.Notification[];
  try {
    presented = await Notifications.getPresentedNotificationsAsync();
  } catch (err) {
    log.warn('presented tray 조회 실패', err as Error);
    return;
  }
  for (const n of presented) {
    tryLogDisplayed(n, safeExtractPayload(n));
  }
}

/**
 * FG receive listener + AppState 'active' drain — BOARDING_PROMPT category notification의
 * displayed 카운터를 살린다.
 *
 * app/_layout.tsx에서 useBoardingPromptResponder 옆에 같이 호출한다. deps 없음.
 */
export function useBoardingPromptDisplayLogger(): void {
  useEffect(() => {
    const sub = Notifications.addNotificationReceivedListener((notification) => {
      const payload = safeExtractPayload(notification);
      logFgCategoryReceived(notification, payload);
      tryLogDisplayed(notification, payload);
    });
    // 마운트 시점에 1회 drain — cold start로 진입한 경우 tray에 이미 표시된 prompt를 흡수.
    void drainPresentedBoardingPrompts();
    const onAppStateChange = (state: AppStateStatus): void => {
      if (state === 'active') void drainPresentedBoardingPrompts();
    };
    const appStateSub = AppState.addEventListener('change', onAppStateChange);
    return () => {
      sub.remove();
      appStateSub.remove();
    };
  }, []);
}
