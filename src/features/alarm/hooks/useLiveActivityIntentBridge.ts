/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: LA 버튼 탭(App Group pending intent)을 기존
 * `useBoardingPromptResponder`의 lock 생성/해제 로직에 연결하는 orchestrator라 여러 features의
 * store/hook을 직접 조합하는 게 본질적이다. Phase 5 enforce 모드에서 file-level disable로 옵트인.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * #2438 — LA 인터랙티브 프롬프트 piece ⑤(JS) + ⑥(dedup).
 *
 * native(③④⑤-native, 병렬 진행)의 AppIntent가 LA 버튼 탭 시 App Group에 pending boarding
 * intent를 write한다. 이 훅은 그 intent를 읽어 `useBoardingPromptResponder.handleResponse`
 * (알림 [탑승]/[하차했어요] 액션과 동일한 lock 생성/해제 로직)로 그대로 위임한다 — 신규 lock
 * 로직을 만들지 않고 기존 tryAutoLock/createPendingFallbackLock/dedup/의향 stamp를 재사용한다.
 *
 * App Group 계약 (native와 공유):
 *   `readPendingBoardingIntent(): string | null` → JSON 문자열 또는 pending 없음/모듈
 *   미지원 시 null (native `Function`이 sync라 JS 래퍼도 sync). `{ id, tripToken,
 *   action: 'BOARDING_BOARDED' | 'DISEMBARK_DISEMBARKED', originStation, line, atMs }`.
 *   `clearPendingBoardingIntent(id): void` → 처리 후 호출(멱등) — 재폴링/재부팅 중복 처리 방지.
 *
 * 트리거: 마운트 + AppState 'active' 진입 + foreground 유지 중 짧은 폴링
 * (`LIVE_ACTIVITY_INTENT_POLL_MS`) — native가 push event 없이 App Group write만 하는 pull
 * 모델이라 재확인이 필요하다.
 *
 * ⑥ dedup — 알림 [탑승] 액션과 LA 버튼 둘 다 최종적으로 이 경로(`tryAutoLock` → `createLock`)로
 * 수렴한다. `createLock`은 호출 즉시 기존 lock을 교체하므로(store 자체엔 dedup이 없음), 같은
 * boarding 역/노선에 이미 active lock이 있으면 LA intent 처리를 no-op으로 skip해 이중 lock
 * 생성(같은 trip을 두 번 잠그며 `initialEtaSeconds` 등 스냅샷을 덮어쓰는 것)을 막는다.
 * hop-end(DISEMBARK) 액션은 `releaseLock`이 이미 멱등이라 별도 가드가 필요 없다.
 */
import { useCallback, useEffect } from 'react';
import {
  clearPendingBoardingIntent,
  readPendingBoardingIntent,
} from 'live-activity';
import { usePolling } from '../../../shared/hooks/usePolling';
import { lineCodeFromApiName } from '../../../shared/constants/lineApiNames';
import {
  LIVE_ACTIVITY_INTENT_POLL_MS,
  LIVE_ACTIVITY_INTENT_STALE_MS,
  NATIVE_CONFIRM_WAIT_MS,
  isRealBoardingLock,
} from '../../../shared/constants/boardingLock';
import type { LaCandidate } from '../../../shared/types/boardingLock';
import { useBoardingLockStore } from '../store/useBoardingLockStore';
import { isDuplicateBoardingLock } from '../utils/duplicateBoardingLock';
import { endBoardingActivity } from '../utils/boardingActivityChannel';
import { applyLaNativeResolution, type LaNativeResolutionResult } from '../utils/applyLaNativeResolution';
import {
  BOARDING_PROMPT_ACTION_BOARDED,
  BOARDING_PROMPT_ACTION_NOT_BOARDED,
  DISEMBARK_ACTION_DISEMBARKED,
  DISEMBARK_ACTION_NOT_YET,
} from '../utils/notificationCategory';
import {
  handleResponse,
  type BoardingPromptPayload,
  type UseBoardingPromptResponderDeps,
} from './useBoardingPromptResponder';
import { postEndPromptContinue } from '../api/alarmBackend';
import { createLogger } from '../../../shared/utils/logger';

const log = createLogger('liveActivityIntentBridge');

/**
 * #3055 PR-1 — native intent가 자기 boarding-confirm POST의 결과를 App Group에 남긴 기록.
 * `'in-flight'` = POST 진행 중(브릿지는 예산 내 보류), 객체 = 완료(`status` 0 = 실패/타임아웃).
 */
export interface NativePostResult {
  status: number;
  resolvedTrainCode?: string;
  lockState?: string;
  atMs: number;
}

/**
 * #3007 PR-2 — 종료 질문 [계속] 마커 action(native `ACTION_END_PROMPT_CONTINUE`와 문자열 일치 — nativeContract 테스트가 고정).
 * 탑승/하차 응답이 아니라 lock과 무관하다: native POST가 실패했을 때 FG에서 backend로 재전송하는 용도(`handleEndPromptContinue`).
 */
const END_PROMPT_CONTINUE_ACTION = 'END_PROMPT_CONTINUE';

type BoardingResponseAction =
  | 'BOARDING_BOARDED'
  | 'DISEMBARK_DISEMBARKED'
  | 'BOARDING_NOT_BOARDED'
  | 'DISEMBARK_NOT_YET';

/** App Group pending boarding intent — native AppIntent가 write하는 schema. */
export interface PendingBoardingIntent {
  id: string;
  tripToken: string;
  action: BoardingResponseAction | typeof END_PROMPT_CONTINUE_ACTION;
  originStation: string;
  line: string;
  atMs: number;
  /** #3055 PR-1 — LA 카드가 싣던 발사 열차(없으면 구 native/미지원 카드). 부재 = 현행 경로. */
  laCandidate?: LaCandidate;
  /** #3055 PR-1 — native POST 결과. 부재 = 구 native → 현행 경로. */
  nativePost?: 'in-flight' | NativePostResult;
}

const VALID_ACTIONS: readonly PendingBoardingIntent['action'][] = [
  'BOARDING_BOARDED',
  'DISEMBARK_DISEMBARKED',
  'BOARDING_NOT_BOARDED',
  'DISEMBARK_NOT_YET',
  END_PROMPT_CONTINUE_ACTION,
];

/**
 * #2470 — 알림 대칭 액션(미탑승/아직이요) 포함 4종 action → handleResponse 호출 파라미터
 * data-driven 매핑(글로벌 규칙 3, 하드코딩 삼항 금지).
 */
const ACTION_MAP: Record<
  BoardingResponseAction,
  { actionIdentifier: string; hopEnd: boolean; nativeConfirm: boolean }
> = {
  // nativeConfirm: native intent가 boarding-confirm을 직접 POST하고 결과를 `nativePost`로 남기는 action.
  BOARDING_BOARDED: { actionIdentifier: BOARDING_PROMPT_ACTION_BOARDED, hopEnd: false, nativeConfirm: true },
  BOARDING_NOT_BOARDED: { actionIdentifier: BOARDING_PROMPT_ACTION_NOT_BOARDED, hopEnd: false, nativeConfirm: false },
  DISEMBARK_DISEMBARKED: { actionIdentifier: DISEMBARK_ACTION_DISEMBARKED, hopEnd: true, nativeConfirm: true },
  DISEMBARK_NOT_YET: { actionIdentifier: DISEMBARK_ACTION_NOT_YET, hopEnd: true, nativeConfirm: false },
};

/** 형식이 맞는 laCandidate만 통과 — 불량은 무시(현행 경로, 400 아님). */
function parseLaCandidate(raw: unknown): LaCandidate | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { trainCode, issuedAtMs } = raw as Record<string, unknown>;
  if (typeof trainCode !== 'string' || trainCode.length === 0) return undefined;
  if (typeof issuedAtMs !== 'number' || !Number.isFinite(issuedAtMs)) return undefined;
  return { trainCode, issuedAtMs };
}

/** `'in-flight'` 또는 완료 객체만 통과 — 불량은 무시(구 native와 동일하게 현행 경로). */
function parseNativePost(raw: unknown): PendingBoardingIntent['nativePost'] {
  if (raw === 'in-flight') return raw;
  if (!raw || typeof raw !== 'object') return undefined;
  const { status, resolvedTrainCode, lockState, atMs } = raw as Record<string, unknown>;
  if (typeof status !== 'number' || typeof atMs !== 'number') return undefined;
  return {
    status,
    atMs,
    ...(typeof resolvedTrainCode === 'string' && resolvedTrainCode.length > 0 ? { resolvedTrainCode } : {}),
    ...(typeof lockState === 'string' ? { lockState } : {}),
  };
}

/**
 * `readPendingBoardingIntent()`가 반환한 raw JSON 문자열을 파싱 + 검증한다.
 * 파싱 실패 또는 필수 필드 누락/타입 불일치는 null — caller가 graceful skip.
 */
export function parsePendingBoardingIntent(raw: string): PendingBoardingIntent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0) return null;
  if (typeof o.tripToken !== 'string' || o.tripToken.length === 0) return null;
  if (typeof o.action !== 'string' || !VALID_ACTIONS.includes(o.action as never)) return null;
  // 종료 질문 [계속]에는 역·노선이 없다(native가 빈 문자열로 쓴다) — 탑승/하차 응답만 둘 다 필수.
  const requiresStation = o.action !== END_PROMPT_CONTINUE_ACTION;
  if (typeof o.originStation !== 'string' || (requiresStation && o.originStation.length === 0)) return null;
  if (typeof o.line !== 'string' || (requiresStation && o.line.length === 0)) return null;
  if (typeof o.atMs !== 'number') return null;
  const laCandidate = parseLaCandidate(o.laCandidate);
  const nativePost = parseNativePost(o.nativePost);
  return {
    id: o.id,
    tripToken: o.tripToken,
    action: o.action as PendingBoardingIntent['action'],
    originStation: o.originStation,
    // #3055 — 탑승 LA(split) 버튼은 content.line(정식 노선명 '7호선')을 보낸다. 코드로 환원.
    line: lineCodeFromApiName(o.line),
    atMs: o.atMs,
    ...(laCandidate !== undefined ? { laCandidate } : {}),
    ...(nativePost !== undefined ? { nativePost } : {}),
  };
}

interface BridgeDeps extends UseBoardingPromptResponderDeps {
  createLock: ReturnType<typeof useBoardingLockStore.getState>['createLock'];
}

/**
 * #2438 ⑥ — 이미 같은 탑승역/노선으로 active lock이 있으면 true(중복 boarding intent).
 * 알림 [탑승] 액션이 먼저 처리돼 lock이 생성된 뒤 LA 버튼(같은 트립)이 뒤이어 도착하는
 * 케이스, 또는 그 반대 순서 모두 이 체크로 흡수한다.
 *
 * #2722 — 판정 로직은 `isDuplicateBoardingLock`(shared)으로 이전했다. 이 함수는 그 predicate를
 * PendingBoardingIntent shape에 맞게 얇게 감싸는 어댑터일 뿐 — 동작은 100% 동일하다. 수동 탭
 * 진입점(`useTransferTrainList`/`useBoardingLockController`)도 같은 shared predicate를 직접
 * 재사용해, LA·알림·수동 탭 세 채널이 하나의 dedup 규칙을 공유한다.
 *
 * #2786 리뷰(P2) — trainCode 인자는 명시적으로 `null`. LA 버튼 intent(`PendingBoardingIntent`)는
 * `originStation`/`line`만 갖고 특정 열차를 지목하지 않으므로 PENDING sentinel 승격 판정에
 * 참여할 trainCode가 없다 — station+line만으로 판정하는 기존 dedup을 그대로 유지한다는 의도를
 * `null` 명시로 코드에 남긴다(타입이 필수라 생략은 컴파일 에러).
 */
function isDuplicateBoardingIntent(intent: PendingBoardingIntent): boolean {
  // #3055 ⓖ — 기존 lock이 PENDING sentinel이면 중복이 아니라 "재POST로 backend 해소 응답을 받아
  // 승격할 기회"다(FG 진입 시 브릿지 재해소 → tryAutoLock → boarding-confirm → 응답 소비).
  // 예외는 **이 어댑터에서만** 둔다 — 공유 predicate의 "null = trainCode 모르는 채널 → station+line
  // dedup 유지" 의도(`duplicateBoardingLock.ts`)와 다른 호출처(`useTransferTrainList`·
  // `useBoardingLockController`)는 불변.
  const { lock } = useBoardingLockStore.getState();
  if (lock !== null && !isRealBoardingLock(lock)) return false;
  return isDuplicateBoardingLock(intent.line, intent.originStation, null);
}

/**
 * #2813 — App Group pending intent를 처리 전 폐기(clear)한다. stale 게이트 skip 경로 전용 —
 * dedup/handleResponse 로직과 무관하게 intent id만 넘겨 정리한다.
 */
function clearStalePendingBoardingIntent(intentId: string): void {
  try {
    clearPendingBoardingIntent(intentId);
  } catch (err) {
    log.warn('clearPendingBoardingIntent 실패', err as Error);
  }
}

/** 파서가 거부한 raw에서 clear용 id만 best-effort로 추출. 추출 불가면 null. */
function extractRawIntentId(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { id } = parsed as Record<string, unknown>;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** 처리 중인 intent id — 모듈 레벨(훅 인스턴스·리렌더와 무관하게 단일). `finally`에서 해제. */
const inFlightIntentIds = new Set<string>();

async function processPendingBoardingIntent(deps: BridgeDeps, nowMs: number): Promise<void> {
  let raw: string | null;
  try {
    raw = readPendingBoardingIntent();
  } catch (err) {
    log.warn('readPendingBoardingIntent 실패', err as Error);
    return;
  }
  if (!raw) return;

  const intent = parsePendingBoardingIntent(raw);
  if (!intent) {
    // #3048 — 파싱 실패 intent를 남겨두면 매 폴링마다 재파싱 실패 + App Group에 영구 잔류한다.
    // native clear는 저장된 id와 일치할 때만 제거하므로, 파서가 거부했어도 raw에서 id를 건질 수
    // 있으면(예: origin=null 버튼이 빈 역명으로 write) 그 id로 폐기한다.
    const rejectedId = extractRawIntentId(raw);
    log.warn('pending boarding intent 파싱 실패 — malformed payload, clear 시도', {
      clearable: rejectedId !== null,
    });
    if (rejectedId !== null) clearStalePendingBoardingIntent(rejectedId);
    return;
  }

  if (nowMs - intent.atMs > LIVE_ACTIVITY_INTENT_STALE_MS) {
    log.warn('stale pending boarding intent — 신선도 게이트 초과, skip + clear');
    clearStalePendingBoardingIntent(intent.id);
    return;
  }

  // #3055 PR-1 — 재진입 가드. clear는 아래 `await` 이후라 POST가 도는 동안 같은 intent가 다시 읽힌다(11/02
  // 19:55:00·:04 두 번 처리 → PENDING 2회). 트리거는 (T1) RootLayout 리렌더(inline deps → run 재생성),
  // (T2) AppState active 전이 즉시 실행, (T3) 5s 폴링 — 전부 이 진입점으로 모이므로 id 단위로 한 번만 통과시킨다.
  if (inFlightIntentIds.has(intent.id)) return;
  inFlightIntentIds.add(intent.id);
  try {
    await handleIntent(intent, deps, nowMs);
  } catch (err) {
    // 처리 중 예외는 clear하지 않는다 — 다음 실행이 재시도하고, 5분(stale)이면 위 게이트가 폐기한다.
    log.warn('pending boarding intent 처리 실패 — 다음 실행에서 재시도', err as Error);
  } finally {
    inFlightIntentIds.delete(intent.id);
  }
}

/** 브릿지가 이 intent를 어떻게 처리할지 — native 응답(`nativePost`) 상태에서 결정한다. */
type IntentRoute =
  | { kind: 'wait' }
  | { kind: 'apply-native'; resolvedTrainCode: string }
  | { kind: 'handle'; skipBackendForward: boolean };

const HANDLE_ROUTE: IntentRoute = { kind: 'handle', skipBackendForward: false };

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function decideIntentRoute(
  intent: PendingBoardingIntent,
  action: BoardingResponseAction,
  nowMs: number,
): IntentRoute {
  const { nativePost } = intent;
  if (!ACTION_MAP[action].nativeConfirm || nativePost === undefined) return HANDLE_ROUTE;
  if (nativePost === 'in-flight') {
    // 대기 예산 내 보류. 예산 경과 후엔 native 결과와 무관하게 fallback(위젯 프로세스가 죽어 in-flight가 남는 경우).
    return nowMs - intent.atMs <= NATIVE_CONFIRM_WAIT_MS ? { kind: 'wait' } : HANDLE_ROUTE;
  }
  if (!isSuccessStatus(nativePost.status)) return HANDLE_ROUTE;
  if (action === 'DISEMBARK_DISEMBARKED') {
    // native가 backend에 'disembarked'를 이미 반영했다 — 로컬 하차 처리만 하고 forward는 생략.
    return { kind: 'handle', skipBackendForward: true };
  }
  const { resolvedTrainCode } = nativePost;
  return resolvedTrainCode === undefined ? HANDLE_ROUTE : { kind: 'apply-native', resolvedTrainCode };
}

const RETRYABLE_APPLY_RESULTS: readonly LaNativeResolutionResult[] = ['failed', 'skipped-no-trip'];

/** 재시도가 의미 없는 응답: 성공(2xx) 또는 클라이언트 오류(4xx — trip 없음/payload 거부). 0·5xx·응답 없음은 재시도 대상. */
function isTerminalStatus(status: number | undefined): boolean {
  return status !== undefined && status >= 200 && status < 500;
}

/**
 * #3007 PR-2 — 종료 질문 [계속] 마커 처리. native `ContinueGuidanceIntent`가 POST를 시도했고 결과를 `nativePost`에 남겼다.
 * 성공/4xx면 그대로 clear, native가 실패(0/5xx)했거나 결과를 못 남겼으면(위젯 프로세스 종료) JS가 재전송한다.
 * 재전송도 실패하면 clear하지 않고 다음 실행에서 재시도한다(5분 stale 게이트가 상한).
 */
async function handleEndPromptContinue(intent: PendingBoardingIntent, nowMs: number): Promise<void> {
  const { nativePost } = intent;
  if (nativePost === 'in-flight' && nowMs - intent.atMs <= NATIVE_CONFIRM_WAIT_MS) return;
  const nativeStatus = typeof nativePost === 'object' ? nativePost.status : undefined;
  if (!isTerminalStatus(nativeStatus)) {
    const { status } = await postEndPromptContinue(intent.tripToken);
    if (!isTerminalStatus(status)) return;
  }
  clearStalePendingBoardingIntent(intent.id);
}

async function handleIntent(intent: PendingBoardingIntent, deps: BridgeDeps, nowMs: number): Promise<void> {
  const { action } = intent;
  if (action === END_PROMPT_CONTINUE_ACTION) return handleEndPromptContinue(intent, nowMs);

  const route = decideIntentRoute(intent, action, nowMs);
  if (route.kind === 'wait') return;

  let shouldRetry = false;
  if (route.kind === 'apply-native') {
    const result = await applyLaNativeResolution(intent, route.resolvedTrainCode, deps);
    // 'failed'(createLock 예외)와 'skipped-no-trip'(목적지 읽기 실패가 "없음"과 구분 불가 —
    // widgetRefreshContext catch)은 일시적일 수 있어 clear하지 않고 재시도한다(5분 stale 게이트가 상한).
    shouldRetry = RETRYABLE_APPLY_RESULTS.includes(result);
  } else if (action === 'BOARDING_BOARDED' && isDuplicateBoardingIntent(intent)) {
    log.info('duplicate boarding intent — active lock already exists, no-op');
  } else {
    const mapped = ACTION_MAP[action];
    const payload: BoardingPromptPayload = {
      kind: 'boarding-prompt',
      originStation: intent.originStation,
      line: intent.line,
      tripToken: intent.tripToken,
      hopEndKind: mapped.hopEnd ? 'disembark' : undefined,
      // 방향·trainCode는 싣지 않는다 — 열차 판정은 backend(PENDING + 응답 승격). 후보는 전달만.
      ...(intent.laCandidate !== undefined ? { laCandidate: intent.laCandidate } : {}),
      source: 'la-bridge',
      ...(route.skipBackendForward ? { skipBackendForward: true } : {}),
    };
    const outcome = await handleResponse(mapped.actionIdentifier, payload, deps);
    // POST를 시도했는데 응답 자체를 못 받았으면(status 없음) clear하지 않고 다음 실행에서 재시도한다.
    shouldRetry = outcome?.posted === true && outcome.status === undefined;
  }
  if (shouldRetry) return;

  // #3221 PR-4 (B2) — LA 버튼 응답을 처리했다(중복 no-op 포함). native `BoardingIntents`가 낙관적으로 카드를
  // 닫지만 앱이 JS로 처리한 시점에 한 번 더 닫아 두 경로 중 하나가 실패해도 카드가 남지 않게 한다(멱등).
  void endBoardingActivity('intent-response');

  try {
    clearPendingBoardingIntent(intent.id);
  } catch (err) {
    log.warn('clearPendingBoardingIntent 실패', err as Error);
  }
}

/**
 * 마운트 + AppState 'active' 진입 + foreground 폴링 시 App Group pending boarding intent를
 * 확인해 기존 boarding-prompt 응답 로직으로 위임한다. `deps`는 `useBoardingPromptResponder`와
 * 동일한 shape — caller(app/_layout.tsx)가 같은 값을 주입해 두 채널이 동일 컨텍스트를 공유한다.
 */
export function useLiveActivityIntentBridge(
  deps: UseBoardingPromptResponderDeps,
  // #2813 — atMs 신선도 게이트 판정용 now 주입 포인트(테스트 전용). 기본값 Date.now.
  now: () => number = Date.now,
): void {
  const createLock = useBoardingLockStore((s) => s.createLock);

  // usePolling은 callback을 ref로 잡아 매 tick 최신 클로저를 실행하므로, deps가 caller
  // 렌더마다 새 객체(app/_layout.tsx의 inline object)여도 run이 재생성되는 것과 무관하게
  // interval 자체는 재시작되지 않는다.
  const run = useCallback(() => {
    void processPendingBoardingIntent({ ...deps, createLock }, now());
  }, [createLock, deps, now]);

  useEffect(() => {
    run();
  }, [run]);

  usePolling(run, LIVE_ACTIVITY_INTENT_POLL_MS);
}
