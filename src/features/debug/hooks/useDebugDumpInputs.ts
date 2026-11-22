/**
 * #3366 — 공유 dump(buildDumpText) 입력 중 "순수 읽기" 부분의 SSoT.
 *
 *  - `useDebugDumpInputs()` — DebugModal(live): ring buffer 구독·AsyncStorage 폴링·AppState refresh.
 *    DebugModal.tsx에 있던 코드를 그대로 옮긴 것(동작·출력 불변 — DebugModal 테스트 + dump characterization).
 *  - `collectReportDumpInputs()` — FeedbackModal(report): 보내기 시점에 1회 읽는다. 훅을 마운트하지 않으므로
 *    watch·폴링·센서 구독·네트워크·리스너를 띄우지 않는다(관찰자 효과 차단, 보내기 시점 값이 최신).
 *
 * 훅 분류(DebugModal이 쓰던 입력 훅 → report 모드 처리):
 *   순수 읽기(report에서 읽기 함수로 사용): ring buffer 9종 getter, getAlarmLog/getFiredAlarmLog/getFusionTierLog,
 *     getBoardingPromptDailyCounters, dumpScheduledNotifications, readBackendSsotMirror, readBgTaskLastHeartbeat,
 *     readBgLastFix, useBoardingLockStore/useSettingsStore/useDestinationStore/useTripGroundTruthStore(.getState()),
 *     getTripStartedAt, readSilentPushDiagnostics(리스너 없는 1회 읽기), getLockCorrectionMetrics,
 *     getConsensusMismatchMetrics.
 *   부수효과(report 미사용 → `n/a(report)`): useFusedNearestStation(watchPositionAsync), useArrivalInfo(5s 폴링+fetch),
 *     useArchFlagRemote(폴링+fetch), useBarometer(센서), useLowPowerMode(native subscribe),
 *     barometer/reeval/accel 계측 폴링(5s interval).
 */
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import {
  getAlarmLog,
  getFiredAlarmLog,
  getFusionTierLog,
  readBgTaskLastHeartbeat,
  type AlarmLogEntry,
  type BgTaskHeartbeatSnapshot,
  type FiredAlarmLogEntry,
  type FusionTierLogEntry,
} from '../../alarm/utils/alarmLog';
import {
  getBoardingPromptDailyCounters,
} from '../../alarm/utils/boardingPromptDailyCounters';
import type { BoardingPromptDayCounts } from '../../alarm/utils/boardingPromptMonitor';
import { readBackendSsotMirror, type BackendSsotMirrorEntry } from '../../alarm/utils/backendSsotMirror';
import { readBgLastFix, type BgLastFix } from '../../nearest-station/utils/bgLastFix';
import {
  getEstimatorEntries,
  subscribeEstimatorDebug,
  type EstimatorDebugEntry,
} from '../../route/utils/estimatorDebugBuffer';
import {
  getFusionDebugEntries,
  subscribeFusionDebug,
  type FusionDebugEntry,
} from '../../nearest-station/utils/fusionDebugBuffer';
import {
  getGpsDropEntries,
  subscribeGpsDrop,
  type GpsDropEntry,
} from '../../nearest-station/utils/gpsDropBuffer';
import {
  getCandidateRejectEntries,
  subscribeCandidateReject,
  type CandidateRejectEntry,
} from '../../nearest-station/utils/candidateRejectBuffer';
import {
  getBoardingLockDriftEntries,
  subscribeBoardingLockDrift,
  type BoardingLockDriftEntry,
} from '../../nearest-station/utils/boardingLockDriftBuffer';
import {
  getLockLifecycleEntries,
  subscribeLockLifecycle,
  type LockLifecycleEntry,
} from '../../alarm/utils/boardingLockLifecycleBuffer';
import {
  getBackendCallEntries,
  subscribeBackendCallEntries,
  type BackendCallEntry,
} from '../../../shared/utils/backendCallBuffer';
import {
  getRawSignalEntries,
  subscribeRawSignal,
  type RawSignalEntry,
} from '../../observability/utils/rawSignalBuffer';
import {
  getPushReceiptEntries,
  subscribePushReceipt,
  type PushReceiptBufferEntry,
} from '../../observability/utils/pushReceiptBuffer';
import {
  dumpScheduledNotifications,
  type ScheduledNotificationDumpEntry,
} from '../../alarm/utils/scheduledNotificationsDump';
import { useBoardingLockStore } from '../../alarm/store/useBoardingLockStore';
import { useSettingsStore } from '../../settings/store/useSettingsStore';
import { useDestinationStore } from '../../route/store/useDestinationStore';
import { useTripGroundTruthStore } from '../store/useTripGroundTruthStore';
import { getTripStartedAt, tripLifecyclePhase } from '../../alarm/utils/tripStartStorage';
import { deviceLocalTripId } from '../../alarm/utils/safetyNetScheduler';
import { readSilentPushDiagnostics } from '../../alarm/hooks/useSilentPushDiagnostics';
import { getLockCorrectionMetrics } from '../../alarm/utils/lockCorrectionMetrics';
import { getConsensusMismatchMetrics } from '../../alarm/utils/consensusMismatchMetrics';
import { isBoardingLockExpired } from '../../../shared/types/boardingLock';
import { hashTripToken } from '../../../shared/infra/monitoring/tripTokenHash';
import type { BuildDumpArgs } from '../components/DebugModal';

/** report 모드에서 fusion/arrival처럼 "돌리지 않은" 입력의 표기. */
export const REPORT_NA_LABEL = 'n/a(report)';

/** DebugModal 폴링 주기(기존 값 그대로). */
const POLL_INTERVAL_MS = 5_000;

/**
 * DebugModal(live)용 순수 읽기 입력 + UI가 쓰는 setter/refresh.
 * 로직은 DebugModal.tsx에서 이동 — 동작 불변.
 */
export function useDebugDumpInputs() {
  // #1568 (T8b, Epic ADR-017 #1553) — backend SSoT 권위 mirror 폴링. 5s 간격.
  // 미존재(backend가 한 번도 forward 안 함) / parse 실패 시 null → '(no recent SSoT push)' 표시.
  const [backendSsotMirror, setBackendSsotMirror] = useState<BackendSsotMirrorEntry | null>(null);
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      void readBackendSsotMirror().then((entry) => {
        if (cancelled) return;
        setBackendSsotMirror((prev) => {
          if (prev === null && entry === null) return prev;
          if (
            prev !== null &&
            entry !== null &&
            prev.receivedAt === entry.receivedAt &&
            prev.currentStationId === entry.currentStationId
          ) {
            return prev;
          }
          return entry;
        });
      });
    };
    // 첫 read 즉시 실행 — DebugModal은 사용자가 명시적으로 연 화면이라 첫 entry를 빠르게 표시.
    tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  // #2618 — BG task heartbeat 폴링. alarmLog ring 적재를 폐지하고 AsyncStorage 단일 키로
  // 전환한 뒤에도 "BG task가 죽지 않았다" 생존 확인은 5s 간격 폴링으로 보존.
  const [bgTaskLastHeartbeat, setBgTaskLastHeartbeat] = useState<BgTaskHeartbeatSnapshot | null>(null);
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      void readBgTaskLastHeartbeat().then((snapshot) => {
        if (!cancelled) setBgTaskLastHeartbeat(snapshot);
      });
    };
    tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  // #3191 PR-0 — BG last fix 폴링. heartbeat와 동일 5s cadence(새 타이머 종류 없이 같은 패턴).
  const [bgLastFix, setBgLastFix] = useState<BgLastFix | null>(null);
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      void readBgLastFix().then((fix) => {
        if (!cancelled) setBgLastFix(fix);
      });
    };
    tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const lock = useBoardingLockStore((s) => s.lock);
  // Operation Dashboard(local alarmAccuracy) 계산용 tripGroundTruth 응답 subscribe.
  const groundTruthResponses = useTripGroundTruthStore((s) => s.responses);

  const [logs, setLogs] = useState<AlarmLogEntry[]>([]);
  // #2861 (T2) — Boarding Prompt Acceptance 일별 영속 카운터 스냅샷. logs와 함께 refresh.
  const [boardingPromptDailyCounters, setBoardingPromptDailyCounters] = useState<
    Readonly<Record<string, BoardingPromptDayCounts>>
  >({});
  // #2284 — fired-only 독립 영속 버퍼 스냅샷. alarmLog(200-cap, 모든 outcome 혼합) rotate와
  // 무관하게 보존되는 fired count SSoT.
  const [firedAlarmLog, setFiredAlarmLog] = useState<FiredAlarmLogEntry[]>([]);
  // #1706 — fusion picker tier 별 ring buffer snapshot. alarmLog ring 점령 회귀 차단으로
  // 분리된 채널 (alarmLog와 다른 200 cap). refresh 사이클에 함께 snapshot.
  const [fusionTierLogs, setFusionTierLogs] = useState<readonly FusionTierLogEntry[]>(() =>
    getFusionTierLog(),
  );
  const [fusionLogs, setFusionLogs] = useState<readonly FusionDebugEntry[]>(() =>
    getFusionDebugEntries(),
  );
  // #1540 (S7) — gps-drop ring buffer. fusionLogs와 동일 패턴(snapshot + subscribe + clear button).
  const [gpsDropLogs, setGpsDropLogs] = useState<readonly GpsDropEntry[]>(() => getGpsDropEntries());
  // #1902 (RC-18) — candidate-reject ring buffer. fusionLogs와 동일 패턴.
  const [candidateRejectLogs, setCandidateRejectLogs] = useState<readonly CandidateRejectEntry[]>(() =>
    getCandidateRejectEntries(),
  );
  // #2049 — boarding-lock-drift ring buffer. #1896 (RC-8) 별 buffer를 UI/dump에 노출.
  const [boardingLockDriftLog, setBoardingLockDriftLog] = useState<readonly BoardingLockDriftEntry[]>(() =>
    getBoardingLockDriftEntries(),
  );
  // #2152 — BoardingLock lifecycle ring buffer. boardingLockDriftLog와 동일 패턴.
  const [lockLifecycleLog, setLockLifecycleLog] = useState<readonly LockLifecycleEntry[]>(() =>
    getLockLifecycleEntries(),
  );
  const [estimatorLogs, setEstimatorLogs] = useState<readonly EstimatorDebugEntry[]>(() =>
    getEstimatorEntries(),
  );
  // #1518 — backend call ring buffer subscribe. 모든 backend fetch chokepoint가 push.
  const [backendCalls, setBackendCalls] = useState<readonly BackendCallEntry[]>(() =>
    getBackendCallEntries(),
  );
  // #1501 — PR-C. Raw signal buffer는 module-level singleton(영속 + boot hydrate).
  // 모달 마운트 시점 스냅샷으로 초기화, 이후 subscribe로 실시간 갱신.
  const [rawSignalLog, setRawSignalLog] = useState<readonly RawSignalEntry[]>(() => getRawSignalEntries());
  // #2861 (T1) — push-receipt 독립 버퍼. rawSignalLog와 동일 패턴(스냅샷 초기화 + subscribe).
  const [pushReceiptLog, setPushReceiptLog] = useState<readonly PushReceiptBufferEntry[]>(() =>
    getPushReceiptEntries(),
  );
  // #756: OS 큐 ground-truth dump. 호출 직후 한 번 비동기로 채워진다.
  // null = 아직 한 번도 dump 안 한 상태 → "Tap Refresh" placeholder 노출.
  const [scheduledDump, setScheduledDump] = useState<ScheduledNotificationDumpEntry[] | null>(null);

  const refreshScheduledDump = useCallback(async () => {
    setScheduledDump(await dumpScheduledNotifications());
  }, []);

  // #1525 — DebugModal 진입 즉시 OS scheduled queue를 1회 dump한다. 사용자가 Refresh를
  // 누르지 않은 share dump가 항상 "(not loaded)"로 나가 zombie alarm 추적이 불가능했던
  // 회귀 차단. 이후 갱신은 기존 Refresh 버튼이 담당.
  useEffect(() => {
    void refreshScheduledDump();
  }, [refreshScheduledDump]);

  useEffect(() => {
    return subscribeFusionDebug(() => setFusionLogs([...getFusionDebugEntries()]));
  }, []);

  // #1540 (S7) — gps-drop buffer 구독. push/clear 어느 쪽이든 같은 listener로 반응.
  useEffect(() => {
    return subscribeGpsDrop(() => setGpsDropLogs([...getGpsDropEntries()]));
  }, []);

  // #1902 (RC-18) — candidate-reject buffer 구독. gps-drop과 동일 패턴.
  useEffect(() => {
    return subscribeCandidateReject(() => setCandidateRejectLogs([...getCandidateRejectEntries()]));
  }, []);

  // #2049 — boarding-lock-drift buffer 구독. candidate-reject와 동일 패턴.
  useEffect(() => {
    return subscribeBoardingLockDrift(() => setBoardingLockDriftLog([...getBoardingLockDriftEntries()]));
  }, []);

  // #2152 — BoardingLock lifecycle buffer 구독. boardingLockDrift와 동일 패턴.
  useEffect(() => {
    return subscribeLockLifecycle(() => setLockLifecycleLog([...getLockLifecycleEntries()]));
  }, []);

  useEffect(() => {
    return subscribeEstimatorDebug(() => setEstimatorLogs([...getEstimatorEntries()]));
  }, []);

  useEffect(() => {
    return subscribeBackendCallEntries(() => setBackendCalls([...getBackendCallEntries()]));
  }, []);

  // #1501 — PR-C. Raw signal buffer 변경 구독. push/clear 어느 쪽이든 같은 listener로 반응.
  useEffect(() => {
    return subscribeRawSignal(() => setRawSignalLog([...getRawSignalEntries()]));
  }, []);

  // #2861 (T1) — push-receipt 독립 버퍼 변경 구독.
  useEffect(() => {
    return subscribePushReceipt(() => setPushReceiptLog([...getPushReceiptEntries()]));
  }, []);

  const refreshLogs = useCallback(async () => {
    setLogs(await getAlarmLog());
    // #1706 — fusion picker tier 별 ring buffer 동시 snapshot. AsyncStorage 없는 in-memory ring
    // 이라 동기 read. logs와 함께 refresh되어 UI/share dump 정합성 유지.
    setFusionTierLogs(getFusionTierLog());
    // #2284 — fired-only 독립 버퍼도 동시 refresh. alarmLog와 별도 key라 별도 read 필요.
    setFiredAlarmLog(await getFiredAlarmLog());
    // #2861 (T2) — Boarding Prompt Acceptance 영속 daily counter도 동시 refresh.
    setBoardingPromptDailyCounters(await getBoardingPromptDailyCounters());
  }, []);

  useEffect(() => {
    void refreshLogs();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshLogs();
    });
    return () => sub.remove();
  }, [refreshLogs]);

  return {
    backendSsotMirror,
    bgTaskLastHeartbeat,
    bgLastFix,
    lock,
    groundTruthResponses,
    logs,
    boardingPromptDailyCounters,
    firedAlarmLog,
    fusionTierLogs,
    fusionLogs,
    setFusionLogs,
    gpsDropLogs,
    setGpsDropLogs,
    candidateRejectLogs,
    setCandidateRejectLogs,
    boardingLockDriftLog,
    setBoardingLockDriftLog,
    lockLifecycleLog,
    setLockLifecycleLog,
    estimatorLogs,
    setEstimatorLogs,
    backendCalls,
    setBackendCalls,
    rawSignalLog,
    setRawSignalLog,
    pushReceiptLog,
    setPushReceiptLog,
    scheduledDump,
    refreshScheduledDump,
    refreshLogs,
  };
}

export interface ReportDumpInputs {
  /** `buildDumpText(args, { redact: true, tokens })`에 그대로 넘긴다. */
  args: BuildDumpArgs;
  /** 값 기반 전수 치환 대상 token — APNS · 활성 trip · device-local trip id. */
  tokens: string[];
  /** hashTripToken(APNS token). token이 없으면 null. */
  tripKey: string | null;
}

/**
 * #3366 — 버그 신고 보내기 시점에 1회 읽는 report 모드 입력. 순수 읽기만 사용한다(위 분류 표 참조).
 * fusion/GPS/arrival/barometer 계열은 돌리지 않으므로 `n/a(report)`·null — 현재 위치 좌표는 애초에 수집하지 않는다.
 */
export async function collectReportDumpInputs(): Promise<ReportDumpInputs> {
  const [
    silentPush,
    tripStartedAt,
    logs,
    firedAlarmLog,
    boardingPromptDailyCounters,
    scheduledDump,
    backendSsotMirror,
    bgTaskLastHeartbeat,
    bgLastFix,
  ] = await Promise.all([
    readSilentPushDiagnostics(),
    getTripStartedAt(),
    getAlarmLog(),
    getFiredAlarmLog(),
    getBoardingPromptDailyCounters(),
    dumpScheduledNotifications(),
    readBackendSsotMirror(),
    readBgTaskLastHeartbeat(),
    readBgLastFix(),
  ]);

  const lock = useBoardingLockStore.getState().lock;
  const { sleepMode } = useSettingsStore.getState();
  const { destination } = useDestinationStore.getState();
  const { responses } = useTripGroundTruthStore.getState();
  const lockActive = lock !== null && !isBoardingLockExpired(lock, Date.now());
  const lockless = destination !== null && !lockActive;

  const args: BuildDumpArgs = {
    userLocation: null,
    speedMps: null,
    accuracyMeters: null,
    nearestName: null,
    nearestDistanceM: null,
    variants: [],
    fusion: {
      confidence: REPORT_NA_LABEL,
      source: REPORT_NA_LABEL,
      fusedLabel: REPORT_NA_LABEL,
      gpsLabel: REPORT_NA_LABEL,
      differs: false,
      candidateTrains: null,
    },
    arrivalSummary: REPORT_NA_LABEL,
    isMock: false,
    silentPush,
    backendSsotMirror,
    bgTaskLastHeartbeat,
    bgLastFix,
    logs,
    boardingPromptDailyCounters,
    firedAlarmLog,
    scheduledDump,
    fusionTierLog: getFusionTierLog(),
    fusionLog: getFusionDebugEntries(),
    gpsDropLog: getGpsDropEntries(),
    candidateRejectLog: getCandidateRejectEntries(),
    boardingLockDriftLog: getBoardingLockDriftEntries(),
    lockLifecycleLog: getLockLifecycleEntries(),
    boardingLock: lock,
    estimatorLog: getEstimatorEntries(),
    backendCalls: getBackendCallEntries(),
    rawSignalLog: getRawSignalEntries(),
    pushReceiptLog: getPushReceiptEntries(),
    lockCorrection: getLockCorrectionMetrics(),
    consensusMismatch: getConsensusMismatchMetrics(),
    trip: {
      lockless,
      tripStartedAt,
      currentHopIndex: undefined,
      routeHopCount: null,
      displayOnlyEstimateStrategy: null,
      lifecyclePhase: tripLifecyclePhase(tripStartedAt),
    },
    sleep: { sleepMode, firstHopApproaching: false },
    operationDashboard: {
      groundTruthAccurateCount: responses.filter((r) => r.outcome === 'accurate').length,
      groundTruthAnsweredCount: responses.filter((r) => r.outcome !== 'unanswered').length,
    },
  };

  const { apnsToken, activeTripToken } = silentPush;
  const tokens = [
    apnsToken,
    activeTripToken,
    tripStartedAt === null ? null : deviceLocalTripId(tripStartedAt),
  ].filter((token): token is string => token !== null);

  return { args, tokens, tripKey: apnsToken === null ? null : hashTripToken(apnsToken) };
}
