import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createLogger } from '../../../shared/utils/logger';
import { useSettingsStore } from '../../settings/store/useSettingsStore';
import { useDestinationStore } from '../../route/store/useDestinationStore';
import { ROUTE_KEY } from '../../../shared/constants/storageKeys';
import type { Route } from '../../../shared/utils/stationRoute';
import type { FusedRouteContext } from '../../../features/nearest-station/hooks/useFusedNearestStation';
import {
  getTripStartedAt,
  tripLifecyclePhase,
  type TripLifecyclePhase,
} from '../../alarm/utils/tripStartStorage';
import {
  readBackendSsotMirror,
  type BackendSsotMirrorEntry,
} from '../../alarm/utils/backendSsotMirror';
import { isDebugModalEnabled } from '../../../shared/constants/debugFlags';
import {
  SIMPLE_ARRIVAL_ARCH_ENV_KEY,
  isSimpleArchEnabled,
  isSimpleArchEnvEnabled,
} from '../../../shared/config/archFlag';
import { useArchFlagRemote } from '../../../shared/config/useArchFlagRemote';
import type { GpsActiveState } from '../../../shared/constants/gpsStatus';
import { formatClockTimeWithSeconds } from '../../../shared/utils/formatTime';
import { useFusedNearestStation } from '../../../features/nearest-station/hooks/useFusedNearestStation';
import { useArrivalInfo } from '../../../features/arrival/hooks/useArrivalInfo';
import {
  useSilentPushDiagnostics,
  type SilentPushDiagnostics,
} from '../../../features/alarm/hooks/useSilentPushDiagnostics';
import {
  BOARDING_PROMPT_WINDOWS,
  clearAlarmLog,
  clearFiredAlarmLog,
  countAlarmLogReasonsByWindow,
  countAutoLockReasonsByWindow,
  countBoardingPromptByWindow,
  countGateReasons,
  computeSilentPushReach,
  countSilentPushKindBreakdown,
  countSilentPushOutcomes,
  formatFusionPickerTierDistribution,
  getAlarmLog,
  getFiredAlarmLog,
  getFusionTierLog,
  summarizeAlarmLogByReason,
  summarizeAlarmLogBySource,
  summarizeAlarmLogCounters,
  type AlarmLogEntry,
  type AlarmLogReason,
  type AlarmLogReasonCounter,
  type FiredAlarmLogEntry,
  type FusionTierLogEntry,
} from '../../../features/alarm/utils/alarmLog';
import {
  computeBoardingPromptMonitor,
  exportRecentDays,
} from '../../../features/alarm/utils/boardingPromptMonitor';
import { useBoardingLockStore } from '../../../features/alarm/store/useBoardingLockStore';
// #2268 (C1) — pending→confirmed lock 정정 measurement infra(#1166). fired count 는
// BoardingTrainList가 이미 기록하지만 DebugModal에 섹션이 없어 관측 불가했다.
import { getLockCorrectionMetrics } from '../../alarm/utils/lockCorrectionMetrics';
import { getConsensusMismatchMetrics } from '../../alarm/utils/consensusMismatchMetrics';
import {
  BOARDING_LOCK_EXPIRY_FACTOR,
  isBoardingLockExpired,
  type BoardingLock,
} from '../../../shared/types/boardingLock';
import { isPendingTrainCode } from '../../../shared/constants/boardingLock';
import {
  clearEstimatorEntries,
  getEstimatorEntries,
  subscribeEstimatorDebug,
  type EstimatorDebugEntry,
} from '../../../features/route/utils/estimatorDebugBuffer';
import { SILENT_PUSH_LABELS, buildSilentPushCountValue } from '../../../shared/constants/labels';
import {
  clearFusionDebugEntries,
  getFusionDebugEntries,
  subscribeFusionDebug,
  type FusionDebugEntry,
} from '../../../features/nearest-station/utils/fusionDebugBuffer';
// #1540 (S7) — gps-drop 전용 buffer. fusionDebugBuffer와 cap을 공유하지 않아 fire-related
// entry(fusion decision / sticky / gps-fix)를 점령하지 않는다.
import {
  clearGpsDropEntries,
  getGpsDropEntries,
  subscribeGpsDrop,
  type GpsDropEntry,
} from '../../../features/nearest-station/utils/gpsDropBuffer';
// #1902 (RC-18) — candidate-reject 전용 buffer. fusionDebugBuffer 200 cap 점령 자기 파괴 차단.
import {
  clearCandidateRejectEntries,
  getCandidateRejectEntries,
  subscribeCandidateReject,
  type CandidateRejectEntry,
} from '../../../features/nearest-station/utils/candidateRejectBuffer';
// #1896 (RC-8) — boarding-lock drift 전용 buffer. stuck 시나리오 매 cycle push가 fusionDebugBuffer
// 점령하는 self-pollution 차단 (candidateRejectBuffer 패턴 동일).
import {
  clearBoardingLockDriftEntries,
  getBoardingLockDriftEntries,
  subscribeBoardingLockDrift,
  type BoardingLockDriftEntry,
} from '../../../features/nearest-station/utils/boardingLockDriftBuffer';
// #2152 — BoardingLock lifecycle(생성 source/해제 reason) 전용 buffer. drift buffer와 동일 패턴
// (fusionDebugBuffer 점령 회귀 차단 위해 소형 cap 별도 buffer).
import {
  clearLockLifecycleEntries,
  getLockLifecycleEntries,
  subscribeLockLifecycle,
  type LockLifecycleEntry,
} from '../../../features/alarm/utils/boardingLockLifecycleBuffer';
// #1518 — device → backend HTTP 호출 ring buffer. 모든 backend fetch chokepoint가 entry를 push.
import {
  clearBackendCallEntries,
  getBackendCallEntries,
  subscribeBackendCallEntries,
  type BackendCallEntry,
} from '../../../shared/utils/backendCallBuffer';
// #1501 — PR-C. PR-A(#1512)가 만든 raw signal ring buffer를 DebugModal에 자동 노출 + share dump 통합.
// 매 fusion cycle/enter/exit 시 push되는 entry를 직전 30건까지 표시 — toggle 없이 모달 열면 즉시.
import {
  clearRawSignalEntries,
  getRawSignalEntries,
  subscribeRawSignal,
  type RawSignalEntry,
} from '../../observability/utils/rawSignalBuffer';
import {
  dumpScheduledNotifications,
  formatScheduledNotificationLine,
  type ScheduledNotificationDumpEntry,
} from '../../../features/alarm/utils/scheduledNotificationsDump';
import {
  getLastObservabilityMetricsSnapshot,
  type ObservabilityMetrics,
} from '../../observability/api/observabilityMetricsClient';
import type { FusionConfidence, FusionSource } from '../../../shared/types/fusion';
import type { NearestStationResult } from '../../../shared/types/station';
import { useTheme, spacing, radius, typography } from '../../../shared/theme';
// #1751 (M3 Sub 1) — Operation Dashboard 섹션.
import { OperationDashboardSection } from './OperationDashboardSection';
// Operation Dashboard alarmAccuracy(local) metric — share dump 재사용.
// Modal UI 는 `useTripGroundTruthStore((s) => s.responses)` 를 통해 mount 시점 스냅샷 + subscribe.
// share dump 는 handleShare 호출 시점 스냅샷만 필요하므로 store selector 로 참조 안정성 확보.
import { useTripGroundTruthStore } from '../store/useTripGroundTruthStore';
// #1956 (S-m3-1) — Operation Dashboard 4 metric → TripDetailModal drill-down 진입.
import { TripDetailModal } from './TripDetailModal';
import { useBarometer } from '../../../shared/hooks/useBarometer';
import { useLowPowerMode } from '../../../shared/hooks/useLowPowerMode';
import { RegressionsSection } from './RegressionsSection';
// SPIKE (throwaway, dev 미머지) — 가속도계 train-fingerprint 검증용 로거 섹션. 추가만, 기존 로직 변경 없음.
import { AccelSpikeLoggerSection } from './AccelSpikeLoggerSection';
// #1898 — RC-12. accelerometerFingerprint raw snapshot을 DebugModal에 노출. useFusedNearestStation이
// pattern 라벨만 노출(unknown/walking/automotive/...)하던 기존 wire-up에 추가로, dashboard에
// rmsMagnitude / sampleCount / lastUpdate를 시각화해 사용자 의문("speed 감지 작동 중?")을 즉시 해소.
import {
  getLatestAccelerometerSnapshot,
  type AccelerometerSnapshot,
} from '../../nearest-station/utils/accelerometerFingerprint';
// #1421 — PR-AutoLock-1 측정 인프라. DebugModal이 SSOT consensus → stability buffer → direction verify
// → inferAutoLockCandidate 결과를 dump에 노출. 동작 변경 0: lock 산출/sync 호출 없음.
import { createConsensusStabilityBuffer } from '../../nearest-station/utils/consensusStabilityBuffer';
import { verifyTrainDirection } from '../../nearest-station/utils/verifyTrainDirection';
import {
  inferAutoLockCandidate,
  type DeviceAutoLockCandidate,
  type InferAutoLockCandidateInput,
} from '../../nearest-station/utils/inferAutoLockCandidate';
import type {
  ConsensusStabilitySnapshot,
} from '../../nearest-station/utils/consensusStabilityBuffer';
import type { VerifyTrainDirectionResult } from '../../nearest-station/utils/verifyTrainDirection';
// #1430 — 환경 분포 측정 인프라. SSOT 활성 cascade → state 결정 → time-based counter tick.
// 동작 변경 0: 측정만. PR #1427(autoLockMeta)와 동일 helper 패턴(buildEnvironmentDistributionMeta).
import {
  createEnvironmentDistributionCounter,
  type EnvironmentDistributionSnapshot,
  type EnvironmentDistributionState,
} from '../../nearest-station/utils/environmentDistributionCounter';

/**
 * #1215 (D9) — DebugModal 상태 가시화 신규 prop 묶음.
 * D1(lockless estimator)/D8(sleep rule wiring) PR 미머지 환경에서도 동작하도록 모두 optional.
 * 미정의는 UI/dump에서 'unknown'으로 표기 — "신호 없음"과 "신호=false"를 명시적으로 구분.
 */
export interface FusionDetectionSummary {
  /** stationDetectionFusion confidence — 'high' | 'medium' | 'low'. */
  tier: string;
  /** signal mask 문자열 (예: 'TFT', 'UUU') — 순서는 STATION_DETECTION_SIGNALS 따름. */
  signalMask: string;
}

export interface TripDebugState {
  /** lockless trip 여부. true면 BoardingLock 없이 사용자 명시 의향만으로 진행 중. */
  lockless: boolean;
  /** trip 시작 시각 (ms epoch). null이면 미정. */
  tripStartedAt: number | null;
  /** D1 estimator 출력 hop index. undefined면 D1 미머지 또는 estimator null. */
  currentHopIndex: number | null | undefined;
  /** 경로 arcStations 총 개수. */
  routeHopCount: number | null;
  /**
   * #1447 — `displayOnlyEstimate`의 채택 strategy 라벨. UI/Share dump 추적 SSOT.
   *
   * PR #1445(E4 / #1437)에서 estimator 시간 적분 결과의 fire 권한을 박탈하고 결과를
   * `useFusedNearestStation.displayOnlyEstimate` 별 채널로 격리했다. 본 필드는 그 strategy를
   * DebugModal Trip 섹션과 Share dump에 노출하기 위한 wire-up — strategy 산출 시 strategy 이름,
   * displayOnlyEstimate=null이면 fallback 라벨로 항상 표시한다.
   *
   * "신호 없음(estimator null)"과 "표시 wire-up 자체 누락"이 dump만 보고 구분 가능해야
   * 사용자 trip 사후 재구성이 가능하다 — strategy가 비어 있어도 항상 row를 노출하는 이유.
   */
  displayOnlyEstimateStrategy:
    | import('../../route/utils/stationProgressEstimator').StationProgressStrategy
    | null;
  /**
   * #1604 — Trip lifecycle 단계 (T10 #1594). 4가지: none/normal/silence/force-end.
   *
   * 사용자가 trip 종료 원인을 즉시 알 수 있도록 DebugModal에 노출 — backstop이 silence/force-end
   * 분기에 들어갔는지 확인. 활성 trip이 'normal' 외 phase로 잠깐이라도 갔다가 종료되면 사용자가
   * 사후 재구성 가능.
   *
   * 산출: `tripLifecyclePhase(tripStartedAt)` 단순 호출. tripStartedAt=null이면 'none'.
   * Optional — 명시 전달 안 하면 caller가 tripStartedAt에서 derive해 표시한다 (backward-compat).
   */
  lifecyclePhase?: TripLifecyclePhase;
}

export interface SleepDebugState {
  sleepMode: boolean;
  /** shouldSuppressBySleepRule의 isFirstHop 입력 — 첫 hop 향하는 중인가. */
  firstHopApproaching: boolean;
}

/**
 * #1421 — PR-AutoLock-1 측정 인프라. DebugModal에 노출할 device-side auto-lock 산출 상태 스냅샷.
 *
 * 본 PR은 측정만 — lock 산출/sync 호출 X. 모든 필드는 SSOT consensus → stability → direction
 * 검증 → inferAutoLockCandidate 파이프라인의 현재 상태를 그대로 시각화한다.
 *
 * candidate null 사유는 다음 한 줄에 명시:
 *   - 'no-ssot'           : surface/underground SSOT 둘 다 미합의 (Tier 1 신호 부재)
 *   - 'stability-pending' : SSOT 합의되었으나 stability buffer threshold 미달
 *   - 'direction-mismatch': SSOT + stability 통과했으나 trainCode 방향이 route와 불일치
 *   - null                : candidate 산출됨
 */
export interface AutoLockDebugMeta {
  /** SSOT 활성 — surface 또는 underground. */
  surfaceSSOTActive: boolean;
  undergroundSSOTActive: boolean;
  /** Stability buffer 현재 snapshot. */
  stability: ConsensusStabilitySnapshot;
  /** verifyTrainDirection 결과 — SSOT 미합의 시 null. */
  direction: VerifyTrainDirectionResult | null;
  /** 최종 산출 후보 — 3 게이트 모두 통과 시 non-null. */
  candidate: DeviceAutoLockCandidate | null;
  /** candidate=null 시 사유. candidate 있으면 null. */
  nullReason: 'no-ssot' | 'stability-pending' | 'direction-mismatch' | null;
}

const UNKNOWN_LABEL = '—';

/**
 * #2268 (S1+S2) — Share dump 실패 관측용 logger. `handleShare`의 성공/실패 + 총 길이를
 * 기록해 무음 실패(void Share.share만 호출하던 이전 구현)를 방지한다.
 */
const shareLog = createLogger('debugModalShare');

/**
 * #2268 (C2) — DebugModal이 최초 로드된 시각. `app/_layout.tsx`가 static import하므로
 * 사실상 앱 launch 시각의 근사치로 쓸 수 있다. 앱 kill/BG 재기동 시 모듈이 새로
 * 로드되며 값도 리셋 — Lifecycle/Drift 버퍼 age 계산의 기준점(C2).
 */
const DEBUG_MODAL_LOAD_AT_MS = Date.now();

/**
 * #1881 — DebugLogSection UI 표시 기본 cap. buffer 전체(최대 300~500)를 한 번에 렌더하면
 * ScrollView 성능 저하. 100건이면 약 50분 분량 — 진단에 충분하고 UI 스크롤 부담도 적다.
 * "더 보기" 버튼 탭 시 expanded state로 전환해 buffer 전체 표시.
 * share dump는 별도 경로(buildDumpText)를 통해 buffer 전체를 그대로 포함.
 */
const DEBUG_LOG_DISPLAY_LIMIT = 100;

/**
 * #1501 — Raw signal 섹션 share dump용 slice cap. build 섹션 함수가 share dump에 포함할 최대 수.
 * UI는 DEBUG_LOG_DISPLAY_LIMIT(100)을 사용하고, share dump 섹션은 buffer 전체를 포함하도록
 * buildRawSignalSection에서 slice 제거 (#1881).
 *
 * @deprecated 직접 사용 말 것 — 테스트 호환용으로만 export 유지. UI/dump 로직은 위 상수 참조.
 */
const RAW_SIGNAL_DISPLAY_LIMIT = DEBUG_LOG_DISPLAY_LIMIT;

function formatOptionalBool(value: boolean | null | undefined): string {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return UNKNOWN_LABEL;
}

function formatOptionalString(value: string | null | undefined): string {
  return value == null || value === '' ? UNKNOWN_LABEL : value;
}

function formatOptionalNumber(value: number | null | undefined): string {
  return value == null ? UNKNOWN_LABEL : String(value);
}

function formatOptionalTs(value: number | null | undefined): string {
  if (value == null) return UNKNOWN_LABEL;
  return new Date(value).toISOString();
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// #2284 — fired-only 독립 버퍼(FiredAlarmLogEntry) 1건 포맷. alarmLog의 formatLogLine과 달리
// (ts, kind, station, line, channel) 5필드만 담는 별도 스키마라 전용 포매터를 둔다.
function formatFiredLogLine(entry: FiredAlarmLogEntry): string {
  const linePart = entry.line ?? UNKNOWN_LABEL;
  return `${formatTime(entry.ts)} ${entry.channel} ${entry.kind} ${entry.station} (${linePart})`;
}

function formatLogLine(entry: AlarmLogEntry): string {
  const parts: string[] = [
    formatTime(entry.ts),
    entry.source,
    entry.outcome,
  ];
  if (entry.reason) parts.push(entry.reason);
  if (entry.kind) parts.push(entry.kind);
  // #2231 — kind가 표준 station kind로 매핑되지 않을 때 backend가 실제로 보낸 원본 값을
  // raw 로그에 보존 — 계약 스큐(device가 모르는 신규 kind) 발생 즉시 관측 가능하게 한다.
  if (entry.pushKindRaw) parts.push(`rawKind=${entry.pushKindRaw}`);
  if (entry.phaseId) parts.push(entry.phaseId);
  if (entry.stationName) parts.push(entry.stationName);
  if (entry.location) {
    parts.push(
      `acc=${entry.location.accuracy ?? '-'} age=${entry.location.ageMs}ms`,
    );
  }
  // #372 stamp — bg-scheduled 엔트리 진단용. 값이 있을 때만 노출(짧은 라인 우선).
  if (entry.direction) parts.push(`dir=${entry.direction}`);
  if (entry.usedTrainCode) parts.push(`train=${entry.usedTrainCode}`);
  if (entry.selectedArrivalSeconds != null) {
    parts.push(`eta=${entry.selectedArrivalSeconds}s`);
  }
  if (entry.expectedStationAtFire) parts.push(`exp=${entry.expectedStationAtFire}`);
  if (entry.actualLastNotifiedStation) parts.push(`last=${entry.actualLastNotifiedStation}`);
  return parts.join(' | ');
}

/** candidates key → 짧은 접두어. 새 key가 늘면 여기 한 줄만 추가하면 됨. */
const CANDIDATE_SHORT: Record<string, string> = {
  positionTrain: 'pt',
  fused: 'fu',
  route: 'rt',
  gps: 'gp',
};

function formatFusionDebugLine(entry: FusionDebugEntry): string {
  const time = formatTime(entry.ts);
  if (entry.kind === 'gps') {
    const station = entry.nearestStation
      ? `${entry.nearestStation}(${entry.nearestLine ?? '-'})`
      : '-';
    const d = entry.nearestDistanceKm != null ? `${Math.round(entry.nearestDistanceKm * 1000)}m` : '-';
    const acc = entry.accuracyMeters != null ? `${Math.round(entry.accuracyMeters)}m` : '-';
    const reason = entry.dropReason ? ` reason=${entry.dropReason}` : '';
    return `${time} | ${entry.event} | ${station} d=${d} acc=${acc}${reason}`;
  }
  if (entry.kind === 'sticky') {
    const acc = entry.accuracyMeters != null ? `${Math.round(entry.accuracyMeters)}m` : '-';
    const sp = entry.speedMps != null ? `${entry.speedMps.toFixed(1)}m/s` : '-';
    return `${time} | sticky:${entry.event} | ${entry.stationName}(${entry.line}) acc=${acc} sp=${sp}`;
  }
  // #2125 — 현재역 표시 고착 정직 강등 이벤트. 표시 계층 전용 관측.
  if (entry.kind === 'display-demote') {
    return `${time} | ${entry.reason} | ${entry.stationName}(${entry.line})`;
  }
  // #2307 — backend-ssot mirror line guard 거부 이벤트. device 확정 노선 vs mirror line 대조.
  if (entry.kind === 'ssot-line-guard-reject') {
    const mirror = `${entry.mirrorStationName}(${entry.mirrorLine})`;
    const device = `${entry.deviceStationName}(${entry.deviceLine})`;
    return `${time} | ssot-line-guard-reject | mirror=${mirror} device=${device}`;
  }
  // #1902 (RC-18) — candidate-reject 분기는 candidateRejectBuffer로 이전(별 buffer + 별 섹션).
  // #1896 (RC-8) — boarding-lock-drift 분기는 boardingLockDriftBuffer로 이전(별 buffer + 별 섹션).
  // fusion 분기는 fusion decision entry만 처리한다.
  const station = entry.stationName ? `${entry.stationName}(${entry.line ?? '-'})` : '-';
  const d = entry.distanceKm != null ? `${Math.round(entry.distanceKm * 1000)}m` : '-';
  const acc =
    entry.gpsAccuracyAtPushMeters != null ? `${Math.round(entry.gpsAccuracyAtPushMeters)}m` : '-';
  const cand = entry.candidates
    .map((c) => {
      const base = `${CANDIDATE_SHORT[c.key] ?? c.key}=${c.stationName}`;
      // boarding-lock 매칭 표기 — positionTrain candidate에 lockMatch=true가 찍히면 한눈에 식별.
      return c.extra?.lockMatch === true ? `${base}[LOCK]` : base;
    })
    .join(' ');
  const candPart = cand.length > 0 ? cand : '-';
  return `${time} | src=${entry.source} conf=${entry.confidence} | ${station} d=${d} acc=${acc} | ${candPart}`;
}

/**
 * #1501 — Raw signal ring buffer entry를 한 줄 텍스트로. 필드 순서:
 *   `HH:MM:SS | kind | stationId | source/confidence | gps(acc/speed) | motion | sub | arvlCd | arc | cell`
 * 누락 필드는 `-`로 출력 — Fusion log와 동일 컨벤션.
 * #1859 — cellular 필드 추가: `cell=<tech_short>/<vote>` (예: `cell=LTE/surface`, `cell=-/unknown`).
 */
function formatRawSignalLine(entry: RawSignalEntry): string {
  const time = formatTime(entry.ts);
  const stationId = entry.stationId ?? '-';
  const source = entry.source ?? '-';
  const confidence = entry.confidence ?? '-';
  const acc =
    entry.gps?.accM != null ? `${Math.round(entry.gps.accM)}m` : '-';
  const speed =
    entry.gps?.speedMps != null ? `${entry.gps.speedMps.toFixed(1)}m/s` : '-';
  const motion = entry.motion ?? '-';
  const subsurface = formatOptionalBool(entry.subsurface ?? undefined);
  const arvlCd = entry.arvlCd != null ? String(entry.arvlCd) : '-';
  const progress =
    entry.arcProgress != null ? entry.arcProgress.toFixed(2) : '-';
  // #1859 — tech 상수에서 'CTRadioAccessTechnology' prefix를 제거해 라인 압축.
  const cellular = entry.cellular != null
    ? `cell=${(entry.cellular.tech ?? '').replace('CTRadioAccessTechnology', '') || '-'}/${entry.cellular.vote}`
    : 'cell=-';
  // #2241 (ADR-030 §Replay harness backbone P0-1) — 기압계 원시 hPa + GPS 수신 타임스탬프.
  // 두 필드 모두 dump 끝에 append — 기존 Raw Signal 파서/문서 column order 보존(surgical).
  const hpa = entry.barometerHpa != null ? entry.barometerHpa.toFixed(1) : '-';
  const gpsFixAt =
    entry.gps?.fixAtMs != null ? formatTime(entry.gps.fixAtMs) : '-';
  return `${time} | ${entry.kind} | ${stationId} | ${source}/${confidence} | gps(${acc}/${speed}) | ${motion} | sub=${subsurface} | arvlCd=${arvlCd} | arc=${progress} | ${cellular} | hpa=${hpa} | fix=${gpsFixAt}`;
}

/**
 * APNs token은 32~64자 hex라 그대로 노출하면 라인이 길어진다.
 * 끝 8자만 표시 — 동일성 비교에 충분하고 공유 시에도 부담이 적다.
 */
function formatTokenTail(token: string | null): string {
  if (!token) return '(none)';
  if (token.length <= 8) return token;
  return `…${token.slice(-8)}`;
}

function formatAt(ts: number | null): string {
  if (ts == null) return '(never)';
  return formatTime(ts);
}

/**
 * Silent push 진단 섹션을 dump/UI 양쪽에서 공유하기 위한 row 목록.
 * - uiLabel: KeyValue 좌측 (좁은 폭 — 약어)
 * - dumpKey: 텍스트 dump의 헤더 (전체 단어)
 * 새 필드는 여기와 hook 타입만 손대면 dump/UI가 동시에 갱신된다.
 *
 * #856 — `logs` 보강. lastRecv/lastFired 시간만 보고 "왜 안 울리지?" 묻는
 * 사용자 의문을 한 라인으로 해소하기 위해 received/fired 카운트 row 추가.
 * lastRecv/lastFired row는 카운트와 같은 값으로 흡수돼 단일 라인으로 줄어든다(중복 제거).
 */
function silentPushDiagRows(
  d: SilentPushDiagnostics,
  logs: readonly AlarmLogEntry[],
  lowPowerMode: boolean,
): { uiLabel: string; dumpKey: string; value: string }[] {
  const task = d.taskRegistrationError
    ? `${d.taskRegistrationState} (${d.taskRegistrationError})`
    : d.taskRegistrationState;
  const silentCounts = countSilentPushOutcomes(logs);
  const receivedValue = buildSilentPushCountValue(silentCounts.received, formatAt(d.lastReceivedAt));
  const firedValue = buildSilentPushCountValue(silentCounts.fired, formatAt(d.lastFiredAt));
  // #1308 — LPM은 silent push를 throttle/drop 한다. received 카운트 옆에 두어 "LPM ON인데
  // received가 안 늘어남"을 한눈에 보고 측정할 수 있게 한다.
  const lowPowerValue = lowPowerMode ? 'ON' : 'off';
  // #1683 — received kind 분포. backend fired vs device received 갭 분석용.
  // #2231 — reschedule/trip-ended(알려진 non-station 제어 push)를 unknown과 분리 표기 —
  // unk는 이제 진짜 계약 스큐(device가 모르는 kind)만 남는다.
  const kindBreakdown = countSilentPushKindBreakdown(logs);
  const receivedKindValue = `stn=${kindBreakdown['station-passed']} xfer=${kindBreakdown.transfer} dst=${kindBreakdown.destination} resched=${kindBreakdown.reschedule} tripEnd=${kindBreakdown.tripEnded} unk=${kindBreakdown.unknown}`;
  return [
    { uiLabel: 'permission', dumpKey: 'permission', value: d.permissionStatus ?? '(unknown)' },
    { uiLabel: 'apnsToken', dumpKey: 'apnsToken', value: formatTokenTail(d.apnsToken) },
    { uiLabel: 'activeTrip', dumpKey: 'activeTrip', value: formatTokenTail(d.activeTripToken) },
    { uiLabel: 'apnsEnv', dumpKey: 'apnsEnv', value: d.apnsEnv },
    // #1931 — RC-5 stamp(`LAST_CONFIRMED_APNS_ENV_KEY`) self-verify. cold start 직후 register가
    // stamp 반영 전이면 '(none)'으로 표시되어 사용자가 race window 발생 여부를 즉시 확인 가능.
    {
      uiLabel: 'apnsEnvStamped',
      dumpKey: 'apnsEnvStamped',
      value: d.apnsEnvStamped ?? '(none)',
    },
    { uiLabel: 'task', dumpKey: 'taskRegistration', value: task },
    { uiLabel: 'route', dumpKey: 'route', value: d.hasRoute ? 'set' : '(none)' },
    { uiLabel: 'dest', dumpKey: 'destination', value: d.destinationId ?? '(none)' },
    { uiLabel: 'currStn', dumpKey: 'currentStation', value: d.lastNotifiedStationId ?? '(none)' },
    {
      uiLabel: SILENT_PUSH_LABELS.receivedKey,
      dumpKey: SILENT_PUSH_LABELS.receivedKey,
      value: receivedValue,
    },
    // #1683 — received kind 분포 (station-passed / transfer / destination / unknown)
    { uiLabel: 'recvKind', dumpKey: 'receivedByKind', value: receivedKindValue },
    {
      uiLabel: SILENT_PUSH_LABELS.firedKey,
      dumpKey: SILENT_PUSH_LABELS.firedKey,
      value: firedValue,
    },
    { uiLabel: 'lastSkip', dumpKey: 'lastSkipped', value: formatAt(d.lastSkippedAt) },
    { uiLabel: 'lowPower', dumpKey: 'lowPowerMode', value: lowPowerValue },
  ];
}

function formatStationLabel(res: NearestStationResult | null): string {
  if (!res) return '-';
  return `${res.station.name}(${res.station.line}) · ${Math.round(res.distanceKm * 1000)}m`;
}

function fusedDiffersFromGps(
  fused: NearestStationResult | null,
  gps: NearestStationResult | null,
): boolean {
  if (!fused || !gps) return false;
  return fused.station.id !== gps.station.id;
}

/**
 * fusedSpeed signal — backend Phase 3 fusion(ADR-009) 산출치를 디버그 모달에 전달하기 위한 prop 형태.
 * 클라 자체에는 산출 함수가 아직 없으므로(#819 후속) 호출부가 명시적으로 주입한다.
 * 미전달이면 UI/dump 모두 `(no fused signal)`로 노출 — GPS speed=null과 구분 가능.
 */
export interface FusedSpeedSignal {
  kmh: number;
  source: FusionSource;
}

const NO_FUSED_SIGNAL_LABEL = '(no fused signal)';

/**
 * GPS 섹션에 노출할 row 목록. fused 라인은 fused signal 유무와 무관하게 항상 1줄 — 사용자가
 * "현재 속도 신호가 클라에 도달했는가"를 즉시 인지할 수 있게 한다. 줄별 렌더링은 호출부에서
 * `Array.map`으로 순회.
 */
function buildGpsRows(args: {
  userLocation: { lat: number; lng: number } | null;
  speedMps: number | null;
  accuracyMeters: number | null;
  fusedSpeed: FusedSpeedSignal | null;
}): { label: string; value: string }[] {
  if (!args.userLocation) return [];
  const fusedValue = args.fusedSpeed
    ? `${args.fusedSpeed.kmh.toFixed(1)} km/h (${args.fusedSpeed.source})`
    : NO_FUSED_SIGNAL_LABEL;
  return [
    { label: 'lat', value: String(args.userLocation.lat) },
    { label: 'lng', value: String(args.userLocation.lng) },
    {
      label: 'speed',
      value: args.speedMps == null ? '-' : `${args.speedMps.toFixed(2)} m/s`,
    },
    { label: 'fused', value: fusedValue },
    {
      label: 'accuracy',
      value: args.accuracyMeters == null ? '-' : `${args.accuracyMeters.toFixed(0)} m`,
    },
  ];
}

/**
 * #1346 — Share dump 섹션 SSOT.
 *
 * 변경 전: `buildDumpText` 함수 본체에 섹션 11개가 하드코딩 → 새 섹션 추가 시 매번 함수를
 *   고쳐야 하고, fusion log처럼 신규 buffer가 누락된 게 사고 후에야 발견됨.
 * 변경 후: 각 섹션 builder를 함수로 분리하고 `SHARE_SECTIONS`에 등록. 새 buffer를 추가하면
 *   1) builder 함수 작성 → 2) 이 배열에 한 줄 등록만 하면 dump/UI 양쪽에 자동 노출된다.
 *
 * 각 builder는 `(args) => string[]` — 빈 섹션(예: Gates에 suppressed reason 0건)이면 빈
 * 배열을 반환해 호출부가 헤더 자체를 생략한다. 출력 텍스트 포맷은 기존과 1:1로 일치한다.
 */

/**
 * 공유 dump의 단일 args 타입. SSOT 배열의 모든 builder가 같은 args를 받는다.
 * 새 섹션이 의존하는 필드는 여기에 optional로 추가하면 된다.
 */
interface BuildDumpArgs {
  userLocation: { lat: number; lng: number } | null;
  speedMps: number | null;
  accuracyMeters: number | null;
  // #852: GPS watch 구독 상태(FG/BG) + 마지막 신뢰 fix 시각. silent push wake 시 stale window 진단용.
  // 호환을 위해 optional — 미전달 시 'fg' / null로 fallback (한 번도 fix 없는 상태와 동일 표기).
  gpsActive?: GpsActiveState;
  lastFixAtMs?: number | null;
  /** #853 — Phase 3 fused speed. 미전달이면 dump의 fused 라인이 (no fused signal). */
  fusedSpeed?: FusedSpeedSignal | null;
  nearestName: string | null;
  nearestDistanceM: number | null;
  variants: string[];
  fusion: {
    confidence: FusionConfidence;
    source: FusionSource;
    fusedLabel: string;
    gpsLabel: string;
    differs: boolean;
    candidateTrains: string[] | null;
  };
  arrivalSummary: string;
  isMock: boolean;
  silentPush: SilentPushDiagnostics;
  /**
   * #1568 (T8b, Epic ADR-017 #1553) — backend가 silent push로 forward한 TripPositionSSoT mirror.
   * null/미전달 시 dump는 `(no recent SSoT push)` 한 줄만 출력 — backend 호환성 추적용.
   */
  backendSsotMirror?: BackendSsotMirrorEntry | null;
  logs: AlarmLogEntry[];
  /**
   * #2284 — fired-only 독립 영속 링버퍼 스냅샷. alarmLog 200-cap rotate와 무관하게 보존되는
   * 발사 기록 SSoT. 미전달 시 (empty) — 단위 테스트 호환.
   */
  firedAlarmLog?: readonly FiredAlarmLogEntry[];
  // #1308: iOS 저전력 모드. optional — 미전달 시 false(off). silent push 측정용.
  lowPowerMode?: boolean;
  // #756: OS 큐 dump. 미전달/null = DebugModal에서 한 번도 Refresh 안 한 상태.
  scheduledDump?: ScheduledNotificationDumpEntry[] | null;
  // #1215 (D9) — 추가 상태 가시화. 모두 optional — 미전달 시 dump의 해당 라인은 '—' 표기.
  barometerSubsurface?: boolean | null;
  /**
   * #1398 — `stop=undefined`(평가 불가)일 때의 원인. undefined면 정상(stop이 boolean 결정).
   * SPOF 분리 효과 측정용. 미전달 시 dump 미노출 (graceful — 기존 호출자 호환).
   */
  barometerUnavailableReason?: import('../../../shared/hooks/useBarometer').BarometerUnavailableReason;
  /**
   * #1398 — ring buffer에 누적된 reading 수. warm-up 인지/sensor 활성 판단용.
   * 미전달 시 dump 미노출 (graceful).
   */
  barometerReadingCount?: number;
  fusionDetection?: FusionDetectionSummary | null;
  trip?: TripDebugState | null;
  sleep?: SleepDebugState | null;
  /**
   * #1346 — Fusion log 채널을 share 텍스트에도 포함하기 위해 entries를 명시 주입.
   * fusionDebugBuffer는 module-level singleton이지만 함수 순수성 유지를 위해 인자로 받는다.
   * 미전달 시 (empty)로 출력 — 단위 테스트에서 fusion log를 다루지 않는 경우 호환.
   */
  fusionLog?: readonly FusionDebugEntry[];
  /** #1896 (RC-8) — boarding-lock-drift 별 buffer entries. 미전달/빈 배열은 (empty). */
  boardingLockDriftLog?: readonly BoardingLockDriftEntry[];
  /** #2152 — BoardingLock lifecycle(create/release) 별 buffer entries. 미전달/빈 배열은 (empty). */
  lockLifecycleLog?: readonly LockLifecycleEntry[];
  /**
   * #2268 (C1) — pending(A)→confirmed(B) lock 정정 counter(#1166). `BoardingTrainList`가
   * `recordLockCorrection`으로 기록하지만 DebugModal에 섹션이 없어 dump로 관측 불가했다.
   * 미전달 시 (n/a) 표기.
   */
  lockCorrection?: ReturnType<typeof getLockCorrectionMetrics>;
  /**
   * #2330 (consensus-D, 설계 SSoT #2323 (3)) — 명시 탭이 backend consensus-confirmed 제안과
   * 다른 열차를 선택했을 때 fire하는 counter(`consensusMismatchMetrics.ts`). 미전달 시 (n/a) 표기.
   */
  consensusMismatch?: ReturnType<typeof getConsensusMismatchMetrics>;
  /**
   * #1413 — BoardingLock 섹션 dump 입력. lock 활성/trainCode/boardingLine/expiresAt.
   * 미전달이면 lock=null과 동일(active=no)로 출력.
   */
  boardingLock?: BoardingLock | null;
  /**
   * #1413 — Estimator State buffer entries. 미전달/빈 배열은 (empty)로 출력.
   */
  estimatorLog?: readonly EstimatorDebugEntry[];
  /**
   * #1413 — boardingPrompt 카운터·acceptance / Counters 등 시간 기반 집계의 기준 시각.
   * 미전달 시 `Date.now()` 사용. 테스트에서 결정적 출력 확보용.
   */
  nowMs?: number;
  /**
   * #2268 (C2) — DebugModal 모듈이 로드된 시각(≈ 앱 launch). 미전달 시
   * `DEBUG_MODAL_LOAD_AT_MS`(모듈 상수) 사용 — 테스트에서 결정적 출력 확보용.
   * Lifecycle/Drift 버퍼는 in-memory라 앱 kill/BG 재기동 시 리셋된다. 두 섹션이 (0)일 때
   * "이벤트 없음"과 "재기동으로 증발"을 구분할 수 없는 문제(C2)를 이 값 기준 age 표기로 완화한다.
   */
  launchAtMs?: number;
  /**
   * #1421 — Auto-lock Candidate 측정 스냅샷. 미전달 시 섹션은 (n/a) 표기.
   * DebugModalInner가 매 render에서 useFusedNearestStation SSOT + stability buffer + direction을
   * 계산해 주입한다. 본 PR은 측정만 — 동작 변경 없음.
   */
  autoLockMeta?: AutoLockDebugMeta;
  /**
   * #1430 — Environment Distribution 측정 스냅샷. 미전달 시 섹션은 (n/a) 표기.
   * DebugModalInner가 매 render에서 SSOT 활성 cascade → state 결정 → counter tick → snapshot.
   * 본 PR은 측정만 — 동작 변경 없음.
   */
  envDistribution?: EnvironmentDistributionSnapshot;
  /**
   * #1518 — Backend call ring buffer entries. 미전달/빈 배열은 (empty)로 출력.
   * call/response/error 1쌍이 callId로 묶여 있어 dump 본문만으로 latency·status 재구성 가능.
   */
  backendCalls?: readonly BackendCallEntry[];
  /**
   * #1501 — Raw signal ring buffer entries (직전 30건까지). 미전달 시 (empty) 출력 —
   * 단위 테스트에서 raw signal을 다루지 않는 경우 호환.
   */
  rawSignalLog?: readonly RawSignalEntry[];
  /**
   * #1540 (S7) — GPS drop ring buffer entries. 미전달/빈 배열은 (empty)로 출력.
   * fusionDebugBuffer와 분리된 채널이라 dump에서도 별도 섹션으로 노출한다.
   */
  gpsDropLog?: readonly GpsDropEntry[];
  /**
   * #1902 (RC-18) — candidate reject ring buffer entries (distance/line). 미전달/빈 배열은 (empty)로 출력.
   * fusionDebugBuffer와 분리된 채널이라 dump에서도 별도 섹션으로 노출.
   */
  candidateRejectLog?: readonly CandidateRejectEntry[];
  /**
   * #1898 — RC-12 결함 A 가시화. trip route arcStations 목록. arcStations에서 distinct
   * line sequence를 도출해 dump/UI 양쪽에 trip line context 노출. 미전달 시 (no route).
   *
   * 환승 trip은 line 변경 순서를 보존해 "2 -> 4 -> 5" 형태로 표시 — modal 노선 추천 잘못
   * (예: 4/5호선) 회귀 발생 시 사용자가 share dump만으로 trip line context 확인 가능.
   */
  routeLines?: readonly { line: string; firstStation: string; lastStation: string }[];
  /**
   * #1898 — RC-12 결함 B 가시화. accelerometer raw snapshot (rmsMagnitude/sampleCount).
   * useFusedNearestStation의 accelerometerPattern은 분류 결과(stationary/walking/automotive)만
   * 노출 → 사용자가 "측정값 자체가 있는가?" 즉시 확인 불가. raw snapshot으로 dashboard 보강.
   *
   * 미전달/null은 (no snapshot)로 명시 — "한 번도 측정 안 됨" / "미지원" / "load 안 함" 구분 가능.
   */
  accelSnapshot?: AccelerometerSnapshot | null;
  /**
   * ADR-022 Feature Flag (arch:simple-arrival-v1) 상태. Modal render에 노출되는 3 값을
   * share dump에도 포함 — 사용자가 dogfood 판정(env vs remote vs 최종 active)을 dump만으로
   * 사후 재구성 가능.
   *
   * 미전달 시 (n/a)로 표기.
   */
  archFlag?: {
    /** `EXPO_PUBLIC_SIMPLE_ARRIVAL_ARCH` env 값. */
    env: boolean;
    /** `arch:simple-arrival-v1` KV remote 값. undefined = 미조회/실패. */
    remote: 'on' | 'off' | undefined;
    /** remote fetch 결과 kind (`ok` / `unconfigured` / `error` / `loading`). */
    remoteKind: string;
    /** 최종 판정 — `isSimpleArchEnabled(remote)`. env=true 시 remote 무관 ON. */
    active: boolean;
  };
  /**
   * Operation Dashboard의 device-local metric 입력(alarmAccuracy). backend polling metric
   * (locklessMiss / boardableMiss / accelPattern / latency / laPush 등)은 이 필드가 아니라
   * `observabilityMetricsClient`의 마지막 poll snapshot에서 직접 읽는다(`buildOperationDashboardSection`
   * 참조) — `OperationDashboardSection` 마운트 시 채워진 결과를 dump 시점에 sync로 재사용.
   *
   * 노출 metric:
   *  - alarmAccuracy (local): tripGroundTruth store `responses` accurate/answered 비율
   *  - silentPushReach (local): `computeSilentPushReach(logs)` visibleReceived/totalReceived (#2231)
   *
   * 미전달 시 (n/a) — DebugModalInner 이 store snapshot 을 주입하지 않은 케이스 graceful.
   */
  operationDashboard?: {
    /** 사용자 "정확했어요" 응답 수. */
    groundTruthAccurateCount: number;
    /** 응답 총 개수(unanswered 제외). */
    groundTruthAnsweredCount: number;
  };
  /**
   * Fusion picker tier 별 ring buffer entries. 최근 1h 윈도우 집계를 dump에 노출 —
   * Modal render(line 2552)과 동일 SSOT(`formatFusionPickerTierDistribution`) 재사용.
   *
   * 미전달/빈 배열은 (none) 반환(포맷터 컨벤션 따라).
   */
  fusionTierLog?: readonly FusionTierLogEntry[];
}

/** dump 본체에서 사용하는 single builder 시그니처 — 본문 줄 배열을 반환. */
type SectionBuilder = (args: BuildDumpArgs) => string[];

function buildGpsSection(args: BuildDumpArgs): string[] {
  // #852: watch 구독 상태 + 마지막 fix 시각. 'bg'면 watch가 정지된 상태(silent push wake 등).
  // #853: fused speed signal. userLocation 있는 경우만 라인 노출, 미전달 시 NO_FUSED_SIGNAL_LABEL.
  // 호출자 호환을 위해 두 필드 모두 optional — 미전달 시 'fg'/(never)/(no fused signal)로 표기.
  const lines: string[] = [];
  if (args.userLocation) {
    const fusedDump = args.fusedSpeed
      ? `${args.fusedSpeed.kmh.toFixed(1)} km/h (${args.fusedSpeed.source})`
      : NO_FUSED_SIGNAL_LABEL;
    lines.push(
      `lat=${args.userLocation.lat}, lng=${args.userLocation.lng}, speed=${args.speedMps ?? '-'} m/s, accuracy=${args.accuracyMeters ?? '-'} m`,
      `fused=${fusedDump}`,
    );
  } else {
    lines.push('(no location)');
  }
  lines.push(
    `state=${args.gpsActive ?? 'fg'}, lastFix=${formatClockTimeWithSeconds(args.lastFixAtMs ?? null)}`,
    formatSubsurfaceDumpLine(args),
  );
  return lines;
}

/**
 * #1398 — subsurface dump 라인 + 기압계 unavailable 원인 분해.
 *
 * 정상 (stop이 boolean 결정) → `subsurface=true|false`만 노출.
 * unavailable (sensor/permission/readings) → `subsurface=... (reason=sensor, readings=12)` 포함.
 *
 * 진단 흐름:
 *   - reason='sensor'     → iPhone 6 이하 등 기기 미지원. WiFi/GPS만 사용.
 *   - reason='permission' → NSMotionUsageDescription 거절. 설정 안내 진입점.
 *   - reason='readings'   → warm-up 초기 또는 sample 부족. ~30s 후 자연 해소.
 *
 * 미전달 시 (기존 호출자 호환) raw subsurface만 노출 — 진단 필드 graceful skip.
 */
function formatSubsurfaceDumpLine(args: BuildDumpArgs): string {
  const subsurface = `subsurface=${formatOptionalBool(args.barometerSubsurface)}`;
  const parts: string[] = [];
  if (args.barometerUnavailableReason !== undefined) {
    parts.push(`reason=${args.barometerUnavailableReason}`);
  }
  if (args.barometerReadingCount !== undefined) {
    parts.push(`readings=${args.barometerReadingCount}`);
  }
  return parts.length > 0 ? `${subsurface} (${parts.join(', ')})` : subsurface;
}

function buildNearestSection(args: BuildDumpArgs): string[] {
  const lines: string[] = [
    args.nearestName
      ? `${args.nearestName} · ${args.nearestDistanceM ?? '-'} m`
      : '(no nearest station)',
  ];
  if (args.variants.length > 0) {
    lines.push(`variants: ${args.variants.join(', ')}`);
  }
  return lines;
}

function buildFusionSection(args: BuildDumpArgs): string[] {
  const lines: string[] = [
    `confidence=${args.fusion.confidence}, source=${args.fusion.source}`,
    `fused: ${args.fusion.fusedLabel}`,
    `gps:   ${args.fusion.gpsLabel}`,
  ];
  if (args.fusion.differs) lines.push('(fused != gps)');
  if (args.fusion.candidateTrains) {
    lines.push(
      `candidateTrains(${args.fusion.candidateTrains.length}): ${args.fusion.candidateTrains.join(', ') || '-'}`,
    );
  }
  // #1215 (D9) — tier / signalMask
  lines.push(
    `tier=${formatOptionalString(args.fusionDetection?.tier)}`,
    `signalMask=${formatOptionalString(args.fusionDetection?.signalMask)}`,
  );
  return lines;
}

/**
 * #1447 — `displayOnlyEstimate`가 null일 때 노출하는 fallback 라벨.
 * "estimator 결과 자체 없음" 상태를 명시한다(표시 wire-up 누락과 구분).
 */
const DISPLAY_ONLY_ESTIMATE_NONE_LABEL = '(none)';

/**
 * #1447 — Trip 섹션 displayOnlyEstimate row 값 산출.
 * trip 미전달/strategy=null → fallback. 모든 strategy(5종)는 그대로 노출.
 */
function formatDisplayOnlyEstimateStrategy(
  strategy:
    | import('../../route/utils/stationProgressEstimator').StationProgressStrategy
    | null
    | undefined,
): string {
  return strategy == null ? DISPLAY_ONLY_ESTIMATE_NONE_LABEL : strategy;
}

/**
 * #1604 — trip 미전달 / lifecyclePhase 미명시 케이스에서 tripStartedAt으로 자동 derive.
 * tripStartedAt 자체도 없으면 'none' 반환.
 */
function resolveLifecyclePhase(trip: TripDebugState | null | undefined): TripLifecyclePhase {
  if (trip?.lifecyclePhase !== undefined) return trip.lifecyclePhase;
  return tripLifecyclePhase(trip?.tripStartedAt ?? null);
}

function buildTripSection(args: BuildDumpArgs): string[] {
  return [
    `lockless=${formatOptionalBool(args.trip?.lockless)}`,
    `tripStartedAt=${formatOptionalTs(args.trip?.tripStartedAt ?? null)}`,
    `currentHopIndex=${formatOptionalNumber(args.trip?.currentHopIndex)}`,
    `route hop count=${formatOptionalNumber(args.trip?.routeHopCount ?? null)}`,
    // #1447 — displayOnlyEstimate.strategy 라벨. null 케이스도 fallback으로 항상 노출.
    `displayOnlyEstimate=${formatDisplayOnlyEstimateStrategy(args.trip?.displayOnlyEstimateStrategy)}`,
    // #1604 — trip lifecycle phase (T10 #1594). 사용자가 trip 종료 원인(silence/force-end)을 즉시 확인.
    `lifecyclePhase=${resolveLifecyclePhase(args.trip)}`,
  ];
}

function buildSleepSection(args: BuildDumpArgs): string[] {
  const sleepModeText = args.sleep ? (args.sleep.sleepMode ? 'on' : 'off') : UNKNOWN_LABEL;
  return [
    `sleepMode=${sleepModeText}`,
    `firstHopApproaching=${formatOptionalBool(args.sleep?.firstHopApproaching)}`,
  ];
}

/**
 * #1898 — RC-12 결함 A. trip route line sequence를 dump에 노출.
 *
 * 출력 형식 (단독 line):
 *   summary=2
 *   line=2 first=신도림 last=강남
 *
 * 출력 형식 (환승):
 *   summary=2 -> 4 -> 5
 *   line=2 first=신도림 last=동대문역사문화공원
 *   line=4 first=동대문역사문화공원 last=사당
 *   line=5 first=사당 last=여의도
 *
 * routeLines 미전달/빈 배열은 `(no route)` 1줄 — destination 미설정 또는 lockless trip 미시작.
 */
function buildRouteLinesSection(args: BuildDumpArgs): string[] {
  const lines = args.routeLines ?? [];
  if (lines.length === 0) return ['(no route)'];
  const summary = lines.map((l) => l.line).join(' -> ');
  const detail = lines.map(
    (l) => `line=${l.line} first=${l.firstStation} last=${l.lastStation}`,
  );
  return [`summary=${summary}`, ...detail];
}

/**
 * #1898 — RC-12 결함 B. accelerometer raw snapshot dashboard.
 *
 * 출력 형식 (snapshot 있음):
 *   pattern=automotive
 *   rmsMagnitude=2.34 m/s^2
 *   sampleCount=287
 *   lastUpdate=12:24:09
 *
 * 출력 형식 (snapshot null — 미지원/load 안 함):
 *   (no snapshot)
 *
 * sampleCount=0 케이스도 정상 출력 — "한 번도 sample 수집 안 됨" 명시.
 * useFusedNearestStation의 accelerometerPattern과 본 섹션의 pattern은 동일 SSOT(native cache)
 * 에서 유래하지만, 본 섹션은 polling 시점 snapshot — UI/dump 양쪽 동일 raw 데이터 노출.
 */
function buildAccelFingerprintSection(args: BuildDumpArgs): string[] {
  const snapshot = args.accelSnapshot ?? null;
  if (!snapshot) return ['(no snapshot)'];
  return [
    `pattern=${snapshot.patternClass}`,
    `rmsMagnitude=${snapshot.rmsMagnitude.toFixed(2)} m/s^2`,
    `sampleCount=${snapshot.sampleCount}`,
    `lastUpdate=${formatTime(snapshot.timestamp)}`,
  ];
}

/**
 * ADR-022 Phase 0 — Feature Flag(arch:simple-arrival-v1) 상태 dump 라인.
 *
 * Modal render(line 2147-2163)의 3 KeyValue row와 동일 SSOT — dogfood 판정 사후 재구성:
 *  - env      : `EXPO_PUBLIC_SIMPLE_ARRIVAL_ARCH` 환경변수 (true/false)
 *  - remote   : `arch:simple-arrival-v1` KV 값 (`on` / `off`) 또는 kind fallback (`unconfigured` / `error` 등)
 *  - active   : 최종 판정 (env OR remote='on')
 *
 * 미전달 시 (n/a) — hook 을 마운트하지 않은 호출자(단위 테스트 baseline) graceful.
 */
function buildFeatureFlagSection(args: BuildDumpArgs): string[] {
  const flag = args.archFlag;
  if (!flag) return ['(n/a)'];
  const remoteLabel = flag.remote ?? `(${flag.remoteKind})`;
  return [
    `env=${flag.env ? 'true' : 'false'}`,
    `remote=${remoteLabel}`,
    `active=${flag.active ? 'ON' : 'OFF'}`,
  ];
}

/** `value/total` 비율을 `pct% (value/total)`로 포맷. total=0이면 0%로 표시. */
function formatRatioPct(value: number, total: number): string {
  const pct = total === 0 ? 0 : Math.round((value / total) * 100);
  return `${pct}% (${value}/${total})`;
}

/** `label=pct% (value/total)` 한 줄 포맷. */
function formatBucketLine(label: string, value: number, total: number): string {
  return `${label}=${formatRatioPct(value, total)}`;
}

/**
 * #1769 accelPattern 4종 분포를 한 줄로 포맷. 분포 key 수가 늘어도 코드 변경 없이
 * 순회(`Object.entries`)해 대응 — `OperationDashboardSection`의 `ACCEL_PATTERN_KEYS`와
 * 동일 데이터(`AccelPatternBucket`)를 소비하되 하드코딩 배열에 의존하지 않는다.
 */
function formatAccelPatternLine(accelPattern: ObservabilityMetrics['accelPatternHitRatio']): string {
  const parts = Object.entries(accelPattern).map(
    ([key, { count, ratio }]) => `${key} ${Math.round(ratio * 100)}%(${count})`,
  );
  return `accelPattern: ${parts.join(' ')}`;
}

/**
 * backend observability metrics(`ObservabilityMetrics`)를 dump 라인 배열로 변환.
 * Modal UI(`OperationDashboardSection`)와 동일 SSOT(backend 응답 필드)를 그대로 읽어
 * 텍스트로 재구성 — ratio 재계산 로직 분기는 두지 않고 필드값을 직접 사용.
 */
function formatBackendMetricsLines(metrics: ObservabilityMetrics): string[] {
  const { locklessMissRatio, boardableMissRatio, laPushDeliveryRatio } = metrics;
  const lines = [
    formatBucketLine('locklessMiss', locklessMissRatio.value, locklessMissRatio.total),
    formatBucketLine('boardableMiss', boardableMissRatio.value, boardableMissRatio.total),
    formatAccelPatternLine(metrics.accelPatternHitRatio),
    metrics.silentPushLatency
      ? `silentPushLatency=p50=${metrics.silentPushLatency.p50}ms p95=${metrics.silentPushLatency.p95}ms n=${metrics.silentPushLatency.totalSamples}`
      : 'silentPushLatency=no data',
    formatBucketLine(
      'laPushDelivery',
      laPushDeliveryRatio.sent,
      laPushDeliveryRatio.sent + laPushDeliveryRatio.failed,
    ),
    metrics.silentPushReachRatio
      ? formatBucketLine(
          'silentPushReach(backend)',
          metrics.silentPushReachRatio.received,
          metrics.silentPushReachRatio.sent,
        )
      : 'silentPushReach(backend)=no data',
    metrics.algorithmAccuracyRatio
      ? formatBucketLine('algorithmAccuracy', metrics.algorithmAccuracyRatio.value, metrics.algorithmAccuracyRatio.total)
      : 'algorithmAccuracy=no data',
    metrics.locklessTripMissRatio
      ? `locklessTripMiss(paradigm=${metrics.locklessTripMissRatio.paradigmIntent})=${formatRatioPct(
          metrics.locklessTripMissRatio.miss,
          metrics.locklessTripMissRatio.miss + metrics.locklessTripMissRatio.fired,
        )}`
      : 'locklessTripMiss=no data',
  ];
  return lines;
}

/**
 * backend observability metrics의 마지막 poll snapshot(`getLastObservabilityMetricsSnapshot`)을
 * dump 라인으로 변환. `OperationDashboardSection`이 마운트 시 1회 `fetchObservabilityMetrics()`를
 * 호출해 이 snapshot을 채운다 — 별도 polling을 추가하지 않고 그 결과를 dump 시점에 sync로 읽는다.
 *
 * - 한 번도 poll 안 됨(모달 진입 전 dump 등): `(no backend poll yet)`
 * - poll 실패(unconfigured/error): `(backend poll failed: <reason>)`
 * - 성공: metric 라인들 + `as of <조회 시각>` (staleness 명시 — snapshot이 dump 시점 것이 아닐 수 있음)
 */
function buildBackendMetricsSection(): string[] {
  const snapshot = getLastObservabilityMetricsSnapshot();
  if (!snapshot) return ['(no backend poll yet)'];
  const { result, fetchedAtMs } = snapshot;
  if (result.kind !== 'ok') {
    const reason = result.kind === 'unconfigured' ? 'unconfigured' : result.message;
    return [`(backend poll failed: ${reason})`];
  }
  return [...formatBackendMetricsLines(result.metrics), `as of ${formatTime(fetchedAtMs)}`];
}

/**
 * Operation Dashboard(Modal render line 2141-2143) metric dump.
 *
 * device-local metric(alarmAccuracy/silentPushReach)과 backend polling metric(locklessMiss /
 * boardableMiss / accelPattern / silentPushLatency / laPushDelivery / silentPushReach(backend) /
 * algorithmAccuracy / locklessTripMiss)을 모두 포함한다.
 *
 * backend metric은 `observabilityMetricsClient`의 마지막 poll 결과 snapshot을 읽는다 — dump는
 * async fetch를 하지 않고 `OperationDashboardSection` 마운트 시 이미 완료된 poll의 결과를
 * 그대로 노출한다(`as of` 로 조회 시각 명시, staleness graceful).
 *
 * 노출 metric:
 *  - alarmAccuracy (local): tripGroundTruth store `responses` accurate/answered 비율
 *  - silentPushReach (local): `computeSilentPushReach(logs)` visibleReceived/totalReceived (#2231)
 *  - backend 8종: 위 참고
 *
 * 미전달 시 (n/a) — DebugModalInner 가 store snapshot 을 주입하지 않은 호출자 graceful.
 */
function buildOperationDashboardSection(args: BuildDumpArgs): string[] {
  const op = args.operationDashboard;
  if (!op) return ['(n/a)'];
  // #2231 — #2064 이후 device 로컬 발사(fired)는 구조적으로 no-op이라 fired/received 비율은
  // 항상 0인 죽은 지표였다. visible station kind로 도달한 수 / 전체 수신 수로 재정의.
  const reach = computeSilentPushReach(args.logs);
  return [
    `alarmAccuracy(local)=${op.groundTruthAccurateCount}/${op.groundTruthAnsweredCount}`,
    `silentPushReach(local)=${reach.visibleReceived}/${reach.totalReceived}`,
    ...buildBackendMetricsSection(),
  ];
}

/**
 * Fusion picker tier 채택 분포 dump (최근 1h). Modal render(line 2552-2560)와 동일 SSOT —
 * `formatFusionPickerTierDistribution(fusionTierLog, nowMs)` 재사용해 UI/dump 정합성 보장.
 *
 * 미전달/빈 배열은 (none)로 명시(포맷터 컨벤션 따라).
 */
function buildFusionTierSection(args: BuildDumpArgs): string[] {
  const entries = args.fusionTierLog ?? [];
  return [formatFusionPickerTierDistribution(entries, args.nowMs ?? Date.now())];
}

function buildArrivalSection(args: BuildDumpArgs): string[] {
  const lines: string[] = [args.arrivalSummary];
  if (args.isMock) lines.push('(MOCK)');
  return lines;
}

function buildSilentPushSection(args: BuildDumpArgs): string[] {
  return silentPushDiagRows(
    args.silentPush,
    args.logs,
    args.lowPowerMode ?? false,
  ).map(({ dumpKey, value }) => `${dumpKey}=${value}`);
}

/**
 * #1568 (T8b, Epic ADR-017 #1553) — backend SSoT mirror dump rows.
 *
 * silent push payload.ssot가 BACKEND_SSOT_MIRROR_KEY에 영속화한 상태. backend cycle이 한 번도
 * SSoT 권위를 forward 안 했으면 `(no recent SSoT push)` 1줄만 노출 — share dump에서 backend
 * 호환성/cycle 활성 여부가 즉시 식별 가능하도록.
 */
const BACKEND_SSOT_DUMP_LABELS = {
  currentStationId: 'currentStationId',
  motionState: 'motionState',
  lastAdvanceEvidence: 'lastAdvanceEvidence',
  lastAdvanceAt: 'lastAdvanceAt',
  // #1572 (T9, ADR-017) — alarmEvents 카운트. backend가 결정한 alarm 누적 개수.
  // 5 fire path가 evaluateSsotFireGate로 본 list를 reader-only 게이트로 사용.
  alarmEventsCount: 'alarmEventsCount',
} as const;

function buildBackendSsotSection(args: BuildDumpArgs): string[] {
  const entry = args.backendSsotMirror ?? null;
  if (!entry) return ['(no recent SSoT push)'];
  return [
    `${BACKEND_SSOT_DUMP_LABELS.currentStationId}=${entry.currentStationId}`,
    `${BACKEND_SSOT_DUMP_LABELS.motionState}=${entry.motionState}`,
    `${BACKEND_SSOT_DUMP_LABELS.lastAdvanceEvidence}=${entry.lastAdvanceEvidence}`,
    `${BACKEND_SSOT_DUMP_LABELS.lastAdvanceAt}=${entry.lastAdvanceAt}`,
    `${BACKEND_SSOT_DUMP_LABELS.alarmEventsCount}=${entry.alarmEvents?.length ?? 0}`,
  ];
}

function buildScheduledQueueSection(args: BuildDumpArgs): string[] {
  // #756: 사용자가 Refresh 안 했으면 dump 섹션 자체를 "(not loaded)"로 명시해
  // "비어있음"과 "load 안 함"을 dump 텍스트만 보고도 구분 가능하게.
  // optional 필드 — undefined 도 null 과 동일 처리.
  if (args.scheduledDump == null) return ['(not loaded)'];
  return args.scheduledDump.map(formatScheduledNotificationLine);
}

function buildGatesSection(args: BuildDumpArgs): string[] {
  // #1019 — suppressed reason 0건이면 빈 배열 → 호출부에서 헤더 자체 생략.
  const reasonLine = formatReasonCountsLine(args.logs);
  return reasonLine ? [reasonLine] : [];
}

// #2284 — args.firedAlarmLog optional 기본값 helper. build/suffix 양쪽이 공유해 동일 branch를
// 재사용 — build()가 omitIfEmpty 판정 이전에 항상 호출되므로 undefined/defined 두 branch
// 모두 이 한 곳에서 커버된다(suffix는 body 비었을 때 호출 자체가 안 됨, buildDumpText 참고).
function getFiredEntries(args: BuildDumpArgs): readonly FiredAlarmLogEntry[] {
  return args.firedAlarmLog ?? [];
}

// #1626 — V4 발사 시점 dump. baseline 측정 fidelity 향상:
// backend `/admin/alarm-log-stats` 호출 없이 device DebugModal에서 발사 시점 즉시 확인.
// #2284 — alarmLog(200-cap, 모든 outcome 혼합) 파생값 대신 독립 fired-only 버퍼를 SSoT로
// 사용. rotate 절단(2026-08-11 덤프 evidence)으로 오래된 fired 기록이 사라지던 회귀 차단.
function buildNotificationsFiredSection(args: BuildDumpArgs): string[] {
  return [...getFiredEntries(args)].reverse().map(formatFiredLogLine);
}

function buildAlarmLogSection(args: BuildDumpArgs): string[] {
  const lines: string[] = [];
  // #564 — source별 카운트 헤더(UI와 동일 포매터 공유). 빈 문자열이면 헤더 생략.
  const sourcesLine = formatSourceCountsLine(args.logs);
  if (sourcesLine) lines.push(`sources: ${sourcesLine}`);
  for (const entry of [...args.logs].reverse()) {
    lines.push(formatLogLine(entry));
  }
  return lines;
}

/**
 * #1692 — Alarm Log Reasons (1h) 섹션.
 *
 * dump 시점 기준 최근 1시간 내 suppressed reason 집계 (count 내림차순 top-10).
 * 사용자가 "어떤 게이트가 가장 자주 발동했는지"를 share dump 수신 즉시 파악 가능.
 *
 * nowMs 미전달 시 Date.now() 사용 — 테스트 결정적 출력 확보.
 * 1h 윈도우 내 suppressed 항목이 없으면 (empty) 반환.
 *
 * #2049 — dump builder(#1692)와 UI section이 공유하는 SSoT helper로 추출.
 * `buildAlarmLogReasonsSummarySection`는 args unpack만 담당하는 thin wrapper.
 */
function computeAlarmLogReasonsLines(
  logs: readonly AlarmLogEntry[],
  nowMs?: number,
): string[] {
  const now = nowMs ?? Date.now();
  const counters = countAlarmLogReasonsByWindow(logs, 60 * 60 * 1000, now);
  if (counters.length === 0) return ['(empty)'];
  return counters.map(({ reason, count }) => `${reason}: ${count}`);
}

function buildAlarmLogReasonsSummarySection(args: BuildDumpArgs): string[] {
  return computeAlarmLogReasonsLines(args.logs, args.nowMs);
}

/**
 * #1501 — Raw signal 섹션. buffer 전체를 최신순으로 직렬화해 share dump에 포함.
 * #1881 — share dump는 buffer 전체를 포함 (UI는 별도 DEBUG_LOG_DISPLAY_LIMIT 적용).
 * 빈 buffer는 (empty)로 명시 — "한 번도 push 안 됨"과 "load 안 함"을 구분.
 */
function buildRawSignalSection(args: BuildDumpArgs): string[] {
  const entries = args.rawSignalLog ?? [];
  if (entries.length === 0) return ['(empty)'];
  return [...entries].reverse().map(formatRawSignalLine);
}

/**
 * #1859 — Cellular Tech Distribution 집계 순수 함수. rawSignalLog entries에서 cellular 필드를
 * 집계해 tech별 발생 빈도와 vote 분포 라인 목록을 반환.
 *
 * 구버전 엔트리(cellular=null): 'legacy' 버킷으로 분리 집계.
 *
 * 출력 형식 (tech 빈도 내림차순):
 *   LTE: 45x (vote=surface)
 *   NRNSA: 12x (vote=surface)
 *   WCDMA: 3x (vote=underground)
 *   legacy(no field): 5x
 *   total=65 measured=60 surface=57 underground=3 unknown=0 legacy=5
 */
export function computeCellularTechDistribution(entries: readonly RawSignalEntry[]): string[] {
  if (entries.length === 0) return ['(empty)'];

  const techStats = new Map<string, { count: number; vote: string }>();
  let legacyCount = 0;
  let surfaceCount = 0;
  let undergroundCount = 0;
  let unknownCount = 0;

  for (const entry of entries) {
    if (entry.cellular == null) {
      legacyCount += 1;
      continue;
    }
    const { tech, vote } = entry.cellular;
    const techKey = tech != null ? tech.replace('CTRadioAccessTechnology', '') : '(null)';
    const existing = techStats.get(techKey);
    techStats.set(techKey, { count: (existing?.count ?? 0) + 1, vote });
    if (vote === 'surface') surfaceCount += 1;
    else if (vote === 'underground') undergroundCount += 1;
    else unknownCount += 1;
  }

  const lines: string[] = [];
  const sorted = [...techStats.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [tech, { count, vote }] of sorted) {
    lines.push(`${tech}: ${count}x (vote=${vote})`);
  }
  if (legacyCount > 0) lines.push(`legacy(no field): ${legacyCount}x`);
  const measured = entries.length - legacyCount;
  lines.push(`total=${entries.length} measured=${measured} surface=${surfaceCount} underground=${undergroundCount} unknown=${unknownCount} legacy=${legacyCount}`);
  return lines;
}

/** #1859 — SHARE_SECTIONS builder wrapper. */
function buildCellularTechDistributionSection(args: BuildDumpArgs): string[] {
  return computeCellularTechDistribution(args.rawSignalLog ?? []);
}

/**
 * #1346 — Fusion log 섹션. 빈 buffer일 때 (empty)로 명시 출력해 "한 번도 push 안 됨"과
 * "load 안 함"을 구분한다(scheduled queue 컨벤션 따라).
 */
function buildFusionLogSection(args: BuildDumpArgs): string[] {
  const entries = args.fusionLog ?? [];
  if (entries.length === 0) return ['(empty)'];
  // 최신이 위로 — Alarm log와 동일 정렬.
  return [...entries].reverse().map(formatFusionDebugLine);
}

/**
 * #1540 (S7) — gps-drop 한 줄 포맷. Fusion log와 동일 컨벤션(HH:MM:SS | … ).
 * acc/speed/reason만 노출 — drop entry는 nearestStation 결정 전 단계이므로 station 컬럼 없음.
 */
function formatGpsDropLine(entry: GpsDropEntry): string {
  const time = formatTime(entry.ts);
  const acc = entry.accuracyMeters == null ? '-' : `${Math.round(entry.accuracyMeters)}m`;
  const sp = entry.speedMps == null ? '-' : `${entry.speedMps.toFixed(1)}m/s`;
  return `${time} | gps-drop | acc=${acc} sp=${sp} reason=${entry.dropReason}`;
}

function buildGpsDropLogSection(args: BuildDumpArgs): string[] {
  const entries = args.gpsDropLog ?? [];
  if (entries.length === 0) return ['(empty)'];
  return [...entries].reverse().map(formatGpsDropLine);
}

/**
 * #1902 (RC-18) — candidate reject 한 줄 포맷. reason별로 다른 컬럼:
 *   - candidate-distance: trainNo + station + 측정 거리 (R12-a, #1616).
 *   - candidate-line: line만 노출 — enumerate 단계 reject라 train picking 전.
 */
function formatCandidateRejectLine(entry: CandidateRejectEntry): string {
  const time = formatTime(entry.ts);
  // #2093 (G) — 집계 윈도우(candidateRejectBuffer.CANDIDATE_REJECT_AGGREGATION_WINDOW_MS) 안에
  // 같은 reason이 반복 reject되면 entry.count가 2 이상 — "×N" suffix로 burst 집계를 노출.
  // count 미설정/1은 기존 개별 entry와 동일 출력(하위 호환).
  const suffix = entry.count != null && entry.count > 1 ? ` ×${entry.count}` : '';
  if (entry.reason === 'candidate-distance') {
    const train = entry.trainNo ?? '-';
    const station = entry.stationName ?? '-';
    const d = entry.distanceKm != null ? `${Math.round(entry.distanceKm * 1000)}m` : '-';
    return `${time} | reject:${entry.reason} | ${train} ${station}(${entry.line}) d=${d}${suffix}`;
  }
  // #1934 G3 option B + #1936 G4 — candidate-env: cascade/candidate env 비교 노출.
  if (entry.reason === 'candidate-env') {
    const station = entry.stationName ?? '-';
    const cascade = entry.cascadeEnvironment ?? '-';
    const cand = entry.candidateEnvironment ?? '-';
    return `${time} | reject:${entry.reason} | ${station}(${entry.line}) cascade=${cascade} candidate=${cand}${suffix}`;
  }
  return `${time} | reject:${entry.reason} | line=${entry.line}${suffix}`;
}

function buildCandidateRejectLogSection(args: BuildDumpArgs): string[] {
  const entries = args.candidateRejectLog ?? [];
  if (entries.length === 0) return ['(empty)'];
  return [...entries].reverse().map(formatCandidateRejectLine);
}

/**
 * #1896 (RC-8) — boarding-lock GPS displacement gate trigger 1줄 포맷.
 * `time | boarding-lock-drift:branch | station(line) drift=Xm` — driftMeters null 시 '-'.
 */
function formatBoardingLockDriftLine(entry: BoardingLockDriftEntry): string {
  const time = formatTime(entry.ts);
  const d = entry.driftMeters != null ? `${Math.round(entry.driftMeters)}m` : '-';
  return `${time} | boarding-lock-drift:${entry.branch} | ${entry.lockStationName}(${entry.lockStationLine}) drift=${d}`;
}

/**
 * #2268 (C2) — Lifecycle/Drift ring buffer가 in-memory 비영속이라 (0)이 "이벤트 없음"인지
 * "앱 kill/BG 재기동으로 증발"인지 dump만으로 구분 불가능했다. launch 이후 경과 초를 헤더
 * suffix로 노출해, "(0) + age 짧음"과 "(0) + age 김"을 사용자가 판정할 수 있게 한다.
 */
function formatBufferAgeSuffix(args: BuildDumpArgs): string {
  const now = args.nowMs ?? Date.now();
  const launchAtMs = args.launchAtMs ?? DEBUG_MODAL_LOAD_AT_MS;
  const ageSec = Math.max(0, Math.round((now - launchAtMs) / 1000));
  return ` (buffer age since launch = ${ageSec}s)`;
}

function buildBoardingLockDriftLogSection(args: BuildDumpArgs): string[] {
  const entries = args.boardingLockDriftLog ?? [];
  if (entries.length === 0) return ['(empty)'];
  return [...entries].reverse().map(formatBoardingLockDriftLine);
}

/**
 * #2152 — BoardingLock lifecycle 1줄 포맷.
 * create: `time | lock-create:source | trainCode(line) station=stationId`
 * release: `time | lock-release:reason | trainCode(line)`
 */
function formatLockLifecycleLine(entry: LockLifecycleEntry): string {
  const time = formatTime(entry.ts);
  if (entry.event === 'create') {
    return `${time} | lock-create:${entry.source} | ${entry.trainCode}(${entry.line}) station=${entry.stationId}`;
  }
  return `${time} | lock-release:${entry.reason} | ${entry.trainCode}(${entry.line})`;
}

function buildLockLifecycleSection(args: BuildDumpArgs): string[] {
  const entries = args.lockLifecycleLog ?? [];
  if (entries.length === 0) return ['(empty)'];
  return [...entries].reverse().map(formatLockLifecycleLine);
}

/**
 * #2268 (C1) — Lock Correction 섹션. `getLockCorrectionMetrics()`(#1166)가 기록하는
 * fired count / lastFiredAtMs를 dump/UI 양쪽에 노출. 미전달 시 (n/a) — 호출자가 metrics를
 * 주입하지 않은 테스트 호환용.
 *
 * #2049 패턴을 따라 dump builder와 UI section이 이 helper를 공유한다.
 */
function computeLockCorrectionLines(
  metrics: ReturnType<typeof getLockCorrectionMetrics> | undefined,
): string[] {
  if (!metrics) return ['(n/a)'];
  const lastFiredLine = metrics.lastFiredAtMs === 0 ? '(never)' : formatTime(metrics.lastFiredAtMs);
  return [`fired=${metrics.fired}`, `lastFiredAt=${lastFiredLine}`];
}

function buildLockCorrectionSection(args: BuildDumpArgs): string[] {
  return computeLockCorrectionLines(args.lockCorrection);
}

/**
 * #2330 (consensus-D, 설계 SSoT #2323 (3)) — Consensus Mismatch 섹션. 명시 탭이 backend
 * consensus-confirmed 제안과 다른 열차를 선택한 빈도를 dump/UI 양쪽에 노출.
 * `computeLockCorrectionLines`와 동일 패턴 — 미전달 시 (n/a).
 */
function computeConsensusMismatchLines(
  metrics: ReturnType<typeof getConsensusMismatchMetrics> | undefined,
): string[] {
  if (!metrics) return ['(n/a)'];
  const lastFiredLine = metrics.lastFiredAtMs === 0 ? '(never)' : formatTime(metrics.lastFiredAtMs);
  return [`fired=${metrics.fired}`, `lastFiredAt=${lastFiredLine}`];
}

function buildConsensusMismatchSection(args: BuildDumpArgs): string[] {
  return computeConsensusMismatchLines(args.consensusMismatch);
}

/**
 * #1518 — Backend call ring buffer 1줄 포맷. call/response/error를 한 줄에 압축해
 * dump 분량을 줄인다. host 부분만 노출하고 path는 trim 안 함(진단 시 endpoint 식별).
 */
function formatBackendCallLine(entry: BackendCallEntry): string {
  const time = formatClockTimeWithSeconds(entry.ts);
  const corr = entry.corrId ? ` corrId=${entry.corrId}` : '';
  const callRef = ` callId=${entry.callId}`;
  if (entry.kind === 'call') {
    return `${time} CALL  ${entry.method} ${entry.url}${corr}${callRef}`;
  }
  if (entry.kind === 'response') {
    const lat = entry.latencyMs ?? 0;
    return `${time} RESP  ${entry.method} ${entry.url} status=${entry.status ?? '-'} ${lat}ms${corr}${callRef}`;
  }
  const lat = entry.latencyMs ?? 0;
  const msg = entry.errorMessage ?? '(no message)';
  return `${time} ERR   ${entry.method} ${entry.url} err="${msg}" ${lat}ms${corr}${callRef}`;
}

/**
 * #1518 — Backend Calls 섹션. 빈 buffer는 (empty)로 명시 출력해 "한 번도 fetch 안 됨"과
 * "buffer 미연동"을 구분 가능하게 한다. 최신이 위로 정렬(다른 log 섹션과 동일).
 */
function buildBackendCallsSection(args: BuildDumpArgs): string[] {
  const entries = args.backendCalls ?? [];
  if (entries.length === 0) return ['(empty)'];
  return [...entries].reverse().map(formatBackendCallLine);
}

/**
 * #2407 — pending sentinel(fallback lock, 실 trainCode 미확정)을 dump/UI 양쪽에 동일하게
 * "(pending)" suffix로 명시 표기. 두 표시 지점(dump text, BoardingLockSection UI)의 SSOT.
 */
function formatTrainCodeDisplay(trainCode: string): string {
  return isPendingTrainCode(trainCode) ? `${trainCode} (pending)` : trainCode;
}

/**
 * #1413 — BoardingLock 섹션. UI BoardingLockSection과 동일 필드를 dump key=value 형태로.
 * lock 없으면 `active=no` 1줄만.
 */
function buildBoardingLockSection(args: BuildDumpArgs): string[] {
  const lock = args.boardingLock ?? null;
  const now = args.nowMs ?? Date.now();
  const active = lock !== null && !isBoardingLockExpired(lock, now);
  const lines: string[] = [`active=${active ? 'yes' : 'no'}`];
  if (lock) {
    lines.push(
      `trainCode=${formatTrainCodeDisplay(lock.trainCode)}`,
      `line=${lock.boardingLine}`,
      `expiresAt=${formatAt(lock.boardedAt + lock.expectedDurationMs * BOARDING_LOCK_EXPIRY_FACTOR)}`,
      `boardedAt=${formatAt(lock.boardedAt)}`,
    );
    if (lock.hydratedFromSentinel) lines.push('sentinel=yes');
  }
  return lines;
}

/**
 * #1413 — Estimator State 섹션. Fusion log와 동일 컨벤션 (빈 buffer=(empty), 최신이 위).
 */
function buildEstimatorSection(args: BuildDumpArgs): string[] {
  const entries = args.estimatorLog ?? [];
  if (entries.length === 0) return ['(empty)'];
  return [...entries].reverse().map(formatEstimatorLine);
}

/**
 * #1413 — Boarding Prompt 발사 빈도 카운터 (5m / 1h / all).
 */
function buildBoardingPromptSection(args: BuildDumpArgs): string[] {
  const counts = countBoardingPromptByWindow(args.logs, args.nowMs ?? Date.now());
  return BOARDING_PROMPT_WINDOWS.map(({ key, label }) => `boardingPrompt(${label})=${counts[key]}`);
}

/**
 * #1413 — Boarding Prompt Acceptance dashboard.
 * displayed/responded/boarded/dismissed + 응답률·탑승률 + 최근 7일 시계열.
 */
function buildBoardingPromptAcceptanceSection(args: BuildDumpArgs): string[] {
  const stats = computeBoardingPromptMonitor(args.logs);
  const rows = exportRecentDays(stats, RECENT_DAYS, args.nowMs ?? Date.now());
  const lines: string[] = [
    `displayed=${stats.displayed}`,
    `responded=${stats.responded}`,
    `boarded=${stats.boarded}`,
    `dismissed=${stats.dismissed}`,
    `responseRate=${formatRatePct(stats.responseRatePct)}`,
    `boardedRate=${formatRatePct(stats.boardedRatePct)}`,
    `recent ${RECENT_DAYS}d (day / disp / resp / brd / dis):`,
  ];
  for (const row of rows) {
    lines.push(
      `${row.dayKey} | ${row.displayed} / ${row.responded} / ${row.boarded} / ${row.dismissed}`,
    );
  }
  return lines;
}

/**
 * #1413 — Counters 섹션. reason별 누적 + 마지막 발생 시각.
 */
function buildCountersSection(args: BuildDumpArgs): string[] {
  const counters = summarizeAlarmLogCounters(args.logs);
  if (counters.length === 0) return ['(empty)'];
  return counters.map(({ reason, count, lastTs }) => `${reason}=${count}x (${formatTime(lastTs)})`);
}

/**
 * #1682 — Suppress Reasons 섹션. 1h 윈도우 suppress reason 분포 top 5.
 * V9(suppress event rate < 100/h/trip) 측정 인프라.
 */
const SUPPRESS_REASONS_WINDOW_MS = 60 * 60 * 1000; // 1h
const SUPPRESS_REASONS_TOP_N = 5;

function buildSuppressReasonsSection(args: BuildDumpArgs): string[] {
  const counters = countAlarmLogReasonsByWindow(
    args.logs,
    SUPPRESS_REASONS_WINDOW_MS,
    args.nowMs ?? Date.now(),
  );
  if (counters.length === 0) return ['(empty — no suppressed events in 1h)'];
  const top = counters.slice(0, SUPPRESS_REASONS_TOP_N);
  return top.map(({ reason, count, lastTs }) => `${reason}=${count}x (${formatTime(lastTs)})`);
}

/**
 * #1421 — Auto-lock Candidate 섹션. SSOT/stability/direction/candidate 4개 라인으로
 * device-side auto-lock 측정 상태를 dump.
 *
 * meta 미전달 시 (n/a) — 호출자가 측정 비활성 또는 SSOT 객체 미주입.
 *
 * #2049 — dump builder(#1421)와 UI section이 공유하는 SSoT helper로 추출.
 * `buildAutoLockSection`는 args unpack만 담당하는 thin wrapper.
 */
function computeAutoLockLines(meta: AutoLockDebugMeta | undefined): string[] {
  if (!meta) return ['(n/a)'];
  const ssotLine = `ssot=${formatSSOTLabel(meta.surfaceSSOTActive, meta.undergroundSSOTActive)}`;
  const stabilityLine = `stability=${meta.stability.stable ? 'stable' : 'pending'} count=${meta.stability.count} stationId=${meta.stability.stationId ?? UNKNOWN_LABEL}`;
  const directionLine = formatDirectionLine(meta.direction);
  const candidateLine = meta.candidate
    ? `candidate=trainCode=${meta.candidate.candidate.trainCode} line=${meta.candidate.candidate.line} source=${meta.candidate.source} path=${meta.candidate.path}`
    : `candidate=null reason=${meta.nullReason ?? UNKNOWN_LABEL}`;
  return [ssotLine, stabilityLine, directionLine, candidateLine];
}

function buildAutoLockSection(args: BuildDumpArgs): string[] {
  return computeAutoLockLines(args.autoLockMeta);
}

function formatDirectionLine(direction: VerifyTrainDirectionResult | null): string {
  if (!direction) return `direction=${UNKNOWN_LABEL}`;
  const matchLabel = direction.matched ? 'matched' : 'mismatch';
  return `direction=${matchLabel} reason=${direction.reason}`;
}

function formatSSOTLabel(surface: boolean, underground: boolean): string {
  if (surface && underground) return 'surface+underground';
  if (surface) return 'surface';
  if (underground) return 'underground';
  return 'none';
}

/**
 * #1430 — Environment Distribution 섹션. SSOT 활성 cascade로 결정한 state별 누적 시간을
 * percentages + totals(분/초) + transitions + observed 4줄로 dump.
 *
 * meta 미전달 시 (n/a) — DebugModal에서 counter 미주입 (off-state).
 *
 * 본문 형식:
 *   surface=42.3% underground=18.1% hybrid=3.2% unknown=36.4%
 *   totals: surface=12m30s underground=5m24s hybrid=58s unknown=10m54s
 *   transitions=5
 *   observed=30m0s
 *
 * #2049 — dump builder(#1430)와 UI section이 공유하는 SSoT helper로 추출.
 * `buildEnvironmentDistributionSection`는 args unpack만 담당하는 thin wrapper.
 */
function computeEnvironmentDistributionLines(
  snap: EnvironmentDistributionSnapshot | undefined,
): string[] {
  if (!snap) return ['(n/a)'];
  const pct = snap.percentages;
  const t = snap.totals;
  return [
    `surface=${formatPercentage(pct.surface)} underground=${formatPercentage(pct.underground)} hybrid=${formatPercentage(pct.hybrid)} unknown=${formatPercentage(pct.unknown)} unknown_warmup=${formatPercentage(pct.unknown_warmup)}`,
    `totals: surface=${formatDurationMs(t.surface)} underground=${formatDurationMs(t.underground)} hybrid=${formatDurationMs(t.hybrid)} unknown=${formatDurationMs(t.unknown)} unknown_warmup=${formatDurationMs(t.unknown_warmup)}`,
    `transitions=${snap.transitions}`,
    `observed=${formatDurationMs(snap.observedMs)}`,
  ];
}

function buildEnvironmentDistributionSection(args: BuildDumpArgs): string[] {
  return computeEnvironmentDistributionLines(args.envDistribution);
}

/** Percentage 표기 — 소수 1자리 고정. */
function formatPercentage(value: number): string {
  return `${value.toFixed(1)}%`;
}

/**
 * ms 누적값을 dump-friendly 형태로 포맷.
 *   - <60s    → `Xs` (소수 0자리)
 *   - <60m    → `XmYs`
 *   - 그 이상 → `XmYs` (분 단위 누적)
 *
 * Acceptance: 0ms는 `0s` — `(empty)`/`—`와 구분되도록 명시 숫자 노출.
 */
function formatDurationMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}m${seconds}s`;
}

/** Warmup 윈도우 ms (#1821) — unknown 분류 시 60s 이내는 unknown_warmup으로 표기. */
const ENV_WARMUP_WINDOW_MS = 60_000;

/**
 * #1430 — SSOT 활성 cascade로 환경 state 결정. PR #1427의 `surfaceSSOTActive`/`undergroundSSOTActive`를
 * 그대로 입력으로 받아 1줄로 분류.
 * #1821 — unknown 구간이 observedMs < 60s이면 'unknown_warmup'으로 분류 (가시화만, 분류 변경 없음).
 */
function deriveEnvironmentState(input: {
  readonly surfaceSSOTActive: boolean;
  readonly undergroundSSOTActive: boolean;
  readonly observedMs: number;
}): EnvironmentDistributionState {
  const { surfaceSSOTActive, undergroundSSOTActive, observedMs } = input;
  if (surfaceSSOTActive && undergroundSSOTActive) return 'hybrid';
  if (surfaceSSOTActive) return 'surface';
  if (undergroundSSOTActive) return 'underground';
  return observedMs < ENV_WARMUP_WINDOW_MS ? 'unknown_warmup' : 'unknown';
}

/**
 * #1430 — Environment distribution counter tick + snapshot 묶음. DebugModalInner는
 * 호출 1줄로 cognitive complexity 유지(PR #1427 `buildAutoLockMeta`와 동일 패턴).
 */
function buildEnvironmentDistributionMeta(input: {
  readonly surfaceSSOTActive: boolean;
  readonly undergroundSSOTActive: boolean;
  readonly counter: ReturnType<typeof createEnvironmentDistributionCounter>;
  readonly nowMs: number;
}): EnvironmentDistributionSnapshot {
  // observedMs는 현재 snapshot 기준 시간 기준 — tick 전 현재값 산출로 unknown_warmup 판정.
  const currentObservedMs = input.counter.snapshot(input.nowMs).observedMs;
  const state = deriveEnvironmentState({
    surfaceSSOTActive: input.surfaceSSOTActive,
    undergroundSSOTActive: input.undergroundSSOTActive,
    observedMs: currentObservedMs,
  });
  input.counter.tick(state, input.nowMs);
  return input.counter.snapshot(input.nowMs);
}

/**
 * #1421 — arrival에서 trainCode에 매칭되는 row의 destination(종착명) 반환.
 * 매칭 없으면 null. verifyTrainDirection 입력 trainTerminalStationName 산출용.
 */
function findArrivalTerminal(
  arrival: import('../../../shared/types/arrival').StationArrival | null,
  trainCode: string,
): string | null {
  if (!arrival) return null;
  const allRows = [...arrival.up, ...arrival.down];
  for (const row of allRows) {
    if (row.trainCode === trainCode) return row.destination || null;
  }
  return null;
}

/**
 * #1421 — candidate=null 사유 분류. 4단 cascade 중 첫 미달 게이트를 노출.
 */
function computeAutoLockNullReason(
  hasSSOT: boolean,
  stable: boolean,
  hasCandidate: boolean,
): AutoLockDebugMeta['nullReason'] {
  if (hasCandidate) return null;
  if (!hasSSOT) return 'no-ssot';
  if (!stable) return 'stability-pending';
  // #1526 — stable+SSOT가 있는데도 candidate=null이면 direction 게이트가 미달 (judge-impossible
  // + stability count < THRESHOLD 또는 reverse/terminal-out-of-route).
  return 'direction-mismatch';
}

/**
 * #1421 — PR-AutoLock-1 측정 파이프라인. DebugModalInner의 render-time 산출 로직을
 * 순수 함수로 분리 — SSOT 활성 cascade, stability push, direction verify, candidate 산출까지
 * 한 곳에 모은다. DebugModalInner는 1줄 호출로 cognitive complexity 유지.
 */
function buildAutoLockMeta(input: {
  readonly surfaceSSOT: InferAutoLockCandidateInput['surfaceSSOT'];
  readonly undergroundSSOT: InferAutoLockCandidateInput['undergroundSSOT'];
  readonly arrival: Parameters<typeof findArrivalTerminal>[0];
  readonly result: NearestStationResult | null;
  readonly arcStations: Parameters<typeof verifyTrainDirection>[0]['routeStations'];
  readonly stabilityBuffer: ReturnType<typeof createConsensusStabilityBuffer>;
}): AutoLockDebugMeta {
  const { surfaceSSOT, undergroundSSOT, arrival, result, arcStations, stabilityBuffer } = input;
  const activeSSOT = surfaceSSOT ?? undergroundSSOT;
  const stability = stabilityBuffer.push(activeSSOT?.station.id ?? null);
  const trainTerminalStationName = activeSSOT
    ? findArrivalTerminal(arrival, activeSSOT.trainCode)
    : null;
  const currentIdx = result
    ? arcStations.findIndex((s) => s.id === result.station.id)
    : -1;
  const destinationIdx = arcStations.length - 1;
  const direction = activeSSOT
    ? verifyTrainDirection({
        routeStations: arcStations,
        currentIdx,
        destinationIdx,
        trainTerminalStationName,
      })
    : null;
  const candidate = inferAutoLockCandidate({
    surfaceSSOT,
    undergroundSSOT,
    stabilityStable: stability.stable,
    stabilityCount: stability.count,
    directionMatched: direction?.matched ?? false,
    directionReason: direction?.reason ?? null,
  });
  return {
    surfaceSSOTActive: surfaceSSOT !== null,
    undergroundSSOTActive: undergroundSSOT !== null,
    stability,
    direction,
    candidate,
    nullReason: computeAutoLockNullReason(
      surfaceSSOT !== null || undergroundSSOT !== null,
      stability.stable,
      candidate !== null,
    ),
  };
}

/**
 * #1898 — RC-12 결함 A. arcStations에서 distinct line sequence 도출.
 *
 * 환승 trip은 같은 line이 연속 후 다음 line으로 전환되는 경계만 추출 — "2,2,2,4,4,5"는
 * "2 -> 4 -> 5"로 압축. 호출자는 본 helper의 entries 길이로 환승 여부 판단 가능 (>1 = 환승).
 *
 * 각 entry는 line 구간의 firstStation/lastStation을 포함 — 사용자가 share dump만으로
 * "2호선 신도림~강남, 4호선 사당~동대문" 식 trip 구조 재구성 가능.
 *
 * arcStations 빈 배열은 빈 결과 반환 → 호출자가 (no route) 표기.
 *
 * 데이터 주도: 노선 수에 의존하지 않고 arcStations 순회 (CLAUDE.md 글로벌 룰 3번).
 */
export function buildRouteLinesSummary(
  arcStations: readonly { name: string; line: string }[],
): { line: string; firstStation: string; lastStation: string }[] {
  if (arcStations.length === 0) return [];
  const segments: { line: string; firstStation: string; lastStation: string }[] = [];
  for (const station of arcStations) {
    const last = segments[segments.length - 1];
    if (last && last.line === station.line) {
      last.lastStation = station.name;
      continue;
    }
    segments.push({
      line: station.line,
      firstStation: station.name,
      lastStation: station.name,
    });
  }
  return segments;
}

/**
 * #1346 — Share dump SSOT.
 *
 * 출력 형식: `## ${title}` + 본문 줄 + 다음 섹션 사이 빈 줄.
 *
 * suffix 옵션:
 *  - `suffix: '(scheduledDump-count)'` 처럼 dynamic 카운트를 헤더에 붙이는 섹션은
 *    builder가 본문만 만들고, 헤더 suffix는 별도 함수가 계산한다(섹션 본체에 dependency 안 흘림).
 *
 * include 옵션:
 *  - Gates 같이 빈 본문이면 헤더까지 생략해야 하는 섹션은 `omitIfEmpty: true` 지정.
 */
interface ShareSectionSpec {
  title: string;
  build: SectionBuilder;
  /** dynamic 헤더 suffix(예: 카운트). 미정의 시 헤더는 title 그대로. */
  suffix?: (args: BuildDumpArgs) => string;
  /** 본문이 빈 배열이면 헤더까지 출력 안 함 (Gates). 기본 false — 빈 본문도 헤더 노출. */
  omitIfEmpty?: boolean;
}

const SHARE_SECTIONS: ReadonlyArray<ShareSectionSpec> = [
  // ADR-022 Phase 0 — Feature Flag(arch:simple-arrival-v1) 상태. Modal render(line 2147-2163)와
  // 동일 SSOT (env / remote / active). dogfood 판정을 dump 만으로 사후 재구성 가능.
  // 최상단 배치 — Modal 첫 섹션(Operation Dashboard, Feature Flag) 순서 그대로.
  { title: 'Feature Flag', build: buildFeatureFlagSection },
  // #1751 (M3 Sub 1) — Operation Dashboard(Modal render line 2141-2143)의 device-local metric.
  // backend polling metric 은 dump 시점 sync 접근 불가라 안내 라인만 포함.
  { title: 'Operation Dashboard', build: buildOperationDashboardSection },
  { title: 'GPS', build: buildGpsSection },
  { title: 'Nearest', build: buildNearestSection },
  { title: 'Fusion', build: buildFusionSection },
  // #1898 — RC-12 결함 B 가시화. accelerometer raw snapshot dashboard (pattern/rms/sample/lastUpdate).
  // Fusion 섹션의 accelPattern row와 동일 SSOT(native cache)지만 raw 값을 노출해 사용자가
  // "sensor 작동 중인가" / "60s window 수렴 했는가" 즉시 판단 가능.
  { title: 'Accel Fingerprint', build: buildAccelFingerprintSection },
  { title: 'Trip', build: buildTripSection },
  // #1898 — RC-12 결함 A 가시화. arcStations 기반 trip line sequence. modal 노선 추천 회귀
  // (예: 동대문 trip line=2인데 modal이 4/5호선 추천) 진단 시 share dump에서 trip line context
  // 즉시 확인 가능. Trip 섹션 직후에 배치해 lockless/hopIndex 신호와 같이 읽힌다.
  { title: 'Trip Route Lines', build: buildRouteLinesSection },
  { title: 'Sleep', build: buildSleepSection },
  { title: 'Arrival', build: buildArrivalSection },
  { title: 'Silent Push', build: buildSilentPushSection },
  // #1568 (T8b, Epic ADR-017 #1553) — backend SSoT 권위 mirror.
  { title: 'Backend SSoT', build: buildBackendSsotSection },
  {
    title: 'Scheduled queue',
    build: buildScheduledQueueSection,
    // null/undefined면 카운트 없음, 그 외 N건은 헤더에 `(N)` suffix.
    suffix: (args) => (args.scheduledDump == null ? '' : ` (${args.scheduledDump.length})`),
  },
  { title: 'Gates', build: buildGatesSection, omitIfEmpty: true },
  // #1413 — BoardingLock dump. lock vs lockless 구분이 dump 본문만으로 확인 가능해야 한다.
  { title: 'BoardingLock', build: buildBoardingLockSection },
  // #2268 (C1) — pending→confirmed lock 정정 counter(#1166). BoardingLock 섹션 직후 배치.
  { title: 'Lock Correction', build: buildLockCorrectionSection },
  // #2330 (consensus-D) — 명시 탭 vs consensus-confirmed 제안 불일치 counter. Lock Correction 직후 배치.
  { title: 'Consensus Mismatch', build: buildConsensusMismatchSection },
  // #1413 — Estimator buffer. lockless trip 진행도 사후 재구성용.
  {
    title: 'Estimator State',
    build: buildEstimatorSection,
    suffix: (args) => ` (${args.estimatorLog?.length ?? 0})`,
  },
  // #1626 — V4 발사 시점만 시간순 reverse. Alarm log 통합 섹션 직전에 노출 →
  // 사용자가 fired 시점 먼저 보고, 거부/시도는 아래 Alarm log에서 분석.
  {
    title: 'Notifications fired',
    build: buildNotificationsFiredSection,
    omitIfEmpty: true,
    suffix: (args) => ` (${getFiredEntries(args).length})`,
  },
  {
    title: 'Alarm log',
    build: buildAlarmLogSection,
    suffix: (args) => ` (${args.logs.length})`,
  },
  // #1692 — Alarm Log Reasons (1h): suppress reason 집계 요약. Alarm log 직후 배치해
  // 사용자가 발사 실패 분포를 share dump에서 즉시 파악 가능.
  { title: 'Alarm Log Reasons (1h)', build: buildAlarmLogReasonsSummarySection },
  // #1346 — fusion log를 share에 포함. 누락 시 sticky cascade 같은 회귀를 사후 재구성 불가.
  {
    title: 'Fusion log',
    build: buildFusionLogSection,
    suffix: (args) => ` (${args.fusionLog?.length ?? 0})`,
  },
  // #1693/#1706 — Fusion picker tier 채택 분포 (최근 1h). Modal render(line 2552-2560)와 동일
  // SSOT (`formatFusionPickerTierDistribution`). 별 ring buffer(fusionTierLog) — alarmLog 점령 회귀 차단.
  { title: 'Fusion Tier (1h)', build: buildFusionTierSection },
  // #1540 (S7) — gps-drop 채널. fusionDebugBuffer 점령 회귀 차단용 별 buffer를 dump에 그대로 노출.
  {
    title: 'GPS drops',
    build: buildGpsDropLogSection,
    suffix: (args) => ` (${args.gpsDropLog?.length ?? 0})`,
  },
  // #1902 (RC-18) — candidate-reject 별 buffer (distance + line). fusionDebugBuffer 점령 회귀 차단.
  {
    title: 'Candidate rejects',
    build: buildCandidateRejectLogSection,
    suffix: (args) => ` (${args.candidateRejectLog?.length ?? 0})`,
  },
  // #1896 (RC-8) — boarding-lock-drift 별 buffer (GPS displacement gate trigger). fusionDebugBuffer 점령 회귀 차단.
  // #2268 (C2) — buffer age suffix 추가: (0)이 "이벤트 없음"인지 "재기동 증발"인지 구분.
  {
    title: 'Boarding-Lock Drift',
    build: buildBoardingLockDriftLogSection,
    suffix: (args) => ` (${args.boardingLockDriftLog?.length ?? 0})${formatBufferAgeSuffix(args)}`,
  },
  // #2152 — BoardingLock lifecycle 별 buffer (생성 source / 해제 reason / trainCode).
  // #2268 (C2) — buffer age suffix 추가.
  {
    title: 'BoardingLock Lifecycle',
    build: buildLockLifecycleSection,
    suffix: (args) => ` (${args.lockLifecycleLog?.length ?? 0})${formatBufferAgeSuffix(args)}`,
  },
  // #1518 — device → backend HTTP 호출 ring buffer. 직전 trip의 register/sync/telemetry 호출
  // 흔적이 dump만 보고 재구성 가능해야 #622 transfer-leg sync 같은 회귀 진단이 가능하다.
  {
    title: 'Backend Calls',
    build: buildBackendCallsSection,
    suffix: (args) => ` (${args.backendCalls?.length ?? 0})`,
  },
  // #1413 — boardingPrompt 발사 빈도 카운터(5m/1h/all).
  { title: 'Boarding Prompt', build: buildBoardingPromptSection },
  // #1413 — boardingPrompt acceptance dashboard (displayed/responded/rates + 7일 시계열).
  { title: 'Boarding Prompt Acceptance', build: buildBoardingPromptAcceptanceSection },
  // #1413 — reason별 누적 + 마지막 발생 시각.
  { title: 'Counters', build: buildCountersSection },
  // #1682 — suppress reason 1h 윈도우 top 5. V9(suppress event rate < 100/h/trip) 측정 인프라.
  { title: 'Suppress Reasons (1h)', build: buildSuppressReasonsSection },
  // #1421 — PR-AutoLock-1 측정 인프라. SSOT consensus → stability → direction → candidate 4줄.
  { title: 'Auto-lock Candidate', build: buildAutoLockSection },
  // #1430 — 환경 분포 측정 인프라. SSOT 활성 cascade → state별 누적 시간 + transition 카운트.
  { title: 'Environment Distribution', build: buildEnvironmentDistributionSection },
  // #1501 — PR-C. Raw signal ring buffer 직전 30건. cold-launch 사후 재구성 데이터 채널.
  // suffix는 buffer 전체 개수(>= 표시 개수) — 모달은 상위 30건만 노출하더라도 전체 누적량 확인 가능.
  {
    title: 'Raw Signal',
    build: buildRawSignalSection,
    suffix: (args) => ` (${args.rawSignalLog?.length ?? 0})`,
  },
  // #1859 — Cellular Tech Distribution. rawSignalLog에서 cellular 분포 집계.
  // 1주 측정 → LTE/NRNSA surface hard-reject 재검토 evidence.
  {
    title: 'Cellular Tech Distribution',
    build: buildCellularTechDistributionSection,
  },
];

function buildDumpText(args: BuildDumpArgs): string {
  const lines: string[] = [`[Subway debug] ${new Date().toISOString()}`];
  for (const spec of SHARE_SECTIONS) {
    const body = spec.build(args);
    if (spec.omitIfEmpty && body.length === 0) continue;
    const suffix = spec.suffix ? spec.suffix(args) : '';
    lines.push('', `## ${spec.title}${suffix}`, ...body);
  }
  return lines.join('\n');
}

/** 게이트 reason 분류. 동일 prefix로 시작하면 같은 범주. */
const GATE_REASONS: readonly AlarmLogReason[] = [
  'gate-age',
  'gate-accuracy',
  'gate-jump',
  'gate-unknown-station',
  'gate-no-location',
  'gate-stale-location',
  'gate-out-of-range',
];

const MOVEMENT_REASONS: readonly AlarmLogReason[] = [
  'movement-no-location',
  'movement-stale-timestamp',
  'movement-low-accuracy',
  'movement-static-speed',
  'movement-static-position',
  'movement-motion-stationary',
];

/**
 * Alarm log section header / dump 헤더에서 공유되는 source별 카운트 요약 문자열 (#564).
 * 비어있으면 빈 문자열을 반환 → 호출부에서 falsy로 분기 가능.
 */
function formatSourceCountsLine(logs: readonly AlarmLogEntry[]): string {
  const counts = summarizeAlarmLogBySource(logs);
  const keys = Object.keys(counts).sort((a, b) => a.localeCompare(b));
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}=${counts[k]}`).join(', ');
}


/**
 * ## Gates 섹션: reason별 억제 카운트 요약 (#1019).
 */
function formatReasonCountsLine(logs: readonly AlarmLogEntry[]): string {
  const counts = summarizeAlarmLogByReason(logs);
  const keys = Object.keys(counts).sort((a, b) => {
    const diff = (counts[b] as number) - (counts[a] as number);
    return diff !== 0 ? diff : a.localeCompare(b);
  });
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}=${counts[k]}`).join(', ');
}

interface DebugModalProps {
  onClose: () => void;
  /**
   * Phase 1 (Position-first fusion) 결정 신호. 후보 trainNo 목록.
   * 현재는 useFusedNearestStation이 노출하지 않아 호출부가 명시적으로 전달.
   * 미전달이면 섹션에서 "(n/a)"로 표기.
   */
  candidateTrains?: string[];
  /**
   * #853 — backend fused speed(ADR-009 Phase 3). 미전달이면 GPS 섹션 fused 라인이
   * `(no fused signal)`로 표기돼 사용자가 클라 GPS 미측정과 구분 가능.
   * 클라 자체 산출 함수는 #819 후속.
   */
  fusedSpeed?: FusedSpeedSignal;
  /**
   * #1215 (D9) — Fusion 섹션에 노출할 detection verdict 요약(tier/signalMask).
   * SSOT는 `useFusedStationDetection` 결과. DebugModal은 호출부가 명시적으로 주입.
   * 미전달 시 두 row 모두 `—`로 표기.
   */
  fusionDetection?: FusionDetectionSummary;
  /**
   * #1215 (D9) — lockless trip 진행도. D1 estimator 미머지 환경에서도 graceful.
   * currentHopIndex가 `undefined`면 D1 미머지(unknown 표기), `null`이면 estimator null 반환.
   */
  trip?: TripDebugState;
  /**
   * #1215 (D9) — 취침모드 + 첫 hop 향하는지(=sleep rule suppress 트리거 조건).
   * D8 미머지면 미전달 가능 — Sleep 섹션 두 row가 `—`로 표기.
   */
  sleep?: SleepDebugState;
}

// 디버그 모달은 측정 인프라 — 관찰자 효과를 피하려고 모달이 열린 동안에만 마운트한다.
// useNearestStation이 별도 Location.watch 구독을 띄우므로, 닫혔을 땐 컴포넌트 자체를
// 마운트하지 않아 GPS·Arrival 폴링이 2배가 되지 않도록 한다. 호출부(_layout)에서
// `debugVisible &&` 조건부 렌더를 보장한다.
export function DebugModal(props: DebugModalProps) {
  // #456: dev 빌드 외에 EXPO_PUBLIC_DEBUG_MODAL=true 빌드도 노출 — 일반 release 빌드는 자동 차단.
  if (!isDebugModalEnabled()) return null;
  return <DebugModalInner {...props} />;
}

function DebugModalInner({
  onClose,
  candidateTrains,
  fusedSpeed,
  fusionDetection: fusionDetectionProp,
  trip: tripProp,
  sleep: sleepProp,
}: Readonly<DebugModalProps>) {
  const { colors } = useTheme();
  // #458: RN Modal 안에서는 SafeAreaView가 안 먹는다(portal로 inset 컨텍스트 분리).
  // 루트 SafeAreaProvider의 insets를 hook으로 직접 받아 헤더에 manual padding.
  const insets = useSafeAreaInsets();
  // #2268 (C2) — Lifecycle/Drift 섹션 헤더에 표시할 launch 이후 경과 초. render마다 재계산.
  const debugModalBufferAgeSec = Math.max(
    0,
    Math.round((Date.now() - DEBUG_MODAL_LOAD_AT_MS) / 1000),
  );
  // #1982 (ADR-022 Phase 0) — arrival-api-ssot-v1 Feature Flag remote 조회.
  // ADMIN_TOKEN / ALARM_BACKEND_URL 미설정 환경은 kind=unconfigured 로 그대로 표시.
  const archFlagRemote = useArchFlagRemote();
  // Operation Dashboard(local alarmAccuracy) 계산용 tripGroundTruth 응답 subscribe.
  // Modal render 는 OperationDashboardSection 이 자체 store subscribe, share dump 는 handleShare
  // 호출 시점 스냅샷만 필요하므로 responses 참조가 안정적으로 갱신되면 dump 도 갱신된다.
  const groundTruthResponses = useTripGroundTruthStore((s) => s.responses);
  // #1812 — routeContext 빌드: HomeScreen이 ROUTE_KEY에 영속화한 route + destinationStore의
  // tripOrigin + destination으로 routeContext를 구성한다. destination 변경 시 재조회.
  // tripStartedAt과 동일 패턴 (AsyncStorage SSOT, destination 의존 effect).
  const destination = useDestinationStore((s) => s.destination);
  const tripOrigin = useDestinationStore((s) => s.tripOrigin);
  const [persistedRoute, setPersistedRoute] = useState<Route>(null);
  useEffect(() => {
    let cancelled = false;
    if (!destination) {
      setPersistedRoute(null);
      return;
    }
    void AsyncStorage.getItem(ROUTE_KEY).then((raw) => {
      if (cancelled) return;
      try {
        setPersistedRoute(raw ? (JSON.parse(raw) as Route) : null);
      } catch {
        setPersistedRoute(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [destination]);
  const routeContext = useMemo<FusedRouteContext | undefined>(
    () =>
      persistedRoute && tripOrigin && destination
        ? { route: persistedRoute, origin: tripOrigin, destination }
        : undefined,
    [persistedRoute, tripOrigin, destination],
  );
  const {
    result,
    gpsResult,
    confidence,
    source,
    variants,
    userLocation,
    speedMps,
    accuracyMeters,
    gpsActive,
    lastFixAtMs,
    // #1235 (D9 wire) — hook이 노출하는 SSOT로 fusionDetection/trip props 구성.
    currentHopIndex,
    arcStations,
    detectionTier,
    detectionSignalMask,
    // #1418 — 환경 인지 fusion arbitration. Tier 1 SSOT 합의 활성 + 추정 환경 노출.
    environment,
    // #1860 — 옵션 C barometer-stop 힌트 원인. DebugModal environment 라인에 함께 노출.
    environmentHintReason,
    surfaceSSOTActive,
    undergroundSSOTActive,
    // #1421 — PR-AutoLock-1 측정 인프라. SSOT 객체 직접 받아 inferAutoLockCandidate에 전달.
    surfaceSSOT,
    undergroundSSOT,
    // #1447 — E4(#1437) 격리 후 노출된 별 채널. strategy 라벨을 Trip 섹션 + Share dump에 wire-up.
    // null이면 fallback 라벨로 항상 표시(estimator 미산출 상태 명시).
    displayOnlyEstimate,
    // #1678 — S9 accelerometer fingerprint vote 상태. 'automotive' = train 진동 env 1표.
    // 'unknown' = 60s window 미수렴 또는 네이티브 모듈 미지원(EAS rebuild 전).
    accelerometerPattern,
  } = useFusedNearestStation(undefined, undefined, routeContext);
  // arc 길이 = trip의 hop 총 수. trip 미설정이면 0.
  const routeHopCount = arcStations.length;
  const stationName = result?.station.name ?? null;
  const { arrival, isMock } = useArrivalInfo(stationName);
  const silentPush = useSilentPushDiagnostics();
  // #1568 (T8b, Epic ADR-017 #1553) — backend SSoT 권위 mirror 폴링. 5s 간격.
  // 미존재(backend가 한 번도 forward 안 함) / parse 실패 시 null → '(no recent SSoT push)' 표시.
  const [backendSsotMirror, setBackendSsotMirror] =
    useState<BackendSsotMirrorEntry | null>(null);
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
    const id = setInterval(tick, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  // #1215 (D9) — 기압계 subsurface. useBarometer는 shared/hooks이라 의존 위배 없음.
  // useFusedNearestStation 내부 useBarometer와 별개 listener — DebugModal 관찰자 효과 허용 범위.
  // #1398 — `stop=undefined` 원인(unavailableReason)과 readingCount도 dump에 노출.
  const {
    subsurface: barometerSubsurface,
    unavailableReason: barometerUnavailableReason,
    readingCount: barometerReadingCount,
  } = useBarometer();
  // #1308 — iOS 저전력 모드. silent push throttle 측정용 텔레메트리 (동작 변경 없음).
  const lowPowerMode = useLowPowerMode();
  const fusedLabel = formatStationLabel(result);
  const gpsLabel = formatStationLabel(gpsResult);
  const differs = fusedDiffersFromGps(result, gpsResult);
  const lock = useBoardingLockStore((s) => s.lock);

  // #1235 (D9 wire) — fusionDetection/trip/sleep SSOT 도출.
  // 호출자가 props로 명시 전달하면 그 값이 우선(테스트/외부 주입). 미전달이면 내부 SSOT 사용.
  // destination은 routeContext 빌드 블록에서 이미 선언됨 (#1812).
  const sleepMode = useSettingsStore((s) => s.sleepMode);
  const lockActive = lock !== null && !isBoardingLockExpired(lock, Date.now());
  // lockless trip = destination 설정됐고 boardingLock 비활성.
  const locklessTrip = destination !== null && !lockActive;
  // tripStartedAt는 AsyncStorage SSOT(tripStartStorage). 마운트 + destination 변경 시 재조회.
  const [tripStartedAt, setTripStartedAt] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getTripStartedAt().then((value) => {
      if (!cancelled) setTripStartedAt(value);
    });
    return () => {
      cancelled = true;
    };
  }, [destination]);

  const fusionDetection: FusionDetectionSummary = useMemo(
    () =>
      fusionDetectionProp ?? {
        tier: detectionTier,
        signalMask: detectionSignalMask,
      },
    [fusionDetectionProp, detectionTier, detectionSignalMask],
  );
  const trip: TripDebugState = useMemo(
    () =>
      tripProp ?? {
        lockless: locklessTrip,
        tripStartedAt,
        currentHopIndex,
        // destination 있어야 routeHopCount 표기 의미. 없으면 null → '—' 표기.
        routeHopCount: destination ? routeHopCount : null,
        // #1447 — displayOnlyEstimate가 없으면 null 전달 → UI/dump가 fallback 라벨 표시.
        displayOnlyEstimateStrategy: displayOnlyEstimate?.strategy ?? null,
        // #1604 — T10 #1594 backstop 단계 노출. tripStartedAt=null이면 'none'.
        lifecyclePhase: tripLifecyclePhase(tripStartedAt),
      },
    [
      tripProp,
      locklessTrip,
      tripStartedAt,
      currentHopIndex,
      routeHopCount,
      destination,
      displayOnlyEstimate,
    ],
  );
  const sleep: SleepDebugState = useMemo(
    () =>
      sleepProp ?? {
        sleepMode,
        // 첫 hop 향함 = lockless + estimator hop index 0 (탑승역 또는 첫 hop 출발 직후).
        // lock 활성 trip은 별도 게이트로 들어가므로 본 디버그 표기는 lockless만 true.
        firstHopApproaching: locklessTrip && currentHopIndex === 0,
      },
    [sleepProp, sleepMode, locklessTrip, currentHopIndex],
  );

  // #1421 — PR-AutoLock-1 측정 인프라. buffer는 모달이 열린 동안만 누적(관찰자 효과 최소화).
  // 산출 로직은 `buildAutoLockMeta`에 위임 — DebugModalInner는 호출 1줄.
  const stabilityBufferRef = useRef(createConsensusStabilityBuffer());
  const autoLockMeta = buildAutoLockMeta({
    surfaceSSOT,
    undergroundSSOT,
    arrival,
    result,
    arcStations,
    stabilityBuffer: stabilityBufferRef.current,
  });

  // #1430 — 환경 분포 측정 인프라. counter도 모달이 열린 동안만 누적(관찰자 효과 최소화).
  // 산출 로직은 `buildEnvironmentDistributionMeta`에 위임 — DebugModalInner는 호출 1줄.
  const envDistributionCounterRef = useRef(createEnvironmentDistributionCounter());
  const envDistribution = buildEnvironmentDistributionMeta({
    surfaceSSOTActive,
    undergroundSSOTActive,
    counter: envDistributionCounterRef.current,
    nowMs: Date.now(),
  });

  // #1898 — RC-12 결함 A. arcStations에서 trip route line sequence 산출. 매 render 호출이지만
  // arcStations 참조 안정성(hook 메모) + 환승 trip도 30개 이하라 비용 무시 가능.
  const routeLines = useMemo(
    () => buildRouteLinesSummary(arcStations),
    [arcStations],
  );

  // #1898 — RC-12 결함 B. accelerometer raw snapshot polling. useAccelerometerFingerprint hook이
  // pattern 라벨만 노출 → DebugModal은 raw snapshot까지 직접 노출. 5s 주기는 fingerprint hook
  // 폴링과 동일(native가 5Hz × 60s window를 캐시하므로 freshness 충분).
  const [accelSnapshot, setAccelSnapshot] = useState<AccelerometerSnapshot | null>(() =>
    getLatestAccelerometerSnapshot(),
  );
  useEffect(() => {
    const tick = () => setAccelSnapshot(getLatestAccelerometerSnapshot());
    tick();
    const id = setInterval(tick, 5_000);
    return () => clearInterval(id);
  }, []);

  const [logs, setLogs] = useState<AlarmLogEntry[]>([]);
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
  const [gpsDropLogs, setGpsDropLogs] = useState<readonly GpsDropEntry[]>(() =>
    getGpsDropEntries(),
  );
  // #1902 (RC-18) — candidate-reject ring buffer. fusionLogs와 동일 패턴.
  const [candidateRejectLogs, setCandidateRejectLogs] = useState<readonly CandidateRejectEntry[]>(() =>
    getCandidateRejectEntries(),
  );
  // #2049 — boarding-lock-drift ring buffer. #1896 (RC-8) 별 buffer를 UI/dump에 노출.
  // fusionLogs와 동일 패턴 (snapshot + subscribe + clear button).
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
  const [rawSignalLog, setRawSignalLog] = useState<readonly RawSignalEntry[]>(() =>
    getRawSignalEntries(),
  );
  // #756: OS 큐 ground-truth dump. 호출 직후 한 번 비동기로 채워진다.
  // null = 아직 한 번도 dump 안 한 상태 → "Tap Refresh" placeholder 노출.
  const [scheduledDump, setScheduledDump] = useState<ScheduledNotificationDumpEntry[] | null>(null);

  // #1956 — Operation Dashboard metric 클릭 시 진입할 TripDetailModal state.
  // tripToken=null이면 modal 닫힘. set 시 visible+token이 함께 갱신된다.
  const [tripDetailToken, setTripDetailToken] = useState<string | null>(null);
  const handleMetricClick = useCallback((_key: string, token: string) => {
    setTripDetailToken(token);
  }, []);
  const handleTripDetailClose = useCallback(() => {
    setTripDetailToken(null);
  }, []);

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
    return subscribeCandidateReject(() =>
      setCandidateRejectLogs([...getCandidateRejectEntries()]),
    );
  }, []);

  // #2049 — boarding-lock-drift buffer 구독. candidate-reject와 동일 패턴.
  useEffect(() => {
    return subscribeBoardingLockDrift(() =>
      setBoardingLockDriftLog([...getBoardingLockDriftEntries()]),
    );
  }, []);

  // #2152 — BoardingLock lifecycle buffer 구독. boardingLockDrift와 동일 패턴.
  useEffect(() => {
    return subscribeLockLifecycle(() =>
      setLockLifecycleLog([...getLockLifecycleEntries()]),
    );
  }, []);

  useEffect(() => {
    return subscribeEstimatorDebug(() => setEstimatorLogs([...getEstimatorEntries()]));
  }, []);

  useEffect(() => {
    return subscribeBackendCallEntries(() =>
      setBackendCalls([...getBackendCallEntries()]),
    );
  }, []);

  // #1501 — PR-C. Raw signal buffer 변경 구독. push/clear 어느 쪽이든 같은 listener로 반응.
  useEffect(() => {
    return subscribeRawSignal(() => setRawSignalLog([...getRawSignalEntries()]));
  }, []);

  const refreshLogs = useCallback(async () => {
    setLogs(await getAlarmLog());
    // #1706 — fusion picker tier 별 ring buffer 동시 snapshot. AsyncStorage 없는 in-memory ring
    // 이라 동기 read. logs와 함께 refresh되어 UI/share dump 정합성 유지.
    setFusionTierLogs(getFusionTierLog());
    // #2284 — fired-only 독립 버퍼도 동시 refresh. alarmLog와 별도 key라 별도 read 필요.
    setFiredAlarmLog(await getFiredAlarmLog());
  }, []);

  useEffect(() => {
    void refreshLogs();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshLogs();
    });
    return () => sub.remove();
  }, [refreshLogs]);

  const handleClear = useCallback(async () => {
    await Promise.all([
      clearAlarmLog(),
      clearFiredAlarmLog(),
      clearEstimatorEntries(),
      clearFusionDebugEntries(),
      clearGpsDropEntries(),
      clearBackendCallEntries(),
      clearRawSignalEntries(),
    ]);
    await refreshLogs();
  }, [refreshLogs]);

  const arrivalSummary = (() => {
    if (!arrival) return '(no arrival data)';
    const up = arrival.up[0];
    const down = arrival.down[0];
    const upText = up
      ? `up: ${up.destination} · ${Math.round(up.arrivalSeconds)}s${up.statusMessage ? ` (${up.statusMessage})` : ''}`
      : 'up: -';
    const downText = down
      ? `down: ${down.destination} · ${Math.round(down.arrivalSeconds)}s${down.statusMessage ? ` (${down.statusMessage})` : ''}`
      : 'down: -';
    return `${upText}\n${downText}`;
  })();

  // #2268 (C1) — pending→confirmed lock 정정 counter. lockCorrectionMetrics.ts는 순수
  // module-level singleton getter라 render마다 직접 호출해도 안전(다른 render-time
  // 스냅샷 산출 값들 — autoLockMeta/envDistribution — 과 동일 패턴).
  const lockCorrectionMetrics = getLockCorrectionMetrics();

  // #2330 (consensus-D) — 명시 탭 vs consensus-confirmed 불일치 counter. 동일 module-level
  // singleton getter 패턴(위 lockCorrectionMetrics와 동일 render-time 스냅샷 근거).
  const consensusMismatchMetrics = getConsensusMismatchMetrics();

  const nearestDistanceM = result ? Math.round(result.distanceKm * 1000) : null;
  const variantNames = variants.map((v) => `${v.name}(${v.line})`);

  // fusedSpeed prop을 null로 정규화해 buildGpsRows/buildDumpText 양쪽에서 동일 분기 사용.
  const fusedSpeedSignal: FusedSpeedSignal | null = fusedSpeed ?? null;

  const handleShare = useCallback(async () => {
    const message = buildDumpText({
      userLocation,
      speedMps,
      accuracyMeters,
      // #852: hook이 신규 필드를 미지원하던 시점 호환 — undefined면 'fg'/null로 fallback.
      gpsActive: gpsActive ?? 'fg',
      lastFixAtMs: lastFixAtMs ?? null,
      fusedSpeed: fusedSpeedSignal,
      nearestName: result?.station.name ?? null,
      nearestDistanceM,
      variants: variantNames,
      fusion: {
        confidence,
        source,
        fusedLabel,
        gpsLabel,
        differs,
        candidateTrains: candidateTrains ?? null,
      },
      arrivalSummary,
      isMock,
      silentPush,
      // #1568 (T8b, Epic ADR-017 #1553) — backend SSoT 권위 mirror.
      backendSsotMirror,
      logs,
      // #2284 — fired-only 독립 버퍼 entries를 share dump에 포함. alarmLog rotate와 무관 보존.
      firedAlarmLog,
      lowPowerMode,
      scheduledDump,
      barometerSubsurface,
      // #1398 — 기압계 unavailable 원인/reading 수도 share dump에 포함.
      barometerUnavailableReason,
      barometerReadingCount,
      fusionDetection,
      trip,
      sleep,
      // #1346 — fusion log entries를 share에 포함. sticky cascade 같은 회귀 사후 재구성용.
      fusionLog: fusionLogs,
      // #1540 (S7) — gps-drop entries를 share에 포함. 별 buffer라 fusion log와 동시 dump.
      gpsDropLog: gpsDropLogs,
      // #1902 (RC-18) — candidate-reject entries를 share에 포함. 별 buffer라 fusion log와 동시 dump.
      candidateRejectLog: candidateRejectLogs,
      // #2049 (#1896 RC-8) — boarding-lock-drift entries를 share에 포함. 별 buffer라 fusion log와 동시 dump.
      boardingLockDriftLog,
      // #2152 — BoardingLock lifecycle entries를 share에 포함. 별 buffer라 fusion log와 동시 dump.
      lockLifecycleLog,
      // #1413 — UI에만 노출되던 BoardingLock/Estimator/Boarding Prompt(+Acceptance)/Counters를 share에 포함.
      boardingLock: lock,
      estimatorLog: estimatorLogs,
      // #1421 — PR-AutoLock-1 측정 인프라. SSOT/stability/direction/candidate 4줄.
      autoLockMeta,
      // #1430 — 환경 분포 측정 인프라. state별 누적 ms + transition 카운트.
      envDistribution,
      // #1518 — backend call ring buffer entries.
      backendCalls,
      // #1501 — PR-C. Raw signal buffer entries (직전 N건). share dump가 모달 표시와 동일 SSOT.
      rawSignalLog,
      // #1898 — RC-12. trip route line sequence + accelerometer raw snapshot. share dump가
      // UI 표시와 동일 SSOT.
      routeLines,
      accelSnapshot,
      // ADR-022 Phase 0 — Feature Flag 상태(env / remote / active). Modal render 와 동일 SSOT.
      archFlag: {
        env: isSimpleArchEnvEnabled(),
        remote: archFlagRemote.value,
        remoteKind: archFlagRemote.kind,
        active: isSimpleArchEnabled(archFlagRemote.value),
      },
      // Operation Dashboard 의 device-local metric (alarmAccuracy local). backend polling metric 은
      // buildOperationDashboardSection이 observabilityMetricsClient의 마지막 poll snapshot을
      // 직접 읽어 채운다 — 여기서는 device-local 입력만 넘긴다.
      operationDashboard: {
        groundTruthAccurateCount: groundTruthResponses.filter((r) => r.outcome === 'accurate').length,
        groundTruthAnsweredCount: groundTruthResponses.filter((r) => r.outcome !== 'unanswered').length,
      },
      // Fusion Tier (1h) — Modal render 와 동일 별 ring buffer(alarmLog 점령 회귀 차단).
      fusionTierLog: fusionTierLogs,
      // #2268 (C1) — Lock Correction counter. Modal render와 동일 SSOT(getLockCorrectionMetrics).
      lockCorrection: lockCorrectionMetrics,
      // #2330 (consensus-D) — Consensus Mismatch counter. Modal render와 동일 SSOT.
      consensusMismatch: consensusMismatchMetrics,
    });
    // #2268 (S1+S2) — 이전엔 `void Share.share(...)`로 실패가 완전 무음이었다(catch 없음).
    // Share 시트를 뜨는 순간 취소돼도 reject 하는 OS 조합이 있어 사용자가 "왜 안 되지"만
    // 겪고 재시도 방법을 몰랐다. 길이를 항상 로그로 남기고, 실패 시 Alert로 안내한다.
    // Clipboard fallback: expo-clipboard 등 클립보드 패키지가 프로젝트에 설치돼 있지 않아
    // (package.json 확인 완료) 자동 클립보드 복사는 도입하지 않았다 — Alert가 실패/길이
    // 안내를 대신한다(PR 본문에 결정 명시).
    shareLog.info(`dump length=${message.length} chars`);
    try {
      await Share.share({ message });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      shareLog.error(`share failed: ${reason}`);
      Alert.alert(
        '공유 실패',
        `진단 덤프 공유에 실패했습니다 (길이 ${message.length}자).\n다시 시도하거나 잠시 후 재시도해 주세요.\n\n오류: ${reason}`,
      );
    }
  }, [
    userLocation,
    speedMps,
    accuracyMeters,
    gpsActive,
    lastFixAtMs,
    fusedSpeedSignal,
    result,
    nearestDistanceM,
    variantNames,
    confidence,
    source,
    fusedLabel,
    gpsLabel,
    differs,
    candidateTrains,
    arrivalSummary,
    isMock,
    silentPush,
    backendSsotMirror,
    logs,
    lowPowerMode,
    scheduledDump,
    barometerSubsurface,
    // #1398 — 기압계 진단 필드 deps. reason flip 시 share 텍스트 자동 갱신.
    barometerUnavailableReason,
    barometerReadingCount,
    fusionDetection,
    trip,
    sleep,
    // #1346 — fusion log 신규 캡쳐.
    fusionLogs,
    // #1540 (S7) — gps-drop entries 변경 시 share 텍스트 자동 갱신.
    gpsDropLogs,
    // #1902 (RC-18) — candidate-reject entries 변경 시 share 텍스트 자동 갱신.
    candidateRejectLogs,
    // #2049 (#1896 RC-8) — boarding-lock-drift entries 변경 시 share 텍스트 자동 갱신.
    boardingLockDriftLog,
    // #2152 — BoardingLock lifecycle entries 변경 시 share 텍스트 자동 갱신.
    lockLifecycleLog,
    // #1413 — BoardingLock/Estimator 신규 캡쳐.
    lock,
    estimatorLogs,
    // #1421 — auto-lock meta는 render-time 산출. 의존성으로 추가해 stability flip 시 share 갱신.
    autoLockMeta,
    // #1430 — env distribution snapshot도 render-time 산출. state flip 시 share 텍스트 갱신.
    envDistribution,
    // #1518 — backend call entries 변경 시 share 텍스트 갱신.
    backendCalls,
    // #1501 — PR-C. raw signal entries 변경 시 share 텍스트 자동 갱신.
    rawSignalLog,
    // #1898 — routeLines/accelSnapshot 변경 시 share 텍스트 자동 갱신.
    routeLines,
    accelSnapshot,
    // ADR-022 Phase 0 — archFlag remote 갱신 시 dump 텍스트 자동 갱신.
    archFlagRemote,
    // Operation Dashboard alarmAccuracy(local) — 사용자가 정답지 응답 시 dump 텍스트 자동 갱신.
    groundTruthResponses,
    // Fusion Tier (1h) — fusion picker tier 별 ring buffer 변경 시 dump 텍스트 자동 갱신.
    fusionTierLogs,
    // #2268 (C1) — Lock Correction counter 변경 시 dump 텍스트 자동 갱신.
    lockCorrectionMetrics,
    // #2330 (consensus-D) — Consensus Mismatch counter 변경 시 dump 텍스트 자동 갱신.
    consensusMismatchMetrics,
  ]);

  return (
    <>
    <Modal visible animationType="slide" onRequestClose={onClose} testID="debug-modal">
      <View style={[styles.container, { backgroundColor: colors.bg, paddingTop: insets.top }]}>
        <View style={[styles.header, { borderBottomColor: colors.hair }]}>
          <Text style={[typography.bodySm, { color: colors.ink, fontWeight: '700' }]}>
            Subway debug
          </Text>
          <TouchableOpacity onPress={onClose} testID="debug-modal-close">
            <Text style={[typography.bodySm, { color: colors.accent, fontWeight: '700' }]}>
              Close
            </Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={{ padding: spacing.xl }}>
          {/* #1751 (M3 Sub 1) — Operation Dashboard. toggle/opt-in 없이 항상 렌더. */}
          {/* #1956 — onMetricClick wire: metric 클릭 → TripDetailModal 진입. */}
          <Section title="Operation Dashboard" colors={colors} testID="operation-dashboard-section-wrapper">
            <OperationDashboardSection logs={logs} onMetricClick={handleMetricClick} />
          </Section>

          {/* #1982 (ADR-022 Phase 0) — arrival-api-ssot-v1 Feature Flag.
              env 값 + remote 값 + 최종 판정을 각각 표시. Phase 0 시점에는 dormant. */}
          <Section title="Feature Flag" colors={colors} testID="feature-flag-section">
            <KeyValue
              label={SIMPLE_ARRIVAL_ARCH_ENV_KEY}
              value={isSimpleArchEnvEnabled() ? 'true' : 'false'}
              colors={colors}
            />
            <KeyValue
              label="arch:simple-arrival-v1 (remote)"
              value={archFlagRemote.value ?? `(${archFlagRemote.kind})`}
              colors={colors}
            />
            <KeyValue
              label="simple-arrival active"
              value={isSimpleArchEnabled(archFlagRemote.value) ? 'ON' : 'OFF'}
              colors={colors}
            />
          </Section>

          <Section title="GPS" colors={colors}>
            {userLocation ? (
              buildGpsRows({
                userLocation,
                speedMps,
                accuracyMeters,
                fusedSpeed: fusedSpeedSignal,
              }).map(({ label, value }) => (
                <KeyValue key={label} label={label} value={value} colors={colors} />
              ))
            ) : (
              <Text style={[typography.mono, { color: colors.muted }]}>(no location)</Text>
            )}
            {/* #852: GPS watch 구독 상태 — 사용자가 "왜 위치가 안 바뀌지" 확인 가능.
                userLocation 유무와 무관하게 항상 노출(cold start 'fg lastFix=(never)' 식별). */}
            <KeyValue label="state" value={gpsActive ?? 'fg'} colors={colors} />
            <KeyValue
              label="lastFix"
              value={formatClockTimeWithSeconds(lastFixAtMs ?? null)}
              colors={colors}
            />
            {/* #1215 (D9) — 기압계 subsurface(지하 진입 후보). 사용자 trip의 지상/지하 분기 확인 진입점. */}
            <KeyValue
              label="subsurface"
              value={formatOptionalBool(barometerSubsurface)}
              colors={colors}
            />
            {/* #1398 — 기압계 unavailable 원인 분해. SPOF 분리 효과 측정용.
                undefined(정상)면 ' — ' 표기 — stop이 boolean으로 결정된 상태.
                readingCount도 undefined면 '—' — useBarometer mock/외부 주입자가 누락한 경우 graceful. */}
            <KeyValue
              label="subsurface reason"
              value={barometerUnavailableReason ?? '—'}
              colors={colors}
            />
            <KeyValue
              label="subsurface readings"
              value={barometerReadingCount === undefined ? '—' : String(barometerReadingCount)}
              colors={colors}
            />
          </Section>

          <Section title="Fusion" colors={colors}>
            <KeyValue label="confidence" value={confidence} colors={colors} />
            <KeyValue label="source" value={source} colors={colors} />
            <KeyValue label="fused" value={fusedLabel} colors={colors} />
            <KeyValue label="gps" value={gpsLabel} colors={colors} />
            {/* #1418 — 환경 인지 fusion arbitration. surface/underground SSOT 합의 활성 여부와
                추정 환경. Tier 5(시간 적분) reject 게이트가 어느 신호에 막혔는지 사후 재구성 가능. */}
            {/* #1860 — 옵션 C 힌트 발동 시 hintReason 부가 표시. "이미 지하" 보완 신호 관측용. */}
            <KeyValue
              label="environment"
              value={environmentHintReason ? `${environment} (hint:${environmentHintReason})` : environment}
              colors={colors}
            />
            <KeyValue
              label="surfaceSSOT"
              value={surfaceSSOTActive ? 'active' : 'null'}
              colors={colors}
            />
            <KeyValue
              label="undergroundSSOT"
              value={undergroundSSOTActive ? 'active' : 'null'}
              colors={colors}
            />
            {/* #1678 — S9 accelerometer fingerprint env vote. 'automotive' = train 진동 1표.
                'unknown' = 60s window 미수렴 또는 네이티브 모듈 미포함(EAS rebuild 필요).
                EAS rebuild 후에도 'unknown'이면 native 모듈 autolinking 실패 의심. */}
            <KeyValue
              label="accelPattern"
              value={accelerometerPattern}
              colors={colors}
            />
            {differs && (
              <Text
                style={[typography.mono, { color: colors.warn, marginTop: spacing.xs }]}
                testID="debug-fusion-diff"
              >
                fused != gps
              </Text>
            )}
            <KeyValue
              label="candidates"
              value={
                candidateTrains
                  ? `${candidateTrains.length}: ${candidateTrains.join(', ') || '-'}`
                  : '(n/a)'
              }
              colors={colors}
            />
            {/* #1215 (D9) — fusion detection verdict (tier/signalMask). */}
            <KeyValue
              label="tier"
              value={formatOptionalString(fusionDetection?.tier)}
              colors={colors}
            />
            <KeyValue
              label="signalMask"
              value={formatOptionalString(fusionDetection?.signalMask)}
              colors={colors}
            />
          </Section>

          {/* #1898 — RC-12 결함 B. accelerometer raw snapshot dashboard. Fusion 섹션의 accelPattern
              라벨 row만으로는 "sensor 작동 중인가?" 구분 불가 — rmsMagnitude/sampleCount/lastUpdate
              raw 값을 추가 노출. snapshot=null이면 (no snapshot) 단일 row. */}
          <AccelFingerprintSection snapshot={accelSnapshot} colors={colors} />

          {/* #1215 (D9) — Trip 섹션: lockless/tripStartedAt/currentHopIndex/route hop count. */}
          <Section title="Trip" colors={colors} testID="debug-modal-trip-section">
            <KeyValue
              label="lockless"
              value={formatOptionalBool(trip?.lockless)}
              colors={colors}
            />
            <KeyValue
              label="tripStartedAt"
              value={formatOptionalTs(trip?.tripStartedAt ?? null)}
              colors={colors}
            />
            <KeyValue
              label="currentHopIndex"
              value={formatOptionalNumber(trip?.currentHopIndex)}
              colors={colors}
            />
            <KeyValue
              label="route hop count"
              value={formatOptionalNumber(trip?.routeHopCount ?? null)}
              colors={colors}
            />
            {/* #1447 — displayOnlyEstimate.strategy 라벨. null이면 fallback "(none)"으로 항상 표시. */}
            <KeyValue
              label="displayOnlyEstimate"
              value={formatDisplayOnlyEstimateStrategy(trip?.displayOnlyEstimateStrategy)}
              colors={colors}
              testID="debug-modal-display-only-estimate"
            />
            {/* #1604 — trip lifecycle phase (T10 #1594). 사용자가 trip 종료 원인(silence/force-end)을 확인. */}
            <KeyValue
              label="lifecyclePhase"
              value={resolveLifecyclePhase(trip)}
              colors={colors}
              testID="debug-modal-lifecycle-phase"
            />
          </Section>

          {/* #1898 — RC-12 결함 A. arcStations 기반 trip route line sequence. modal 노선 추천
              회귀(예: 동대문 trip line=2인데 modal이 4/5호선 추천) 진단 시 사용자가 trip line
              context를 즉시 확인 가능. arcStations 빈 배열이면 (no route) 단일 row. */}
          <RouteLinesSection routeLines={routeLines} colors={colors} />

          {/* #1215 (D9) — Sleep 섹션: sleepMode + 첫 hop 향하는 중인가. */}
          <Section title="Sleep" colors={colors}>
            <KeyValue
              label="sleepMode"
              // #1235 (D9 wire) — sleep는 SSOT 도출로 항상 non-null. on/off만 분기.
              value={sleep.sleepMode ? 'on' : 'off'}
              colors={colors}
            />
            <KeyValue
              label="firstHopApproaching"
              value={formatOptionalBool(sleep?.firstHopApproaching)}
              colors={colors}
            />
          </Section>

          <Section title="Nearest station" colors={colors}>
            {result ? (
              <>
                <KeyValue label="name" value={result.station.name} colors={colors} />
                <KeyValue label="line" value={String(result.station.line)} colors={colors} />
                <KeyValue
                  label="distance"
                  value={`${nearestDistanceM} m`}
                  colors={colors}
                />
                {variantNames.length > 0 && (
                  <KeyValue
                    label="variants"
                    value={variantNames.join(', ')}
                    colors={colors}
                  />
                )}
              </>
            ) : (
              <Text style={[typography.mono, { color: colors.muted }]}>(no nearest)</Text>
            )}
          </Section>

          <Section title="Arrival" colors={colors}>
            <Text style={[typography.mono, { color: colors.ink }]} testID="debug-arrival-summary">
              {arrivalSummary}
            </Text>
            {isMock && (
              <Text style={[typography.mono, { color: colors.warn, marginTop: spacing.xs }]}>
                MOCK
              </Text>
            )}
          </Section>

          <Section title="Silent Push" colors={colors}>
            {silentPushDiagRows(silentPush, logs, lowPowerMode).map(
              ({ uiLabel, value }) => (
                <KeyValue key={uiLabel} label={uiLabel} value={value} colors={colors} />
              ),
            )}
          </Section>

          {/*
           * #1568 (T8b, Epic ADR-017 #1553) — backend SSoT 권위 mirror 표시.
           * silent push payload.ssot가 BACKEND_SSOT_MIRROR_KEY에 영속화한 권위 스냅샷.
           * backend가 한 번도 SSoT 권위를 forward 안 한 cycle은 `(no recent SSoT push)` 1줄.
           */}
          <Section title="Backend SSoT" colors={colors}>
            {backendSsotMirror ? (
              <>
                <KeyValue
                  label={BACKEND_SSOT_DUMP_LABELS.currentStationId}
                  value={backendSsotMirror.currentStationId}
                  colors={colors}
                />
                <KeyValue
                  label={BACKEND_SSOT_DUMP_LABELS.motionState}
                  value={backendSsotMirror.motionState}
                  colors={colors}
                />
                <KeyValue
                  label={BACKEND_SSOT_DUMP_LABELS.lastAdvanceEvidence}
                  value={backendSsotMirror.lastAdvanceEvidence}
                  colors={colors}
                />
                <KeyValue
                  label={BACKEND_SSOT_DUMP_LABELS.lastAdvanceAt}
                  value={String(backendSsotMirror.lastAdvanceAt)}
                  colors={colors}
                />
                <KeyValue
                  label={BACKEND_SSOT_DUMP_LABELS.alarmEventsCount}
                  value={String(backendSsotMirror.alarmEvents?.length ?? 0)}
                  colors={colors}
                />
              </>
            ) : (
              <Text
                style={[typography.mono, { color: colors.muted }]}
                testID="debug-backend-ssot-empty"
              >
                (no recent SSoT push)
              </Text>
            )}
          </Section>

          <BoardingLockSection lock={lock} colors={colors} />

          {/* #2268 (C1) — Lock Correction: pending→confirmed 정정 fired count / lastFiredAt.
              buildLockCorrectionSection과 동일 SSOT (내부 helper 재사용). */}
          <LockCorrectionSection metrics={lockCorrectionMetrics} colors={colors} />

          {/* #2330 (consensus-D) — Consensus Mismatch: 탭 vs consensus-confirmed 불일치 fired count.
              buildConsensusMismatchSection과 동일 SSOT (내부 helper 재사용). */}
          <ConsensusMismatchSection metrics={consensusMismatchMetrics} colors={colors} />

          <DebugLogSection
            title="Estimator State"
            logs={estimatorLogs}
            formatLine={formatEstimatorLine}
            onClear={() => {
              clearEstimatorEntries();
              setEstimatorLogs([]);
            }}
            clearTestId="debug-estimator-clear"
            entryTestId="debug-estimator-entry"
            colors={colors}
          />

          <GatesSection logs={logs} colors={colors} />

          <DebugLogSection
            title="Fusion log"
            logs={fusionLogs}
            formatLine={formatFusionDebugLine}
            onClear={() => {
              clearFusionDebugEntries();
              setFusionLogs([]);
            }}
            clearTestId="debug-fusion-log-clear"
            entryTestId="debug-fusion-log-entry"
            colors={colors}
          />

          {/* #1540 (S7) — gps-drop 별 buffer. fusion log cap 점령 회귀 차단용 별 채널 표시. */}
          <DebugLogSection
            title="GPS drops"
            logs={gpsDropLogs}
            formatLine={formatGpsDropLine}
            onClear={() => {
              clearGpsDropEntries();
              setGpsDropLogs([]);
            }}
            clearTestId="debug-gps-drop-log-clear"
            entryTestId="debug-gps-drop-log-entry"
            colors={colors}
          />

          {/* #1902 (RC-18) — candidate-reject 별 buffer. fusion log cap 점령 회귀 차단용 별 채널 표시. */}
          <DebugLogSection
            title="Candidate rejects"
            logs={candidateRejectLogs}
            formatLine={formatCandidateRejectLine}
            onClear={() => {
              clearCandidateRejectEntries();
              setCandidateRejectLogs([]);
            }}
            clearTestId="debug-candidate-reject-log-clear"
            entryTestId="debug-candidate-reject-log-entry"
            colors={colors}
          />

          {/* #2049 (#1896 RC-8) — boarding-lock-drift 별 buffer. candidate-reject와 동일 표시 패턴. */}
          {/* #2268 (C2) — 헤더에 launch 이후 경과 초를 표시해 (0)이 "이벤트 없음"인지
              "앱 재기동으로 버퍼 증발"인지 판정 가능하게 한다. */}
          <DebugLogSection
            title={`Boarding-Lock Drift (buffer age since launch = ${debugModalBufferAgeSec}s)`}
            logs={boardingLockDriftLog}
            formatLine={formatBoardingLockDriftLine}
            onClear={() => {
              clearBoardingLockDriftEntries();
              setBoardingLockDriftLog([]);
            }}
            clearTestId="debug-boarding-lock-drift-log-clear"
            entryTestId="debug-boarding-lock-drift-log-entry"
            colors={colors}
          />

          {/* #2152 — BoardingLock lifecycle(생성 source / 해제 reason) 별 buffer. drift와 동일 표시 패턴. */}
          {/* #2268 (C2) — 헤더에 launch 이후 경과 초를 표시(위 Drift 섹션과 동일 근거). */}
          <DebugLogSection
            title={`BoardingLock Lifecycle (buffer age since launch = ${debugModalBufferAgeSec}s)`}
            logs={lockLifecycleLog}
            formatLine={formatLockLifecycleLine}
            onClear={() => {
              clearLockLifecycleEntries();
              setLockLifecycleLog([]);
            }}
            clearTestId="debug-lock-lifecycle-log-clear"
            entryTestId="debug-lock-lifecycle-log-entry"
            colors={colors}
          />

          {/* #1518 — device → backend HTTP 호출 ring buffer. 토글 없이 직전 entries 자동 표시. */}
          <DebugLogSection
            title="Backend Calls"
            logs={backendCalls}
            formatLine={formatBackendCallLine}
            onClear={() => {
              clearBackendCallEntries();
              setBackendCalls([]);
            }}
            clearTestId="debug-backend-calls-clear"
            entryTestId="debug-backend-calls-entry"
            colors={colors}
          />

          <Section
            title={
              scheduledDump
                ? `Scheduled queue (${scheduledDump.length})`
                : 'Scheduled queue'
            }
            colors={colors}
            action={
              <Pressable onPress={refreshScheduledDump} testID="debug-scheduled-dump-refresh">
                <Text style={[typography.bodySm, { color: colors.accent }]}>Refresh</Text>
              </Pressable>
            }
          >
            <ScheduledQueueBody dump={scheduledDump} colors={colors} />
          </Section>

          <NotificationsFiredSection firedLog={firedAlarmLog} colors={colors} />

          <Section
            title={`Alarm log (${logs.length})`}
            colors={colors}
            testID="alarm-log-modal-content"
            action={
              <Pressable onPress={refreshLogs} testID="debug-log-refresh">
                <Text style={[typography.bodySm, { color: colors.accent }]}>Refresh</Text>
              </Pressable>
            }
          >
            {logs.length === 0 ? (
              <Text style={[typography.mono, { color: colors.muted }]}>(empty)</Text>
            ) : (
              <>
                <Text
                  style={[typography.mono, { color: colors.subtle, marginBottom: spacing.xs }]}
                  selectable
                  testID="debug-log-source-counts"
                >
                  {formatSourceCountsLine(logs)}
                </Text>
                {[...logs].reverse().map((entry, idx) => (
                  <MonoEntry key={`${entry.ts}-${idx}`} colors={colors}>
                    {formatLogLine(entry)}
                  </MonoEntry>
                ))}
              </>
            )}
          </Section>

          {/* #1019: Gates */}
          {formatReasonCountsLine(logs) ? (
            <Section title="Gates" colors={colors}>
              <Text
                style={[typography.mono, { color: colors.ink }]}
                selectable
                testID="debug-gate-reason-counts"
              >
                {formatReasonCountsLine(logs)}
              </Text>
            </Section>
          ) : null}

          {/* #1693/#1706 — fusion picker tier 채택 분포 (최근 1h). 별 ring buffer(#1706)에서
              직접 집계 — alarmLog ring 점령 회귀 차단. PR #1650/#1662/#1674 효과 검증. */}
          <Section title="Fusion Tier (1h)" colors={colors}>
            <Text
              style={[typography.mono, { color: colors.ink }]}
              selectable
              testID="debug-fusion-picker-tier"
            >
              {formatFusionPickerTierDistribution(fusionTierLogs)}
            </Text>
          </Section>

          {/* #1021: boardingPrompt 발사 빈도 카운터 */}
          <Section title="Boarding Prompt" colors={colors}>
            {BOARDING_PROMPT_WINDOWS.map(({ key, label }) => (
              <KeyValue
                key={key}
                label={`boardingPrompt(${label})`}
                value={String(countBoardingPromptByWindow(logs)[key])}
                colors={colors}
              />
            ))}
            {/* #1687 — autoLock outcome 분포 (1h 윈도우). success rate baseline 측정. */}
            <AutoLockTelemetryRow logs={logs} colors={colors} />
          </Section>

          {/* #1170: boarding-prompt acceptance dashboard (gate 통과율/응답률) */}
          <BoardingPromptMonitorSection logs={logs} colors={colors} />

          {/* #1024 — ## Counters: reason별 누적 count + 마지막 발생 시각 */}
          <CountersSection logs={logs} colors={colors} />

          {/* #1682 — Suppress Reasons: 1h 윈도우 top 5 suppress reason 분포 */}
          <SuppressReasonsSection logs={logs} colors={colors} />

          {/* #2049 (#1692) — Alarm Log Reasons (1h): suppress reason 집계 요약.
              buildAlarmLogReasonsSummarySection과 동일 SSOT (내부 helper 재사용). */}
          <AlarmLogReasonsSummarySection logs={logs} colors={colors} />

          {/* #2049 (#1421) — Auto-lock Candidate: SSOT/stability/direction/candidate 4줄.
              buildAutoLockSection과 동일 SSOT (내부 helper 재사용). */}
          <AutoLockCandidateSection meta={autoLockMeta} colors={colors} />

          {/* #2049 (#1430) — Environment Distribution: SSOT 활성 cascade state별 누적 시간.
              buildEnvironmentDistributionSection과 동일 SSOT (내부 helper 재사용). */}
          <EnvironmentDistributionSection snapshot={envDistribution} colors={colors} />

          {/* #1501 — PR-C. Raw signal 자동 표시 (toggle 없음).
              #1881 — 전체 buffer 전달. UI는 DebugLogSection의 DEBUG_LOG_DISPLAY_LIMIT(100) 적용.
              Clear는 buffer + AsyncStorage 모두 wipe. */}
          <DebugLogSection
            title="Raw Signal"
            logs={rawSignalLog}
            formatLine={formatRawSignalLine}
            onClear={() => {
              clearRawSignalEntries();
              setRawSignalLog([]);
            }}
            clearTestId="debug-raw-signal-clear"
            entryTestId="debug-raw-signal-entry"
            colors={colors}
          />

          {/* #1859 — Cellular Tech Distribution. rawSignalLog cellular 분포 집계.
              1주 측정 → LTE/NRNSA surface hard-reject 재검토 결정 evidence. */}
          <Section
            title="Cellular Tech Distribution"
            colors={colors}
            testID="debug-cellular-tech-distribution"
          >
            {computeCellularTechDistribution(rawSignalLog).map((line, idx) => (
              <Text
                // eslint-disable-next-line react/no-array-index-key
                key={idx}
                style={[typography.mono, { color: colors.ink }]}
                selectable
                testID="debug-cellular-tech-entry"
              >
                {line}
              </Text>
            ))}
          </Section>

          {/* #1263 (Epic #1204 그룹 0 PR C): Regressions 4종 추이 */}
          <RegressionsSection />

          {/* SPIKE (throwaway) — 가속도계 train-fingerprint 검증 로거. */}
          <AccelSpikeLoggerSection />

          {/* #1022: Worker Quota admin view */}
          <Section title="Worker Quota" colors={colors}>
            <KeyValue
              label="endpoint"
              value={`${process.env.EXPO_PUBLIC_ALARM_BACKEND_URL ?? '(unset)'}/admin/quota`}
              colors={colors}
            />
            <Text
              style={[typography.mono, { color: colors.muted, marginTop: spacing.xs }]}
              testID="debug-quota-note"
            >
              GET with Bearer ADMIN_TOKEN
            </Text>
          </Section>

          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.actionButton, { borderColor: colors.accent }]}
              onPress={handleClear}
              testID="debug-clear-log"
            >
              <Text style={[styles.actionText, { color: colors.accent }]}>Clear all logs</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionButton, { backgroundColor: colors.accent }]}
              onPress={handleShare}
              testID="debug-share-dump"
            >
              <Text style={[styles.actionText, { color: colors.onAccent }]}>Share dump</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </View>
    </Modal>
    {/* #1956 — Operation Dashboard metric drill-down. visible은 token 유무로 결정. */}
    <TripDetailModal
      visible={tripDetailToken !== null}
      tripToken={tripDetailToken}
      onClose={handleTripDetailClose}
    />
    </>
  );
}

// #756: Scheduled queue 섹션 본문 — null/empty/non-empty 3가지 상태를 별도 컴포넌트로
// 분리해 nested ternary를 피한다. dump 배열은 fire 시각 기준 정렬된 상태로 들어온다.
function ScheduledQueueBody({
  dump,
  colors,
}: Readonly<{
  dump: ScheduledNotificationDumpEntry[] | null;
  colors: ReturnType<typeof useTheme>['colors'];
}>) {
  if (dump === null) {
    return (
      <Text style={[typography.mono, { color: colors.muted }]}>(tap Refresh to load)</Text>
    );
  }
  if (dump.length === 0) {
    return <Text style={[typography.mono, { color: colors.muted }]}>(empty)</Text>;
  }
  return (
    <>
      {dump.map((entry) => (
        <MonoEntry key={entry.identifier} testID="debug-scheduled-dump-entry" colors={colors}>
          {formatScheduledNotificationLine(entry)}
        </MonoEntry>
      ))}
    </>
  );
}

// #1626 — V4 발사된 notification만 시간순 reverse. baseline 측정 fidelity 향상.
// fired 0건이면 섹션 자체를 노출하지 않는다 — 사용자 노이즈 최소화 (fired 없으면 Alarm log
// Section만 보면 충분).
// #2284 — alarmLog 파생값(rotate 절단 상속) 대신 독립 fired-only 버퍼를 SSoT로 사용.
function NotificationsFiredSection({
  firedLog,
  colors,
}: Readonly<{
  firedLog: readonly FiredAlarmLogEntry[];
  colors: ReturnType<typeof useTheme>['colors'];
}>) {
  if (firedLog.length === 0) return null;
  return (
    <Section
      title={`Notifications fired (${firedLog.length})`}
      colors={colors}
      testID="notifications-fired-section"
    >
      {[...firedLog].reverse().map((entry, idx) => (
        <MonoEntry
          key={`fired-${entry.ts}-${idx}`}
          testID="debug-notifications-fired-entry"
          colors={colors}
        >
          {formatFiredLogLine(entry)}
        </MonoEntry>
      ))}
    </Section>
  );
}

/**
 * #1025 — 역방향(최신 → 오래된) 모노 로그 목록 섹션 — Estimator/Fusion 공통 패턴.
 * #1881 — DEBUG_LOG_DISPLAY_LIMIT(100) 기본 표시. 초과 시 "Show more (N)" 버튼 노출.
 *          share dump는 호출부가 별도로 buffer 전체 주입(UI cap과 무관).
 */
function DebugLogSection<T extends { ts: number }>({
  title,
  logs,
  formatLine,
  onClear,
  clearTestId,
  entryTestId,
  colors,
}: Readonly<{
  title: string;
  logs: readonly T[];
  formatLine: (entry: T) => string;
  onClear: () => void;
  clearTestId: string;
  entryTestId: string;
  colors: ReturnType<typeof useTheme>['colors'];
}>) {
  const [expanded, setExpanded] = useState(false);
  const reversed = [...logs].reverse();
  const displayed = expanded ? reversed : reversed.slice(0, DEBUG_LOG_DISPLAY_LIMIT);
  const hidden = reversed.length - displayed.length;
  return (
    <Section
      title={`${title} (${logs.length})`}
      colors={colors}
      action={
        <Pressable onPress={onClear} testID={clearTestId}>
          <Text style={[typography.bodySm, { color: colors.accent }]}>Clear</Text>
        </Pressable>
      }
    >
      {logs.length === 0 ? (
        <Text style={[typography.mono, { color: colors.muted }]}>(empty)</Text>
      ) : (
        <>
          {displayed.map((entry, idx) => (
            <MonoEntry key={`${entry.ts}-${idx}`} testID={entryTestId} colors={colors}>
              {formatLine(entry)}
            </MonoEntry>
          ))}
          {hidden > 0 && (
            <Pressable
              onPress={() => setExpanded(true)}
              testID={`${entryTestId}-show-more`}
            >
              <Text style={[typography.bodySm, { color: colors.accent, marginTop: spacing.xs }]}>
                {`Show more (${hidden})`}
              </Text>
            </Pressable>
          )}
        </>
      )}
    </Section>
  );
}

/**
 * #1898 — RC-12 결함 A. trip route line sequence 시각화.
 *
 * 환승 trip은 summary row + 각 line 구간(first/last station) row를 나열한다.
 * `routeLines`가 빈 배열이면 (no route) 단일 row 노출.
 *
 * 데이터 주도: lines 수에 의존하지 않고 map 순회. 새 line 추가 / 환승 N회도 같은 코드.
 */
function RouteLinesSection({
  routeLines,
  colors,
}: Readonly<{
  routeLines: readonly { line: string; firstStation: string; lastStation: string }[];
  colors: ReturnType<typeof useTheme>['colors'];
}>) {
  return (
    <Section title="Trip Route Lines" colors={colors} testID="debug-route-lines-section">
      {routeLines.length === 0 ? (
        <Text
          style={[typography.mono, { color: colors.muted }]}
          testID="debug-route-lines-empty"
        >
          (no route)
        </Text>
      ) : (
        <>
          <KeyValue
            label="summary"
            value={routeLines.map((l) => l.line).join(' -> ')}
            colors={colors}
            testID="debug-route-lines-summary"
          />
          {routeLines.map((entry, idx) => (
            <KeyValue
              // segment index를 key에 포함해 환승 trip의 같은 line 재등장(2→4→2, 분기 회귀)에서도
              // React duplicate-key 경고 차단. firstStation을 함께 묶어 디버깅 친화적 식별자 유지.
              key={`leg-${idx}-${entry.line}-${entry.firstStation}`}
              label={`line=${entry.line}`}
              value={`first=${entry.firstStation} last=${entry.lastStation}`}
              colors={colors}
              // testID도 idx suffix로 unique 보장 — getByTestId 충돌 방지. 같은 line 재방문 trip
              // (예: 2호선→다른 노선→2호선)에서 두 segment를 별도로 조회 가능.
              testID={`debug-route-lines-leg-${idx}-line-${entry.line}`}
            />
          ))}
        </>
      )}
    </Section>
  );
}

/**
 * #1898 — RC-12 결함 B. accelerometer raw snapshot dashboard.
 *
 * Fusion 섹션의 accelPattern row는 분류 결과만 노출 → 사용자가 "sensor 작동 중인가?",
 * "60s window 수렴 했는가?" 즉시 판단 불가. 본 섹션은 rmsMagnitude(중력 제거 RMS) /
 * sampleCount(window 누적 sample 수) / lastUpdate(snapshot 갱신 시각)를 추가 노출.
 *
 * `snapshot=null`이면 (no snapshot) 단일 row + 안내 라인 — 미지원/native 모듈 미포함/load
 * 안 함을 구분 가능. snapshot.patternClass='unknown' + sampleCount<50이면 60s window 미수렴
 * 상태.
 */
function AccelFingerprintSection({
  snapshot,
  colors,
}: Readonly<{
  snapshot: AccelerometerSnapshot | null;
  colors: ReturnType<typeof useTheme>['colors'];
}>) {
  return (
    <Section title="Accel Fingerprint" colors={colors} testID="debug-accel-fingerprint-section">
      {snapshot === null ? (
        <>
          <Text
            style={[typography.mono, { color: colors.muted }]}
            testID="debug-accel-fingerprint-empty"
          >
            (no snapshot)
          </Text>
          <Text
            style={[typography.mono, { color: colors.subtle, marginTop: spacing.xs }]}
          >
            sensor 미지원 또는 native 모듈 미포함 (EAS rebuild 후 자연 채워짐)
          </Text>
        </>
      ) : (
        <>
          <KeyValue
            label="pattern"
            value={snapshot.patternClass}
            colors={colors}
            testID="debug-accel-fingerprint-pattern"
          />
          <KeyValue
            label="rmsMag"
            value={`${snapshot.rmsMagnitude.toFixed(2)} m/s^2`}
            colors={colors}
            testID="debug-accel-fingerprint-rms"
          />
          <KeyValue
            label="samples"
            value={String(snapshot.sampleCount)}
            colors={colors}
            testID="debug-accel-fingerprint-samples"
          />
          <KeyValue
            label="lastUpdate"
            value={formatTime(snapshot.timestamp)}
            colors={colors}
            testID="debug-accel-fingerprint-last-update"
          />
        </>
      )}
    </Section>
  );
}

/** BoardingLock 섹션 — lock 활성/trainCode/boardingLine/expiresAt 요약 (#1025). */
function BoardingLockSection({
  lock,
  colors,
}: Readonly<{
  lock: import('../../../shared/types/boardingLock').BoardingLock | null;
  colors: ReturnType<typeof useTheme>['colors'];
}>) {
  // lock 변경 시점 스냅샷 — 디버그 모달 특성상 실시간 갱신 불필요.
  const active = lock !== null && !isBoardingLockExpired(lock, Date.now());
  return (
    <Section title="BoardingLock" colors={colors}>
      <KeyValue label="active" value={active ? 'yes' : 'no'} colors={colors} />
      {lock && (
        <>
          <KeyValue
            label="trainCode"
            value={formatTrainCodeDisplay(lock.trainCode)}
            colors={colors}
          />
          <KeyValue label="line" value={String(lock.boardingLine)} colors={colors} />
          <KeyValue
            label="expiresAt"
            value={formatAt(
              lock.boardedAt + lock.expectedDurationMs * BOARDING_LOCK_EXPIRY_FACTOR,
            )}
            colors={colors}
          />
          <KeyValue
            label="boardedAt"
            value={formatAt(lock.boardedAt)}
            colors={colors}
          />
          {lock.hydratedFromSentinel && (
            <KeyValue label="sentinel" value="yes" colors={colors} />
          )}
        </>
      )}
    </Section>
  );
}

/** Estimator 엔트리를 한 줄 텍스트로 포맷 (#1025). */
export function formatEstimatorLine(entry: EstimatorDebugEntry): string {
  const time = formatTime(entry.ts);
  const strategy = entry.strategy ?? 'none';
  const station = entry.stationName
    ? `${entry.stationName}(${entry.stationLine ?? '-'})`
    : '-';
  const idx = entry.arcIndex != null ? `idx=${entry.arcIndex}` : 'idx=-';
  return `${time} | ${strategy} | ${station} ${idx}`;
}

/** Gates 섹션 — gate 7종 + movement 6종 reason 분포 (#1025). */
function GatesSection({
  logs,
  colors,
}: Readonly<{
  logs: readonly AlarmLogEntry[];
  colors: ReturnType<typeof useTheme>['colors'];
}>) {
  const allCounts = {
    ...countGateReasons(logs, GATE_REASONS),
    ...countGateReasons(logs, MOVEMENT_REASONS),
  };
  const allKeys = Object.keys(allCounts).sort((a, b) => a.localeCompare(b));
  return (
    <Section title="Gates" colors={colors}>
      {allKeys.length === 0 ? (
        <Text style={[typography.mono, { color: colors.muted }]}>(no gate blocks)</Text>
      ) : (
        allKeys.map((key) => (
          <KeyValue
            key={key}
            label={key}
            value={String(allCounts[key])}
            colors={colors}
          />
        ))
      )}
    </Section>
  );
}

/** 단일 모노 로그 라인 — Alarm log / Estimator / Fusion / Scheduled queue 공통 스타일 (#1025). */
function MonoEntry({
  testID,
  children,
  colors,
}: {
  testID?: string;
  children: string;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  return (
    <Text
      style={[typography.mono, { color: colors.ink, marginBottom: 2 }]}
      selectable
      testID={testID}
    >
      {children}
    </Text>
  );
}

interface SectionProps {
  title: string;
  children: React.ReactNode;
  colors: ReturnType<typeof useTheme>['colors'];
  action?: React.ReactNode;
  testID?: string;
}

function Section({ title, children, colors, action, testID }: SectionProps) {
  return (
    <View style={[styles.section, { backgroundColor: colors.card }]} testID={testID}>
      <View style={styles.sectionHeader}>
        <Text style={[typography.label, { color: colors.muted }]}>{title}</Text>
        {action}
      </View>
      {children}
    </View>
  );
}

function KeyValue({
  label,
  value,
  colors,
  testID,
}: {
  label: string;
  value: string;
  colors: ReturnType<typeof useTheme>['colors'];
  /** #1447 — 특정 row를 테스트에서 식별할 때 optional testID. 미전달 시 무영향. */
  testID?: string;
}) {
  return (
    <View style={styles.kvRow}>
      <Text style={[typography.mono, { color: colors.subtle, width: 80 }]}>{label}</Text>
      <Text
        style={[typography.mono, { color: colors.ink, flex: 1 }]}
        selectable
        testID={testID}
      >
        {value}
      </Text>
    </View>
  );
}

/**
 * ## Counters 섹션 본문 (#1024) — reason별 누적 count + 마지막 발생 시각.
 * 억제 이벤트가 없으면 "(empty)" 노출. 항상 표시.
 */
function CountersSection({
  logs,
  colors,
}: Readonly<{
  logs: readonly AlarmLogEntry[];
  colors: ReturnType<typeof useTheme>['colors'];
}>) {
  const counters: AlarmLogReasonCounter[] = summarizeAlarmLogCounters(logs);
  return (
    <Section title="Counters" colors={colors}>
      {counters.length === 0 ? (
        <Text style={[typography.mono, { color: colors.muted }]}>(empty)</Text>
      ) : (
        counters.map(({ reason, count, lastTs }) => (
          <KeyValue
            key={reason}
            label={reason}
            value={`${count}x (${formatTime(lastTs)})`}
            colors={colors}
          />
        ))
      )}
    </Section>
  );
}

const AUTOLOCK_1H_MS = 60 * 60 * 1000;

/**
 * #1687 — autoLock outcome 분포 row (1h 윈도우).
 *
 * boardingPrompt 응답 → autoLock chain 성공률 baseline 측정 인프라.
 * 표시: success / ambiguous(=ambiguity) / empty(=arrivals-empty) / failed(=lock-failed) 4개 카운트.
 * 1시간 윈도우 고정 — 단기 측정에 적합. 0건이면 "—"로 표기.
 */
function AutoLockTelemetryRow({
  logs,
  colors,
}: Readonly<{
  logs: readonly AlarmLogEntry[];
  colors: ReturnType<typeof useTheme>['colors'];
}>) {
  const counts = useMemo(() => countAutoLockReasonsByWindow(logs, AUTOLOCK_1H_MS), [logs]);
  const total =
    counts['autolock-success'] +
    counts['autolock-ambiguity'] +
    counts['autolock-arrivals-empty'] +
    counts['autolock-no-trip'] +
    counts['autolock-station-lookup'] +
    counts['autolock-lock-failed'] +
    counts['autolock-fallback-pending'];
  const value =
    total === 0
      ? '—'
      // #2407 — pending: root-fix fallback lock 카운트(train 미확정이어도 lock은 생성됨).
      : `ok=${counts['autolock-success']} amb=${counts['autolock-ambiguity']} empty=${counts['autolock-arrivals-empty']} fail=${counts['autolock-lock-failed']} pending=${counts['autolock-fallback-pending']}`;
  return (
    <KeyValue
      label="autoLock(1h)"
      value={value}
      colors={colors}
      testID="debug-autolock-telemetry-1h"
    />
  );
}

/**
 * #1682 — Suppress Reasons 섹션 본문. 1h 윈도우 top 5 suppress reason 분포.
 * V9(suppress event rate < 100/h/trip) 측정 인프라. 디버그 only.
 */
function SuppressReasonsSection({
  logs,
  colors,
}: Readonly<{
  logs: readonly AlarmLogEntry[];
  colors: ReturnType<typeof useTheme>['colors'];
}>) {
  const counters = countAlarmLogReasonsByWindow(logs, SUPPRESS_REASONS_WINDOW_MS);
  const top = counters.slice(0, SUPPRESS_REASONS_TOP_N);
  return (
    <Section title="Suppress Reasons (1h)" colors={colors}>
      {top.length === 0 ? (
        <Text
          style={[typography.mono, { color: colors.muted }]}
          testID="debug-suppress-reasons-empty"
        >
          (empty — no suppressed events in 1h)
        </Text>
      ) : (
        top.map(({ reason, count, lastTs }) => (
          <KeyValue
            key={reason}
            label={reason}
            value={`${count}x (${formatTime(lastTs)})`}
            colors={colors}
          />
        ))
      )}
    </Section>
  );
}

/**
 * #2049 — dump builder가 return하는 sentinel line. UI에서 empty state로 렌더한다.
 * dump builder는 항상 최소 1개 라인 반환 (empty buffer도 `['(empty)']`) — sentinel 매칭만으로 판정.
 */
const DUMP_EMPTY_LINES: ReadonlySet<string> = new Set(['(n/a)', '(empty)']);

/**
 * #2049 — dump text section 공통 표시. 각 dump builder(string[])의 결과를 그대로 monospace로 노출.
 * builder를 UI와 share dump 둘 다에서 재사용해 SSoT 유지 — UI/dump가 어긋날 여지가 없다.
 * 단일 sentinel 라인(`(n/a)` / `(empty)`)이면 muted 톤으로 표시.
 */
function DumpTextSection({
  title,
  lines,
  entryTestId,
  colors,
}: Readonly<{
  title: string;
  lines: readonly string[];
  entryTestId: string;
  colors: ReturnType<typeof useTheme>['colors'];
}>) {
  const firstLine = lines[0];
  const isEmpty = firstLine !== undefined && lines.length === 1 && DUMP_EMPTY_LINES.has(firstLine);
  return (
    <Section title={title} colors={colors} testID={`${entryTestId}-section`}>
      {isEmpty ? (
        <Text
          style={[typography.mono, { color: colors.muted }]}
          testID={`${entryTestId}-empty`}
        >
          {firstLine}
        </Text>
      ) : (
        lines.map((line, idx) => (
          <MonoEntry
            key={`${entryTestId}-${idx}`}
            testID={entryTestId}
            colors={colors}
          >
            {line}
          </MonoEntry>
        ))
      )}
    </Section>
  );
}

/**
 * #2268 (C1) — Lock Correction UI section. computeLockCorrectionLines helper를 dump builder와 공유.
 */
function LockCorrectionSection({
  metrics,
  colors,
}: Readonly<{
  metrics: ReturnType<typeof getLockCorrectionMetrics> | undefined;
  colors: ReturnType<typeof useTheme>['colors'];
}>) {
  return (
    <DumpTextSection
      title="Lock Correction"
      lines={computeLockCorrectionLines(metrics)}
      entryTestId="debug-lock-correction"
      colors={colors}
    />
  );
}

/**
 * #2330 (consensus-D) — Consensus Mismatch UI section. computeConsensusMismatchLines helper를
 * dump builder와 공유.
 */
function ConsensusMismatchSection({
  metrics,
  colors,
}: Readonly<{
  metrics: ReturnType<typeof getConsensusMismatchMetrics> | undefined;
  colors: ReturnType<typeof useTheme>['colors'];
}>) {
  return (
    <DumpTextSection
      title="Consensus Mismatch"
      lines={computeConsensusMismatchLines(metrics)}
      entryTestId="debug-consensus-mismatch"
      colors={colors}
    />
  );
}

/**
 * #2049 (#1421) — Auto-lock Candidate UI section. computeAutoLockLines helper를 dump builder와 공유.
 */
function AutoLockCandidateSection({
  meta,
  colors,
}: Readonly<{
  meta: AutoLockDebugMeta | undefined;
  colors: ReturnType<typeof useTheme>['colors'];
}>) {
  return (
    <DumpTextSection
      title="Auto-lock Candidate"
      lines={computeAutoLockLines(meta)}
      entryTestId="debug-auto-lock-candidate"
      colors={colors}
    />
  );
}

/**
 * #2049 (#1430) — Environment Distribution UI section. computeEnvironmentDistributionLines helper를 공유.
 */
function EnvironmentDistributionSection({
  snapshot,
  colors,
}: Readonly<{
  snapshot: EnvironmentDistributionSnapshot | undefined;
  colors: ReturnType<typeof useTheme>['colors'];
}>) {
  return (
    <DumpTextSection
      title="Environment Distribution"
      lines={computeEnvironmentDistributionLines(snapshot)}
      entryTestId="debug-environment-distribution"
      colors={colors}
    />
  );
}

/**
 * #2049 (#1692) — Alarm Log Reasons (1h) UI section. computeAlarmLogReasonsLines helper를 공유.
 */
function AlarmLogReasonsSummarySection({
  logs,
  colors,
}: Readonly<{
  logs: readonly AlarmLogEntry[];
  colors: ReturnType<typeof useTheme>['colors'];
}>) {
  return (
    <DumpTextSection
      title="Alarm Log Reasons (1h)"
      lines={computeAlarmLogReasonsLines(logs)}
      entryTestId="debug-alarm-log-reasons-1h"
      colors={colors}
    />
  );
}

/**
 * #1170 — boarding-prompt acceptance dashboard.
 *
 * 표시: displayed / responded / 응답률 / 탑승률 + 최근 7일 일별 표 (export 진입점).
 * 응답률·탑승률 0건 시 "—" 표기.
 */
const RECENT_DAYS = 7;

function formatRatePct(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`;
}

function BoardingPromptMonitorSection({
  logs,
  colors,
}: Readonly<{
  logs: readonly AlarmLogEntry[];
  colors: ReturnType<typeof useTheme>['colors'];
}>) {
  const stats = computeBoardingPromptMonitor(logs);
  const rows = exportRecentDays(stats, RECENT_DAYS);
  return (
    <Section title="Boarding Prompt Acceptance" colors={colors}>
      <KeyValue label="displayed" value={String(stats.displayed)} colors={colors} />
      <KeyValue label="responded" value={String(stats.responded)} colors={colors} />
      <KeyValue label="boarded" value={String(stats.boarded)} colors={colors} />
      <KeyValue label="dismissed" value={String(stats.dismissed)} colors={colors} />
      <KeyValue
        label="responseRate"
        value={formatRatePct(stats.responseRatePct)}
        colors={colors}
      />
      <KeyValue
        label="boardedRate"
        value={formatRatePct(stats.boardedRatePct)}
        colors={colors}
      />
      <Text
        style={[typography.mono, { color: colors.muted, marginTop: spacing.xs }]}
        testID="debug-boarding-prompt-recent-header"
      >
        {`recent ${RECENT_DAYS}d (day / disp / resp / brd / dis)`}
      </Text>
      {rows.map((row) => (
        <Text
          key={row.dayKey}
          style={[typography.mono, { color: colors.ink }]}
          testID={`debug-boarding-prompt-day-${row.dayKey}`}
        >
          {`${row.dayKey}  ${row.displayed}/${row.responded}/${row.boarded}/${row.dismissed}`}
        </Text>
      ))}
    </Section>
  );
}

// Internal exports for tests — DO NOT use from app code.
export const __test__ = {
  formatLogLine,
  buildDumpText,
  buildGpsRows,
  formatFusionDebugLine,
  formatBoardingLockDriftLine,
  buildBoardingLockDriftLogSection,
  formatLockLifecycleLine,
  buildLockLifecycleSection,
  formatTokenTail,
  formatAt,
  formatSourceCountsLine,
  formatEstimatorLine,
  formatReasonCountsLine,
  NO_FUSED_SIGNAL_LABEL,
  summarizeAlarmLogCounters,
  formatOptionalBool,
  formatOptionalString,
  formatOptionalNumber,
  formatOptionalTs,
  UNKNOWN_LABEL,
  // #1421 — Auto-lock 측정 인프라 내부 헬퍼. 호출자는 DebugModal 자체에서 render-time 산출.
  findArrivalTerminal,
  computeAutoLockNullReason,
  // #1430 — 환경 분포 측정 인프라 내부 헬퍼. render-time SSOT cascade → state 결정.
  deriveEnvironmentState,
  formatPercentage,
  formatDurationMs,
  // #1518 — backend call formatter / section builder. test에서 직접 검증.
  formatBackendCallLine,
  buildBackendCallsSection,
  // #1501 — PR-C. Raw signal 라인 포맷 helper. share dump 단위 테스트에서 직접 호출.
  formatRawSignalLine,
  // #1881 — UI 표시 cap (100). 기존 RAW_SIGNAL_DISPLAY_LIMIT alias로 테스트 호환 유지.
  DEBUG_LOG_DISPLAY_LIMIT,
  RAW_SIGNAL_DISPLAY_LIMIT,
  // #1540 (S7) — gps-drop 별 buffer 포맷/섹션. 단위 테스트에서 직접 호출.
  formatGpsDropLine,
  buildGpsDropLogSection,
  // #1902 (RC-18) — candidate-reject 별 buffer 포맷/섹션. 단위 테스트에서 직접 호출.
  formatCandidateRejectLine,
  buildCandidateRejectLogSection,
  // #1898 — RC-12 helper/builder. share dump 단위 테스트 + buildRouteLinesSummary 데이터 주도 검증.
  buildRouteLinesSummary,
  buildRouteLinesSection,
  buildAccelFingerprintSection,
  // Share dump 누락 3 섹션(#2044-scope) — Feature Flag(ADR-022) + Operation Dashboard(#1751) +
  // Fusion Tier (1h)(#1693/#1706). 단위 테스트에서 각 builder 직접 검증.
  buildFeatureFlagSection,
  buildOperationDashboardSection,
  buildFusionTierSection,
  // #2049 — dump builder와 UI section이 공유하는 SSoT helper. UI/dump 라인 일치 검증에 사용.
  computeAutoLockLines,
  computeEnvironmentDistributionLines,
  computeAlarmLogReasonsLines,
  // #2268 (C2) — Lifecycle/Drift buffer age suffix. 단위 테스트에서 launchAtMs/nowMs 조합 검증.
  formatBufferAgeSuffix,
  DEBUG_MODAL_LOAD_AT_MS,
  // #2268 (C1) — Lock Correction section builder/helper. 단위 테스트에서 직접 검증.
  computeLockCorrectionLines,
  buildLockCorrectionSection,
  // #2330 (consensus-D) — Consensus Mismatch section builder/helper. 단위 테스트에서 직접 검증.
  computeConsensusMismatchLines,
  buildConsensusMismatchSection,
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    borderBottomWidth: 1,
  },
  section: {
    padding: spacing.lg,
    borderRadius: radius.md,
    marginBottom: spacing.md,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  kvRow: {
    flexDirection: 'row',
    marginBottom: 2,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  actionButton: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
  },
  actionText: {
    fontWeight: '700',
    ...typography.bodySm,
  },
});
