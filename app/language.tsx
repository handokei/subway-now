import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Stack, useRouter } from 'expo-router';
import { useLocaleStore, type LocalePreference } from '../src/shared/i18n/store/useLocaleStore';
import { LANGUAGE_REGISTRY } from '../src/shared/i18n/types';
import { useTheme, spacing } from '../src/shared/theme';

export default function LanguageScreen() {
  const localePreference = useLocaleStore((s) => s.localePreference);
  const setLocalePreference = useLocaleStore((s) => s.setLocalePreference);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();

  const rows: readonly { value: LocalePreference; label: string }[] = [
    { value: 'auto', label: t('settings.languageAuto') },
    ...LANGUAGE_REGISTRY.map((lang) => ({ value: lang.code, label: lang.nativeName })),
  ];

  const handleSelect = (next: LocalePreference) => {
    setLocalePreference(next);
    router.back();
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: t('settings.languageSection'),
          headerBackTitle: t('tabs.settings'),
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.ink,
        }}
      />

      <ScrollView contentContainerStyle={styles.scroll}>
        <View
          style={[styles.card, { backgroundColor: colors.card }]}
          testID="locale-list"
          accessibilityRole="radiogroup"
        >
          {rows.map(({ value: rowValue, label: rowLabel }, index) => {
            const active = localePreference === rowValue;
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
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scroll: {
    paddingVertical: 24,
  },
  card: {
    borderRadius: 16,
    paddingHorizontal: 20,
    marginHorizontal: 24,
  },
  localeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 52,
    paddingVertical: spacing.sm,
  },
  localeRowLabel: {
    fontSize: 16,
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
