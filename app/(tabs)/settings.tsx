import { useEffect } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppStore, type ThemeMode } from '../../src/store/useAppStore';
import { useTheme, spacing, radius } from '../../src/theme';

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'auto', label: '자동' },
  { value: 'light', label: '라이트' },
  { value: 'dark', label: '다크' },
];

export default function SettingsScreen() {
  const sleepMode = useAppStore((s) => s.sleepMode);
  const setSleepMode = useAppStore((s) => s.setSleepMode);
  const loadSleepMode = useAppStore((s) => s.loadSleepMode);
  const themeMode = useAppStore((s) => s.themeMode);
  const setThemeMode = useAppStore((s) => s.setThemeMode);
  const loadThemeMode = useAppStore((s) => s.loadThemeMode);
  const { colors } = useTheme();

  useEffect(() => {
    loadSleepMode();
    loadThemeMode();
  }, []);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
      <Text style={[styles.header, { color: colors.muted }]}>설정</Text>

      {/* 테마 */}
      <View style={[styles.card, { backgroundColor: colors.card }]}>
        <Text style={[styles.sectionTitle, { color: colors.muted }]}>테마</Text>

        <View style={styles.settingRow}>
          <View style={styles.settingInfo}>
            <Text style={[styles.settingLabel, { color: colors.ink }]}>다크 모드</Text>
            <Text style={[styles.settingDesc, { color: colors.muted }]}>
              자동은 기기 설정을 따릅니다
            </Text>
          </View>
        </View>

        <View style={[styles.segmentGroup, { backgroundColor: colors.hair }]} testID="theme-segment">
          {THEME_OPTIONS.map(({ value, label }) => {
            const active = themeMode === value;
            return (
              <Pressable
                key={value}
                style={[styles.segment, active && { backgroundColor: colors.accent }]}
                onPress={() => setThemeMode(value)}
                testID={`theme-${value}`}
              >
                <Text style={[styles.segmentText, { color: active ? colors.onAccent : colors.muted }]}>
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* 알람 */}
      <View style={[styles.card, { backgroundColor: colors.card }]}>
        <Text style={[styles.sectionTitle, { color: colors.muted }]}>알람</Text>

        <View style={styles.settingRow}>
          <View style={styles.settingInfo}>
            <Text style={[styles.settingLabel, { color: colors.ink }]}>취침 모드</Text>
            <Text style={[styles.settingDesc, { color: colors.muted }]}>
              이어폰 연결 시 기상 알람음으로 울립니다
            </Text>
          </View>
          <Switch
            value={sleepMode}
            onValueChange={setSleepMode}
            trackColor={{ false: colors.hair, true: colors.accent }}
            thumbColor={sleepMode ? colors.onAccent : colors.subtle}
            testID="sleep-mode-switch"
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    fontSize: 14,
    letterSpacing: 2,
    textTransform: 'uppercase',
    padding: 24,
    paddingBottom: 16,
  },
  card: {
    borderRadius: 16,
    padding: 20,
    marginHorizontal: 24,
    marginBottom: spacing.lg,
  },
  sectionTitle: {
    fontSize: 14,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 16,
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  settingInfo: {
    flex: 1,
    marginRight: 16,
  },
  settingLabel: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  settingDesc: {
    fontSize: 13,
    lineHeight: 18,
  },
  segmentGroup: {
    flexDirection: 'row',
    borderRadius: radius.md,
    padding: 3,
    marginTop: spacing.md,
  },
  segment: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  segmentText: {
    fontSize: 13,
    fontWeight: '600',
  },
});
