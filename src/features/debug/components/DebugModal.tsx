import { useCallback, useEffect, useState } from 'react';
import {
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSettingsStore } from '../../settings/store/useSettingsStore';
import { isDebugModalEnabled } from '../../../shared/constants/debugFlags';
import type { GpsActiveState } from '../../../shared/constants/gpsStatus';
import { formatClockTimeWithSeconds } from '../../../shared/utils/formatTime';
import { useFusedNearestStation } from '../../../features/nearest-station/hooks/useFusedNearestStation';
import { useArrivalInfo } from '../../../features/arrival/hooks/useArrivalInfo';
import {
  useSilentPushDiagnostics,
  type SilentPushDiagnostics,
} from '../../../features/alarm/hooks/useSilentPushDiagnostics';
import {
  clearAlarmLog,
  countGateReasons,
  countSilentPushOutcomes,
  getAlarmLog,
  summarizeAlarmLogBySource,
  type AlarmLogEntry,
  type AlarmLogReason,
} from '../../../features/alarm/utils/alarmLog';
import { useBoardingLockStore } from '../../../features/alarm/store/useBoardingLockStore';
import { isBoardingLockExpired } from '../../../shared/types/boardingLock';
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
import {
  dumpScheduledNotifications,
  formatScheduledNotificationLine,
  type ScheduledNotificationDumpEntry,
} from '../../../features/alarm/utils/scheduledNotificationsDump';
import type { FusionConfidence, FusionSource } from '../../../shared/types/fusion';
import type { NearestStationResult } from '../../../shared/types/station';
import { useTheme, spacing, radius, typography } from '../../../shared/theme';

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatLogLine(entry: AlarmLogEntry): string {
  const parts: string[] = [
    formatTime(entry.ts),
    entry.source,
    entry.outcome,
  ];
  if (entry.reason) parts.push(entry.reason);
  if (entry.kind) parts.push(entry.kind);
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
 * #856 — `logs`/`locklessOn` 보강. lastRecv/lastFired 시간만 보고 "왜 안 울리지?" 묻는
 * 사용자 의문을 한 라인으로 해소하기 위해 received/fired 카운트 + toggle 상태 row 추가.
 * lastRecv/lastFired row는 카운트와 같은 값으로 흡수돼 단일 라인으로 줄어든다(중복 제거).
 */
function silentPushDiagRows(
  d: SilentPushDiagnostics,
  logs: readonly AlarmLogEntry[],
  locklessOn: boolean,
): { uiLabel: string; dumpKey: string; value: string }[] {
  const task = d.taskRegistrationError
    ? `${d.taskRegistrationState} (${d.taskRegistrationError})`
    : d.taskRegistrationState;
  const silentCounts = countSilentPushOutcomes(logs);
  const receivedValue = buildSilentPushCountValue(silentCounts.received, formatAt(d.lastReceivedAt));
  const firedValue = buildSilentPushCountValue(silentCounts.fired, formatAt(d.lastFiredAt));
  const toggleValue = locklessOn ? SILENT_PUSH_LABELS.toggleOn : SILENT_PUSH_LABELS.toggleOff;
  return [
    { uiLabel: 'permission', dumpKey: 'permission', value: d.permissionStatus ?? '(unknown)' },
    { uiLabel: 'apnsToken', dumpKey: 'apnsToken', value: formatTokenTail(d.apnsToken) },
    { uiLabel: 'activeTrip', dumpKey: 'activeTrip', value: formatTokenTail(d.activeTripToken) },
    { uiLabel: 'apnsEnv', dumpKey: 'apnsEnv', value: d.apnsEnv },
    { uiLabel: 'task', dumpKey: 'taskRegistration', value: task },
    { uiLabel: 'route', dumpKey: 'route', value: d.hasRoute ? 'set' : '(none)' },
    { uiLabel: 'dest', dumpKey: 'destination', value: d.destinationId ?? '(none)' },
    { uiLabel: 'currStn', dumpKey: 'currentStation', value: d.lastNotifiedStationId ?? '(none)' },
    {
      uiLabel: SILENT_PUSH_LABELS.receivedKey,
      dumpKey: SILENT_PUSH_LABELS.receivedKey,
      value: receivedValue,
    },
    {
      uiLabel: SILENT_PUSH_LABELS.firedKey,
      dumpKey: SILENT_PUSH_LABELS.firedKey,
      value: firedValue,
    },
    { uiLabel: 'lastSkip', dumpKey: 'lastSkipped', value: formatAt(d.lastSkippedAt) },
    {
      uiLabel: SILENT_PUSH_LABELS.toggleKey,
      dumpKey: SILENT_PUSH_LABELS.toggleKey,
      value: toggleValue,
    },
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

function buildDumpText(args: {
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
  logs: AlarmLogEntry[];
  // #856: lockless station-passed toggle ON/OFF — Silent Push 섹션 row의 SSOT.
  // optional — DebugModal 본체는 항상 전달, 단순 dump 단위 테스트는 생략 가능(기본 false).
  locklessOn?: boolean;
  // #756: OS 큐 dump. 미전달/null = DebugModal에서 한 번도 Refresh 안 한 상태.
  scheduledDump?: ScheduledNotificationDumpEntry[] | null;
}): string {
  const lines: string[] = [];
  // SonarCloud S7778: 인접한 정적 push 호출은 다인자 단일 호출로 묶는다.
  // #852: watch 구독 상태 + 마지막 fix 시각. 'bg'면 watch가 정지된 상태(silent push wake 등).
  // #853: fused speed signal. userLocation 있는 경우만 라인 노출, 미전달 시 NO_FUSED_SIGNAL_LABEL.
  // 호출자 호환을 위해 두 필드 모두 optional — 미전달 시 'fg'/(never)/(no fused signal)로 표기.
  const gpsLines: string[] = [];
  if (args.userLocation) {
    const fusedDump = args.fusedSpeed
      ? `${args.fusedSpeed.kmh.toFixed(1)} km/h (${args.fusedSpeed.source})`
      : NO_FUSED_SIGNAL_LABEL;
    gpsLines.push(
      `lat=${args.userLocation.lat}, lng=${args.userLocation.lng}, speed=${args.speedMps ?? '-'} m/s, accuracy=${args.accuracyMeters ?? '-'} m`,
      `fused=${fusedDump}`,
    );
  } else {
    gpsLines.push('(no location)');
  }
  lines.push(
    `[Subway debug] ${new Date().toISOString()}`,
    '',
    '## GPS',
    ...gpsLines,
    `state=${args.gpsActive ?? 'fg'}, lastFix=${formatClockTimeWithSeconds(args.lastFixAtMs ?? null)}`,
    '',
    '## Nearest',
    args.nearestName
      ? `${args.nearestName} · ${args.nearestDistanceM ?? '-'} m`
      : '(no nearest station)',
  );
  if (args.variants.length > 0) {
    lines.push(`variants: ${args.variants.join(', ')}`);
  }
  lines.push(
    '',
    '## Fusion',
    `confidence=${args.fusion.confidence}, source=${args.fusion.source}`,
    `fused: ${args.fusion.fusedLabel}`,
    `gps:   ${args.fusion.gpsLabel}`,
  );
  if (args.fusion.differs) lines.push('(fused != gps)');
  if (args.fusion.candidateTrains) {
    lines.push(
      `candidateTrains(${args.fusion.candidateTrains.length}): ${args.fusion.candidateTrains.join(', ') || '-'}`,
    );
  }
  lines.push('', '## Arrival', args.arrivalSummary);
  if (args.isMock) lines.push('(MOCK)');
  lines.push('', '## Silent Push');
  for (const { dumpKey, value } of silentPushDiagRows(args.silentPush, args.logs, args.locklessOn ?? false)) {
    lines.push(`${dumpKey}=${value}`);
  }
  lines.push('');
  // #756: 사용자가 Refresh 안 했으면 dump 섹션 자체를 "(not loaded)"로 명시해
  // "비어있음"과 "load 안 함"을 dump 텍스트만 보고도 구분 가능하게.
  // optional 필드 — undefined 도 null 과 동일 처리.
  if (args.scheduledDump == null) {
    lines.push('## Scheduled queue', '(not loaded)');
  } else {
    lines.push(
      `## Scheduled queue (${args.scheduledDump.length})`,
      ...args.scheduledDump.map(formatScheduledNotificationLine),
    );
  }
  lines.push('');
  lines.push(`## Alarm log (${args.logs.length})`);
  // #564 — source별 카운트 헤더(UI와 동일 포매터 공유). 빈 문자열이면 헤더 생략.
  const sourcesLine = formatSourceCountsLine(args.logs);
  if (sourcesLine) lines.push(`sources: ${sourcesLine}`);
  for (const entry of [...args.logs].reverse()) {
    lines.push(formatLogLine(entry));
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

function DebugModalInner({ onClose, candidateTrains, fusedSpeed }: Readonly<DebugModalProps>) {
  const { colors } = useTheme();
  // #458: RN Modal 안에서는 SafeAreaView가 안 먹는다(portal로 inset 컨텍스트 분리).
  // 루트 SafeAreaProvider의 insets를 hook으로 직접 받아 헤더에 manual padding.
  const insets = useSafeAreaInsets();
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
  } = useFusedNearestStation();
  const stationName = result?.station.name ?? null;
  const { arrival, isMock } = useArrivalInfo(stationName);
  const silentPush = useSilentPushDiagnostics();
  // #856: lockless station-passed toggle. OFF면 backend가 받은 silent push도 client가
  // intermediate 알림을 차단 → "received는 늘어도 fired는 안 늘어남"이 정상 동작.
  // DebugModal에 한 줄로 노출해 사용자가 설정 위치를 즉시 알 수 있게 한다.
  const locklessOn = useSettingsStore((s) => s.locklessStationPassed);
  const fusedLabel = formatStationLabel(result);
  const gpsLabel = formatStationLabel(gpsResult);
  const differs = fusedDiffersFromGps(result, gpsResult);
  const lock = useBoardingLockStore((s) => s.lock);
  const [logs, setLogs] = useState<AlarmLogEntry[]>([]);
  const [fusionLogs, setFusionLogs] = useState<readonly FusionDebugEntry[]>(() =>
    getFusionDebugEntries(),
  );
  const [estimatorLogs, setEstimatorLogs] = useState<readonly EstimatorDebugEntry[]>(() =>
    getEstimatorEntries(),
  );
  // #756: OS 큐 ground-truth dump. 호출 직후 한 번 비동기로 채워진다.
  // null = 아직 한 번도 dump 안 한 상태 → "Tap Refresh" placeholder 노출.
  const [scheduledDump, setScheduledDump] = useState<ScheduledNotificationDumpEntry[] | null>(null);

  const refreshScheduledDump = useCallback(async () => {
    setScheduledDump(await dumpScheduledNotifications());
  }, []);

  useEffect(() => {
    return subscribeFusionDebug(() => setFusionLogs([...getFusionDebugEntries()]));
  }, []);

  useEffect(() => {
    return subscribeEstimatorDebug(() => setEstimatorLogs([...getEstimatorEntries()]));
  }, []);

  const refreshLogs = useCallback(async () => {
    setLogs(await getAlarmLog());
  }, []);

  useEffect(() => {
    void refreshLogs();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshLogs();
    });
    return () => sub.remove();
  }, [refreshLogs]);

  const handleClear = useCallback(async () => {
    await clearAlarmLog();
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

  const nearestDistanceM = result ? Math.round(result.distanceKm * 1000) : null;
  const variantNames = variants.map((v) => `${v.name}(${v.line})`);

  // fusedSpeed prop을 null로 정규화해 buildGpsRows/buildDumpText 양쪽에서 동일 분기 사용.
  const fusedSpeedSignal: FusedSpeedSignal | null = fusedSpeed ?? null;

  const handleShare = useCallback(() => {
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
      logs,
      locklessOn,
      scheduledDump,
    });
    void Share.share({ message });
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
    logs,
    locklessOn,
    scheduledDump,
  ]);

  return (
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
          </Section>

          <Section title="Fusion" colors={colors}>
            <KeyValue label="confidence" value={confidence} colors={colors} />
            <KeyValue label="source" value={source} colors={colors} />
            <KeyValue label="fused" value={fusedLabel} colors={colors} />
            <KeyValue label="gps" value={gpsLabel} colors={colors} />
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
            {silentPushDiagRows(silentPush, logs, locklessOn).map(({ uiLabel, value }) => (
              <KeyValue key={uiLabel} label={uiLabel} value={value} colors={colors} />
            ))}
          </Section>

          <BoardingLockSection lock={lock} colors={colors} />

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

          <Section
            title={`Alarm log (${logs.length})`}
            colors={colors}
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
              <Text style={[styles.actionText, { color: colors.accent }]}>Clear log</Text>
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

/** 역방향(최신 → 오래된) 모노 로그 목록 섹션 — Estimator/Fusion 공통 패턴 (#1025). */
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
        [...logs].reverse().map((entry, idx) => (
          <MonoEntry key={`${entry.ts}-${idx}`} testID={entryTestId} colors={colors}>
            {formatLine(entry)}
          </MonoEntry>
        ))
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
          <KeyValue label="trainCode" value={lock.trainCode} colors={colors} />
          <KeyValue label="line" value={String(lock.boardingLine)} colors={colors} />
          <KeyValue
            label="expiresAt"
            value={formatAt(
              lock.boardedAt + lock.expectedDurationMs * 1.5,
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
  const allKeys = Object.keys(allCounts).sort();
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
}

function Section({ title, children, colors, action }: SectionProps) {
  return (
    <View style={[styles.section, { backgroundColor: colors.card }]}>
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
}: {
  label: string;
  value: string;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  return (
    <View style={styles.kvRow}>
      <Text style={[typography.mono, { color: colors.subtle, width: 80 }]}>{label}</Text>
      <Text style={[typography.mono, { color: colors.ink, flex: 1 }]} selectable>
        {value}
      </Text>
    </View>
  );
}

// Internal exports for tests — DO NOT use from app code.
export const __test__ = {
  formatLogLine,
  buildDumpText,
  buildGpsRows,
  formatFusionDebugLine,
  formatTokenTail,
  formatAt,
  formatSourceCountsLine,
  formatEstimatorLine,
  NO_FUSED_SIGNAL_LABEL,
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
    fontSize: 14,
  },
});
