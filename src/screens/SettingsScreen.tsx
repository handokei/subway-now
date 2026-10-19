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
import { useTheme, typography, spacing, radiusGlass, lineTint, useLineTintStore, shadowStyle } from '../shared/theme';
import { LineGlowBackground } from '../shared/ui/LineGlowBackground';
import { GLASS_SCREEN_BOTTOM_PADDING } from '../shared/ui/GlassTabBar';
import { useSleepModeGuide } from '../features/settings/hooks/useSleepModeGuide';
import { SleepModeSilentWarning } from '../features/settings/components/SleepModeSilentWarning';
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
  // #1038 follow-up — Sentry 오류 진단 정보 opt-in.
  const sentryOptIn = useSettingsStore((s) => s.sentryOptIn);
  const setSentryOptIn = useSettingsStore((s) => s.setSentryOptIn);
  const loadSentryOptIn = useSettingsStore((s) => s.loadSentryOptIn);
  const themeMode = useThemeStore((s) => s.themeMode);
  const setThemeMode = useThemeStore((s) => s.setThemeMode);
  const routePreference = useDestinationStore((s) => s.routePreference);
  const setRoutePreference = useDestinationStore((s) => s.setRoutePreference);
  const loadRoutePreference = useDestinationStore((s) => s.loadRoutePreference);
  const localePreference = useLocaleStore((s) => s.localePreference);
  const { colors, isDark } = useTheme();
  const tint = lineTint(useLineTintStore((st) => st.line), isDark);
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
    loadSentryOptIn();
  }, []);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
      <LineGlowBackground />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.header, { color: colors.ink }]}>{t('settings.title')}</Text>

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
        <View style={[styles.card, { backgroundColor: colors.glass, borderColor: colors.glassBorder }]}>
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
              trackColor={{ false: colors.hair, true: tint.base }}
              thumbColor="#ffffff"
              testID="sleep-mode-switch"
              accessibilityRole="switch"
              accessibilityLabel={t('settings.sleepModeLabel')}
              accessibilityHint={t('a11y.settings.sleepModeHint')}
              accessibilityState={{ checked: sleepMode }}
            />
          </View>

          <SleepModeSilentWarning visible={sleepMode} />

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
              trackColor={{ false: colors.hair, true: tint.base }}
              thumbColor="#ffffff"
              testID="allow-speaker-switch"
              accessibilityRole="switch"
              accessibilityLabel={t('settings.speakerOutputLabel')}
              accessibilityHint={t('a11y.settings.speakerOutputHint')}
              accessibilityState={{ checked: allowSpeaker }}
            />
          </View>

        </View>

        {/* 접근성 — 알람 카드 아래에 배치. E2E smoke flow의 sleep-mode-switch 가시성을 깨지 않기 위함. */}
        <View style={[styles.card, { backgroundColor: colors.glass, borderColor: colors.glassBorder }]}>
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
              trackColor={{ false: colors.hair, true: tint.base }}
              thumbColor="#ffffff"
              testID="accessibility-mode-switch"
              accessibilityRole="switch"
              accessibilityLabel={t('settings.accessibilityModeLabel')}
              accessibilityHint={t('a11y.settings.accessibilityModeHint')}
              accessibilityState={{ checked: accessibilityMode }}
            />
          </View>
        </View>

        {/* #1038 follow-up — Sentry 오류 진단 정보 opt-in. 기본 OFF. */}
        <View style={[styles.card, { backgroundColor: colors.glass, borderColor: colors.glassBorder }]}>
          <Text style={[styles.sectionTitle, { color: colors.muted }]}>
            {t('settings.privacySection')}
          </Text>
          <View style={styles.settingRow}>
            <View style={styles.settingInfo}>
              <Text style={[styles.settingLabel, { color: colors.ink }]}>
                {t('settings.sentryOptInLabel')}
              </Text>
              <Text style={[styles.settingDesc, { color: colors.muted }]}>
                {t('settings.sentryOptInDescription')}
              </Text>
            </View>
            <Switch
              value={sentryOptIn}
              onValueChange={setSentryOptIn}
              trackColor={{ false: colors.hair, true: tint.base }}
              thumbColor="#ffffff"
              testID="sentry-opt-in-switch"
              accessibilityRole="switch"
              accessibilityLabel={t('settings.sentryOptInLabel')}
              accessibilityHint={t('a11y.settings.sentryOptInHint')}
              accessibilityState={{ checked: sentryOptIn }}
            />
          </View>
        </View>

        {/* #1034 — 버그 신고 진입점. Pressable 1줄로 모달 open. */}
        <View style={[styles.card, { backgroundColor: colors.glass, borderColor: colors.glassBorder }]}>
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
  const { t } = useTranslation();
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
      accessibilityRole="button"
      accessibilityLabel={t('a11y.settings.versionFooterLabel', { version })}
      accessibilityHint={isDebugModalEnabled() ? t('a11y.settings.versionFooterHint') : undefined}
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
    <View style={[styles.card, { backgroundColor: colors.glass, borderColor: colors.glassBorder }]}>
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
  const { colors, isDark } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: colors.glass, borderColor: colors.glassBorder }]}>
      <Text style={[styles.sectionTitle, { color: colors.muted }]}>{sectionTitle}</Text>

      <View style={styles.settingRow}>
        <View style={styles.settingInfo}>
          <Text style={[styles.settingLabel, { color: colors.ink }]}>{label}</Text>
          <Text style={[styles.settingDesc, { color: colors.muted }]}>{description}</Text>
        </View>
      </View>

      <View style={[styles.segmentGroup, { backgroundColor: colors.segmentTrack }]} testID={`${testIDPrefix}-segment`}>
        {options.map(({ value: optionValue, label: optionLabel }) => {
          const active = value === optionValue;
          return (
            <Pressable
              key={optionValue}
              style={[styles.segment, active && { backgroundColor: colors.segmentActive, ...shadowStyle('segment', isDark) }]}
              onPress={() => onChange(optionValue)}
              testID={`${testIDPrefix}-${optionValue}`}
              accessibilityRole="radio"
              accessibilityLabel={optionLabel}
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.segmentText, { color: active ? colors.ink : colors.muted, fontWeight: active ? '700' : '600' }]}>
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
    paddingBottom: GLASS_SCREEN_BOTTOM_PADDING,
  },
  header: {
    ...typography.screen,
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 12,
  },
  card: {
    borderRadius: radiusGlass.lg,
    borderWidth: 1,
    paddingHorizontal: 18,
    paddingVertical: 16,
    marginHorizontal: 14,
    marginBottom: 10,
  },
  sectionTitle: {
    ...typography.label,
    marginBottom: 8,
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
    ...typography.bodyBase,
    fontWeight: '600',
    marginBottom: 2,
  },
  settingDesc: {
    ...typography.captionSm,
    lineHeight: 17,
  },
  segmentGroup: {
    flexDirection: 'row',
    borderRadius: radiusGlass.md,
    padding: 4,
    marginTop: spacing.md,
  },
  segment: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: radiusGlass.sm,
    alignItems: 'center',
  },
  segmentText: {
    ...typography.caption,
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
    ...typography.bodyBase,
    fontWeight: '500',
  },
  localeChevron: {
    ...typography.titleXs,
    marginLeft: spacing.sm,
  },
  versionFooter: {
    alignItems: 'center',
    paddingVertical: spacing.lg,
    marginTop: spacing.md,
  },
  versionText: {
    ...typography.captionSm,
    letterSpacing: 0.5,
  },
});
