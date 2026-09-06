import { create } from 'zustand';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import { isBoardingLockExpired } from '../../../shared/types/boardingLock';
import {
  clearBoardingLock,
  getBoardingLock,
  setBoardingLock,
} from '../utils/boardingLockStorage';
import { clearDismissSilence } from '../utils/dismissSilenceStorage';
import { addDomainBreadcrumb } from '../../../shared/infra/monitoring/breadcrumb';
import { isSimpleArchEnabled } from '../../../shared/config/archFlag';
import {
  pushLockLifecycleEntry,
  type LockLifecycleCreateSource,
} from '../utils/boardingLockLifecycleBuffer';

/**
 * #1438 (E5) — release 사유 식별자.
 *
 * - 'user'            — 사용자가 "하차" 직접 탭 (default).
 * - 'transfer'        — backend silent push로 환승 release 통보.
 * - 'vanish'          — backend silent push로 trainCode 소실 release 통보.
 * - 'destination-change' — 화면에서 destination이 바뀌어 stale lock 자동 release (controller).
 * - 'expired'         — 자동 만료(`checkExpiry`).
 * - 'train-code-mismatch' — 같은 노선에서 다른 trainCode가 90s 지속 관찰 (useTrainCodeMismatchDetector, #1659).
 * - 'trip-cleanup'    — #2152 (P1) `tripBoundCleanups.clearTripBoundStoreMemory`가 trip 종료
 *   시 store 메모리를 정리하며 releaseLock을 경유하는 generic 사유. silent push trip-ended /
 *   FG setDestination(null/switch) / useStateRehydration sentinel / cold-launch reconciliation
 *   4개 진입점이 모두 `runTripBoundCleanups`만 호출하므로 개별 사유를 구분할 수 없다 — 그 지점에서
 *   lock이 살아있었다는 사실 자체가 진단 가치(오토락 범인 소거법).
 */
export type LockReleaseReason =
  | 'user'
  | 'transfer'
  | 'vanish'
  | 'destination-change'
  | 'expired'
  | 'train-code-mismatch'
  | 'trip-cleanup';

/**
 * #2290 P1 (PR #2295 리뷰 2회차) — `createLock` 호출부가 만드는 lock payload. `boardingEvidence`는
 * 이 타입에서 의도적으로 제외된다 — 호출자가 lock 객체 안에 산발적으로 stamp하면 새 lock 생성
 * 경로가 추가될 때 stamp를 빠뜨려도 컴파일이 통과해버린다(P1-1 회귀의 재발 형태). 대신
 * `createLock`의 별도 필수 인자 `evidence`로 강제해, 신규 호출부가 이 값을 명시하지 않으면
 * 컴파일이 실패하도록 한다.
 */
export type BoardingLockInput = Omit<BoardingLock, 'boardingEvidence'>;

/**
 * BoardingLock 전역 store (#584 PR A).
 *
 * Single Lock only — trip 1개에 leg 1개. multi-transfer는 createLock으로 교체(PR E).
 * 모든 mutation은 in-memory state + AsyncStorage 양쪽 동기 — Fusion/스케줄러가 둘 중 어디든
 * 읽어도 같은 결과를 얻게 한다.
 */
export interface BoardingLockState {
  lock: BoardingLock | null;
  /**
   * Trip 진입 또는 환승 전환 시 호출. 기존 Lock은 자동 교체.
   *
   * #2152 — source는 lifecycle breadcrumb에 stamp되는 생성 경로 식별자. 사용자 명시 탭
   * (BoardingTrainList)과 boardingPrompt 응답을 구분해 오토락 범인 특정을 소거법으로 가능하게
   * 한다. 미전달(그 외 경로 — 자동 lock/backend suggestion 등)은 'other'로 기록.
   *
   * #2290 P1 — `evidence`는 필수 인자다(기본값 없음). "탑승했다/곧 탑승한다"는 device-side 또는
   * backend-confirmed evidence가 이 lock 생성 시점에 실제로 있었는지를 호출자가 명시해야 한다:
   *   - `true` — arvlCd 강 게이트 + consensus를 통과한 device-side auto-lock, backend가 이미
   *     arvlcd-confirmed evidence로 합의한 lockSuggestion(#1534), 또는 backend가 (기존 lock +
   *     trainCode 변경) 3조건을 모두 검증한 transfer-swap candidate처럼 "생성 시점 자체가 탑승
   *     evidence"인 경로.
   *   - `false` — user-tap(BoardingTrainList 직접 탭), boardingPrompt 응답 자동lock, 환승 leg
   *     device auto-lock(D5), backend가 evidence 없이 발급한 autoLock candidate처럼 "미래 열차
   *     선택/의향"만 있고 탑승 확정 evidence가 없는 경로. `hasConsumedOriginWait`가 이 경우
   *     `initialEtaSeconds` 경과 여부로 별도 판정한다(부재 시 보수적으로 대기 유지).
   */
  createLock: (
    lock: BoardingLockInput,
    evidence: boolean,
    source?: LockLifecycleCreateSource,
  ) => Promise<void>;
  /**
   * 사용자가 "하차" 탭하거나 trip 종료 시 호출.
   *
   * #1438 (E5) — silent push payload `lockReleasedReason`으로 backend가 lock release를 알릴 때도
   * 같은 진입점으로 호출. reason은 breadcrumb 메타에만 stamp되며 멱등 — lock=null에서 호출돼도
   * graceful no-op.
   */
  releaseLock: (reason?: LockReleaseReason) => Promise<void>;
  /** 앱 마운트 시 storage에서 복원. */
  loadLock: () => Promise<void>;
  /**
   * 자동 만료 확인. 만료 시 lock=null로 상태 갱신 + storage 정리 후 true 반환.
   * now 인자는 테스트 시각 주입용 — 기본 Date.now().
   */
  checkExpiry: (now?: number) => Promise<boolean>;
}

export const useBoardingLockStore = create<BoardingLockState>((set, get) => ({
  lock: null,

  createLock: async (
    lockInput: BoardingLockInput,
    evidence: boolean,
    source: LockLifecycleCreateSource = 'other',
  ) => {
    // #2290 P1 — evidence를 별도 필수 인자로 받아 여기서 한 곳에서만 lock 객체에 합성한다.
    // 호출부가 lock 객체 리터럴 안에 산발적으로 boardingEvidence를 stamp하던 방식(P1-1)은
    // 새 생성 경로가 추가돼도 stamp를 빠뜨리면 컴파일이 통과했다 — 이 지점 하나로 강제한다.
    const lock: BoardingLock = { ...lockInput, boardingEvidence: evidence };
    // #1996 (Phase 1-7, ADR-022 A4) — boardingStationId 불변 정책 (flag ON 시).
    //
    // route 등록 시 확정된 boardingStationId는 절대 자동 변경 금지 (auto-swap / reanchored /
    // fusion cascade 금지). 예외는 정당한 route 재등록:
    //   1) trainCode 변경 (환승 leg 진입 → 새 열차 = 사실상 새 route)
    //   2) boardingLine 변경 (환승 → 다른 노선 leg 진입)
    //   3) destinationId 변경 (다른 trip)
    // 위 3가지가 모두 동일한데 boardingStationId만 다른 createLock은 auto-swap 시도로 간주 → skip.
    //
    // Flag OFF (default) 시 기존 동작 유지 — 어떤 createLock이든 기존 lock을 교체.
    // Flag ON 시 위 정책을 강제해 회귀 방어.
    if (isSimpleArchEnabled()) {
      const prev = get().lock;
      if (
        prev &&
        prev.destinationId === lock.destinationId &&
        prev.trainCode === lock.trainCode &&
        prev.boardingLine === lock.boardingLine &&
        prev.boardingStationId !== lock.boardingStationId
      ) {
        // 동일 route/leg에서 boardingStationId만 다른 lock 재생성 시도 → auto-swap 차단.
        // 사용자 명시 route 재등록은 (trainCode 또는 boardingLine 변경)으로 감지되므로 정당한
        // 환승/재탑승 경로는 그대로 통과. 본 분기는 순수 "같은 leg 안에서 boardingStationId만
        // silently overwrite" 회귀 만 차단한다.
        addDomainBreadcrumb('boarding', 'lock-create-skip-immutable', {
          trainCode: lock.trainCode,
          line: lock.boardingLine,
          prevBoardingStationId: prev.boardingStationId,
          attemptedBoardingStationId: lock.boardingStationId,
        });
        return;
      }
    }
    set({ lock });
    await setBoardingLock(lock);
    // #746: 새 lock 생성 = 사용자가 새 leg에 탑승 의사 명시 → 이전 dismiss silence는 무효.
    // 동일 trip 내 환승으로 lock이 교체되는 경우에도 같은 의미 — 즉시 클리어.
    await clearDismissSilence();
    addDomainBreadcrumb('boarding', 'lock-create', {
      trainCode: lock.trainCode,
      line: lock.boardingLine,
    });
    // #2152 — lifecycle breadcrumb ring buffer. addDomainBreadcrumb(Sentry)는 device 밖 관측용,
    // 본 push는 DebugModal 덤프(1차 evidence)에서 사후 재구성 가능하게 하는 별 채널.
    pushLockLifecycleEntry({
      kind: 'boarding-lock-lifecycle',
      event: 'create',
      ts: Date.now(),
      source,
      trainCode: lock.trainCode,
      line: lock.boardingLine,
      stationId: lock.boardingStationId,
    });
  },

  releaseLock: async (reason: LockReleaseReason = 'user') => {
    const prev = get().lock;
    set({ lock: null });
    await clearBoardingLock();
    if (prev) {
      addDomainBreadcrumb('boarding', 'lock-release', {
        trainCode: prev.trainCode,
        line: prev.boardingLine,
        reason,
      });
      // #2152 — lifecycle breadcrumb ring buffer.
      pushLockLifecycleEntry({
        kind: 'boarding-lock-lifecycle',
        event: 'release',
        ts: Date.now(),
        reason,
        trainCode: prev.trainCode,
        line: prev.boardingLine,
      });
    }
  },

  loadLock: async () => {
    const stored = await getBoardingLock();
    set({ lock: stored });
  },

  checkExpiry: async (now: number = Date.now()) => {
    const { lock } = get();
    if (!lock) return false;
    if (!isBoardingLockExpired(lock, now)) return false;
    set({ lock: null });
    await clearBoardingLock();
    return true;
  },
}));
