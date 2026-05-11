import { useEffect } from 'react';
import { Alert, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useAppStore, type ThemeMode } from '../../src/store/useAppStore';
import { ROUTE_CATEGORIES } from '../../src/utils/stationRoute';
import { useTheme, spacing, radius } from '../../src/theme';
import { useSleepModeGuide } from '../../src/hooks/useSleepModeGuide';

const THEME_OPTIONS = [
  { value: 'auto', labelKey: 'settings.themeAuto' },
  { value: 'light', labelKey: 'settings.themeLight' },
  { value: 'dark', labelKey: 'settings.themeDark' },
] as const satisfies readonly { value: ThemeMode; labelKey: string }[];

export default function SettingsScreen() {
  const sleepMode = useAppStore((s) => s.sleepMode);
  const setSleepMode = useAppStore((s) => s.setSleepMode);
  const loadSleepMode = useAppStore((s) => s.loadSleepMode);
  const allowSpeaker = useAppStore((s) => s.allowSpeaker);
  const setAllowSpeaker = useAppStore((s) => s.setAllowSpeaker);
  const loadAllowSpeaker = useAppStore((s) => s.loadAllowSpeaker);
  const themeMode = useAppStore((s) => s.themeMode);
  const setThemeMode = useAppStore((s) => s.setThemeMode);
  const routePreference = useAppStore((s) => s.routePreference);
  const setRoutePreference = useAppStore((s) => s.setRoutePreference);
  const loadRoutePreference = useAppStore((s) => s.loadRoutePreference);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const showSleepModeGuide = useSleepModeGuide();

  useEffect(() => {
    loadSleepMode();
    loadAllowSpeaker();
    loadRoutePreference();
  }, []);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
      <Text style={[styles.header, { color: colors.muted }]}>{t('settings.title')}</Text>

      {/* 테마 */}
      <View style={[styles.card, { backgroundColor: colors.card }]}>
        <Text style={[styles.sectionTitle, { color: colors.muted }]}>{t('settings.themeSection')}</Text>

        <View style={styles.settingRow}>
          <View style={styles.settingInfo}>
            <Text style={[styles.settingLabel, { color: colors.ink }]}>{t('settings.themeLabel')}</Text>
            <Text style={[styles.settingDesc, { color: colors.muted }]}>
              {t('settings.themeDescription')}
            </Text>
          </View>
        </View>

        <View style={[styles.segmentGroup, { backgroundColor: colors.hair }]} testID="theme-segment">
          {THEME_OPTIONS.map(({ value, labelKey }) => {
            const active = themeMode === value;
            return (
              <Pressable
                key={value}
                style={[styles.segment, active && { backgroundColor: colors.accent }]}
                onPress={() => setThemeMode(value)}
                testID={`theme-${value}`}
              >
                <Text style={[styles.segmentText, { color: active ? colors.onAccent : colors.muted }]}>
                  {t(labelKey)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* 경로 */}
      <View style={[styles.card, { backgroundColor: colors.card }]}>
        <Text style={[styles.sectionTitle, { color: colors.muted }]}>{t('settings.routeSection')}</Text>

        <View style={styles.settingRow}>
          <View style={styles.settingInfo}>
            <Text style={[styles.settingLabel, { color: colors.ink }]}>{t('settings.routePreferenceLabel')}</Text>
            <Text style={[styles.settingDesc, { color: colors.muted }]}>
              {t('settings.routePreferenceDescription')}
            </Text>
          </View>
        </View>

        <View style={[styles.segmentGroup, { backgroundColor: colors.hair }]} testID="route-segment">
          {ROUTE_CATEGORIES.map((category) => {
            const active = routePreference === category.key;
            return (
              <Pressable
                key={category.key}
                style={[styles.segment, active && { backgroundColor: colors.accent }]}
                onPress={() => setRoutePreference(category.key)}
                testID={`route-${category.key}`}
              >
                <Text style={[styles.segmentText, { color: active ? colors.onAccent : colors.muted }]}>
                  {t(`routes.${category.key}`)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* 알람 */}
      <View style={[styles.card, { backgroundColor: colors.card }]}>
        <Text style={[styles.sectionTitle, { color: colors.muted }]}>{t('settings.alarmSection')}</Text>

        <View style={styles.settingRow}>
          <View style={styles.settingInfo}>
            <Text style={[styles.settingLabel, { color: colors.ink }]}>{t('settings.sleepModeLabel')}</Text>
            <Text style={[styles.settingDesc, { color: colors.muted }]}>
              {t('settings.sleepModeDescription')}
            </Text>
          </View>
          <Switch
            value={sleepMode}
            onValueChange={(value) => {
              if (value) {
                showSleepModeGuide(() => setSleepMode(true));
              } else {
                setSleepMode(false);
              }
            }}
            trackColor={{ false: colors.hair, true: colors.accent }}
            thumbColor={sleepMode ? colors.onAccent : colors.subtle}
            testID="sleep-mode-switch"
          />
        </View>

        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: colors.hair }]}>
          <View style={styles.settingInfo}>
            <Text style={[styles.settingLabel, { color: colors.ink }]}>{t('settings.speakerOutputLabel')}</Text>
            <Text style={[styles.settingDesc, { color: colors.muted }]}>
              {t('settings.speakerOutputDescription')}
            </Text>
          </View>
          <Switch
            value={allowSpeaker}
            onValueChange={(value) => {
              if (!value) {
                Alert.alert(
                  t('settings.speakerOffTitle'),
                  t('settings.speakerOffMessage'),
                  [
                    { text: t('common.cancel'), style: 'cancel' },
                    { text: t('settings.speakerOffConfirm'), style: 'destructive', onPress: () => setAllowSpeaker(false) },
                  ],
                );
              } else {
                setAllowSpeaker(true);
              }
            }}
            trackColor={{ false: colors.hair, true: colors.accent }}
            thumbColor={allowSpeaker ? colors.onAccent : colors.subtle}
            testID="allow-speaker-switch"
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
