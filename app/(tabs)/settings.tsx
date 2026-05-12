import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { useAppStore, type ThemeMode, type LocalePreference } from '../../src/store/useAppStore';
import { ROUTE_CATEGORIES } from '../../src/utils/stationRoute';
import { LANGUAGE_REGISTRY } from '../../src/i18n/types';
import { useTheme, spacing, radius } from '../../src/theme';
import { useSleepModeGuide } from '../../src/hooks/useSleepModeGuide';
import {
  BG_DIAGNOSTIC_ROWS,
  clearBgDiagnostics,
  getBgDiagnostics,
  type BgDiagnostics,
} from '../../src/utils/bgDiagnostics';

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
  const localePreference = useAppStore((s) => s.localePreference);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const showSleepModeGuide = useSleepModeGuide();

  useEffect(() => {
    loadSleepMode();
    loadAllowSpeaker();
    loadRoutePreference();
  }, []);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.header, { color: colors.muted }]}>{t('settings.title')}</Text>

        <LocaleNavSetting
          sectionTitle={t('settings.languageSection')}
          label={t('settings.languageLabel')}
          description={t('settings.languageDescription')}
          autoLabel={t('settings.languageAuto')}
          value={localePreference}
          onPress={() => router.push('/language')}
        />

        <SegmentSetting
          sectionTitle={t('settings.themeSection')}
          label={t('settings.themeLabel')}
          description={t('settings.themeDescription')}
          testIDPrefix="theme"
          value={themeMode}
          onChange={setThemeMode}
          options={THEME_OPTIONS.map(({ value, labelKey }) => ({ value, label: t(labelKey) }))}
        />

        <SegmentSetting
          sectionTitle={t('settings.routeSection')}
          label={t('settings.routePreferenceLabel')}
          description={t('settings.routePreferenceDescription')}
          testIDPrefix="route"
          value={routePreference}
          onChange={setRoutePreference}
          options={ROUTE_CATEGORIES.map((c) => ({ value: c.key, label: t(`routes.${c.key}`) }))}
        />

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

        <BgDiagnosticsCard />
      </ScrollView>
    </SafeAreaView>
  );
}

// #275 진단 패널. 가설 격리 완료 후 제거 예정 — i18n 생략(임시 surface).
function BgDiagnosticsCard() {
  const { colors } = useTheme();
  const [snapshot, setSnapshot] = useState<BgDiagnostics | null>(null);

  const refresh = useCallback(async () => {
    setSnapshot(await getBgDiagnostics());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleClear = useCallback(() => {
    Alert.alert('진단 카운터 초기화', '카운터를 모두 0으로 되돌립니다.', [
      { text: '취소', style: 'cancel' },
      {
        text: '초기화',
        style: 'destructive',
        onPress: async () => {
          await clearBgDiagnostics();
          await refresh();
        },
      },
    ]);
  }, [refresh]);

  if (!snapshot) return null;

  const lastTs = snapshot.lastTaskFiredTs;
  const lastLabel = lastTs ? new Date(lastTs).toLocaleString() : '없음';

  return (
    <View style={[styles.card, { backgroundColor: colors.card }]}>
      <Text style={[styles.sectionTitle, { color: colors.muted }]}>진단 (#275)</Text>
      {BG_DIAGNOSTIC_ROWS.map(({ key, label }) => (
        <DiagRow key={key} label={label} value={String(snapshot[key])} colors={colors} />
      ))}
      <View style={[styles.diagRow, { borderTopWidth: 1, borderTopColor: colors.hair, marginTop: spacing.sm, paddingTop: spacing.sm }]}>
        <Text style={[styles.diagLabel, { color: colors.muted }]}>마지막 TASK FIRED</Text>
        <Text style={[styles.diagValue, { color: colors.muted }]}>{lastLabel}</Text>
      </View>
      <View style={styles.diagActions}>
        <DiagButton label="새로고침" onPress={() => void refresh()} colors={colors} />
        <DiagButton label="초기화" onPress={handleClear} colors={colors} />
      </View>
    </View>
  );
}

type DiagColors = { readonly ink: string; readonly muted: string; readonly hair: string };

function DiagRow({ label, value, colors }: { readonly label: string; readonly value: string; readonly colors: DiagColors }) {
  return (
    <View style={styles.diagRow}>
      <Text style={[styles.diagLabel, { color: colors.ink }]}>{label}</Text>
      <Text style={[styles.diagValue, { color: colors.muted }]}>{value}</Text>
    </View>
  );
}

function DiagButton({ label, onPress, colors }: { readonly label: string; readonly onPress: () => void; readonly colors: DiagColors }) {
  return (
    <Pressable
      style={[styles.diagButton, { borderColor: colors.hair }]}
      onPress={onPress}
      accessibilityRole="button"
    >
      <Text style={[styles.diagButtonText, { color: colors.ink }]}>{label}</Text>
    </Pressable>
  );
}

interface LocaleNavSettingProps {
  readonly sectionTitle: string;
  readonly label: string;
  readonly description: string;
  readonly autoLabel: string;
  readonly value: LocalePreference;
  readonly onPress: () => void;
}

function LocaleNavSetting({
  sectionTitle,
  label,
  description,
  autoLabel,
  value,
  onPress,
}: LocaleNavSettingProps) {
  const { colors } = useTheme();
  const { i18n } = useTranslation();

  const resolvedCode = i18n.language?.split('-')[0];
  const resolvedNativeName = LANGUAGE_REGISTRY.find((l) => l.code === resolvedCode)?.nativeName;
  const selectedNativeName = LANGUAGE_REGISTRY.find((l) => l.code === value)?.nativeName;
  const triggerText =
    value === 'auto'
      ? resolvedNativeName
        ? `${autoLabel} (${resolvedNativeName})`
        : autoLabel
      : (selectedNativeName ?? autoLabel);

  return (
    <View style={[styles.card, { backgroundColor: colors.card }]}>
      <Text style={[styles.sectionTitle, { color: colors.muted }]}>{sectionTitle}</Text>

      <View style={styles.settingRow}>
        <View style={styles.settingInfo}>
          <Text style={[styles.settingLabel, { color: colors.ink }]}>{label}</Text>
          <Text style={[styles.settingDesc, { color: colors.muted }]}>{description}</Text>
        </View>
      </View>

      <Pressable
        style={[styles.localeTrigger, { borderTopColor: colors.hair }]}
        onPress={onPress}
        testID="locale-trigger"
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${triggerText}`}
      >
        <Text style={[styles.localeTriggerValue, { color: colors.ink }]}>{triggerText}</Text>
        <Text style={[styles.localeChevron, { color: colors.muted }]}>›</Text>
      </Pressable>
    </View>
  );
}

interface SegmentSettingProps<T extends string> {
  readonly sectionTitle: string;
  readonly label: string;
  readonly description: string;
  readonly testIDPrefix: string;
  readonly value: T;
  readonly onChange: (next: T) => void;
  readonly options: readonly { value: T; label: string }[];
}

function SegmentSetting<T extends string>({
  sectionTitle,
  label,
  description,
  testIDPrefix,
  value,
  onChange,
  options,
}: SegmentSettingProps<T>) {
  const { colors } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: colors.card }]}>
      <Text style={[styles.sectionTitle, { color: colors.muted }]}>{sectionTitle}</Text>

      <View style={styles.settingRow}>
        <View style={styles.settingInfo}>
          <Text style={[styles.settingLabel, { color: colors.ink }]}>{label}</Text>
          <Text style={[styles.settingDesc, { color: colors.muted }]}>{description}</Text>
        </View>
      </View>

      <View style={[styles.segmentGroup, { backgroundColor: colors.hair }]} testID={`${testIDPrefix}-segment`}>
        {options.map(({ value: optionValue, label: optionLabel }) => {
          const active = value === optionValue;
          return (
            <Pressable
              key={optionValue}
              style={[styles.segment, active && { backgroundColor: colors.accent }]}
              onPress={() => onChange(optionValue)}
              testID={`${testIDPrefix}-${optionValue}`}
            >
              <Text style={[styles.segmentText, { color: active ? colors.onAccent : colors.muted }]}>
                {optionLabel}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scroll: {
    paddingBottom: 80,
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
  localeTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    paddingVertical: spacing.sm,
    marginTop: spacing.md,
    borderTopWidth: 1,
  },
  localeTriggerValue: {
    fontSize: 15,
    fontWeight: '500',
  },
  localeChevron: {
    fontSize: 20,
    marginLeft: spacing.sm,
  },
  diagRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  diagLabel: {
    fontSize: 13,
    flex: 1,
    marginRight: spacing.sm,
  },
  diagValue: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  diagActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  diagButton: {
    flex: 1,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  diagButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
});
