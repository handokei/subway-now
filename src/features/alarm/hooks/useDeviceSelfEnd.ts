/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration (#2043): device self-contained 자동종료 hook은 route (destination /
 * arc / progressM) + nearest-station (positionStability) + alarm (runTripBoundCleanups + sentinel +
 * alarmLog) 3개 슬라이스 신호를 묶어 fire path 없이 trip 종료 chain을 발화한다.
 *
 * useLaunchTripReconciliation / useStateRehydration 과 동형의 orchestrator 패턴이라 file-level
 * disable 옵트인 (ADR Phase 5). 후속 orchestration 슬라이스 이전 예정.
 */
/**
 * Device self-contained 자동종료 hook (#2043, β 옵션).
 *
 * 배경 (관찰 22):
 *   - PR #2041(γ' fix): silent push 도달한 케이스의 FG UI 잔존 8-18초 해결.
 *   - 관찰 22 잔여 gap: silent push 미도달 or 앱 kill 6h+ → sentinel 저장 안 됨 → 9h+
 *     lifecycle backstop만 유일 backup. 사용자가 몇 시간 앱 재개해도 UI 안내가 안 사라짐.
 *
 * Paradigm 정합 ([[feedback-device-self-contained-fusion]]):
 *   "backend/GPS/WiFi 다 죽어도 device 보장" → 자동종료도 device self-contained 확장.
 *
 * 3-Signal fusion (β 옵션 초기 스코프):
 *   Signal 1 fusion-destination: fusion === destination + 강 confidence + 30s 지속
 *   Signal 2 arc-completion:     arc ≥ 0.95 + stationary 60s 지속
 *   Signal 3 eta-backstop:       elapsed > expectedEta × 2 + stationary 5분 지속
 *
 *   Signal 4 backend-timeout은 silentPushTask.ts 4-way 편집 충돌 회피로 후속 이슈 분리.
 *
 * Idempotent guard:
 *   - trigger 전 `getTripEndedSentinel()` 확인 → non-null 이면 이미 backend cleanup 실행 → skip.
 *   - trigger 시 `runTripBoundCleanups()` + `setTripEndedSentinel(now)` 호출 → backend가 뒤늦게
 *     cleanup 시도해도 이미 정리돼 no-op.
 *   - useLaunchTripReconciliation / useStateRehydration lifecycle backstop / silent push trip-ended
 *     3개 chain과 동일 시퀀스 사용 — 중복 호출 안전(멱등).
 *
 * False positive 방어:
 *   - Signal 1: FusionConfidence 강 신호 화이트리스트만 통과 (gps-only/gps-only-underground 배제).
 *   - Signal 2: stationary 60s 지속 요구 — 움직임 중이면 trigger X.
 *   - Signal 3: eta × 2 gate + stationary 5분 — KTX 등 실 장거리 trip은 eta 자체가 커서 자연 방어.
 *
 * 마운트: HomeScreen (fusion 신호 이미 생성). useStationAlarm 과 동형 배치.
 *
 * 호출 시점: fusion 신호 변경 tick마다 평가. 신호 지속 시간은 ref로 유지 (첫 진입 tick의 ts 저장,
 * 다음 tick에서 elapsed 계산). 매 render마다 storage read를 피하려 tripStartedAt은 destinationId
 * 변경 감지 effect로 한 번만 load.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Station } from '../../../shared/types/station';
import type { FusionConfidence } from '../../../shared/types/fusion';
import type { PositionStability } from '../../nearest-station/utils/positionStaticDetector';
import { createLogger } from '../../../shared/utils/logger';
import {
  fusionDestinationSignal,
  arcCompletionSignal,
  etaBackstopSignal,
  shouldTriggerSelfEnd,
  type SelfEndSignalReason,
} from '../utils/deviceSelfEndSignals';
import { getTripStartedAt } from '../utils/tripStartStorage';
import {
  clearTripEndedSentinel,
  getTripEndedSentinel,
  resolveTripEndedSentinelVerdict,
  setTripEndedSentinel,
} from '../utils/tripEndedSentinel';
import { runTripBoundCleanups } from '../store/tripBoundCleanups';
import { triggerTripEndRecall } from '../utils/triggerTripEndRecall';
import { getCurrentTripCorrIdSync } from '../../observability/utils/tripCorrId';
import { triggerTripGroundTruthPrompt } from '../../debug/utils/triggerTripGroundTruthPrompt';
import { appendAlarmLog } from '../utils/alarmLog';
import { useDestinationStore } from '../../route/store/useDestinationStore';
import { useBoardingLockStore } from '../store/useBoardingLockStore';
import { addDomainBreadcrumb } from '../../../shared/infra/monitoring/breadcrumb';

const logger = createLogger('useDeviceSelfEnd');

const REASON_TO_ALARM_LOG_REASON: Record<
  SelfEndSignalReason,
  'trip-device-self-end-fusion-destination'
  | 'trip-device-self-end-arc-completion'
  | 'trip-device-self-end-eta-backstop'
> = {
  'fusion-destination': 'trip-device-self-end-fusion-destination',
  'arc-completion': 'trip-device-self-end-arc-completion',
  'eta-backstop': 'trip-device-self-end-eta-backstop',
};

export interface UseDeviceSelfEndInputs {
  /** Fusion result.station.id (또는 fusion result 자체). null이면 아직 판정 불가. */
  currentStation: Station | null;
  /** Fusion confidence 라벨. */
  confidence: FusionConfidence | null;
  /** Route arc 진행도 0~1. useRouteProgress의 progressM / arc.totalM. null이면 미활성. */
  arcProgress: number | null;
  /** Position stability. 'static' 이면 stationary=true. */
  positionStability: PositionStability;
  /**
   * Trip 예상 소요 시간 (ms). Signal 3(eta-backstop) gate에 사용. null이면 Signal 3 skip.
   * 호출자(HomeScreen)가 route.totalTimeSec × 1000 등으로 계산해 전달.
   */
  expectedTripDurationMs: number | null;
}

/**
 * device self-end 자동종료 hook.
 *
 * fusion signal 변경 tick마다 3-signal 판정 → 하나라도 trigger면 idempotent guard 통과 후
 * runTripBoundCleanups + setTripEndedSentinel 시퀀스 발화.
 *
 * @param inputs.currentStation           fusion nearestStation
 * @param inputs.confidence               fusion confidence
 * @param inputs.arcProgress              route arc 0~1
 * @param inputs.positionStability        static/moving/unknown
 * @param inputs.expectedTripDurationMs   trip 예상 소요 (Signal 3 backstop)
 */
export function useDeviceSelfEnd(inputs: UseDeviceSelfEndInputs): void {
  const destination = useDestinationStore((s) => s.destination);
  const releaseLock = useBoardingLockStore((s) => s.releaseLock);
  const [tripStartedAt, setTripStartedAt_] = useState<number | null>(null);

  // signal 지속 시간 tracker refs — 각 signal 최초 진입 tick의 ts.
  const destinationMatchStartedAtRef = useRef<number | null>(null);
  const stationaryStartedAtRef = useRef<number | null>(null);
  const stationary5minStartedAtRef = useRef<number | null>(null);

  // trigger fired guard — 같은 trip에서 중복 호출 방지 (idempotent chain 자체도 안전하지만
  // 불필요 storage/log I/O 회피).
  const firedForDestinationIdRef = useRef<string | null>(null);

  // destination id 변경 감지 → tripStartedAt 재로드 + ref 리셋 (새 trip은 카운트 처음부터).
  const destinationId = destination?.id ?? null;
  useEffect(() => {
    destinationMatchStartedAtRef.current = null;
    stationaryStartedAtRef.current = null;
    stationary5minStartedAtRef.current = null;
    firedForDestinationIdRef.current = null;
    if (destinationId === null) {
      setTripStartedAt_(null);
      return;
    }
    let cancelled = false;
    void getTripStartedAt().then((v) => {
      if (!cancelled) setTripStartedAt_(v);
    });
    return () => {
      cancelled = true;
    };
  }, [destinationId]);

  const performSelfEnd = useCallback(
    async (reason: SelfEndSignalReason, capturedDestinationId: string): Promise<void> => {
      // Ref를 async guard 전에 즉시 stamp — sentinel await 대기 사이 useEffect 재실행으로 인한
      // 중복 performSelfEnd 호출 방지. 두 번째 effect tick은 이 ref 값으로 useEffect 진입 guard
      // (firedForDestinationIdRef.current === destinationId)를 통과하지 못하고 return.
      // sentinel이 이미 있어 skip되는 케이스에도 ref는 stamp된 채로 남지만, 그 경우 이미 backend
      // cleanup이 실행됐거나 진행 중이라 재발화도 스킵되어야 정합.
      firedForDestinationIdRef.current = capturedDestinationId;
      try {
        // #1597 — clearTripCorrId가 cache를 비우기 전에 (아직 살아있는) 현재 trip의 corrId
        // snapshot 캡처. #2114 (방안 C′) — sentinel 판정의 currentCorrId로도 재사용.
        const endedCorrIdSnapshot = getCurrentTripCorrIdSync();

        // Idempotent guard: sentinel 이미 있으면 backend cleanup 완료 상태 → skip.
        // #2114 — sentinel이 현재 활성 trip과 다른 trip의 것이면(stale) skip하지 않고
        // clear 후 self-end를 계속 진행한다. stale sentinel이 self-end를 영구 봉인하는
        // 부수 결함(밤샘 trip force-end sentinel이 그 직후 등록된 새 trip의 self-end를
        // 계속 "이미 처리됨"으로 오판) 동시 수리. 판정은 corrId 1순위 + timestamp fallback
        // (resolveTripEndedSentinelVerdict, 방안 C′).
        const sentinel = await getTripEndedSentinel();
        if (sentinel !== null) {
          const verdict = resolveTripEndedSentinelVerdict(
            sentinel,
            tripStartedAt,
            endedCorrIdSnapshot,
          );
          if (verdict !== 'stale') {
            logger.info(`skip — sentinel already recorded reason=${reason}`);
            return;
          }
          logger.info(
            `sentinel=${JSON.stringify(sentinel)} stale (tripStartedAt=${tripStartedAt}, currentCorrId=${endedCorrIdSnapshot}) reason=${reason} → clear + continue`,
          );
          await clearTripEndedSentinel();
        }

        const now = Date.now();
        logger.info(`device self-end fired reason=${reason}`);
        addDomainBreadcrumb('trip', 'device-self-end', { reason });
        appendAlarmLog({
          ts: now,
          source: 'lifecycle-backstop',
          outcome: 'fired',
          reason: REASON_TO_ALARM_LOG_REASON[reason],
        });

        // silent push trip-ended / lifecycle-backstop force-end 와 동일 시퀀스.
        // recall이 cleanup 전에 호출돼야 ROUTE_KEY / DESTINATION_KEY / TRIP_STARTED_AT_KEY 를 읽을 수 있다.
        await triggerTripEndRecall();
        await runTripBoundCleanups();
        await triggerTripGroundTruthPrompt(endedCorrIdSnapshot);
        useDestinationStore.setState({
          destination: null,
          customOrigin: null,
          tripOrigin: null,
        });
        await releaseLock();
        // #2114 (방안 C′) — sentinel에 corrId 동봉.
        await setTripEndedSentinel(now, endedCorrIdSnapshot);
      } catch (e) {
        // graceful — 다음 tick 재평가에서 다시 시도. sentinel/refs 상태에 따라 자연 dedup.
        logger.warn('device self-end 실패 (graceful)', e);
      }
    },
    [releaseLock, tripStartedAt],
  );

  // 매 render tick에서 fusion 신호 평가. 신호 변경마다 실행되며, 매 evaluation 시점의 fresh input으로
  // 3-signal OR 판정. 첫 진입 tick의 ts는 ref에 저장하고 다음 tick부터 elapsed 누적 계산.
  useEffect(() => {
    if (destinationId === null) return;
    if (firedForDestinationIdRef.current === destinationId) return; // 이미 fire 완료 — 동일 trip에서 재발화 억제.

    const now = Date.now();
    const currentStationId = inputs.currentStation?.id ?? null;
    const isStationary = inputs.positionStability === 'static';

    // Signal 1 — destination match 지속 시간 tracker 갱신.
    const isDestinationMatch =
      currentStationId !== null &&
      currentStationId === destinationId &&
      inputs.confidence !== null;
    if (isDestinationMatch) {
      if (destinationMatchStartedAtRef.current === null) {
        destinationMatchStartedAtRef.current = now;
      }
    } else {
      destinationMatchStartedAtRef.current = null;
    }

    // Signal 2 — stationary 60s tracker (arc completion).
    if (isStationary) {
      if (stationaryStartedAtRef.current === null) {
        stationaryStartedAtRef.current = now;
      }
    } else {
      stationaryStartedAtRef.current = null;
    }

    // Signal 3 — stationary 5분 tracker (eta backstop). 별도 ref로 유지해 Signal 2와 독립 카운트.
    if (isStationary) {
      if (stationary5minStartedAtRef.current === null) {
        stationary5minStartedAtRef.current = now;
      }
    } else {
      stationary5minStartedAtRef.current = null;
    }

    const s1 = fusionDestinationSignal(
      currentStationId,
      destinationId,
      inputs.confidence,
      destinationMatchStartedAtRef.current,
      now,
    );
    const s2 = arcCompletionSignal(
      inputs.arcProgress,
      isStationary,
      stationaryStartedAtRef.current,
      now,
    );
    const s3 = etaBackstopSignal(
      tripStartedAt,
      inputs.expectedTripDurationMs,
      stationary5minStartedAtRef.current,
      now,
    );

    const verdict = shouldTriggerSelfEnd([s1, s2, s3]);
    if (verdict.trigger && verdict.reason !== null) {
      void performSelfEnd(verdict.reason, destinationId);
    }
  }, [
    destinationId,
    inputs.currentStation,
    inputs.confidence,
    inputs.arcProgress,
    inputs.positionStability,
    inputs.expectedTripDurationMs,
    tripStartedAt,
    performSelfEnd,
  ]);
}
