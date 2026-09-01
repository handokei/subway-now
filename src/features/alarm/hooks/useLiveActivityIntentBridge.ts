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
import { LIVE_ACTIVITY_INTENT_POLL_MS } from '../../../shared/constants/boardingLock';
import { isBoardingLockExpired } from '../../../shared/types/boardingLock';
import { isValidLineNumber } from '../../../shared/constants/lineApiNames';
import { findStationByNameAndLine } from '../../../shared/utils/stationLookup';
import { useBoardingLockStore } from '../store/useBoardingLockStore';
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
import { createLogger } from '../../../shared/utils/logger';

const log = createLogger('liveActivityIntentBridge');

/** App Group pending boarding intent — native AppIntent가 write하는 schema. */
export interface PendingBoardingIntent {
  id: string;
  tripToken: string;
  action: 'BOARDING_BOARDED' | 'DISEMBARK_DISEMBARKED' | 'BOARDING_NOT_BOARDED' | 'DISEMBARK_NOT_YET';
  originStation: string;
  line: string;
  atMs: number;
}

const VALID_ACTIONS: readonly PendingBoardingIntent['action'][] = [
  'BOARDING_BOARDED',
  'DISEMBARK_DISEMBARKED',
  'BOARDING_NOT_BOARDED',
  'DISEMBARK_NOT_YET',
];

/**
 * #2470 — 알림 대칭 액션(미탑승/아직이요) 포함 4종 action → handleResponse 호출 파라미터
 * data-driven 매핑(글로벌 규칙 3, 하드코딩 삼항 금지).
 */
const ACTION_MAP: Record<PendingBoardingIntent['action'], { actionIdentifier: string; hopEnd: boolean }> = {
  BOARDING_BOARDED: { actionIdentifier: BOARDING_PROMPT_ACTION_BOARDED, hopEnd: false },
  BOARDING_NOT_BOARDED: { actionIdentifier: BOARDING_PROMPT_ACTION_NOT_BOARDED, hopEnd: false },
  DISEMBARK_DISEMBARKED: { actionIdentifier: DISEMBARK_ACTION_DISEMBARKED, hopEnd: true },
  DISEMBARK_NOT_YET: { actionIdentifier: DISEMBARK_ACTION_NOT_YET, hopEnd: true },
};

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
  if (typeof o.originStation !== 'string' || o.originStation.length === 0) return null;
  if (typeof o.line !== 'string' || o.line.length === 0) return null;
  if (typeof o.atMs !== 'number') return null;
  return {
    id: o.id,
    tripToken: o.tripToken,
    action: o.action as PendingBoardingIntent['action'],
    originStation: o.originStation,
    line: o.line,
    atMs: o.atMs,
  };
}

interface BridgeDeps extends UseBoardingPromptResponderDeps {
  createLock: ReturnType<typeof useBoardingLockStore.getState>['createLock'];
}

/**
 * #2438 ⑥ — 이미 같은 탑승역/노선으로 active lock이 있으면 true(중복 boarding intent).
 * 알림 [탑승] 액션이 먼저 처리돼 lock이 생성된 뒤 LA 버튼(같은 트립)이 뒤이어 도착하는
 * 케이스, 또는 그 반대 순서 모두 이 체크로 흡수한다.
 */
function isDuplicateBoardingIntent(intent: PendingBoardingIntent): boolean {
  const lock = useBoardingLockStore.getState().lock;
  if (!lock) return false;
  if (isBoardingLockExpired(lock, Date.now())) return false;
  if (!isValidLineNumber(intent.line) || lock.boardingLine !== intent.line) return false;
  const station = findStationByNameAndLine(intent.originStation, intent.line);
  return station !== null && station.id === lock.boardingStationId;
}

async function processPendingBoardingIntent(deps: BridgeDeps): Promise<void> {
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
    log.warn('pending boarding intent 파싱 실패 — malformed payload');
    return;
  }

  if (intent.action === 'BOARDING_BOARDED' && isDuplicateBoardingIntent(intent)) {
    log.info('duplicate boarding intent — active lock already exists, no-op');
  } else {
    const mapped = ACTION_MAP[intent.action];
    const payload: BoardingPromptPayload = {
      kind: 'boarding-prompt',
      originStation: intent.originStation,
      line: intent.line,
      tripToken: intent.tripToken,
      hopEndKind: mapped.hopEnd ? 'disembark' : undefined,
    };
    await handleResponse(mapped.actionIdentifier, payload, deps);
  }

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
export function useLiveActivityIntentBridge(deps: UseBoardingPromptResponderDeps): void {
  const createLock = useBoardingLockStore((s) => s.createLock);

  // usePolling은 callback을 ref로 잡아 매 tick 최신 클로저를 실행하므로, deps가 caller
  // 렌더마다 새 객체(app/_layout.tsx의 inline object)여도 run이 재생성되는 것과 무관하게
  // interval 자체는 재시작되지 않는다.
  const run = useCallback(() => {
    void processPendingBoardingIntent({ ...deps, createLock });
  }, [createLock, deps]);

  useEffect(() => {
    run();
  }, [run]);

  usePolling(run, LIVE_ACTIVITY_INTENT_POLL_MS);
}
