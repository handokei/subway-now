import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { useSettingsStore } from '../features/settings/store/useSettingsStore';
import { useDestinationStore } from '../features/route/store/useDestinationStore';
import { useDebugStore } from '../features/debug/store/useDebugStore';
import { useThemeStore, type ThemeMode } from '../shared/theme/store/useThemeStore';
import { useLocaleStore, type LocalePreference } from '../shared/i18n/store/useLocaleStore';
import { ROUTE_CATEGORIES } from '../shared/utils/stationRoute';
import { LANGUAGE_REGISTRY } from '../shared/i18n/types';
import { useTheme, spacing, radius } from '../shared/theme';
import { useSleepModeGuide } from '../features/settings/hooks/useSleepModeGuide';
import { FeedbackModal } from '../features/feedback/components/FeedbackModal';
import {
  DEBUG_MODAL_TRIGGER_RESET_MS,
  DEBUG_MODAL_TRIGGER_TAP_COUNT,
  isDebugModalEnabled,
} from '../shared/constants/debugFlags';

const THEME_OPTIONS = [
  { value: 'auto', labelKey: 'settings.themeAuto' },
  { value: 'light', labelKey: 'settings.themeLight' },
  { value: 'dark', labelKey: 'settings.themeDark' },
] as const satisfies readonly { value: ThemeMode; labelKey: string }[];

export default function SettingsScreen() {
  const sleepMode = useSettingsStore((s) => s.sleepMode);
  const setSleepMode = useSettingsStore((s) => s.setSleepMode);
  const loadSleepMode = useSettingsStore((s) => s.loadSleepMode);
  const allowSpeaker = useSettingsStore((s) => s.allowSpeaker);
  const setAllowSpeaker = useSettingsStore((s) => s.setAllowSpeaker);
  const loadAllowSpeaker = useSettingsStore((s) => s.loadAllowSpeaker);
  const accessibilityMode = useSettingsStore((s) => s.accessibilityMode);
  const setAccessibilityMode = useSettingsStore((s) => s.setAccessibilityMode);
  const loadAccessibilityMode = useSettingsStore((s) => s.loadAccessibilityMode);
  // #816 C — lockless station-passed opt-in 토글.
  const locklessStationPassed = useSettingsStore((s) => s.locklessStationPassed);
  const setLocklessStationPassed = useSettingsStore((s) => s.setLocklessStationPassed);
  const loadLocklessStationPassed = useSettingsStore((s) => s.loadLocklessStationPassed);
  const themeMode = useThemeStore((s) => s.themeMode);
  const setThemeMode = useThemeStore((s) => s.setThemeMode);
  const routePreference = useDestinationStore((s) => s.routePreference);
  const setRoutePreference = useDestinationStore((s) => s.setRoutePreference);
  const loadRoutePreference = useDestinationStore((s) => s.loadRoutePreference);
  const localePreference = useLocaleStore((s) => s.localePreference);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const showSleepModeGuide = useSleepModeGuide();
  // #1034 — 버그 신고 모달 (Cloudflare KV FEEDBACK + POST /feedback).
  const [feedbackVisible, setFeedbackVisible] = useState(false);

  useEffect(() => {
    loadSleepMode();
    loadAllowSpeaker();
    loadAccessibilityMode();
    loadRoutePreference();
    loadLocklessStationPassed();
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

          {/* #816 C — lockless station-passed opt-in. 기본 OFF + 명시 동의 후에만 lock 없는 trip의 station-passed 발사. */}
          <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: colors.hair }]}>
            <View style={styles.settingInfo}>
              <Text style={[styles.settingLabel, { color: colors.ink }]}>{t('settings.locklessStationPassedLabel')}</Text>
              <Text style={[styles.settingDesc, { color: colors.muted }]}>
                {t('settings.locklessStationPassedDescription')}
              </Text>
            </View>
            <Switch
              value={locklessStationPassed}
              onValueChange={setLocklessStationPassed}
              trackColor={{ false: colors.hair, true: colors.accent }}
              thumbColor={locklessStationPassed ? colors.onAccent : colors.subtle}
              testID="lockless-station-passed-switch"
            />
          </View>
        </View>

        {/* 접근성 — 알람 카드 아래에 배치. E2E smoke flow의 sleep-mode-switch 가시성을 깨지 않기 위함. */}
        <View style={[styles.card, { backgroundColor: colors.card }]}>
          <Text style={[styles.sectionTitle, { color: colors.muted }]}>{t('settings.accessibilitySection')}</Text>

          <View style={styles.settingRow}>
            <View style={styles.settingInfo}>
              <Text style={[styles.settingLabel, { color: colors.ink }]}>{t('settings.accessibilityModeLabel')}</Text>
              <Text style={[styles.settingDesc, { color: colors.muted }]}>
                {t('settings.accessibilityModeDescription')}
              </Text>
            </View>
            <Switch
              value={accessibilityMode}
              onValueChange={setAccessibilityMode}
              trackColor={{ false: colors.hair, true: colors.accent }}
              thumbColor={accessibilityMode ? colors.onAccent : colors.subtle}
              testID="accessibility-mode-switch"
            />
          </View>
        </View>

        {/* #1034 — 버그 신고 진입점. Pressable 1줄로 모달 open. */}
        <View style={[styles.card, { backgroundColor: colors.card }]}>
          <Text style={[styles.sectionTitle, { color: colors.muted }]}>
            {t('settings.feedbackSection')}
          </Text>
          <Pressable
            style={styles.settingRow}
            onPress={() => setFeedbackVisible(true)}
            testID="feedback-entry"
            accessibilityRole="button"
            accessibilityLabel={t('settings.feedbackLabel')}
          >
            <View style={styles.settingInfo}>
              <Text style={[styles.settingLabel, { color: colors.ink }]}>
                {t('settings.feedbackLabel')}
              </Text>
              <Text style={[styles.settingDesc, { color: colors.muted }]}>
                {t('settings.feedbackDescription')}
              </Text>
            </View>
            <Text style={[styles.localeChevron, { color: colors.muted }]}>›</Text>
          </Pressable>
        </View>

        <VersionFooter />
      </ScrollView>
      <FeedbackModal
        visible={feedbackVisible}
        onClose={() => setFeedbackVisible(false)}
      />
    </SafeAreaView>
  );
}

function VersionFooter() {
  const { colors } = useTheme();
  const tapCountRef = useRef(0);
  const lastTapAtRef = useRef(0);
  const setDebugVisible = useDebugStore((s) => s.setDebugVisible);
  const version = Constants.expoConfig?.version ?? '-';

  const handlePress = () => {
    if (!isDebugModalEnabled()) return;
    const now = Date.now();
    // 탭 간격 RESET_MS 초과 시 새 시퀀스 — 우발 누적 트리거 방지(Android 컨벤션).
    tapCountRef.current =
      now - lastTapAtRef.current > DEBUG_MODAL_TRIGGER_RESET_MS
        ? 1
        : tapCountRef.current + 1;
    lastTapAtRef.current = now;
    if (tapCountRef.current >= DEBUG_MODAL_TRIGGER_TAP_COUNT) {
      tapCountRef.current = 0;
      setDebugVisible(true);
    }
  };

  return (
    <Pressable
      onPress={handlePress}
      style={styles.versionFooter}
      testID="settings-version-footer"
    >
      <Text style={[styles.versionText, { color: colors.muted }]}>v{version}</Text>
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
  versionFooter: {
    alignItems: 'center',
    paddingVertical: spacing.lg,
    marginTop: spacing.md,
  },
  versionText: {
    fontSize: 12,
    letterSpacing: 0.5,
  },
});
