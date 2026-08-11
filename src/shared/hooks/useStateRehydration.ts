/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 본 hook은 trip 상태가 살고 있는 모든 zustand store를
 * 한 곳에서 재수화·동기화하는 orchestrator. 여러 feature(route/alarm)의 store를 직접
 * 참조하는 것이 본질이므로 file-level disable로 옵트인 처리.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useDestinationStore } from '../../features/route/store/useDestinationStore';
import { useBoardingLockStore } from '../../features/alarm/store/useBoardingLockStore';
import { useLegAdvanceStore } from '../../features/alarm/store/useLegAdvanceStore';
import {
  clearTripEndedSentinel,
  getTripEndedSentinel,
  resolveTripEndedSentinelVerdict,
  setTripEndedSentinel,
} from '../../features/alarm/utils/tripEndedSentinel';
import { runTripBoundCleanups } from '../../features/alarm/store/tripBoundCleanups';
import {
  getTripStartedAt,
  tripLifecyclePhase,
} from '../../features/alarm/utils/tripStartStorage';
import {
  getNavigationPausedAt,
  isPauseAutoEndDue,
} from '../../features/alarm/utils/navigationPauseStorage';
import { appendAlarmLog } from '../../features/alarm/utils/alarmLog';
import {
  clearBackendSsotMirror,
  readBackendSsotMirror,
} from '../../features/alarm/utils/backendSsotMirror';
import { getCurrentTripCorrIdSync } from '../../features/observability/utils/tripCorrId';
import { triggerTripGroundTruthPrompt } from '../../features/debug/utils/triggerTripGroundTruthPrompt';
import { createLogger } from '../utils/logger';
import { addDomainBreadcrumb } from '../infra/monitoring/breadcrumb';

const logger = createLogger('useStateRehydration');

/**
 * FG 복귀 시 상태 hydration seam (#899 Seam C).
 *
 * 책임:
 *  1) 마운트 + AppState 'active' 진입마다 trip-bound store(destination/customOrigin/
 *     tripOrigin/lock/legAdvance)를 storage에서 재수화 — BG 동안 다른 채널(silent push 등)이
 *     storage를 갱신했을 수 있으므로 zustand snapshot을 항상 최신화. legAdvance(#2278)는
 *     지하에서 앱 kill 후 재기동해도 하차 응답 stamp가 사라지지 않도록 하는 P1-2 보강.
 *  2) trip-ended sentinel(`TRIP_ENDED_BY_BACKEND_AT_KEY`)이 있으면 destination/lock store를
 *     명시적으로 reset — BG에서 storage cleanup만 수행한 trip-ended가 in-memory zustand에
 *     stale state로 잠시 노출되는 회귀(#899)를 차단. 처리 후 sentinel 즉시 삭제.
 *
 * 호출 시점: app/_layout.tsx에서 1회 마운트. 마운트 자체가 첫 hydrate를 트리거.
 *
 * runAt 인자: 테스트에서 시각 주입용. 기본 Date.now.
 *
 * 멱등성: 동일 active 진입에서 여러 번 호출되어도 storage 키 부재 시 graceful no-op.
 */
export function useStateRehydration(): void {
  useEffect(() => {
    void runRehydration('mount');
    const handler = (state: AppStateStatus): void => {
      // BG/FG transition은 background↔active 양쪽 모두 의미 있음 — 디버그 시
      // crash가 active 진입 직후인지 BG로 내려간 직후인지 식별에 사용.
      if (state === 'active' || state === 'background') {
        addDomainBreadcrumb('lifecycle', state);
      }
      if (state === 'active') void runRehydration('active');
    };
    const sub = AppState.addEventListener('change', handler);
    return () => sub.remove();
  }, []);
}

/** 한 번의 재수화 사이클. mount/active 모두 동일 로직. */
async function runRehydration(trigger: 'mount' | 'active'): Promise<void> {
  // sentinel 우선 — store reset이 hydrate된 stale state를 덮지 않도록 순서 보장.
  const sentinel = await getTripEndedSentinel();
  if (sentinel !== null) {
    // #2114 — sentinel이 현재 활성 trip과 다른 trip의 것이면(stale) reset 없이 sentinel만
    // 폐기. 2026-08-03 건대 RCA: 밤샘 trip force-end sentinel이 그 직후 등록된 새 trip을
    // FG 재진입 시 통째로 삭제하던 회귀. 판정은 corrId 1순위 + timestamp fallback
    // (resolveTripEndedSentinelVerdict, 방안 C′).
    const tripStartedAt = await getTripStartedAt();
    const currentCorrId = getCurrentTripCorrIdSync();
    const verdict = resolveTripEndedSentinelVerdict(sentinel, tripStartedAt, currentCorrId);
    if (verdict === 'stale') {
      logger.info(
        `trigger=${trigger} trip-ended sentinel=${JSON.stringify(sentinel)} stale (tripStartedAt=${tripStartedAt}, currentCorrId=${currentCorrId}) → discard without reset`,
      );
      appendAlarmLog({
        ts: Date.now(),
        source: 'lifecycle-backstop',
        outcome: 'suppressed',
        reason: 'trip-sentinel-stale-discarded',
      });
      await clearTripEndedSentinel();
    } else {
      logger.info(`trigger=${trigger} trip-ended sentinel=${JSON.stringify(sentinel)} → store reset`);
      // #1351 R2 — 과거에는 setDestination(null)을 trigger로 사용했지만, prev=null인 경우
      // isSwitch=false로 평가되어 cleanup chain이 실행되지 않는 버그가 있었다.
      // isSwitch 의존 없이 storage cleanup을 직접 호출. 멱등이므로 Fix 1 / silent push handler와
      // 중복 호출 안전. 메모리 store도 setState로 즉시 reset해 stale state가 노출되지 않게 한다.
      // #1597 — clearTripCorrId가 cache를 비우기 전에 종료된 trip의 corrId snapshot 캡처.
      const endedCorrIdSnapshot = getCurrentTripCorrIdSync();
      await runTripBoundCleanups();
      // #1597 — trip-end 사용자 정답지 prompt enqueue (cleanup 후, corrId snapshot으로).
      await triggerTripGroundTruthPrompt(endedCorrIdSnapshot);
      useDestinationStore.setState({
        destination: null,
        customOrigin: null,
        tripOrigin: null,
      });
      addDomainBreadcrumb('trip', 'end', { reason: 'sentinel-rehydration' });
      await useBoardingLockStore.getState().releaseLock();
      await clearTripEndedSentinel();
    }
  }

  // 항상 storage → memory hydrate (sentinel 분기에서 reset된 store는 빈 storage 그대로 유지).
  const destStore = useDestinationStore.getState();
  await Promise.allSettled([
    destStore.loadDestination(),
    destStore.loadCustomOrigin(),
    destStore.loadTripOrigin(),
    useBoardingLockStore.getState().loadLock(),
    // #2278 (PR #2287 리뷰 P1-2) — leg-advance stamp도 storage → memory 재수화. 지하에서 앱이
    // kill된 뒤 재기동하면 in-memory stamp가 사라지므로, 이 공통 hydrate chokepoint(mount +
    // AppState 'active' 진입)에서 복원하지 않으면 원 버그(releaseLock 직후 route.stopsToTransfer
    // frozen → fromLine 고착)가 재기동 후 그대로 재현된다.
    useLegAdvanceStore.getState().loadLegAdvance(),
  ]);

  // #1573 (T10) — trip lifecycle 단계적 backstop. FG 복귀 / mount 마다 확인.
  // silence(6h~9h)와 force-end(9h+)는 staged-handling 룰에 따라 분리 처리한다.
  //   silence — alarm/notify 차단만 (UI는 유지). KTX/장거리 trip false positive 방지.
  //   force-end — runTripBoundCleanups + sentinel + store reset. lockless 9h+ 잔존 #1346 차단.
  //
  // silence 적재는 entry 1회당 한 cycle만 의미가 있고 멱등이 자연 — 매 active 진입마다 1엔트리.
  // share dump에서 lifecycle-backstop source 카운트로 측정.
  await runLifecycleBackstop(trigger);

  // #2293 (Part of #2285 결정 ①+③) — "일시정지" 15분 경과 자동 종료 backstop. 신규 타이머
  // 대신 이 chokepoint(mount + AppState 'active' 진입)에 편승 — 앱이 kill된 채로 15분이
  // 지나도 다음 진입 시 정리된다. known limitation: 앱이 계속 kill 상태면 backend trip은
  // 다음 진입까지 생존(backend-side pause 인지는 ADR-031 Phase 2, 본 PR 스코프 밖).
  await runNavigationPauseBackstop(trigger);

  // #1598 — app boot / FG 복귀 시 active trip이 없는데 Backend SSoT mirror가 잔존하면 즉시 clear.
  // 2026-06-20 trip dump evidence: 사용자 위치 용마산 / activeTrip=(none) / mirror=건대입구.
  // TRIP_BOUND_CLEANUPS는 trip 종료 경로(setDestination(null)/silent push trip-ended/sentinel/
  // launch reconciliation)에서만 동작 — 정상 종료가 누락된 옛 trip의 mirror 잔재는 본 backstop으로
  // 회수. mirror read 실패는 graceful — 다음 active 진입에서 재시도.
  await clearStaleBackendSsotMirrorIfNoTrip(trigger);
}

/**
 * #1598 — active trip 없음 + mirror 잔존 시 mirror만 즉시 제거.
 *
 * `getTripStartedAt`을 단일 source로 삼아 "active trip 있음" 판정. tripStartedAt 부재 = 정상 종료
 * 후 잔재이거나 boot 시점 미시작 상태. mirror가 있으면 cascade picker가 다음 polling cycle에서
 * 이전 trip의 stationId를 backend-ssot tier로 채택하는 회귀(#1598)를 차단.
 *
 * mirror 부재 시 read만 하고 종료 — 불필요한 storage write 회피. throw 없음 — launch 차단 금지.
 */
async function clearStaleBackendSsotMirrorIfNoTrip(
  trigger: 'mount' | 'active',
): Promise<void> {
  try {
    const startedAt = await getTripStartedAt();
    if (startedAt !== null) return;
    const mirror = await readBackendSsotMirror();
    if (mirror === null) return;
    logger.info(`trigger=${trigger} no active trip + mirror stale → clearBackendSsotMirror`);
    await clearBackendSsotMirror();
  } catch (e) {
    logger.warn('stale mirror clear 실패 (graceful)', e);
  }
}

/**
 * #1573 (T10) — trip 시작 시각 기준 단계 판정 후 backstop 실행. throw 없음 — launch 차단 금지.
 *
 * silence는 share dump 측정만, force-end는 silent push trip-ended와 동일한 cleanup 시퀀스를
 * 따라 store 메모리/storage 일관성 유지. setDestination 호출 대신 runTripBoundCleanups + setState
 * 직접 호출은 #1351 R2와 동일 이유(prev=null 시 isSwitch=false로 cleanup chain skip되는 버그 회피).
 */
async function runLifecycleBackstop(trigger: 'mount' | 'active'): Promise<void> {
  try {
    const startedAt = await getTripStartedAt();
    if (startedAt === null) return;
    // tripLifecyclePhase는 startedAt non-null이면 'none' 외 3개 phase만 반환.
    const phase = tripLifecyclePhase(startedAt);
    if (phase === 'normal') return;

    const now = Date.now();
    const elapsedMs = now - startedAt;

    if (phase === 'silence') {
      appendAlarmLog({
        ts: now,
        source: 'lifecycle-backstop',
        outcome: 'suppressed',
        reason: 'trip-lifecycle-silence',
      });
      logger.info(`trigger=${trigger} silence elapsedMs=${elapsedMs}`);
      return;
    }

    // force-end (9h+). silent push trip-ended와 동일 시퀀스.
    appendAlarmLog({
      ts: now,
      source: 'lifecycle-backstop',
      outcome: 'fired',
      reason: 'trip-lifecycle-force-ended',
    });
    logger.info(`trigger=${trigger} force-end elapsedMs=${elapsedMs} → cleanup`);
    // #1597 — clearTripCorrId가 cache를 비우기 전에 종료된 trip의 corrId snapshot 캡처.
    const endedCorrIdSnapshot = getCurrentTripCorrIdSync();
    await runTripBoundCleanups();
    // #1597 — trip-end 사용자 정답지 prompt enqueue (cleanup 후, corrId snapshot으로).
    await triggerTripGroundTruthPrompt(endedCorrIdSnapshot);
    useDestinationStore.setState({
      destination: null,
      customOrigin: null,
      tripOrigin: null,
    });
    addDomainBreadcrumb('trip', 'end', { reason: 'lifecycle-9h-force-end' });
    await useBoardingLockStore.getState().releaseLock();
    // #2114 (방안 C′) — sentinel에 corrId 동봉해 다음 소비 시점 trip 인스턴스 스코프 비교 가능하게.
    await setTripEndedSentinel(now, endedCorrIdSnapshot);
  } catch (e) {
    logger.warn('lifecycle backstop 실패 (graceful)', e);
  }
}

/**
 * #2293 (Part of #2285 결정 ①+③) — "일시정지"(navigationActive=false && destination 존재)
 * 상태 PAUSE_AUTO_END_MS(15분) 경과 시 자동 종료. throw 없음 — launch 차단 금지.
 *
 * pausedAt은 trip 종료 전체 경로(TRIP_BOUND_CLEANUPS)에서 항상 함께 제거되므로, 이 값이
 * 남아있다는 것 자체가 "아직 어떤 종료 경로도 거치지 않은 활성 일시정지"를 의미한다 —
 * destination 존재 여부를 별도로 재확인할 필요 없음(force-end backstop과 동일 불변식).
 *
 * force-end(9h+) 분기와 동일한 cleanup 시퀀스를 재사용한다(silent push trip-ended와 동형) —
 * setDestination 호출 대신 runTripBoundCleanups + setState 직접 호출은 #1351 R2와 동일 이유.
 */
async function runNavigationPauseBackstop(trigger: 'mount' | 'active'): Promise<void> {
  try {
    const pausedAt = await getNavigationPausedAt();
    const now = Date.now();
    if (!isPauseAutoEndDue(pausedAt, now)) return;

    appendAlarmLog({
      ts: now,
      source: 'lifecycle-backstop',
      outcome: 'fired',
      reason: 'trip-paused-auto-ended',
    });
    logger.info(`trigger=${trigger} pause auto-end (pausedAt=${pausedAt}) → cleanup`);
    // #1597 — clearTripCorrId가 cache를 비우기 전에 종료된 trip의 corrId snapshot 캡처.
    const endedCorrIdSnapshot = getCurrentTripCorrIdSync();
    await runTripBoundCleanups();
    // #1597 — trip-end 사용자 정답지 prompt enqueue (cleanup 후, corrId snapshot으로).
    await triggerTripGroundTruthPrompt(endedCorrIdSnapshot);
    useDestinationStore.setState({
      destination: null,
      customOrigin: null,
      tripOrigin: null,
    });
    addDomainBreadcrumb('trip', 'end', { reason: 'navigation-pause-auto-end' });
    await useBoardingLockStore.getState().releaseLock();
  } catch (e) {
    logger.warn('navigation pause backstop 실패 (graceful)', e);
  }
}
