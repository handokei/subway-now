import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useAppStore, type ThemeMode, type LocalePreference } from '../../src/store/useAppStore';
import { ROUTE_CATEGORIES } from '../../src/utils/stationRoute';
import { LANGUAGE_REGISTRY } from '../../src/i18n/types';
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
  const localePreference = useAppStore((s) => s.localePreference);
  const setLocalePreference = useAppStore((s) => s.setLocalePreference);
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
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.header, { color: colors.muted }]}>{t('settings.title')}</Text>

        <LocaleListSetting
          sectionTitle={t('settings.languageSection')}
          label={t('settings.languageLabel')}
          description={t('settings.languageDescription')}
          autoLabel={t('settings.languageAuto')}
          value={localePreference}
          onChange={setLocalePreference}
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
      </ScrollView>
    </SafeAreaView>
  );
}

interface LocaleListSettingProps {
  readonly sectionTitle: string;
  readonly label: string;
  readonly description: string;
  readonly autoLabel: string;
  readonly value: LocalePreference;
  readonly onChange: (next: LocalePreference) => void;
}

function LocaleListSetting({
  sectionTitle,
  label,
  description,
  autoLabel,
  value,
  onChange,
}: LocaleListSettingProps) {
  const { colors } = useTheme();
  const { i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const rows: readonly { value: LocalePreference; label: string }[] = [
    { value: 'auto', label: autoLabel },
    ...LANGUAGE_REGISTRY.map((lang) => ({ value: lang.code, label: lang.nativeName })),
  ];

  const resolvedCode = i18n.language?.split('-')[0];
  const resolvedNativeName = LANGUAGE_REGISTRY.find((l) => l.code === resolvedCode)?.nativeName;
  const triggerText =
    value === 'auto'
      ? resolvedNativeName
        ? `${autoLabel} (${resolvedNativeName})`
        : autoLabel
      : (rows.find((r) => r.value === value)?.label ?? autoLabel);

  const handleSelect = (next: LocalePreference) => {
    onChange(next);
    setExpanded(false);
  };

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
        onPress={() => setExpanded((v) => !v)}
        testID="locale-trigger"
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${triggerText}`}
        accessibilityState={{ expanded }}
      >
        <Text style={[styles.localeTriggerValue, { color: colors.ink }]}>{triggerText}</Text>
        <Text style={[styles.localeChevron, { color: colors.muted }]}>{expanded ? '▴' : '▾'}</Text>
      </Pressable>

      {expanded && (
        <View
          style={[styles.localeList, { borderTopColor: colors.hair }]}
          testID="locale-list"
          accessibilityRole="radiogroup"
        >
          {rows.map(({ value: rowValue, label: rowLabel }, index) => {
            const active = value === rowValue;
            return (
              <Pressable
                key={rowValue}
                style={[
                  styles.localeRow,
                  index > 0 && { borderTopWidth: 1, borderTopColor: colors.hair },
                ]}
                onPress={() => handleSelect(rowValue)}
                testID={`locale-row-${rowValue}`}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
              >
                <Text style={[styles.localeRowLabel, { color: active ? colors.ink : colors.muted }]}>
                  {rowLabel}
                </Text>
                <View
                  style={[
                    styles.localeRadio,
                    { borderColor: active ? colors.accent : colors.hair },
                    active && { backgroundColor: colors.accent },
                  ]}
                >
                  {active && <View style={[styles.localeRadioDot, { backgroundColor: colors.onAccent }]} />}
                </View>
              </Pressable>
            );
          })}
        </View>
      )}
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
    fontSize: 14,
    marginLeft: spacing.sm,
  },
  localeList: {
    borderTopWidth: 1,
  },
  localeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    paddingVertical: spacing.sm,
  },
  localeRowLabel: {
    fontSize: 15,
    fontWeight: '500',
  },
  localeRadio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  localeRadioDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
