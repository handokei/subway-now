/**
 * SPIKE (throwaway, dev 미머지) — 가속도계 train-fingerprint 검증 로거 UI.
 *
 * DebugModal에 추가만 되는 섹션 — 기존 프로덕션 알람/fusion 경로는 건드리지 않는다.
 * 실기기에서: 거치위치/노선 라벨 입력 → 로깅 시작 → 탑승 → 정차/출발마다 MARK 탭 →
 * 로깅 종료(자동 export + share sheet).
 */
import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { spacing, radius, typography, useTheme } from '../../../shared/theme';
import {
  getSpikeLoggingCounts,
  isSpikeLoggingActive,
  markSpikeEvent,
  startSpikeLogging,
  stopSpikeLoggingAndExport,
  type SpikePlacement,
} from '../utils/accelSpikeLogger';

const PLACEMENTS: readonly SpikePlacement[] = ['pocket', 'hand', 'bag'];
/** UI 카운트 새로고침 주기 — logging 진행 중에만 tick. */
const COUNT_REFRESH_MS = 1000;

export function AccelSpikeLoggerSection() {
  const { colors } = useTheme();
  const [logging, setLogging] = useState(false);
  const [ride, setRide] = useState('');
  const [line, setLine] = useState('');
  const [placement, setPlacement] = useState<SpikePlacement>('pocket');
  const [counts, setCounts] = useState({ samples: 0, marks: 0 });
  const busyRef = useRef(false);

  useEffect(() => {
    if (!logging) return;
    const id = setInterval(() => setCounts(getSpikeLoggingCounts()), COUNT_REFRESH_MS);
    return () => clearInterval(id);
  }, [logging]);

  const handleToggle = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      if (isSpikeLoggingActive()) {
        const uri = await stopSpikeLoggingAndExport();
        setLogging(false);
        setCounts({ samples: 0, marks: 0 });
        try {
          await Share.share({ url: uri, message: uri });
        } catch {
          // graceful — share sheet 미지원/취소 시 Alert로 경로만 안내.
        }
        Alert.alert('SPIKE 로그 저장됨', uri);
      } else {
        startSpikeLogging({ ride: ride.trim() || '(unlabeled)', placement, line: line.trim() });
        setLogging(true);
        setCounts({ samples: 0, marks: 0 });
      }
    } finally {
      busyRef.current = false;
    }
  };

  return (
    <View style={[styles.section, { backgroundColor: colors.card }]} testID="debug-spike-logger-section">
      <Text style={[typography.label, { color: colors.muted, marginBottom: spacing.sm }]}>
        SPIKE — Accel Fingerprint Logger
      </Text>

      {!logging && (
        <>
          <TextInput
            value={ride}
            onChangeText={setRide}
            placeholder="ride label (예: 2호선 강남-역삼)"
            placeholderTextColor={colors.subtle}
            style={[typography.mono, styles.input, { color: colors.ink, borderColor: colors.subtle }]}
            testID="debug-spike-ride-input"
          />
          <TextInput
            value={line}
            onChangeText={setLine}
            placeholder="line (예: 2)"
            placeholderTextColor={colors.subtle}
            style={[typography.mono, styles.input, { color: colors.ink, borderColor: colors.subtle }]}
            testID="debug-spike-line-input"
          />
          <View style={styles.row}>
            {PLACEMENTS.map((p) => (
              <Pressable
                key={p}
                onPress={() => setPlacement(p)}
                style={[
                  styles.placementChip,
                  {
                    borderColor: colors.accent,
                    backgroundColor: placement === p ? colors.accent : 'transparent',
                  },
                ]}
                testID={`debug-spike-placement-${p}`}
              >
                <Text
                  style={[
                    typography.bodySm,
                    { color: placement === p ? colors.onAccent : colors.accent },
                  ]}
                >
                  {p}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      )}

      {logging && (
        <Text style={[typography.mono, { color: colors.ink, marginBottom: spacing.sm }]} testID="debug-spike-counts">
          {`samples=${counts.samples} marks=${counts.marks}`}
        </Text>
      )}

      <View style={styles.row}>
        <Pressable
          onPress={handleToggle}
          style={[
            styles.actionButton,
            { backgroundColor: logging ? colors.warn : colors.accent },
          ]}
          testID="debug-spike-toggle"
        >
          <Text style={[typography.bodySm, { color: colors.onAccent }]}>
            {logging ? 'SPIKE 로깅 종료' : 'SPIKE 로깅 시작'}
          </Text>
        </Pressable>
        {logging && (
          <>
            <Pressable
              onPress={() => markSpikeEvent('arrive')}
              style={[styles.actionButton, { backgroundColor: colors.accent }]}
              testID="debug-spike-mark-arrive"
            >
              <Text style={[typography.bodySm, { color: colors.onAccent }]}>MARK 도착</Text>
            </Pressable>
            <Pressable
              onPress={() => markSpikeEvent('depart')}
              style={[styles.actionButton, { backgroundColor: colors.accent }]}
              testID="debug-spike-mark-depart"
            >
              <Text style={[typography.bodySm, { color: colors.onAccent }]}>MARK 출발</Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    padding: spacing.lg,
    borderRadius: radius.md,
    marginBottom: spacing.md,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  placementChip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  actionButton: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
});
