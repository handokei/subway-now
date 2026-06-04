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
import { useAppStore } from '../store/useAppStore';
import { isDebugModalEnabled } from '../constants/debugFlags';
import type { GpsActiveState } from '../constants/gpsStatus';
import { formatClockTimeWithSeconds } from '../utils/formatTime';
import { useFusedNearestStation } from '../hooks/useFusedNearestStation';
import { useArrivalInfo } from '../hooks/useArrivalInfo';
import {
  useSilentPushDiagnostics,
  type SilentPushDiagnostics,
} from '../hooks/useSilentPushDiagnostics';
import {
  clearAlarmLog,
  getAlarmLog,
  summarizeAlarmLogBySource,
  type AlarmLogEntry,
} from '../utils/alarmLog';
import {
  clearFusionDebugEntries,
  getFusionDebugEntries,
  subscribeFusionDebug,
  type FusionDebugEntry,
} from '../utils/fusionDebugBuffer';
import {
  dumpScheduledNotifications,
  formatScheduledNotificationLine,
  type ScheduledNotificationDumpEntry,
} from '../utils/scheduledNotificationsDump';
import type { FusionConfidence, FusionSource } from '../utils/pickFusedStation';
import type { NearestStationResult } from '../types/station';
import { useTheme, spacing, radius, typography } from '../theme';

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
 */
function silentPushDiagRows(
  d: SilentPushDiagnostics,
): { uiLabel: string; dumpKey: string; value: string }[] {
  const task = d.taskRegistrationError
    ? `${d.taskRegistrationState} (${d.taskRegistrationError})`
    : d.taskRegistrationState;
  return [
    { uiLabel: 'permission', dumpKey: 'permission', value: d.permissionStatus ?? '(unknown)' },
    { uiLabel: 'apnsToken', dumpKey: 'apnsToken', value: formatTokenTail(d.apnsToken) },
    { uiLabel: 'activeTrip', dumpKey: 'activeTrip', value: formatTokenTail(d.activeTripToken) },
    { uiLabel: 'apnsEnv', dumpKey: 'apnsEnv', value: d.apnsEnv },
    { uiLabel: 'task', dumpKey: 'taskRegistration', value: task },
    { uiLabel: 'route', dumpKey: 'route', value: d.hasRoute ? 'set' : '(none)' },
    { uiLabel: 'dest', dumpKey: 'destination', value: d.destinationId ?? '(none)' },
    { uiLabel: 'currStn', dumpKey: 'currentStation', value: d.lastNotifiedStationId ?? '(none)' },
    { uiLabel: 'lastRecv', dumpKey: 'lastReceived', value: formatAt(d.lastReceivedAt) },
    { uiLabel: 'lastFired', dumpKey: 'lastFired', value: formatAt(d.lastFiredAt) },
    { uiLabel: 'lastSkip', dumpKey: 'lastSkipped', value: formatAt(d.lastSkippedAt) },
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

function buildDumpText(args: {
  userLocation: { lat: number; lng: number } | null;
  speedMps: number | null;
  accuracyMeters: number | null;
  // #852: GPS watch 구독 상태(FG/BG) + 마지막 신뢰 fix 시각. silent push wake 시 stale window 진단용.
  // 호환을 위해 optional — 미전달 시 'fg' / null로 fallback (한 번도 fix 없는 상태와 동일 표기).
  gpsActive?: GpsActiveState;
  lastFixAtMs?: number | null;
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
  // #756: OS 큐 dump. 미전달/null = DebugModal에서 한 번도 Refresh 안 한 상태.
  scheduledDump?: ScheduledNotificationDumpEntry[] | null;
}): string {
  const lines: string[] = [];
  lines.push(`[Subway debug] ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## GPS');
  lines.push(
    args.userLocation
      ? `lat=${args.userLocation.lat}, lng=${args.userLocation.lng}, speed=${args.speedMps ?? '-'} m/s, accuracy=${args.accuracyMeters ?? '-'} m`
      : '(no location)',
  );
  // #852: watch 구독 상태 + 마지막 fix 시각. 'bg'면 watch가 정지된 상태(silent push wake 등).
  // 호출자 호환을 위해 optional — 미전달 시 'fg'/(never)로 표기.
  lines.push(
    `state=${args.gpsActive ?? 'fg'}, lastFix=${formatClockTimeWithSeconds(args.lastFixAtMs ?? null)}`,
    '',
  );
  lines.push('## Nearest');
  lines.push(
    args.nearestName
      ? `${args.nearestName} · ${args.nearestDistanceM ?? '-'} m`
      : '(no nearest station)',
  );
  if (args.variants.length > 0) {
    lines.push(`variants: ${args.variants.join(', ')}`);
  }
  lines.push('');
  lines.push('## Fusion');
  lines.push(`confidence=${args.fusion.confidence}, source=${args.fusion.source}`);
  lines.push(`fused: ${args.fusion.fusedLabel}`);
  lines.push(`gps:   ${args.fusion.gpsLabel}`);
  if (args.fusion.differs) lines.push('(fused != gps)');
  if (args.fusion.candidateTrains) {
    lines.push(
      `candidateTrains(${args.fusion.candidateTrains.length}): ${args.fusion.candidateTrains.join(', ') || '-'}`,
    );
  }
  lines.push('');
  lines.push('## Arrival');
  lines.push(args.arrivalSummary);
  if (args.isMock) lines.push('(MOCK)');
  lines.push('');
  lines.push('## Silent Push');
  for (const { dumpKey, value } of silentPushDiagRows(args.silentPush)) {
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

function DebugModalInner({ onClose, candidateTrains }: DebugModalProps) {
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
  const fusedLabel = formatStationLabel(result);
  const gpsLabel = formatStationLabel(gpsResult);
  const differs = fusedDiffersFromGps(result, gpsResult);
  const [logs, setLogs] = useState<AlarmLogEntry[]>([]);
  const [fusionLogs, setFusionLogs] = useState<readonly FusionDebugEntry[]>(() =>
    getFusionDebugEntries(),
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

  const handleShare = useCallback(() => {
    const message = buildDumpText({
      userLocation,
      speedMps,
      accuracyMeters,
      // #852: hook이 신규 필드를 미지원하던 시점 호환 — undefined면 'fg'/null로 fallback.
      gpsActive: gpsActive ?? 'fg',
      lastFixAtMs: lastFixAtMs ?? null,
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
      scheduledDump,
    });
    void Share.share({ message });
  }, [
    userLocation,
    speedMps,
    accuracyMeters,
    gpsActive,
    lastFixAtMs,
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
              <>
                <KeyValue label="lat" value={String(userLocation.lat)} colors={colors} />
                <KeyValue label="lng" value={String(userLocation.lng)} colors={colors} />
                <KeyValue
                  label="speed"
                  value={speedMps != null ? `${speedMps.toFixed(2)} m/s` : '-'}
                  colors={colors}
                />
                <KeyValue
                  label="accuracy"
                  value={accuracyMeters != null ? `${accuracyMeters.toFixed(0)} m` : '-'}
                  colors={colors}
                />
              </>
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
            {silentPushDiagRows(silentPush).map(({ uiLabel, value }) => (
              <KeyValue key={uiLabel} label={uiLabel} value={value} colors={colors} />
            ))}
          </Section>

          <Section
            title={`Fusion log (${fusionLogs.length})`}
            colors={colors}
            action={
              <Pressable
                onPress={() => {
                  clearFusionDebugEntries();
                  setFusionLogs([]);
                }}
                testID="debug-fusion-log-clear"
              >
                <Text style={[typography.bodySm, { color: colors.accent }]}>Clear</Text>
              </Pressable>
            }
          >
            {fusionLogs.length === 0 ? (
              <Text style={[typography.mono, { color: colors.muted }]}>(empty)</Text>
            ) : (
              [...fusionLogs].reverse().map((entry, idx) => (
                <Text
                  key={`${entry.ts}-${idx}`}
                  style={[typography.mono, { color: colors.ink, marginBottom: 2 }]}
                  selectable
                  testID="debug-fusion-log-entry"
                >
                  {formatFusionDebugLine(entry)}
                </Text>
              ))
            )}
          </Section>

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
                  <Text
                    key={`${entry.ts}-${idx}`}
                    style={[typography.mono, { color: colors.ink, marginBottom: 2 }]}
                    selectable
                  >
                    {formatLogLine(entry)}
                  </Text>
                ))}
              </>
            )}
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
        <Text
          key={entry.identifier}
          style={[typography.mono, { color: colors.ink, marginBottom: 2 }]}
          selectable
          testID="debug-scheduled-dump-entry"
        >
          {formatScheduledNotificationLine(entry)}
        </Text>
      ))}
    </>
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
  formatFusionDebugLine,
  formatTokenTail,
  formatAt,
  formatSourceCountsLine,
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
