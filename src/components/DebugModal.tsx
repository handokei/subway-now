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
import { useAppStore } from '../store/useAppStore';
import { useNearestStation } from '../hooks/useNearestStation';
import { useArrivalInfo } from '../hooks/useArrivalInfo';
import { clearAlarmLog, getAlarmLog, type AlarmLogEntry } from '../utils/alarmLog';
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
  return parts.join(' | ');
}

function buildDumpText(args: {
  userLocation: { lat: number; lng: number } | null;
  speedMps: number | null;
  nearestName: string | null;
  nearestDistanceM: number | null;
  variants: string[];
  arrivalSummary: string;
  isMock: boolean;
  logs: AlarmLogEntry[];
}): string {
  const lines: string[] = [];
  lines.push(`[Subway debug] ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## GPS');
  lines.push(
    args.userLocation
      ? `lat=${args.userLocation.lat}, lng=${args.userLocation.lng}, speed=${args.speedMps ?? '-'} m/s`
      : '(no location)',
  );
  lines.push('');
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
  lines.push('## Arrival');
  lines.push(args.arrivalSummary);
  if (args.isMock) lines.push('(MOCK)');
  lines.push('');
  lines.push(`## Alarm log (${args.logs.length})`);
  for (const entry of [...args.logs].reverse()) {
    lines.push(formatLogLine(entry));
  }
  return lines.join('\n');
}

interface DebugModalProps {
  onClose: () => void;
}

// 디버그 모달은 측정 인프라 — 관찰자 효과를 피하려고 모달이 열린 동안에만 마운트한다.
// useNearestStation이 별도 Location.watch 구독을 띄우므로, 닫혔을 땐 컴포넌트 자체를
// 마운트하지 않아 GPS·Arrival 폴링이 2배가 되지 않도록 한다. 호출부(_layout)에서
// `debugVisible &&` 조건부 렌더를 보장한다.
export function DebugModal({ onClose }: DebugModalProps) {
  if (!__DEV__) return null;
  return <DebugModalInner onClose={onClose} />;
}

function DebugModalInner({ onClose }: DebugModalProps) {
  const { colors } = useTheme();
  const { result, variants, userLocation, speedMps } = useNearestStation();
  const stationName = result?.station.name ?? null;
  const { arrival, isMock } = useArrivalInfo(stationName);
  const [logs, setLogs] = useState<AlarmLogEntry[]>([]);

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
      nearestName: result?.station.name ?? null,
      nearestDistanceM,
      variants: variantNames,
      arrivalSummary,
      isMock,
      logs,
    });
    void Share.share({ message });
  }, [userLocation, speedMps, result, nearestDistanceM, variantNames, arrivalSummary, isMock, logs]);

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} testID="debug-modal">
      <View style={[styles.container, { backgroundColor: colors.bg }]}>
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
              </>
            ) : (
              <Text style={[typography.mono, { color: colors.muted }]}>(no location)</Text>
            )}
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
              [...logs].reverse().map((entry, idx) => (
                <Text
                  key={`${entry.ts}-${idx}`}
                  style={[typography.mono, { color: colors.ink, marginBottom: 2 }]}
                  selectable
                >
                  {formatLogLine(entry)}
                </Text>
              ))
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
export const __test__ = { formatLogLine, buildDumpText };

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
