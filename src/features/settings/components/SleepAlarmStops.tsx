import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, typography, spacing, radiusGlass } from '../../../shared/theme';
import {
  SLEEP_ALARM_MIN_STOPS_BEFORE,
  SLEEP_ALARM_MODES,
  type SleepAlarmMode,
} from '../../../shared/constants/sleepAlarm';
import { sleepAlarmStopOptions } from '../../../shared/utils/sleepAlarmCells';
import { useSettingsStore } from '../store/useSettingsStore';

/** 저장값이 없을 때(= 기본값) 화면에 보이는 방식. 저장 스키마는 기본값을 필드로 두지 않는다. */
const DEFAULT_MODE: SleepAlarmMode = 'selected';

const MODE_LABEL_KEYS = {
  every: 'settings.sleepAlarmModeEvery',
  selected: 'settings.sleepAlarmModeSelected',
} as const satisfies Record<SleepAlarmMode, string>;

interface Props {
  /** 취침 모드가 꺼진 동안 true — 컨트롤을 잠그고 저장값은 건드리지 않는다. */
  disabled?: boolean;
}

/**
 * #3100 PR-5 — 취침 알람 "N역 전부터" 설정. 행 = `sleepAlarmStopOptions()`(상수 파생).
 *  - 선택한 역에서만: 체크박스 다중, 마지막 한 칸은 해제 불가(빈 선택 방지).
 *  - 매 역: 시작 N 하나(라디오) — N역 전부터 도착 직전까지 전부 울린다.
 * 저장은 `setSleepAlarm`(normalize 경유)만 쓴다. 기본값과 같은 조합은 저장이 비워지므로 모드는 로컬로 유지한다.
 */
export function SleepAlarmStops({ disabled = false }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const config = useSettingsStore((s) => s.sleepAlarm);
  const setSleepAlarm = useSettingsStore((s) => s.setSleepAlarm);
  const [mode, setMode] = useState<SleepAlarmMode>(config?.mode ?? DEFAULT_MODE);

  useEffect(() => {
    if (config) setMode(config.mode);
  }, [config]);

  const stops = config?.stops ?? [SLEEP_ALARM_MIN_STOPS_BEFORE];
  const farthest = Math.max(...stops);
  const isEvery = mode === 'every';
  const isChecked = (n: number) => (isEvery ? n === farthest : stops.includes(n));

  const onMode = (next: SleepAlarmMode) => {
    setMode(next);
    void setSleepAlarm({ mode: next, stops });
  };

  const onRow = (n: number) => {
    if (isEvery) {
      void setSleepAlarm({ mode, stops: [n] });
      return;
    }
    const next = stops.includes(n) ? stops.filter((s) => s !== n) : [...stops, n];
    void setSleepAlarm({ mode, stops: next });
  };

  return (
    <View testID="sleep-alarm-stops" style={styles.container}>
      <Text style={[styles.title, { color: colors.ink }]}>{t('settings.sleepAlarmTitle')}</Text>

      <View
        style={[styles.segmentGroup, { backgroundColor: colors.segmentTrack, opacity: disabled ? 0.5 : 1 }]}
      >
        {SLEEP_ALARM_MODES.map((value) => {
          const active = mode === value;
          const label = t(MODE_LABEL_KEYS[value]);
          return (
            <Pressable
              key={value}
              style={[styles.segment, active && { backgroundColor: colors.segmentActive }]}
              onPress={() => onMode(value)}
              disabled={disabled}
              testID={`sleep-alarm-mode-${value}`}
              accessibilityRole="radio"
              accessibilityLabel={label}
              accessibilityState={{ selected: active, disabled }}
            >
              <Text style={[styles.segmentText, { color: active ? colors.ink : colors.muted }]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>

      <Text style={[styles.helper, { color: colors.muted }]}>
        {isEvery
          ? t('settings.sleepAlarmHelperEvery', { count: farthest })
          : t('settings.sleepAlarmHelperSelected')}
      </Text>

      {sleepAlarmStopOptions().map((n) => {
        const checked = isChecked(n);
        const isLastSelected = !isEvery && checked && stops.length === 1;
        const rowDisabled = disabled || isLastSelected;
        const label = t('settings.sleepAlarmRow', { count: n });
        return (
          <Pressable
            key={n}
            style={[styles.row, { borderTopColor: colors.hair, opacity: disabled ? 0.5 : 1 }]}
            onPress={() => onRow(n)}
            disabled={rowDisabled}
            testID={`sleep-alarm-row-${n}`}
            accessibilityRole={isEvery ? 'radio' : 'checkbox'}
            accessibilityLabel={label}
            accessibilityHint={isLastSelected ? t('a11y.settings.sleepAlarmLastStopHint') : undefined}
            accessibilityState={{ checked, disabled: rowDisabled }}
          >
            <Text style={[styles.rowLabel, { color: colors.ink }]}>{label}</Text>
            <View
              style={[
                styles.mark,
                isEvery && styles.markRound,
                {
                  borderColor: checked ? colors.ink : colors.hair,
                  backgroundColor: checked ? colors.ink : 'transparent',
                },
              ]}
            >
              {checked && !isEvery ? (
                <Text style={[styles.markGlyph, { color: colors.bg }]}>✓</Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const MARK_SIZE = 22;

const styles = StyleSheet.create({
  container: {
    marginTop: spacing.md,
  },
  title: {
    ...typography.bodyBase,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  segmentGroup: {
    flexDirection: 'row',
    borderRadius: radiusGlass.md,
    padding: 4,
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
  helper: {
    ...typography.captionSm,
    lineHeight: 17,
    marginVertical: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    borderTopWidth: 1,
  },
  rowLabel: {
    ...typography.bodyBase,
  },
  mark: {
    width: MARK_SIZE,
    height: MARK_SIZE,
    borderWidth: 1.5,
    borderRadius: radiusGlass.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markRound: {
    borderRadius: MARK_SIZE / 2,
  },
  markGlyph: {
    ...typography.captionSm,
    fontWeight: '700',
  },
});
